import { cursor } from "./ingest/cursor.ts";
import { onLogs } from "./ingest/receipt.ts";
import type { StoredFill } from "./ingest/reconstruct.ts";
import { catchUp, head, watch } from "./ingest/subscribe.ts";
import { sweeper } from "./ingest/sweep.ts";
import { log } from "./log.ts";
import { sleep } from "./sleep.ts";

/** How far the chain may run ahead of the newest log before the socket is doubted; about 5 minutes. */
const GAP_BLOCKS = 3_000;
const WATCHDOG_MS = 30_000;
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
 * The socket can also die quietly, or a provider can reconnect it and forget the
 * subscriptions, so a watchdog compares the chain head with the newest log: a gap is
 * read over HTTP, and fills found that way are proof the socket is not delivering.
 */
export function follow(wsUrl: string, emit: Emit): void {
  let backoff = 1_000;
  let stop = () => {};
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
    stop = watch(
      wsUrl,
      (entry) => void onLogs([entry], emit),
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
      const fresh = await catchUp(from, to, emit);
      recent.done(to);
      if (fresh > 0) log.warn(`the sweep found ${fresh} fills the socket did not deliver`);
    } catch (error) {
      log.error("sweep", error);
    }
  }, SWEEP_MS);

  setInterval(async () => {
    try {
      const block = Number(await tip());
      if (block - cursor.highest < GAP_BLOCKS) return;
      const fresh = await resume(emit);
      if (fresh > 0) {
        log.warn(`the socket missed ${fresh} fills; resubscribing`);
        stop();
        start();
      }
    } catch (error) {
      log.error("watchdog", error);
    }
  }, WATCHDOG_MS);
}
