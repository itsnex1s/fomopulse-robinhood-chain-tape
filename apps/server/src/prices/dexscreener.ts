import type { Address } from "viem";
import { chainConfig } from "../config.ts";

const ENDPOINT = "https://api.dexscreener.com/tokens/v1";

/** The endpoint takes 30 addresses per call and allows 300 calls a minute. */
const PER_CALL = 30;
/**
 * Tokens quoted in one pass, across as many calls as that takes. The tape trades far more
 * tokens in a day than one call carries — 344 of them on 2026-09-05, against 294 wallets —
 * and the pass takes the stalest first, so the round trip for any one token is the day's
 * token count divided by this, times the fifteen seconds between passes. At thirty a pass
 * that was about two minutes, long enough for a mark on a fast token to sit several percent
 * away from the trade it is compared against; at a hundred and eighty it is half a minute,
 * and it costs twenty-four of the three hundred calls a minute the endpoint allows.
 */
export const BATCH = 180;
/**
 * A feed that accepts the connection and then says nothing would otherwise hang the whole
 * pass: the tick awaits the quotes before it catches up, and inside a Durable Object a
 * promise that never settles is not interrupted by anything. Measured 2026-09-05: ticks
 * started and never finished, and the tape sat two minutes behind the head between them.
 */
const TIMEOUT_MS = 10_000;

/**
 * The chains fomo reports bags on, as DexScreener names them. The tracked chain adds
 * itself, so a fork that follows another chain gets its bags named without editing this.
 */
export const SLUGS: Record<number, string> = {
  1: "ethereum",
  56: "bsc",
  8453: "base",
  1399811149: "solana",
  [chainConfig.id]: chainConfig.dexscreenerSlug,
};

/**
 * The whole card the feed returns for a pool, not just the price: the same call
 * carries the token's day and hour, its market-wide buys and sells, its size and its
 * picture, so the tape can show them without asking anyone else.
 */
export interface Quote {
  price: number;
  liquidity: number | null;
  change24: number | null;
  change1h: number | null;
  change5m: number | null;
  volume24: number | null;
  buys24: number | null;
  sells24: number | null;
  marketCap: number | null;
  fdv: number | null;
  pairCreatedAt: number | null;
  /** The pool the price came from; the tape links to it. */
  pair: string | null;
  /** Exchange and version, e.g. `uniswap v4`. */
  dex: string | null;
  imageUrl: string | null;
}

interface Pair {
  pairAddress?: string;
  dexId?: string;
  labels?: string[];
  baseToken?: { address?: string; symbol?: string; name?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  priceChange?: { m5?: number; h1?: number; h24?: number };
  volume?: { h24?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
  marketCap?: number;
  fdv?: number;
  pairCreatedAt?: number;
  info?: { imageUrl?: string };
}

async function callFor(slug: string, tokens: string[]): Promise<Pair[]> {
  const response = await fetch(`${ENDPOINT}/${slug}/${tokens.join(",")}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`dexscreener ${response.status}`);
  return (await response.json()) as Pair[];
}

/** The pass's tokens, in calls of the size the endpoint takes, asked for at once. */
async function pairsOf(slug: string, tokens: string[]): Promise<Pair[]> {
  const calls: Promise<Pair[]>[] = [];
  for (let at = 0; at < tokens.length && at < BATCH; at += PER_CALL)
    calls.push(callFor(slug, tokens.slice(at, at + PER_CALL)));
  return (await Promise.all(calls)).flat();
}

/** Quotes for a pass's worth of tokens on one chain; the tracked chain unless a slug says otherwise. */
export async function fetchQuotes(tokens: string[], slug = chainConfig.dexscreenerSlug): Promise<Map<Address, Quote>> {
  const out = new Map<Address, Quote>();

  for (const pair of await pairsOf(slug, tokens)) {
    const token = pair.baseToken?.address?.toLowerCase() as Address | undefined;
    const price = Number(pair.priceUsd);
    if (!token || !Number.isFinite(price) || price <= 0) continue;
    const liquidity = pair.liquidity?.usd ?? null;
    // A token trades in several pools; the deepest one carries the honest price.
    const known = out.get(token);
    if (known && (known.liquidity ?? 0) >= (liquidity ?? 0)) continue;
    out.set(token, {
      price,
      liquidity,
      change24: pair.priceChange?.h24 ?? null,
      change1h: pair.priceChange?.h1 ?? null,
      change5m: pair.priceChange?.m5 ?? null,
      volume24: pair.volume?.h24 ?? null,
      buys24: pair.txns?.h24?.buys ?? null,
      sells24: pair.txns?.h24?.sells ?? null,
      marketCap: pair.marketCap ?? null,
      fdv: pair.fdv ?? null,
      pairCreatedAt: pair.pairCreatedAt ?? null,
      pair: pair.pairAddress?.toLowerCase() ?? null,
      dex: pair.dexId ? [pair.dexId, ...(pair.labels ?? []).slice(0, 1)].join(" ") : null,
      imageUrl: pair.info?.imageUrl ?? null,
    });
  }
  return out;
}

/**
 * What a token is called, on any chain fomo reports a bag on. The tape's own chain is
 * read from the chain itself; everywhere else this is the only name available, and
 * without it a third of the bags are a hex string. Addresses come back in their own
 * case — checksummed, or base58 on Solana — so both sides are lowercased to match.
 */
export async function fetchNames(
  slug: string,
  tokens: string[],
): Promise<Map<string, { symbol: string; name: string | null }>> {
  const out = new Map<string, { symbol: string; name: string | null }>();

  for (const pair of await pairsOf(slug, tokens)) {
    const token = pair.baseToken?.address?.toLowerCase();
    const symbol = pair.baseToken?.symbol;
    if (!token || !symbol || out.has(token)) continue;
    out.set(token, { symbol, name: pair.baseToken?.name ?? null });
  }
  return out;
}
