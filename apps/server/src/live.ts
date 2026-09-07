import { cursor } from "./ingest/cursor.ts";
import { onLogs } from "./ingest/receipt.ts";
import type { StoredFill } from "./ingest/reconstruct.ts";
import { catchUp, head, watch } from "./ingest/subscribe.ts";
import { sweeper, unaccounted } from "./ingest/sweep.ts";
import { log } from "./log.ts";
import { sleep } from "./sleep.ts";

/** How often the recent past is re-read for logs the socket dropped; the range is ingest/sweep.ts's. */
const SWEEP_MS = 120_000;
/** A block number the heartbeat brought back this recently stands in for an HTTP call. */
const HEAD_FRESH_MS = 60_000;
/** A socket that lived this long resets the reconnect backoff. */
const STABLE_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;

export type Emit = (fills: StoredFill[]) => void;

/** Everything between the cursor and the head, through the same path as a cold start. Returns how many fills were new. */
export async function resume(emit: Emit): Promise<number> {
  const from = BigInt(cursor.last) + 1n;
  const to = await head();
  return to >= from ? catchUp(from, to, emit) : 0;
}

/**
 * No websocket endpoint: keep the tape moving by re-running the catch-up on a timer.
 * A demo mode — one poll costs one batched request and the delay is the interval,
 * where a subscription would cost one block.
 */
export async function poll(emit: Emit, seconds: number): Promise<never> {
  log.info(`RPC_WS_URL is not set; polling every ${seconds}s instead (see .env.example)`);
  for (;;) {
    await sleep(seconds * 1_000);
    await resume(emit).catch((error) => log.error("poll failed", error));
  }
}

/**
 * Live mode. A dropped socket loses the blocks it was down for, so every reconnect
 * replays them through the catch-up path; the fills primary key drops the overlap.
 *
 * The socket can also die quietly: a provider can answer the heartbeat and still have
 * forgotten the subscriptions, and then nothing about the connection looks wrong. The
 * sweep is what notices. It already re-reads the recent past through the catch-up path,
 * and `insertFills` returns only rows that were not stored before, so a fill it finds in
 * a block past everything the socket ever handed us is proof the subscription is gone.
 * A gap comparison against the resume cursor cannot do this job: the sweep advances that
 * cursor itself, so the gap it measures never opens.
 */
export function follow(wsUrl: string, emit: Emit): void {
  let backoff = 1_000;
  let stop = () => {};
  /**
   * How far the socket has accounted for the chain: the head when it subscribed, then
   * every log it delivered. A fill below this mark is a log dropped in passing, which is
   * what the sweep is for; a fill above it is a subscription that stopped.
   */
  let delivered = 0n;
  // The chain head as the socket last reported it. The watchdog and the sweep used to
  // ask for it again over HTTP: a second question every thirty seconds that the
  // heartbeat had just had answered.
  let seenHead = { block: 0n, at: 0 };
  const tip = (): Promise<bigint> =>
    Date.now() - seenHead.at < HEAD_FRESH_MS ? Promise.resolve(seenHead.block) : head();
  const recent = sweeper();

  const start = () => {
    const since = Date.now();
    log.info("subscribed");
    // Where this socket takes over. Without it a subscription that never delivers its
    // first log leaves the mark at zero, and the one case worth catching is exactly that.
    void head().then(
      (block) => {
        if (block > delivered) delivered = block;
      },
      () => {},
    );
    stop = watch(
      wsUrl,
      (entry) => {
        if (entry.blockNumber > delivered) delivered = entry.blockNumber;
        void onLogs([entry], emit);
      },
      async (why) => {
        if (Date.now() - since > STABLE_MS) backoff = 1_000;
        log.warn(`subscription down (${why}), retrying in ${backoff / 1000}s`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        await resume(emit).catch((error) => log.error("catch-up failed", error));
        start();
      },
      {
        onHead: (block) => {
          seenHead = { block, at: Date.now() };
        },
      },
    );
  };
  start();

  setInterval(async () => {
    try {
      const [from, to] = recent.range(await tip());
      // Counted against the live mark rather than one taken before the scan: a block the
      // socket delivers while the sweep is reading it must not be held against it.
      let past = 0;
      const fresh = await catchUp(from, to, (fills) => {
        past += unaccounted(fills, delivered);
        emit(fills);
      });
      recent.done(to);
      if (fresh > 0) log.warn(`the sweep found ${fresh} fills the socket did not deliver`);
      if (past > 0) {
        log.warn(`${past} of them are past everything the socket ever delivered; resubscribing`);
        stop();
        start();
      }
    } catch (error) {
      log.error("sweep", error);
    }
  }, SWEEP_MS);
}
