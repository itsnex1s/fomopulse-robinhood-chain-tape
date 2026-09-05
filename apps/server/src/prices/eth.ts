import type { Address } from "viem";
import { QUOTE_TOKENS } from "../config.ts";
import { fetchQuotes } from "./dexscreener.ts";

/** The quote token without a fixed dollar value — WETH — is priced through the same feed as everything else. */
export const FLOATING: Address | undefined = [...QUOTE_TOKENS.entries()].find(([, q]) => q.usd === undefined)?.[0];
const TTL_MS = 60_000;

let cached: { at: number; usd?: number } = { at: 0 };

/** The price feed hands the floating token's quote over as it comes in, so the receipt path rarely has to ask. */
export const noteEthUsd = (usd: number): void => {
  cached = { at: Date.now(), usd };
};

/**
 * Dollar price of the floating quote token, at most a minute old. A failed lookup
 * keeps the last price for another minute; with none at all, WETH cash legs are
 * left to the feed rather than guessed.
 */
export async function ethUsd(): Promise<number | undefined> {
  if (!FLOATING) return undefined;
  if (Date.now() - cached.at < TTL_MS) return cached.usd;
  const usd = await fetchQuotes([FLOATING])
    .then((quotes) => quotes.get(FLOATING)?.price)
    .catch(() => undefined);
  cached = { at: Date.now(), usd: usd ?? cached.usd };
  return cached.usd;
}
