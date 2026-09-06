import type { Address } from "viem";
import { loadPrices, savePrice, setEstimate, stampSupply, tokensToPrice, unpricedFills } from "../db.ts";
import { log } from "../log.ts";
import { BATCH, fetchQuotes } from "./dexscreener.ts";
import { FLOATING, noteEthUsd } from "./eth.ts";

/** Last known USD price per token; `reconstruct` reads it to estimate legs no cash leg pays for. */
export const prices = loadPrices();

const DAY = 86_400;
/**
 * An estimate uses the price right now, so only recent fills qualify.
 * note: older unpriced fills stay unpriced until there is a historical price source.
 */
const ESTIMATE_MAX_AGE = 3_600;

/** One pass: quote the most stale tokens, then price the fills that were waiting. */
export async function refreshPrices(onRepriced: (txs: string[]) => void): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const wanted = tokensToPrice(now - DAY, BATCH - (FLOATING ? 1 : 0)) as Address[];
  // The floating quote token rides along whenever a call goes out anyway: the receipt
  // path prices WETH cash legs from it, and a quote it already has is a request it does
  // not make. An idle tape still makes no call at all.
  const tokens = wanted.length > 0 && FLOATING ? [FLOATING, ...wanted] : wanted;
  const quotes = await fetchQuotes(tokens);

  const touched = new Set<string>();
  for (const [token, quote] of quotes) {
    if (token === FLOATING) {
      noteEthUsd(quote.price);
      continue;
    }
    savePrice(token, quote, now);
    prices.set(token, quote.price);
    // A new pool trades before the feed has heard of it, so its first fills landed with no
    // supply to stamp. This is the other order the two can happen in.
    stampSupply(token, now - ESTIMATE_MAX_AGE);
    for (const fill of unpricedFills(token, now - ESTIMATE_MAX_AGE)) {
      setEstimate(fill.tx, fill.log_index, fill.amount * quote.price, quote.price);
      touched.add(fill.tx);
    }
  }
  if (touched.size > 0) onRepriced([...touched]);
}

/** DexScreener allows 300 calls a minute; one call every 15s uses 0.3% of that. */
export function startPrices(onRepriced: (txs: string[]) => void, seconds = 15): void {
  const tick = async () => {
    await refreshPrices(onRepriced).catch((error) => log.error("prices", error));
    setTimeout(tick, seconds * 1_000);
  };
  void tick();
}
