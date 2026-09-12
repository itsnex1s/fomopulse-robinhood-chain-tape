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
/**
 * How old the feed's card may be and still describe the pool. A pool that rugs stops being
 * answered for rather than answered badly: the card keeps the depth, the day's volume and the
 * change the pool had the hour it emptied, and every one of those reads as a discovery. The
 * quote pass asks about a young pool every few minutes, so an hour of silence is the feed's
 * answer, not its queue.
 */
export const MAX_QUOTE_AGE = 3_600;
/**
 * Buys a pool has to have taken before no sell at all is a fact about the token rather than
 * about its age. A pool the feed reports dozens of entries and not one exit from is the shape
 * a honeypot leaves: the buy works for everyone and the sell works for nobody. Under this many
 * it is only early, and the page says nothing.
 */
export const HONEYPOT_BUYS = 10;
/**
 * Handouts per real fill, past which the token is pushing itself rather than being bought. A
 * launch that sprays the tracked wallets buys its way onto their tape: the page ranks on who
 * is in a token, and a thousand dustings next to twenty buys is what that ranking is being
 * played with. Counted off this tape's own dust verdict, not the feed's.
 */
export const MAX_SPRAY = 5;
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
  /**
   * The page: which young pools it shows and in what order. The ranking is who bought, so the
   * fills of every young pool are read here and nowhere else — everything a row carries beyond
   * that is asked of the page's own tokens below.
   *
   * Parameters: the oldest pool birth in milliseconds, the window start in seconds, the oldest
   * quote that still counts, the pool floor, the buys that make no exit mean something, the
   * churn ceiling and the row limit.
   */
  page: db.query<
    PageRow,
    { $born: number; $recent: number; $fresh: number; $pool: number; $exits: number; $churn: number; $limit: number }
  >(
    /* The pools are the small side of the join — a few hundred against the whole tape — and left
       to itself the planner walks the fills instead, which is every fill this tape holds read for
       a page about three days. MATERIALIZED and CROSS JOIN say so. */
    `WITH young AS MATERIALIZED (
       SELECT p.token AS token, p.price_usd AS price, p.updated_at AS quoted_at,
              p.liquidity_usd AS liquidity, p.change24 AS change24, p.volume24 AS volume24,
              p.buys24 AS buys24, p.sells24 AS sells24, p.market_cap AS market_cap,
              p.dex AS dex, p.image_url AS image_url,
              p.pair_created_at AS pair_created_at, p.pair_address AS pair_address
         FROM prices p
        WHERE p.pair_created_at IS NOT NULL AND p.pair_created_at >= $born
          AND p.updated_at >= $fresh
          AND p.liquidity_usd >= $pool
          /* Null is the feed not saying, which is not the same as a pool nobody got out of. */
          AND (p.sells24 IS NULL OR p.sells24 > 0 OR COALESCE(p.buys24, 0) < $exits)
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
         FROM young y CROSS JOIN fills f ON f.token = y.token
        GROUP BY f.token
     )
     SELECT y.token AS token, t.symbol AS symbol, t.name AS name, y.image_url AS image_url,
            y.price AS price, y.quoted_at AS quoted_at, y.liquidity AS liquidity,
            y.change24 AS change24, y.volume24 AS volume24, y.buys24 AS buys24,
            y.sells24 AS sells24, y.market_cap AS market_cap, y.dex AS dex,
            y.pair_created_at AS pair_created_at, y.pair_address AS pair_address,
            w.buyers AS buyers, w.buyers_recent AS buyers_recent, w.sellers AS sellers,
            w.fills AS fills, w.dusted AS dusted,
            w.bought_usd AS bought_usd, w.sold_usd AS sold_usd, w.last_fill_ts AS last_fill_ts
       FROM young y
       JOIN flow w ON w.token = y.token
       JOIN tokens t ON t.address = y.token
      WHERE w.buyers > 0 AND t.symbol IS NOT NULL
        AND w.dusted <= w.fills * ${MAX_SPRAY}
      ORDER BY w.buyers_recent DESC, w.buyers DESC, y.pair_created_at DESC
      LIMIT $limit`,
  ),
  /**
   * What a row carries beyond the ranking, for the page's own tokens by name: who is holding,
   * who opened it, how it stood an hour ago, what it was worth when the first tracked wallet
   * bought, and the buys that were cancelled minutes later. Each one is a seek apiece rather
   * than a pass over every young pool, which is what these cost before the page was known.
   */
  detail: db.query<DetailRow, [string, number, number]>(
    `SELECT w.value AS token,
            (SELECT COUNT(*) FROM positions po
              WHERE po.token = w.value AND po.amount > po.gross * ${RESIDUE}) AS holders,
            /* Several wallets bought in the same second often enough to matter — a bundle enters
               as one — so the tie is broken on the address rather than left to the query plan. */
            (SELECT po.wallet FROM positions po
              WHERE po.token = w.value AND po.first_buy_ts IS NOT NULL
              ORDER BY po.first_buy_ts, po.wallet LIMIT 1) AS first_buyer,
            (SELECT MIN(po.first_buy_ts) FROM positions po WHERE po.token = w.value) AS first_buy_ts,
            /* The chain is named as well as the token: it sits between them in the key, and
               without it the seek stops at the token and reads every hour it has been held. */
            (SELECT h.holders FROM bag_hours h
              WHERE h.token = w.value AND h.network = ?3 AND h.ts <= ?2
              ORDER BY h.ts DESC LIMIT 1) AS holders_then,
            /* What the token was worth when the first tracked wallet bought it: that fill's own
               price over the supply stamped on it, falling back to the supply the feed implies.
               Null where the fill had no cash leg and took the price of the quote still standing —
               that is the same number twice, and it reads as a token that has not moved. */
            (SELECT CASE WHEN f.priced = 'estimate' AND f.price = p.price_usd THEN NULL
                         ELSE f.price * COALESCE(f.supply, p.market_cap / NULLIF(p.price_usd, 0)) END
               FROM fills f
              WHERE f.token = w.value AND f.dust = 0 AND f.side = 'buy' AND f.price IS NOT NULL
              ORDER BY f.ts, f.log_index LIMIT 1) AS mcap_at,
            /* One wallet in and back out inside WASH_SECONDS at the same size, counted per token. */
            (SELECT COUNT(*) FROM fills a
               JOIN fills b ON b.wallet = a.wallet AND b.token = a.token
                           AND b.ts > a.ts AND b.ts <= a.ts + ${WASH_SECONDS}
              WHERE a.token = w.value AND a.dust = 0 AND b.dust = 0
                AND a.side = 'buy' AND b.side = 'sell'
                AND a.amount > 0 AND ABS(b.amount - a.amount) <= a.amount * ${WASH_TOLERANCE}) AS wash
       FROM json_each(?1) w
       LEFT JOIN prices p ON p.token = w.value`,
  ),
};

/** The ranking half of a row: the pool's card and what this tape saw happen in it. */
type PageRow = Omit<DiscoverRow, "holders" | "holders_then" | "first_buyer" | "first_buy_ts" | "mcap_at" | "wash">;
/** The half asked of the page's own tokens, once the page is known. */
type DetailRow = Pick<
  DiscoverRow,
  "token" | "holders" | "holders_then" | "first_buyer" | "first_buy_ts" | "mcap_at" | "wash"
>;

/** Young pools a tracked wallet has bought into, deepest cuts already applied. `recentTs` is
 *  what "just now" means for the page: the buyer count and the holder delta are read against it. */
export function discoverTokens(now: number, recentTs: number, limit: number, network: number): DiscoverRow[] {
  positionsReady();
  const page = stmt.page.all({
    $born: (now - MAX_POOL_AGE) * 1_000,
    $recent: recentTs,
    $fresh: now - MAX_QUOTE_AGE,
    $pool: MIN_POOL_USD,
    $exits: HONEYPOT_BUYS,
    $churn: MAX_CHURN,
    $limit: limit,
  });
  if (page.length === 0) return [];
  const detail = new Map(
    stmt.detail.all(JSON.stringify(page.map((row) => row.token)), recentTs, network).map((row) => [row.token, row]),
  );
  return page.map((row) => ({ ...row, ...detail.get(row.token)!, holders: detail.get(row.token)!.holders ?? 0 }));
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
