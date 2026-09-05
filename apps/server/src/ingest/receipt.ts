import type { Hex } from "viem";
import { env, QUOTE_TOKENS, rpc, WALLET_SET } from "../config.ts";
import { deleteFill, getReceipt, insertFills, saveReceipt } from "../db.ts";
import { log } from "../log.ts";
import { ethUsd } from "../prices/eth.ts";
import { prices } from "../prices/feed.ts";
import { sleep } from "../sleep.ts";
import { isStock } from "../stocks.ts";
import { cursor } from "./cursor.ts";
import { sample } from "./lag.ts";
import {
  type ParsedReceipt,
  parse,
  participants,
  type RawReceipt,
  reconstruct,
  type StoredFill,
  tokensToResolve,
} from "./reconstruct.ts";
import { decimals, kinds, resolveKinds, resolveTokens, timestampOf } from "./resolve.ts";

/** What a log needs to look like for this module; the socket, `getLogs` and the tests all satisfy it. */
export interface IngestLog {
  transactionHash: Hex;
  blockNumber: bigint;
  logIndex: number;
  removed?: boolean;
}

/**
 * Receipts read at once during a catch-up; the HTTP transport batches their calls anyway.
 * Read per pass rather than held in a constant: in a Worker the settings arrive after this
 * module is imported, so a constant keeps the endpoint the app had before it was configured
 * — the chain's own, and the pacing that endpoint needs — with a provider key in hand.
 */
const concurrency = () => (env.publicRpc ? 2 : 8);
const ATTEMPTS = 5;
const RETRY_MS = 5_000;
/**
 * A swap touches a handful of balances; a transaction that changes hundreds is a
 * distribution — a stock-token airdrop reached 1 900 wallets in one go. Its fills are
 * recorded but not priced, and its participants are not looked up one by one.
 */
const MAX_PARTICIPANTS = 40;

const pending = new Map<Hex, ReturnType<typeof setTimeout>>();
const running = new Map<Hex, Promise<StoredFill[]>>();

/**
 * Live (delayMs > 0): a transaction's logs arrive one by one, so it is held briefly and
 * its receipt read once — briefly, because the receipt carries the whole transaction
 * whichever of its logs triggered the read, so the wait only saves a repeat. Catch-up (delayMs = 0): the batch is read with bounded
 * concurrency and the promise settles when every transaction in it is done, so the
 * caller moves the cursor only past finished work.
 */
export async function onLogs(
  logs: IngestLog[],
  emit: (fills: StoredFill[]) => void,
  delayMs = 40,
): Promise<StoredFill[]> {
  const txs = new Map<Hex, bigint>();
  for (const log of logs) {
    if (log.removed) {
      // A reorg on a single-sequencer Orbit chain is close to impossible, and cheap to survive anyway.
      deleteFill(log.transactionHash, log.logIndex);
      continue;
    }
    txs.set(log.transactionHash, log.blockNumber);
  }
  for (const [tx, block] of txs) cursor.begin(tx, Number(block));

  if (delayMs > 0) {
    for (const [tx, block] of txs) {
      clearTimeout(pending.get(tx));
      pending.set(
        tx,
        setTimeout(() => {
          pending.delete(tx);
          void processTx(tx, block, emit);
        }, delayMs),
      );
    }
    return [];
  }

  const fresh: StoredFill[] = [];
  await eachLimit([...txs], concurrency(), async ([tx, block]) => {
    fresh.push(...(await processTx(tx, block, emit)));
  });
  return fresh;
}

/** One read per transaction, however many paths ask for it at once. */
export function processTx(tx: Hex, block: bigint, emit: (fills: StoredFill[]) => void): Promise<StoredFill[]> {
  const active = running.get(tx);
  if (active) return active;
  const run = withRetries(tx, block, emit).finally(() => running.delete(tx));
  running.set(tx, run);
  return run;
}

async function withRetries(tx: Hex, block: bigint, emit: (fills: StoredFill[]) => void): Promise<StoredFill[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      const fills = await readAndStore(tx, block, emit);
      cursor.done(tx);
      return fills;
    } catch (error) {
      if (attempt >= ATTEMPTS) {
        // Left in flight on purpose: the cursor stays below this block and the next start rescans it.
        log.error(`giving up on ${tx} after ${attempt} attempts; its block will be rescanned on restart`, error);
        return [];
      }
      await sleep(RETRY_MS * attempt);
    }
  }
}

async function readAndStore(tx: Hex, block: bigint, emit: (fills: StoredFill[]) => void): Promise<StoredFill[]> {
  // The timestamp and the ETH price depend on the block, not on the receipt, so they are
  // asked for while the receipt is still in flight: one round trip off the live path.
  const ofBlock = Promise.all([timestampOf(block), ethUsd()]);
  ofBlock.catch(() => {}); // rethrown below; this only stops an unhandled rejection if the receipt fails first

  const stored = getReceipt(tx);
  const receipt: ParsedReceipt = stored ?? parse((await fetchReceipt(tx)) ?? unavailable());

  // Independent lookups; the chain ones leave as one JSON-RPC batch.
  const involved = participants(receipt, QUOTE_TOKENS);
  const [[ts, eth]] = await Promise.all([
    ofBlock,
    involved.length <= MAX_PARTICIPANTS ? resolveKinds(involved) : Promise.resolve(),
    resolveTokens(tokensToResolve(receipt, WALLET_SET, QUOTE_TOKENS)),
  ]);

  // Stored with its timestamp, so a rebuild can replay it even if no fill survives the rules.
  if (!stored || stored.ts === null) saveReceipt(receipt, ts);

  const fills = reconstruct(receipt, {
    wallets: WALLET_SET,
    quote: QUOTE_TOKENS,
    decimals,
    kinds,
    ts,
    ethUsd: eth,
    prices,
    isStock,
  });
  const fresh = insertFills(fills);
  if (fresh.length > 0) {
    sample(ts);
    emit(fresh);
  }
  return fresh;
}

function unavailable(): never {
  throw new Error("receipt not available");
}

/** A receipt is null for a moment after the log arrives. */
async function fetchReceipt(tx: Hex, attempts = 20): Promise<RawReceipt | null> {
  for (let i = 0; i < attempts; i++) {
    const receipt = (await rpc.request({ method: "eth_getTransactionReceipt", params: [tx] })) as RawReceipt | null;
    if (receipt) return receipt;
    await sleep(100);
  }
  return null;
}

async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
