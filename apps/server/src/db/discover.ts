import { PER_QUERY, RESIDUE } from "./bags.ts";
import { db } from "./connection.ts";
import { positionsReady } from "./positions.ts";

/**
 * New tokens the tracked wallets are buying: one row per pool young enough to still be a
 * discovery, with what this tape saw happen in it. The cuts below are the page's meaning
 * rather than its cost, so they live here beside the query and not in config/limits.json.
 */

/** How young a pool has to be to belong on the page at all. */
export const MAX_POOL_AGE = 3 * 86_400;
/**
 * A pool shallower than this is not a market. Measured over the tape's own first days: of
 * the young pools under it, the median token sat at a ninth of the market cap the first
 * tracked wallet paid, and four in five were down.
 */
export const MIN_POOL_USD = 10_000;
/** Day's volume over pool depth, past which the volume is not the market's: a pool turning
 *  over twenty times its own depth in a day is the shape wash trading leaves behind. */
export const MAX_CHURN = 20;
/** A buy and a sell by one wallet this close together and this near the same size cancel:
 *  nothing moved and the tape carries the volume anyway. Counted, never hidden here. */
const WASH_SECONDS = 300;
const WASH_TOLERANCE = 0.05;

/** What the discover query returns; the server turns wallets into handles and adds the rest. */
export interface DiscoverRow {
  token: string;
  symbol: string | null;
  name: string | null;
  image_url: string | null;
  price: number | null;
  quoted_at: number | null;
  liquidity: number | null;
  change24: number | null;
  volume24: number | null;
  buys24: number | null;
  sells24: number | null;
  market_cap: number | null;
  dex: string | null;
  pair_created_at: number | null;
  pair_address: string | null;
  buyers: number;
  buyers_recent: number;
  sellers: number;
  fills: number;
  dusted: number;
  bought_usd: number;
  sold_usd: number;
  last_fill_ts: number | null;
  holders: number;
  holders_then: number | null;
  first_buyer: string | null;
  first_buy_ts: number | null;
  mcap_at: number | null;
  wash: number;
}

const stmt = {
  /** Parameters: the oldest pool birth in milliseconds, the window start in seconds, the pool
   *  floor, the churn ceiling and the row limit. */
  discover: db.query<DiscoverRow, { $born: number; $recent: number; $pool: number; $churn: number; $limit: number }>(
    `WITH young AS (
       SELECT p.token AS token, p.price_usd AS price, p.updated_at AS quoted_at,
              p.liquidity_usd AS liquidity, p.change24 AS change24, p.volume24 AS volume24,
              p.buys24 AS buys24, p.sells24 AS sells24, p.market_cap AS market_cap,
              p.dex AS dex, p.image_url AS image_url,
              p.pair_created_at AS pair_created_at, p.pair_address AS pair_address
         FROM prices p
        WHERE p.pair_created_at IS NOT NULL AND p.pair_created_at >= $born
          AND p.liquidity_usd >= $pool
          AND (p.volume24 IS NULL OR p.volume24 <= p.liquidity_usd * $churn)
     ),
     flow AS (
       SELECT f.token AS token,
              COALESCE(SUM(f.dust = 0), 0) AS fills,
              COALESCE(SUM(f.dust != 0), 0) AS dusted,
              COUNT(DISTINCT CASE WHEN f.dust = 0 AND f.side = 'buy' THEN f.wallet END) AS buyers,
              COUNT(DISTINCT CASE WHEN f.dust = 0 AND f.side = 'buy' AND f.ts >= $recent
                                  THEN f.wallet END) AS buyers_recent,
              COUNT(DISTINCT CASE WHEN f.dust = 0 AND f.side = 'sell' THEN f.wallet END) AS sellers,
              COALESCE(SUM(CASE WHEN f.dust = 0 AND f.side = 'buy' THEN f.usd END), 0) AS bought_usd,
              COALESCE(SUM(CASE WHEN f.dust = 0 AND f.side = 'sell' THEN f.usd END), 0) AS sold_usd,
              MAX(CASE WHEN f.dust = 0 THEN f.ts END) AS last_fill_ts
         FROM fills f JOIN young y ON y.token = f.token
        GROUP BY f.token
     ),
     bag AS (
       SELECT p.token AS token, COUNT(*) AS holders
         FROM positions p JOIN young y ON y.token = p.token
        WHERE p.amount > p.gross * ${RESIDUE}
        GROUP BY p.token
     ),
     /* Several wallets bought in the same second often enough to matter — a bundle enters
        as one — so the tie is broken on the address rather than left to the query plan. */
     opened AS (
       SELECT token, first_buy_ts, wallet AS first_buyer FROM (
         SELECT p.token AS token, p.first_buy_ts AS first_buy_ts, p.wallet AS wallet,
                ROW_NUMBER() OVER (PARTITION BY p.token ORDER BY p.first_buy_ts, p.wallet) AS place
           FROM positions p JOIN young y ON y.token = p.token
          WHERE p.first_buy_ts IS NOT NULL
       ) WHERE place = 1
     ),
     /* One wallet in and back out inside WASH_SECONDS at the same size, counted per token. */
     washed AS (
       SELECT a.token AS token, COUNT(*) AS flips
         FROM fills a
         JOIN young y ON y.token = a.token
         JOIN fills b ON b.wallet = a.wallet AND b.token = a.token
                     AND b.ts > a.ts AND b.ts <= a.ts + ${WASH_SECONDS}
        WHERE a.dust = 0 AND b.dust = 0 AND a.side = 'buy' AND b.side = 'sell'
          AND a.amount > 0 AND ABS(b.amount - a.amount) <= a.amount * ${WASH_TOLERANCE}
        GROUP BY a.token
     )
     SELECT y.token AS token, t.symbol AS symbol, t.name AS name, y.image_url AS image_url,
            y.price AS price, y.quoted_at AS quoted_at, y.liquidity AS liquidity,
            y.change24 AS change24, y.volume24 AS volume24, y.buys24 AS buys24,
            y.sells24 AS sells24, y.market_cap AS market_cap, y.dex AS dex,
            y.pair_created_at AS pair_created_at, y.pair_address AS pair_address,
            w.buyers AS buyers, w.buyers_recent AS buyers_recent, w.sellers AS sellers,
            w.fills AS fills, w.dusted AS dusted,
            w.bought_usd AS bought_usd, w.sold_usd AS sold_usd, w.last_fill_ts AS last_fill_ts,
            COALESCE(b.holders, 0) AS holders,
            (SELECT h.holders FROM bag_hours h
              WHERE h.token = y.token AND h.ts <= $recent ORDER BY h.ts DESC LIMIT 1) AS holders_then,
            o.first_buyer AS first_buyer, o.first_buy_ts AS first_buy_ts,
            /* What the token was worth when the first tracked wallet bought it: that fill's own
               price over the supply stamped on it, falling back to the supply the feed implies.
               Null where the fill had no cash leg and took the price of the quote still standing —
               that is the same number twice, and it reads as a token that has not moved. */
            (SELECT CASE WHEN f.priced = 'estimate' AND f.price = y.price THEN NULL
                         ELSE f.price * COALESCE(f.supply, y.market_cap / NULLIF(y.price, 0)) END
               FROM fills f
              WHERE f.token = y.token AND f.dust = 0 AND f.side = 'buy' AND f.price IS NOT NULL
              ORDER BY f.ts, f.log_index LIMIT 1) AS mcap_at,
            COALESCE(sh.flips, 0) AS wash
       FROM young y
       JOIN flow w ON w.token = y.token
       JOIN tokens t ON t.address = y.token
       LEFT JOIN bag b ON b.token = y.token
       LEFT JOIN opened o ON o.token = y.token
       LEFT JOIN washed sh ON sh.token = y.token
      WHERE w.buyers > 0 AND t.symbol IS NOT NULL
      ORDER BY w.buyers_recent DESC, w.buyers DESC, y.pair_created_at DESC
      LIMIT $limit`,
  ),
};

/** Young pools a tracked wallet has bought into, deepest cuts already applied. `recentTs` is
 *  what "just now" means for the page: the buyer count and the holder delta are read against it. */
export function discoverTokens(now: number, recentTs: number, limit: number): DiscoverRow[] {
  positionsReady();
  return stmt.discover.all({
    $born: (now - MAX_POOL_AGE) * 1_000,
    $recent: recentTs,
    $pool: MIN_POOL_USD,
    $churn: MAX_CHURN,
    $limit: limit,
  });
}

/** One wallet's entry into a token: when it first bought, and what it has put in since. */
export interface Buyer {
  wallet: string;
  ts: number;
  usd: number | null;
}

/**
 * Who bought a whole page of tokens, earliest first. The tokens are all known before the
 * first of them is needed, so they go together — and the page ranks its rows by who is in
 * them, which needs every buyer rather than the largest few.
 */
export function discoverBuyers(tokens: string[]): Map<string, Buyer[]> {
  const bought = new Map<string, Buyer[]>();
  for (let from = 0; from < tokens.length; from += PER_QUERY) {
    const batch = tokens.slice(from, from + PER_QUERY);
    const rows = db
      .query<{ token: string; wallet: string; ts: number; usd: number | null }, string[]>(
        `SELECT token, wallet, MIN(ts) AS ts, SUM(usd) AS usd
           FROM fills
          WHERE token IN (${batch.map(() => "?").join(", ")}) AND dust = 0 AND side = 'buy'
          GROUP BY token, wallet
          ORDER BY token, ts`,
      )
      .all(...batch);
    for (const row of rows) {
      const list = bought.get(row.token);
      const buyer = { wallet: row.wallet, ts: row.ts, usd: row.usd };
      if (list === undefined) bought.set(row.token, [buyer]);
      else list.push(buyer);
    }
  }
  return bought;
}
