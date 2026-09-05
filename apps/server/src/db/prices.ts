import { db } from "./connection.ts";

/**
 * The feed's card for every token the tape has traded: the price the screen marks
 * fills against, and the rest of what the same call carries. One row per token,
 * replaced on every quote. The tape joins it, and fills without a cash leg are priced from it.
 */
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
  /** Tokens traded recently, the ones with unpriced fills first, then the stalest quote. */
  toPrice: db.query<{ token: string }, [number, number]>(
    `SELECT f.token AS token
       FROM fills f LEFT JOIN prices p ON p.token = f.token
      WHERE f.ts >= ?
      GROUP BY f.token
      ORDER BY SUM(f.priced = 'unpriced') > 0 DESC, COALESCE(p.updated_at, 0) ASC
      LIMIT ?`,
  ),
  unpriced: db.query<{ tx: string; log_index: number; amount: number }, [string, number]>(
    "SELECT tx, log_index, amount FROM fills WHERE token = ? AND priced = 'unpriced' AND ts >= ?",
  ),
  setEstimate: db.query("UPDATE fills SET usd = ?, price = ?, priced = 'estimate' WHERE tx = ? AND log_index = ?"),
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
export const tokensToPrice = (sinceTs: number, limit: number) => stmt.toPrice.all(sinceTs, limit).map((r) => r.token);
export const unpricedFills = (token: string, sinceTs: number) => stmt.unpriced.all(token, sinceTs);
export const setEstimate = (tx: string, logIndex: number, usd: number, price: number) =>
  stmt.setEstimate.run(usd, price, tx, logIndex);
