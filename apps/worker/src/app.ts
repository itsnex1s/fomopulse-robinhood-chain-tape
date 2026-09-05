/**
 * Everything the tape does, on the object's own storage. Imported only after the object
 * has bound that storage, so the database this pulls in opens where the object lives.
 */
import { toFill } from "../../server/src/api/fills.ts";
import { configure, env as settings, wallets } from "../../server/src/config.ts";
import { prune as pruneStorage, setMeta, tapeOfTx } from "../../server/src/db.ts";
import { cursor } from "../../server/src/ingest/cursor.ts";
import { onLogs } from "../../server/src/ingest/receipt.ts";
import type { StoredFill } from "../../server/src/ingest/reconstruct.ts";
import { catchUp, head, openSocketWith, scanChunk, watch } from "../../server/src/ingest/subscribe.ts";
import { SWEEP_BLOCKS, sweeper } from "../../server/src/ingest/sweep.ts";
import { log } from "../../server/src/log.ts";
import { refreshPrices } from "../../server/src/prices/feed.ts";
import { sessionState } from "../../server/src/privy.ts";
import { maintain, quoteBags, traderInterval } from "../../server/src/traders.ts";
import type { Secrets } from "./env.ts";
import { upgrade } from "./socket.ts";

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
 * socket delivers the logs and the sweep re-reads the recent past on its own clock;
 * reading the gap since the last log on every tick as well was three RPC calls every
 * fifteen seconds for nothing — measured 2026-09-05, about seventeen thousand a day.
 */
let behind = true;
/** The chain head as the socket last reported it, from the heartbeat. */
let seenHead = { block: 0n, at: 0 };
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
  openSocketWith(upgrade);
  publish = send;
  // These modules live in the isolate, not in the object, and an object that was put
  // away can leave a subscription behind in them. The platform refuses I/O started by
  // one object context from another — "cannot perform I/O on behalf of a different
  // Durable Object" — so a new object forgets the old socket and opens its own.
  following = false;
  behind = true;
}

/** Follow the chain. Idempotent: an object that is already subscribed stays as it is. */
export function follow(): void {
  if (following || !settings.wsUrl) return;
  following = true;
  // Whatever landed while there was no socket is read over HTTP once, on the next tick.
  behind = true;
  setMeta("source", "websocket");
  // watch() closes its own socket before it reports down, so there is nothing to hold on to.
  watch(
    settings.wsUrl,
    (entry) => void onLogs([entry], emit),
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

/**
 * Which call failed, kept in the message. The tick reports one error per step and an RPC
 * error names neither the method nor the endpoint, so "catch-up: unknown RPC error" left
 * nothing to go on but a page of viem's request dump in the log.
 */
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
  // cut off partway through re-reads the same oldest blocks every time and never the newest.
  const span = SWEEP_BLOCKS < scanChunk() * SWEEP_CHUNKS ? SWEEP_BLOCKS : scanChunk() * SWEEP_CHUNKS;
  const [from, to] = recent.range(await tip(), span);
  const found = await at("scan", catchUp(from, to, emit));
  recent.done(to);
  return found;
}

export const prices = (): Promise<void> => refreshPrices(push);
/** Drops what is past its horizon; see db/prune.ts for how long each row is kept. */
export function prune(): Promise<void> {
  const gone = pruneStorage(Math.floor(Date.now() / 1000));
  if (gone.fills > 0 || gone.receipts > 0)
    log.info(`pruned ${gone.receipts} receipts and ${gone.fills} fills past their horizon`);
  return Promise.resolve();
}
export const quotes = quoteBags;
export const traders = maintain;
export { traderInterval };
/** What the fomo session is doing: whether one was deployed at all, whether it can renew
 *  itself, and when the one in hand runs out. Without any of that the leaderboard pass is
 *  skipped in silence, and silence and a broken session look the same from outside. */
export const session = sessionState;
export const wallet_count = wallets.length;
