/**
 * Everything the tape does, on the object's own storage. Imported only after the object
 * has bound that storage, so the database this pulls in opens where the object lives.
 */

import { meterRows } from "../../server/src/api/budget.ts";
import { toFill } from "../../server/src/api/fills.ts";
import { configure, env as settings, wallets } from "../../server/src/config.ts";
import { carryTransfers, prune as pruneStorage, setMeta, tapeOfTx } from "../../server/src/db.ts";
import { cursor } from "../../server/src/ingest/cursor.ts";
import { repairFills } from "../../server/src/ingest/rebuild.ts";
import { onLogs } from "../../server/src/ingest/receipt.ts";
import type { StoredFill } from "../../server/src/ingest/reconstruct.ts";
import { catchUp, head, mend, openSocketWith, scanChunk, watch } from "../../server/src/ingest/subscribe.ts";
import { SWEEP_BLOCKS, sweeper, unaccounted } from "../../server/src/ingest/sweep.ts";
import { limits } from "../../server/src/limits.ts";
import { log } from "../../server/src/log.ts";
import { booksInterval, rebuildStats } from "../../server/src/pnl.ts";
import { refreshPrices } from "../../server/src/prices/feed.ts";
import { sessionState } from "../../server/src/privy.ts";
import { maintain, quoteBags, traderInterval } from "../../server/src/traders.ts";
import type { Secrets } from "./env.ts";
import { upgrade } from "./socket.ts";
import { rowsRead } from "./sqlite.ts";

export { api } from "../../server/src/api/routes.ts";

/** A cold object reads this much of the chain before it starts following: ~17 minutes. */
const COLD_START_BLOCKS = 10_000n;
/** Chunks one sweep may spend, when the provider's cap makes 6 000 blocks hundreds of them. */
const SWEEP_CHUNKS = 20n;
/** A block number the heartbeat brought back this recently stands in for an HTTP call. */
const HEAD_FRESH_MS = 60_000;

type Publish = (rows: unknown[]) => void;

let publish: Publish = () => {};
let following = false;
/**
 * Whether the chain has to be read over HTTP before the socket can be trusted: on a cold
 * object, and after the socket went down, until one catch-up has run since. A healthy
 * socket delivers the logs and the sweep re-reads the recent past on its own clock.
 */
let behind = true;
/** The chain head as the socket last reported it, from the heartbeat. */
let seenHead = { block: 0n, at: 0 };
/**
 * How far the socket has accounted for the chain: the head when it subscribed, then every
 * log it delivered. The heartbeat cannot tell a working subscription from a forgotten one,
 * so the sweep checks whether what it finds sits past this mark; see `unaccounted`.
 */
let delivered = 0n;
/** Closes the socket this isolate opened, for the case where it has to be given up on. */
let unfollow: (() => void) | undefined;
const recent = sweeper();

/** Rows are read back from the database, so the socket and the REST tape agree field for field. */
const push = (txs: string[]): void => {
  const rows = [...new Set(txs)].flatMap(tapeOfTx).map(toFill);
  if (rows.length > 0) publish(rows);
};

const emit = (fills: StoredFill[]): void => push(fills.map((f) => f.tx));

/** Settings first: the modules above were imported with none, and hold live bindings. */
export function boot(secrets: Secrets, send: Publish): void {
  configure(secrets);
  // What the storage says it walked, which is the whole bill rather than the API's share of it.
  meterRows(rowsRead);
  openSocketWith(upgrade);
  publish = send;
  // These modules live in the isolate, not in the object, and an object that was put away
  // can leave a subscription behind in them. A Durable Object cannot perform I/O on behalf
  // of another, so a new object forgets the old socket and opens its own.
  following = false;
  behind = true;
  delivered = 0n;
  unfollow = undefined;
}

/** Follow the chain. Idempotent: an object that is already subscribed stays as it is. */
export function follow(): void {
  if (following || !settings.wsUrl) return;
  following = true;
  // Whatever landed while there was no socket is read over HTTP once, on the next tick.
  behind = true;
  setMeta("source", "websocket");
  // Where this socket takes over. Without it a subscription that never delivers its first
  // log leaves the mark at zero, and that is the one case worth catching.
  void head().then(
    (block) => {
      if (block > delivered) delivered = block;
    },
    () => {},
  );
  // watch() closes its own socket before it reports down, so the handle is only for the
  // case it cannot report: a subscription that stopped while the connection stayed up.
  unfollow = watch(
    settings.wsUrl,
    (entry) => {
      if (entry.blockNumber > delivered) delivered = entry.blockNumber;
      void onLogs([entry], emit);
    },
    (why) => {
      following = false;
      behind = true;
      log.warn(`subscription down (${why}); the next alarm resubscribes`);
    },
    {
      onHead: (block) => {
        seenHead = { block, at: Date.now() };
      },
    },
  );
}

/** Which call failed, kept in the message: the tick reports one error per step, and an RPC
 *  error names neither the method nor the endpoint. */
const at = <T>(what: string, work: Promise<T>): Promise<T> =>
  work.catch((error: unknown) => {
    throw new Error(`${what}: ${brief(error)}`);
  });

/** viem's message is a page: the first line, and the one line of it that says what went wrong. */
function brief(error: unknown): string {
  const [first, ...rest] = (error instanceof Error ? error.message : String(error)).split("\n");
  const details = rest.find((line) => line.startsWith("Details:"));
  return details ? `${first} ${details}` : first!;
}

/** The chain head: the socket's answer while it is fresh, else one HTTP call. */
const tip = (): Promise<bigint> =>
  Date.now() - seenHead.at < HEAD_FRESH_MS ? Promise.resolve(seenHead.block) : at("head", head());

/**
 * Everything the chain owes us between the cursor and the head — when the socket cannot
 * vouch for it. Without a socket at all this is the only source, and then it runs every tick.
 */
export async function resume(): Promise<number> {
  if (following && !behind) return 0;
  const from = BigInt(cursor.last) + 1n;
  const to = await at("head", head());
  // A cold object would otherwise read from block zero.
  const start = cursor.last === 0 ? to - COLD_START_BLOCKS : from;
  const found = to < start ? 0 : await at("scan", catchUp(start, to, emit));
  behind = false;
  return found;
}

/** The sweep: what the socket delivered is not always all there was. */
export async function sweep(): Promise<number> {
  // As far back as the endpoint can be asked for inside one pass: a provider that caps
  // `eth_getLogs` at ten blocks turns six thousand into six hundred requests, and a sweep
  // cut off partway through never reaches the newest blocks.
  const span = SWEEP_BLOCKS < scanChunk() * SWEEP_CHUNKS ? SWEEP_BLOCKS : scanChunk() * SWEEP_CHUNKS;
  const [from, to] = recent.range(await tip(), span);
  // Counted against the live mark rather than one taken before the scan: a block the socket
  // delivers while the sweep is reading it must not be held against it.
  let past = 0;
  const found = await at(
    "scan",
    catchUp(from, to, (fills) => {
      past += unaccounted(fills, delivered);
      emit(fills);
    }),
  );
  recent.done(to);
  // Blocks a receipt read gave up on, tried again now that the endpoint has had a minute.
  const mended = await at("scan", mend(emit));
  if (mended > 0) log.info(`read ${mended} blocks that were owed one`);
  if (past > 0) {
    log.warn(`the sweep found ${past} fills past everything the socket delivered; resubscribing`);
    // The old socket never reported down, so it is closed here rather than left running
    // alongside its replacement. One belonging to an object the platform has since put away
    // refuses to close, and there is nothing to do about that but let it go.
    try {
      unfollow?.();
    } catch {
      // an object that is no longer ours to touch
    }
    unfollow = undefined;
    following = false;
    behind = true;
  }
  return found;
}

/**
 * Fills written under rules that have since changed, replayed from their receipts. Runs at
 * most once per deployment of a new rule, and runs here because only the object can reach
 * its own storage.
 */
export const repair = (): Promise<unknown> => repairFills();

/**
 * One slice of the one-off carry of the old per-row transfers onto their receipts, true once
 * the table is empty and dropped. Ahead of the replay in the pass, because a replay of a
 * receipt whose transfers have not been carried yet would find nothing under it.
 */
export const carry = (): Promise<boolean> => Promise.resolve(carryTransfers(limits.migrate.passRows));

export const prices = (): Promise<void> => refreshPrices(push);
/** The books, rewritten from the fills. Off the live path: the ranking reads the table a
 *  job keeps up to date, not a walk every open tab would start. */
export const books = (): Promise<void> => {
  rebuildStats();
  return Promise.resolve();
};
/** Drops what is past its horizon; see db/prune.ts for how long each row is kept. */
export function prune(): Promise<void> {
  const gone = pruneStorage(Math.floor(Date.now() / 1000));
  if (gone.fills > 0 || gone.receipts > 0)
    log.info(`pruned ${gone.receipts} receipts and ${gone.fills} fills past their horizon`);
  return Promise.resolve();
}
export const quotes = quoteBags;
export const traders = maintain;
export { booksInterval, traderInterval };
/** What the fomo session is doing: whether one was deployed at all, whether it can renew
 *  itself, and when the one in hand runs out. Without it a skipped leaderboard pass and a
 *  broken session look the same from outside. */
export const session = sessionState;
export const wallet_count = wallets.length;
