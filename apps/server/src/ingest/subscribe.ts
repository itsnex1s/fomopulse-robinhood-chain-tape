import { type Hex, parseAbiItem } from "viem";
import { env, logRpc, rpc, WALLET_LIST, WALLET_TOPICS, wideRpc } from "../config.ts";
import { log } from "../log.ts";
import { sleep } from "../sleep.ts";
import { cursor } from "./cursor.ts";
import { type IngestLog, onLogs } from "./receipt.ts";
import { type StoredFill, TRANSFER_TOPIC } from "./reconstruct.ts";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/** Chunk size for catch-up; 2 000 blocks is about 3 minutes of this chain. */
const CHUNK = 2_000n;
/**
 * What the chain's own fallback will take. Measured 2026-09-05 with the real wallet filter:
 * OrdoFi answered 500 blocks in 2.2 s and gave up on 2 000 — viem's ten-second timeout with
 * four retries behind it, which is a whole pass spent on a range that was never coming back.
 * Asking that endpoint for what it can serve beats asking for what it cannot and waiting.
 */
const WIDE_CHUNK = 500n;
/** Below this a catch-up is more round trips than the narrower range is worth. */
const MIN_CHUNK = 125n;
/**
 * Providers cap the `eth_getLogs` range — Alchemy's free tier allows ten blocks, one
 * second of this chain, which would turn one chunk into two hundred requests. The
 * first rejection of any kind moves the scan to the chain's own endpoint, which has no
 * cap; only if that one refuses too does the chunk shrink to the cap it states.
 */
let chunk = CHUNK;
/**
 * Which endpoint the scan is on, as a flag rather than the client itself. The clients are
 * rebuilt when the settings arrive, and a module that captured one at import time keeps
 * the endpoint the app had before it was configured: in a Worker there is no environment
 * to read at import, so that is the chain's own endpoint, which answers a Cloudflare
 * address with 429 — the key was there the whole time and the scan never used it.
 */
let onWide = false;
/**
 * How wide the chunk may grow back. A range narrowed because the endpoint was slow for a
 * minute should not stay narrow for the life of the isolate — that is eight times the round
 * trips on every later catch-up — but it must not grow past a cap the provider has stated.
 */
let ceiling = CHUNK;

function rangeCapOf(error: unknown): bigint | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const stated = message.match(/up to a (\d+)[- ]block range/i);
  if (stated) return BigInt(stated[1]!);
  return /block range|range is too (large|wide)|limited to \d+ blocks/i.test(message) ? 10n : undefined;
}

/** A timeout states no cap, but it says this range is too wide for this endpoint right now. */
const timedOut = (error: unknown): boolean =>
  /timed out|took too long/i.test(error instanceof Error ? error.message : String(error));

const half = (of: bigint): bigint => (of / 2n < MIN_CHUNK ? MIN_CHUNK : of / 2n);
/**
 * How small a stated cap may be and still be worth meeting. Meeting one keeps the scan
 * on the endpoint that stated it, which is worth something — but Alchemy's free tier
 * allows ten blocks, and meeting that turns one chunk into two hundred requests and a
 * six-thousand-block sweep into six hundred, where the endpoint with no cap answers the
 * same range in one. Four times the requests to keep a key is a trade; two hundred is
 * not.
 */
const WORTH_MEETING = CHUNK / 4n;
/** Space between catch-up chunks on the public RPC, which rejects requests that come faster. */
const PACE_MS = 300;
/** A silent socket is asked for the block number this often, and given this long to answer. */
const HEARTBEAT_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

export const head = () => rpc.getBlockNumber();

/** How wide a range the scan may ask for, for a caller sizing a range of its own. */
export const scanChunk = (): bigint => chunk;

/** The first line of an RPC error; the rest is viem's request dump, which is a page long. */
const short = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0]!;

/**
 * Two filters, because a tracked wallet is either the receiver of a token (a buy)
 * or its sender (a sell), and one filter cannot express that as an OR. Filtering by
 * token contract is impossible: fomo routes through relay.link, so the token arrives
 * from whichever pool or router the route picked.
 */
const FILTERS = [{ to: WALLET_LIST }, { from: WALLET_LIST }];
const TOPICS: (Hex | Hex[] | null)[][] = [
  [TRANSFER_TOPIC, null, WALLET_TOPICS],
  [TRANSFER_TOPIC, WALLET_TOPICS],
];

/**
 * Reads the range in chunks and stores its fills. Each chunk is fully processed before
 * the cursor moves past it, so a crash never skips a transaction. Returns how many
 * fills were new.
 */
export async function catchUp(from: bigint, to: bigint, emit: (fills: StoredFill[]) => void): Promise<number> {
  let fresh = 0;
  for (let start = from; start <= to; ) {
    const end = start + chunk - 1n > to ? to : start + chunk - 1n;
    // Both filters at once: one waits on the other's round trip either way.
    let batches: Awaited<ReturnType<typeof rpc.getLogs>>[];
    const scan = onWide ? wideRpc : logRpc;
    try {
      batches = await Promise.all(
        FILTERS.map((args) => scan.getLogs({ event: TRANSFER, args, fromBlock: start, toBlock: end })),
      );
    } catch (error) {
      // A cap the provider states is worth more than another endpoint while meeting it
      // is cheap: scanning in the steps it allows keeps the key, and with it the rate
      // limit a key is for. Ten blocks is not cheap, and on the wide endpoint there is
      // nowhere further to go, so there any cap is met.
      const cap = rangeCapOf(error);
      if (cap !== undefined && cap < chunk && (onWide || cap >= WORTH_MEETING)) {
        log.info(`the RPC caps eth_getLogs at ${cap} blocks; catching up in steps of that`);
        ceiling = cap;
        chunk = cap;
        continue;
      }
      // A refusal that names no cap is not one the scan can meet; the chain's own
      // endpoint caps nothing, and its rate limit is what the pacing below is for.
      if (!onWide) {
        log.info(`the keyed RPC refused eth_getLogs (${short(error)}); scanning on the chain's own endpoint`);
        onWide = true;
        ceiling = WIDE_CHUNK;
        if (chunk > WIDE_CHUNK) chunk = WIDE_CHUNK;
        continue;
      }
      // Nothing left to switch to, so meet the endpoint where it is: halve and ask again.
      if (timedOut(error) && chunk > MIN_CHUNK) {
        chunk = half(chunk);
        log.info(`the scan timed out; narrowing to ${chunk} blocks`);
        continue;
      }
      throw error;
    }
    // Back towards the ceiling after a narrowing: the endpoint that timed out a minute ago
    // is usually fine now, and the chunk should not stay where its worst minute put it.
    if (chunk < ceiling) chunk = chunk * 2n > ceiling ? ceiling : chunk * 2n;
    const logs = batches.flat() as unknown as IngestLog[];
    if (logs.length > 0) fresh += (await onLogs(logs, emit, 0)).length;
    cursor.seen(Number(end));
    if ((env.publicRpc || onWide) && end < to) await sleep(PACE_MS);
    start = end + 1n;
  }
  return fresh;
}

interface Notification {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
  params?: {
    subscription: string;
    result: { transactionHash: Hex; blockNumber: Hex; logIndex: Hex; removed?: boolean };
  };
}

/**
 * How a client socket is opened. Bun has the constructor a browser has; a Worker has none
 * and asks the provider for an upgrade instead, so that platform swaps this out before it
 * subscribes.
 */
export let openSocket: (url: string) => WebSocket = (url) => new WebSocket(url);
export const openSocketWith = (open: typeof openSocket): void => {
  openSocket = open;
};

interface WatchOptions {
  heartbeatMs?: number;
  timeoutMs?: number;
  /** Every block number the heartbeat brings back, for a caller that would otherwise ask for it over HTTP. */
  onHead?: (block: bigint) => void;
}

/**
 * Live subscription over a raw websocket: two `eth_subscribe` calls, and a heartbeat
 * that asks the socket for the block number every 30 s. A socket that stops answering
 * is declared down, which a provider-side reconnect would otherwise hide. Returns a
 * function that stops it; `onDown` fires once, for any other end of the socket.
 */
export function watch(
  wsUrl: string,
  onLog: (log: IngestLog) => void,
  onDown: (reason: string) => void,
  { heartbeatMs = HEARTBEAT_MS, timeoutMs = HEARTBEAT_TIMEOUT_MS, onHead }: WatchOptions = {},
): () => void {
  const socket = openSocket(wsUrl);
  const replies = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const subscriptions = new Set<string>();
  let nextId = 1;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let waiting: ReturnType<typeof setTimeout> | undefined;

  const call = (method: string, params: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      replies.set(id, { resolve, reject });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });

  const stop = () => {
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(waiting);
    for (const { reject } of replies.values()) reject(new Error("socket closed"));
    replies.clear();
    try {
      socket.close();
    } catch {
      // already closed
    }
  };

  const down = (reason: string) => {
    if (closed) return;
    stop();
    onDown(reason);
  };

  socket.onopen = async () => {
    try {
      for (const topics of TOPICS) subscriptions.add((await call("eth_subscribe", ["logs", { topics }])) as string);
    } catch (error) {
      down(`subscribe failed: ${error instanceof Error ? error.message : error}`);
      return;
    }
    heartbeat = setInterval(() => {
      if (waiting) return; // the previous question is still open
      waiting = setTimeout(() => down("heartbeat timed out"), timeoutMs);
      call("eth_blockNumber", []).then(
        (result) => {
          clearTimeout(waiting);
          waiting = undefined;
          if (typeof result === "string" && /^0x[0-9a-f]+$/i.test(result)) onHead?.(BigInt(result));
        },
        () => down("heartbeat failed"),
      );
    }, heartbeatMs);
  };

  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as Notification;
    if (message.id !== undefined) {
      const reply = replies.get(message.id);
      replies.delete(message.id);
      if (!reply) return;
      if (message.error) reply.reject(new Error(message.error.message));
      else reply.resolve(message.result);
      return;
    }
    if (message.method !== "eth_subscription" || !message.params || !subscriptions.has(message.params.subscription))
      return;
    const log = message.params.result;
    onLog({
      transactionHash: log.transactionHash,
      blockNumber: BigInt(log.blockNumber),
      logIndex: Number(log.logIndex),
      removed: log.removed === true,
    });
  };

  socket.onerror = () => down("socket error");
  socket.onclose = (event) => down(`socket closed (${event.code})`);

  return stop;
}
