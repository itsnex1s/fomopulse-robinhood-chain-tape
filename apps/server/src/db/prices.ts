import { DUST_USD, DUSTED, TRADE } from "../ingest/reconstruct.ts";
import { MIN_LIQUIDITY } from "../prices/dexscreener.ts";
import { db } from "./connection.ts";

/** The feed's card for every token the tape has traded, one row per token, replaced on every quote. The tape
 *  joins it, and a fill with no cash leg is priced from it. */
const stmt = {
  savePrice: db.query(
    `INSERT INTO prices (token, price_usd, liquidity_usd, change24, pair_created_at, pair_address, updated_at,
                         change1h, change5m, volume24, buys24, sells24, market_cap, fdv, dex, image_url)
     VALUES ($token, $price, $liquidity, $change24, $pair_created_at, $pair, $at,
             $change1h, $change5m, $volume24, $buys24, $sells24, $market_cap, $fdv, $dex, $image_url)
     ON CONFLICT (token) DO UPDATE SET price_usd = excluded.price_usd, liquidity_usd = excluded.liquidity_usd,
       change24 = excluded.change24, pair_created_at = COALESCE(excluded.pair_created_at, prices.pair_created_at),
       pair_address = COALESCE(excluded.pair_address, prices.pair_address), updated_at = excluded.updated_at,
       change1h = excluded.change1h, change5m = excluded.change5m, volume24 = excluded.volume24,
       buys24 = excluded.buys24, sells24 = excluded.sells24, market_cap = excluded.market_cap, fdv = excluded.fdv,
       dex = COALESCE(excluded.dex, prices.dex), image_url = COALESCE(excluded.image_url, prices.image_url)`,
  ),
  allPrices: db.query<{ token: string; price_usd: number }, []>("SELECT token, price_usd FROM prices"),
  /** Quotes from a pool too shallow to have priced anything; see MIN_LIQUIDITY in dexscreener.ts. */
  dropThin: db.query("DELETE FROM prices WHERE COALESCE(liquidity_usd, 0) < ?"),
  /**
   * Quoted tokens whose quote is the stalest, of the ones this tape saw trade inside the
   * window. Read off `prices`, which holds one row per token this tape has ever priced — a few
   * hundred — and asks the fills only whether each of them traded, which stops at the first fill
   * it finds. Grouping the window's fills by token instead was a scan of every fill on the tape,
   * four times a minute, and the most expensive thing this object did.
   *
   * A token with no quote yet is not here and does not need to be: its own fills are unpriced,
   * and `unpricedByToken` puts those at the front of the same queue.
   *
   * The stalest go first. More tokens are eligible than one call can hold, and an unordered
   * limit stops at the same prefix of them every pass: the tail is then never quoted again and
   * its card freezes at whatever the pool looked like the day it stopped trading. Ordering a
   * few hundred rows once a sweep is the cheap half of that trade.
   */
  toPrice: db.query<{ token: string }, [number, number, number]>(
    `SELECT p.token AS token FROM prices p
      WHERE p.updated_at < ?1
        AND EXISTS (SELECT 1 FROM fills f WHERE f.token = p.token AND f.ts >= ?2)
      ORDER BY p.updated_at
      LIMIT ?3`,
  ),
  /** Every fill still owed a price, across the whole window at once: the quote pass has a
   *  hundred and eighty tokens in hand and wants the few of them this mentions, which is one
   *  read rather than one read per token. */
  unpriced: db.query<{ token: string; tx: string; log_index: number; amount: number }, [number]>(
    "SELECT token, tx, log_index, amount FROM fills WHERE priced = 'unpriced' AND ts >= ?",
  ),
  /** A fill priced after it landed was dusted with no value to judge, so the arriving price finishes that
   *  decision here. Only the value verdict is reversed: a handout is a verdict about shape, which a price
   *  says nothing about. */
  setEstimate: db.query(
    `UPDATE fills SET usd = ?, price = ?, priced = 'estimate',
       dust = CASE WHEN dust = ${DUSTED} AND ? >= ${DUST_USD} THEN ${TRADE} ELSE dust END
     WHERE tx = ? AND log_index = ?`,
  ),
};

/** A quote as the feed returns it: only the price is certain, the rest of the card is optional. */
export interface StoredQuote {
  price: number;
  liquidity: number | null;
  change24: number | null;
  pairCreatedAt: number | null;
  pair: string | null;
  change1h?: number | null;
  change5m?: number | null;
  volume24?: number | null;
  buys24?: number | null;
  sells24?: number | null;
  marketCap?: number | null;
  fdv?: number | null;
  dex?: string | null;
  imageUrl?: string | null;
}

export const savePrice = (token: string, q: StoredQuote, at: number) =>
  stmt.savePrice.run({
    $token: token,
    $price: q.price,
    $liquidity: q.liquidity,
    $change24: q.change24,
    $pair_created_at: q.pairCreatedAt,
    $pair: q.pair,
    $at: at,
    $change1h: q.change1h ?? null,
    $change5m: q.change5m ?? null,
    $volume24: q.volume24 ?? null,
    $buys24: q.buys24 ?? null,
    $sells24: q.sells24 ?? null,
    $market_cap: q.marketCap ?? null,
    $fdv: q.fdv ?? null,
    $dex: q.dex ?? null,
    $image_url: q.imageUrl ?? null,
  });
export const loadPrices = () => new Map(stmt.allPrices.all().map((r) => [r.token, r.price_usd]));
/** Drops the quotes no fill should ever have been priced from, and says how many went. */
export const dropThinPrices = (floor = MIN_LIQUIDITY): number => stmt.dropThin.run(floor).changes;
/** Quoted tokens that traded since `sinceTs` and were last quoted before `staleBefore`. */
export const tokensToPrice = (sinceTs: number, staleBefore: number, limit: number) =>
  stmt.toPrice.all(staleBefore, sinceTs, limit).map((r) => r.token);
/** The fills of the window that no price has reached, by token. */
export function unpricedByToken(sinceTs: number): Map<string, { tx: string; log_index: number; amount: number }[]> {
  const waiting = new Map<string, { tx: string; log_index: number; amount: number }[]>();
  for (const row of stmt.unpriced.all(sinceTs)) {
    const list = waiting.get(row.token);
    if (list === undefined) waiting.set(row.token, [row]);
    else list.push(row);
  }
  return waiting;
}

/** Writes to a fill, so the caller owes `refreshPositions` for its token afterwards: what a
 *  buy cost is a position column, and this is the statement that gives an unpriced buy a cost. */
export const setEstimate = (tx: string, logIndex: number, usd: number, price: number) =>
  stmt.setEstimate.run(usd, price, usd, tx, logIndex);
