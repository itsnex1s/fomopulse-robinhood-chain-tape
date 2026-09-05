import { DurableObject } from "cloudflare:workers";
import { log } from "../../server/src/log.ts";
import type { Env } from "./env.ts";
import { bytesUsed, use } from "./sqlite.ts";

/** The alarm is the object's pulse: it prices, sweeps and resubscribes, and it is also
 *  what wakes the object again after the platform has put it away. */
const TICK_MS = 15_000;
/** Sweep and quote every 2 minutes, ask fomo every 10. Read off the clock rather than
 *  counted in ticks: the platform may put the object away between two alarms, and a
 *  counter that starts at zero again every time would never reach the tenth minute. */
const SWEEP_MS = 2 * 60_000;
const TRADERS_MS = 10 * 60_000;
/** And drop what is past its horizon four times a day: the horizons are counted in days,
 *  so anything more often is the same delete over a range that has not moved. */
const PRUNE_MS = 6 * 3_600_000;
/**
 * How long an object with no leaderboard at all waits before asking again. A restart, a
 * deploy or a first run leaves the ranks, the PnL and the avatars empty, and ten minutes
 * of that is ten minutes of a screen missing half of what it is for. Doubles after every
 * failed read, so a dead token is not asked four times a minute for as long as it is dead.
 */
const TRADERS_COLD_MS = 60_000;
/**
 * How long the tape waits for an alarm that never comes before the cron does the tick
 * itself. Measured on 2026-09-05: the platform accepted `setAlarm`, `getAlarm` read the
 * time back, the time went by, and `alarm()` was never entered — the tape ingested for
 * as long as the socket happened to live and then went quiet, twice, with nothing in the
 * log. Three missed ticks is past any ordinary delay.
 */
const STALE_MS = 3 * TICK_MS;
/**
 * How much of a pass is spent before the sweep is left for the next one. Work that outlives
 * the request that started it is cut off by the platform, and a pass that ran prices,
 * catch-up and a six-thousand-block sweep in one go never reached its end.
 */
const BUDGET_MS = 20_000;
/**
 * The whole pass, end to end. Every step runs against what is left of it and is abandoned
 * when that runs out: an endpoint that neither answers nor refuses used to hold the tick
 * for as long as the platform allowed, and the steps behind it — the leaderboard among
 * them — never ran at all. Shorter than the deadline that frees the slot, so a pass that
 * is still going is never joined by a second one.
 */
const PASS_MS = 45_000;
/**
 * A pass still going after this long is not coming back. Holding the slot for it froze
 * the tape for as long as it hung, because the next caller joined the dead promise
 * instead of starting a pass of its own.
 */
const TICK_DEADLINE_MS = 4 * TICK_MS;

type App = typeof import("./app.ts");

/**
 * One object holds the whole tape: the chain subscription, the SQLite the fills are
 * written to, and every reader watching them arrive. Single-threaded on purpose — one
 * writer, no locks, and a broadcast that reaches a thousand sockets from the same
 * memory the row was written in.
 */
export class Tape extends DurableObject<Env> {
  private app?: App;
  private readonly booted: Promise<void>;
  /**
   * What the pulse did last, answered on `/alive`. The alarm is the only thing that
   * prices, sweeps and resubscribes, and an alarm that stops firing looks from outside
   * exactly like a quiet chain: `curl /alive` tells the two apart.
   */
  private beat = { ran: 0, took: 0, error: null as string | null, ticks: 0, by: "none", step: "none" };
  /** One tick at a time, whoever asked for it — until the one in flight overstays. */
  private running?: { started: number; done: Promise<void> };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Bind the storage before anything that opens a database is imported.
    use(ctx.storage);
    // The readers' keepalive, answered by the runtime itself. Every "p" that reaches
    // `webSocketMessage` is a request against the object and wakes it out of hibernation;
    // a thousand idle tabs pinging every twenty seconds is three requests a second for
    // nothing. Matched here, the object never hears them.
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
    // Any request is also a sign of life: the indexer starts if it is not running.
    await this.ensureRunning();
    if (url.pathname === "/api/alive") {
      // The cron is the spare key, and a key has to turn: when the alarm stops being
      // delivered the cron is the only thing still moving, so it runs the tick itself
      // rather than only poking the object. Only the cron does — it reaches the object
      // under its own hostname and nothing waits on its answer, while the same path from
      // outside is a read of the pulse and has to come back at once.
      const spare = url.hostname === "tape.internal";
      // The cron turns the key every minute whether or not the beat looks fresh: a reader's
      // tick stamps the beat on its way in and is cut short two seconds later, so waiting
      // for a stale-looking beat meant the pass that sweeps and asks fomo never ran.
      if (spare) await this.pulse("cron");
      return Response.json({
        ...this.beat,
        session: this.app!.session(),
        // Nothing prunes the tape, and the object's SQLite stops at ten gigabytes: the
        // number that says how far off that is belongs where the pulse is read.
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
   * Started by the first request, kept going by the alarm. Both are cheap when there is
   * nothing to do, and either one on its own is enough to bring the tape back.
   */
  private async ensureRunning(): Promise<void> {
    const at = await this.ctx.storage.getAlarm();
    // A timestamp well in the past is as dead as none: an alarm lost with the object that
    // set it never fires, and re-arming on `null` alone left the tape frozen while every
    // request walked past it. One tick of slack, so an alarm about to fire is left alone
    // and steady traffic cannot keep pushing the next one out of reach.
    const now = Date.now();
    if (at === null || at < now - TICK_MS) await this.ctx.storage.setAlarm(now + TICK_MS);
    this.app!.follow();
    // Readers poll every few seconds, so their requests are the densest clock the object
    // has when the alarm is silent: waiting only for the cron let the tape drift a couple
    // of minutes behind the head between ticks. The reader is not made to wait for the
    // whole pass — the tick goes on in `running` after this returns.
    // Handed to the platform rather than raced against a timer: work left running when the
    // response goes out is cancelled, and a tick cut off halfway never reaches the sweep.
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
   * stop the work — nothing here can be cancelled — but the pass goes on without it, and
   * `/alive` names the step that overstayed instead of showing a tick that never ended.
   */
  private async within<T>(step: string, until: number, work: Promise<T>): Promise<T | undefined> {
    this.beat.step = step;
    const left = until - Date.now();
    if (left <= 0) {
      this.failed(step, new Error("no time left in the pass"));
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
    return Promise.race([done, capped]).finally(() => clearTimeout(timer));
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
    this.beat = { ran: now, took: 0, error: null, ticks: this.beat.ticks + 1, by, step: "start" };
    const app = this.app!;
    const until = now + PASS_MS;
    app.follow();
    // Which step the pass is on, kept on the beat: a step that overstays leaves the tick
    // looking simply unfinished, and `took: 0` on `/alive` says only that, not where.
    // A price a tick late turns an unpriced fill into a priced one, and dusting into a trade.
    await this.within("prices", until, app.prices());
    // Only when the socket cannot vouch for the gap since the last log; see app.resume.
    await this.within("catch-up", until, app.resume());
    // fomo first: four requests that take seconds, ahead of a sweep that re-reads the
    // blocks since the last one over an endpoint that paces us. Behind it, the ten-minute
    // job never came up for air.
    const every = app.traderInterval(TRADERS_MS, TRADERS_COLD_MS);
    if (await this.due("traders", every, now)) await this.within("traders", until, app.traders());
    // And the sweep only starts if there is any of the pass's budget left to run it in.
    if (Date.now() - now < BUDGET_MS && (await this.due("sweep", SWEEP_MS, now))) {
      const found = (await this.within("sweep", until, app.sweep())) ?? 0;
      if (found > 0) log.warn(`the sweep found ${found} fills the socket did not deliver`);
      await this.within("bag quotes", until, app.quotes());
    }
    // Last, and only with budget to spare: nothing waits on it, and the storage it frees
    // is measured in days rather than in the seconds a pass has.
    if (Date.now() - now < BUDGET_MS && (await this.due("prune", PRUNE_MS, now)))
      await this.within("prune", until, app.prune());
    this.beat.step = "done";
    this.beat.took = Date.now() - now;
  }
}
