import { DurableObject } from "cloudflare:workers";
import { limits, ms } from "../../server/src/limits.ts";
import { log } from "../../server/src/log.ts";
import type { Env } from "./env.ts";
import { bytesUsed, rowsRead, use } from "./sqlite.ts";

/**
 * Every clock this object runs on comes from config/limits.json, where the reasoning sits
 * beside the number. Read off the wall clock rather than counted in ticks: the platform may
 * put the object away between two alarms, and a counter starting at zero again every time
 * would never reach the tenth minute.
 */
const TICK_MS = ms(limits.pace.tickSeconds);
const SWEEP_MS = ms(limits.pace.sweepSeconds);
const TRADERS_MS = ms(limits.pace.tradersSeconds);
const TRADERS_COLD_MS = ms(limits.pace.tradersColdSeconds);
/** The floor of the books walk, rather than its interval: the pass is spaced off its own cost
 *  between these two, so it does not grow into the clock as the tape does. */
const BOOKS_MS = ms(limits.pace.booksMinSeconds);
const BOOKS_MAX_MS = ms(limits.pace.booksMaxSeconds);
const PRUNE_MS = ms(limits.pace.pruneSeconds);
/** How much of a pass may be spent before the sweep is left for the next one, and how long the
 *  whole pass may run: work that outlives the request that started it is cut off by the platform. */
const BUDGET_MS = ms(limits.pace.passBudgetSeconds);
const PASS_MS = ms(limits.pace.passSeconds);
/** Both counted in ticks rather than configured, because both are about the alarm and not about
 *  pace: three missed deliveries is past any ordinary delay, and a pass still going after four
 *  is not coming back, so the slot goes to the next caller rather than holding a dead promise. */
const STALE_MS = 3 * TICK_MS;
const TICK_DEADLINE_MS = 4 * TICK_MS;

type App = typeof import("./app.ts");

/**
 * One object holds the whole tape: the chain subscription, the SQLite the fills are
 * written to, and every reader watching them arrive. Single-threaded, so one writer and
 * no locks.
 */
export class Tape extends DurableObject<Env> {
  private app?: App;
  private readonly booted: Promise<void>;
  /**
   * What the pulse did last, answered on `/alive`. An alarm that stops firing looks from
   * outside exactly like a quiet chain; this tells the two apart.
   */
  private beat = {
    ran: 0,
    took: 0,
    error: null as string | null,
    ticks: 0,
    by: "none",
    step: "none",
    /**
     * Rows each step of the last pass walked, as the storage counted them. The bill is mostly
     * this — the jobs, not the readers — and without it the only way to tell which of them is
     * spending the month is to guess. Answered on `/alive`.
     */
    rows: {} as Record<string, number>,
  };
  /** One tick at a time, whoever asked for it — until the one in flight overstays. */
  private running?: { started: number; done: Promise<void> };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Bind the storage before anything that opens a database is imported.
    use(ctx.storage);
    // The readers' keepalive, answered by the runtime itself: every "p" that reached
    // `webSocketMessage` would wake the object out of hibernation and be billed for.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("p", "p"));
    this.booted = ctx.blockConcurrencyWhile(async () => {
      const app: App = await import("./app.ts");
      app.boot(env, (rows) => this.broadcast(rows));
      this.app = app;
    });
  }

  /** The queries run through a module that holds one storage handle, and an isolate can
   *  hold more than one object: whoever is about to work points it at its own first. */
  private bind(): void {
    use(this.ctx.storage);
  }

  /** The Worker forwards `/api/*` and `/ws` here and nothing else. */
  override async fetch(request: Request): Promise<Response> {
    await this.booted;
    this.bind();
    const url = new URL(request.url);
    if (url.pathname === "/ws") return this.reader();
    await this.ensureRunning();
    if (url.pathname === "/api/alive") {
      // When the alarm stops being delivered the cron is the only thing still moving, so it
      // runs the tick itself. Only the cron does, under its own hostname: the same path from
      // outside is a read of the pulse and has to come back at once.
      const spare = url.hostname === "tape.internal";
      // Unconditionally, whether or not the beat looks fresh: a reader's tick stamps the
      // beat on its way in and may then be cut short before it sweeps or asks fomo.
      if (spare) await this.pulse("cron");
      return Response.json({
        ...this.beat,
        session: this.app!.session(),
        // The object's SQLite stops at ten gigabytes, so how far off that is belongs here.
        bytes: bytesUsed(),
        alarm: await this.ctx.storage.getAlarm(),
        now: Date.now(),
      });
    }
    return this.app!.api.fetch(request);
  }

  /** Hibernatable, so a thousand idle readers cost nothing between fills. */
  private reader(): Response {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Only for a socket accepted before the auto-response was set; the runtime answers the rest. */
  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message === "string" && message === "p") ws.send("p");
  }

  private broadcast(rows: unknown[]): void {
    const payload = JSON.stringify({ type: "fills", data: rows });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        // a reader that went away between the fill and the send
      }
    }
  }

  /**
   * Started by the first request, kept going by the alarm. Either one on its own is enough
   * to bring the tape back.
   */
  private async ensureRunning(): Promise<void> {
    const at = await this.ctx.storage.getAlarm();
    // A timestamp well in the past is as dead as none: an alarm lost with the object that
    // set it never fires and is never cleared. One tick of slack, so an alarm about to fire
    // is left alone and steady traffic cannot keep pushing the next one out of reach.
    const now = Date.now();
    if (at === null || at < now - TICK_MS) await this.ctx.storage.setAlarm(now + TICK_MS);
    this.app!.follow();
    // Readers poll every few seconds, so their requests are the densest clock the object has
    // when the alarm is silent. Handed to the platform rather than left running behind the
    // response: work still going when the response goes out is cancelled mid-pass.
    if (now - this.beat.ran > STALE_MS) this.ctx.waitUntil(this.pulse("request"));
  }

  /** True once `every` has passed since the last time this job ran, and the clock is stamped
   *  for the next one. Kept in the object's own storage, so an eviction does not lose it. */
  private async due(job: string, every: number, now: number): Promise<boolean> {
    const last = (await this.ctx.storage.get<number>(`ran:${job}`)) ?? 0;
    if (now - last < every) return false;
    await this.ctx.storage.put(`ran:${job}`, now);
    return true;
  }

  /**
   * One step of the pass, given what is left of its budget. Abandoning the promise does not
   * stop the work — nothing here can be cancelled — but the pass goes on without it.
   */
  private async within<T>(step: string, until: number, work: Promise<T>): Promise<T | undefined> {
    this.beat.step = step;
    const walked = rowsRead();
    const count = () => {
      this.beat.rows[step] = (this.beat.rows[step] ?? 0) + (rowsRead() - walked);
    };
    const left = until - Date.now();
    if (left <= 0) {
      this.failed(step, new Error("no time left in the pass"));
      count();
      return undefined;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capped = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        this.failed(step, new Error(`gave up after ${Math.round(left / 1000)}s`));
        resolve(undefined);
      }, left);
    });
    const done = work.catch((error) => {
      this.failed(step, error);
      return undefined;
    });
    return Promise.race([done, capped]).finally(() => {
      clearTimeout(timer);
      count();
    });
  }

  /** Logged for the tail, and kept for `/alive`, which outlives the log line. */
  private failed(job: string, error: unknown): void {
    log.error(job, error);
    this.beat.error = `${job}: ${error instanceof Error ? error.message : String(error)}`;
  }

  override async alarm(): Promise<void> {
    await this.booted;
    this.bind();
    // Awaited before any work: the next tick is what keeps the object beating, and a
    // dropped write here is the one failure nothing downstream can recover from.
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    await this.pulse("alarm");
  }

  /** Deduplicated, so a slow tick and the next caller do not run the pass twice over. */
  private pulse(by: string): Promise<void> {
    const now = Date.now();
    if (this.running && now - this.running.started < TICK_DEADLINE_MS) return this.running.done;
    const run = { started: now, done: Promise.resolve() };
    run.done = this.tick(by)
      .catch((error) => this.failed("tick", error))
      .finally(() => {
        // Only if it is still the current one: a pass let go for overstaying must not
        // clear the slot out from under its replacement when it finally comes back.
        if (this.running === run) this.running = undefined;
      });
    this.running = run;
    return run.done;
  }

  /** Everything the pulse does, whichever clock woke it. */
  private async tick(by: string): Promise<void> {
    await this.booted;
    this.bind();
    const now = Date.now();
    this.beat = { ran: now, took: 0, error: null, ticks: this.beat.ticks + 1, by, step: "start", rows: {} };
    const app = this.app!;
    const until = now + PASS_MS;
    app.follow();
    // The transfers of a database written before they were packed onto their receipt, a slice
    // at a time. Nothing below may replay a receipt until they are all where the replay looks.
    const carried = await this.within("carry", until, app.carry());
    // Before anything is read: a deploy that changed how a fill is reconstructed or priced
    // replays the stored receipts once, so every read after it is of the corrected tape.
    if (carried === true) await this.within("repair", until, app.repair());
    // A price a tick late turns an unpriced fill into a priced one, and dusting into a trade.
    await this.within("prices", until, app.prices());
    // Only when the socket cannot vouch for the gap since the last log; see app.resume.
    await this.within("catch-up", until, app.resume());
    // fomo first: four requests that take seconds, ahead of a sweep that can spend the rest
    // of the pass against an endpoint that paces us.
    const every = app.traderInterval(TRADERS_MS, TRADERS_COLD_MS);
    if (await this.due("traders", every, now)) await this.within("traders", until, app.traders());
    if (Date.now() - now < BUDGET_MS && (await this.due("sweep", SWEEP_MS, now))) {
      const found = (await this.within("sweep", until, app.sweep())) ?? 0;
      if (found > 0) log.warn(`the sweep found ${found} fills the socket did not deliver`);
      await this.within("bag quotes", until, app.quotes());
    }
    // Behind the chain work: nothing on the tape waits for it, and it reads rows the steps
    // above have just written.
    if (Date.now() - now < BUDGET_MS && (await this.due("books", app.booksInterval(BOOKS_MS, BOOKS_MAX_MS), now)))
      await this.within("books", until, app.books());
    // Last, and only with budget to spare: nothing waits on it, and the storage it frees is
    // measured in days rather than in the seconds a pass has.
    if (Date.now() - now < BUDGET_MS && (await this.due("prune", PRUNE_MS, now)))
      await this.within("prune", until, app.prune());
    this.beat.step = "done";
    this.beat.took = Date.now() - now;
  }
}
