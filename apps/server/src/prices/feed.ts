import type { Address } from "viem";
import {
  loadPrices,
  MAX_POOL_AGE,
  refreshPositions,
  savePrice,
  setEstimate,
  stampSupply,
  tokensToPrice,
  unpricedByToken,
} from "../db.ts";
import { limits, ms } from "../limits.ts";
import { log } from "../log.ts";
import { BATCH, fetchQuotes } from "./dexscreener.ts";
import { FLOATING, noteEthUsd } from "./eth.ts";

/** Last known USD price per token; `reconstruct` reads it to estimate legs no cash leg pays for. */
export const prices = loadPrices();

/**
 * How long after its last fill a token is still worth re-marking. The discover page shows a
 * pool for MAX_POOL_AGE, and a card nothing refreshes freezes at the day the pool stopped
 * trading — which for a rug is the day it was still full.
 */
const MARK_MAX_AGE = MAX_POOL_AGE;
/**
 * An estimate uses the price right now, so only recent fills qualify.
 * note: older unpriced fills stay unpriced until there is a historical price source.
 */
const ESTIMATE_MAX_AGE = 3_600;

/** When the marks were last swept, so the pass in between only asks about what is owed a price. */
let sweptAt = 0;
/**
 * Marks one sweep chooses between, wider than one call on purpose. The stalest quotes belong
 * to the pools the feed has stopped answering for, and asking about one of those changes
 * nothing on its row — so a call filled by staleness alone is the same call every minute and
 * everything behind it is never quoted again.
 */
const CANDIDATES = 1_000;
/**
 * When each token was last asked about, in this object's memory rather than on its row: an
 * unanswered ask leaves no trace on the row, and a row written costs a thousand rows read.
 * Whose turn it is survives a restart no better than the quotes do, which is one wasted sweep.
 */
const askedAt = new Map<string, number>();

/** One pass: quote what is owed a price, sweep the stale marks on their own slower clock. */
export async function refreshPrices(onRepriced: (txs: string[]) => void): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - ESTIMATE_MAX_AGE;
  // The fills still owed a price, once for the whole window. Their tokens go first — a fill
  // with no dollars on it is the one thing a quote actually changes.
  const waiting = unpricedByToken(from);
  const room = BATCH - (FLOATING ? 1 : 0);
  const owed = [...waiting.keys()].slice(0, room);
  // The rest of the call is marks that have gone stale, and every one of them is a row
  // written. Sweeping them on a slower clock than the fills costs the marks their freshness
  // between sweeps and saves the writes of every pass in between; see feed.staleSweepSeconds.
  const sweeping = now - sweptAt >= limits.feed.staleSweepSeconds;
  if (sweeping) sweptAt = now;
  const stale = sweeping ? tokensToPrice(now - MARK_MAX_AGE, now - limits.feed.staleSweepSeconds, CANDIDATES) : [];
  // Longest unasked first, so a pool the feed has dropped takes its turn and no more.
  const queue = stale.filter((token) => !waiting.has(token));
  queue.sort((a, b) => (askedAt.get(a) ?? 0) - (askedAt.get(b) ?? 0));
  const wanted = [...owed, ...queue].slice(0, room) as Address[];
  for (const token of wanted) askedAt.set(token, now);
  // The candidates are everything a sweep may ask about, so anything else has stopped trading.
  // Not while they were cut short, when the ones left out are candidates the query never reached.
  if (sweeping && stale.length < CANDIDATES) {
    const live = new Set(stale);
    for (const token of askedAt.keys()) if (!live.has(token)) askedAt.delete(token);
  }
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
    stampSupply(token, from);
    const fills = waiting.get(token);
    for (const fill of fills ?? []) {
      setEstimate(fill.tx, fill.log_index, fill.amount * quote.price, quote.price);
      touched.add(fill.tx);
    }
    // A buy that had no dollars now has some, and a dusted one can have been pardoned: both
    // are what a position costs. Only when something moved — this runs every fifteen seconds.
    if (fills !== undefined && fills.length > 0) refreshPositions([token]);
  }
  if (touched.size > 0) onRepriced([...touched]);
}

/** DexScreener allows 300 calls a minute; one call every 15s uses 0.3% of that. */
export function startPrices(onRepriced: (txs: string[]) => void, seconds = limits.pace.quoteSeconds): void {
  const tick = async () => {
    await refreshPrices(onRepriced).catch((error) => log.error("prices", error));
    setTimeout(tick, ms(seconds));
  };
  void tick();
}
