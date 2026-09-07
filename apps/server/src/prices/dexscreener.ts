import type { Address } from "viem";
import { chainConfig } from "../config.ts";

const ENDPOINT = "https://api.dexscreener.com/tokens/v1";

/** The endpoint takes 30 addresses per call and allows 300 calls a minute. */
const PER_CALL = 30;
/**
 * Tokens quoted in one pass, across as many calls as that takes. The pass takes the stalest
 * first, so a token's round trip is the day's token count divided by this, times the interval
 * between passes; at 180 it costs 24 of the 300 calls a minute the endpoint allows.
 */
export const BATCH = 180;
/**
 * A feed that accepts the connection and then says nothing would otherwise hang the whole
 * pass: the tick awaits the quotes before it catches up, and inside a Durable Object a
 * promise that never settles is not interrupted by anything.
 */
const TIMEOUT_MS = 10_000;
/**
 * Under this much in the pool the quote is not a price: an almost-empty pool prices the last
 * dust that crossed it, at any number at all. A token below the floor is left unpriced,
 * which the tape already shows as a dash.
 */
export const MIN_LIQUIDITY = 1_000;

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

/** The whole card one call returns for a pool, not just the price. */
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
    // Unknown liquidity counts as none: the feed reports it for every pool that has any.
    if ((liquidity ?? 0) < MIN_LIQUIDITY) continue;
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
 * What a token is called, on any chain fomo reports a bag on. Addresses come back in their
 * own case — checksummed, or base58 on Solana — so both sides are lowercased to match.
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
