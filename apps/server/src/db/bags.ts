import type { Bag } from "../api/types.ts";
import { db } from "./connection.ts";
import { getMeta, setMeta } from "./meta.ts";

/** What the tracked traders are sitting in, by token: net positions off this tape's fills,
 *  the feed's quote against them, and the token's flow inside the window. */
const stmt = {
  /** One row per token per hour, so a window can be compared against its own start.
   *  Stamped on the hour with OR IGNORE: a job on any clock still leaves one row an hour. */
  recordBagHistory: db.query(
    `WITH pos AS (
       SELECT wallet, token,
         SUM(CASE WHEN side = 'buy' THEN amount ELSE -amount END) AS amount,
         SUM(CASE WHEN side = 'buy' AND usd IS NOT NULL THEN usd ELSE 0 END) AS bought_usd,
         SUM(CASE WHEN side = 'buy' AND usd IS NOT NULL THEN amount ELSE 0 END) AS bought_amount
         FROM fills WHERE dust = 0 GROUP BY wallet, token
     )
     INSERT OR IGNORE INTO bag_hours (token, network, ts, holders, value, pnl)
     SELECT pos.token, ?2, ?1, COUNT(*), SUM(pos.amount * p.price_usd),
            SUM(CASE WHEN pos.bought_amount > 0
                     THEN pos.amount * (p.price_usd - pos.bought_usd / pos.bought_amount) END)
       FROM pos JOIN prices p ON p.token = pos.token
      WHERE pos.amount > 0
      GROUP BY pos.token`,
  ),
  pruneBagHistory: db.query("DELETE FROM bag_hours WHERE ts < ?"),
  /** Held tokens still without a name, largest bag first, for the chain to be asked about. */
  unnamedBags: db.query<{ token: string }, [number]>(
    `WITH pos AS (
       SELECT wallet, token, SUM(CASE WHEN side = 'buy' THEN amount ELSE -amount END) AS amount
         FROM fills WHERE dust = 0 GROUP BY wallet, token
     )
     SELECT pos.token AS token FROM pos
       LEFT JOIN tokens t ON t.address = pos.token
       LEFT JOIN prices p ON p.token = pos.token
      WHERE pos.amount > 0 AND t.symbol IS NULL
      GROUP BY pos.token
      ORDER BY SUM(pos.amount) * COALESCE(MAX(p.price_usd), 0) DESC
      LIMIT ?1`,
  ),
  /** Tokens a tracked wallet is still long, with the age of their quote, so the feed knows
   *  what to mark. Neither ordered nor bounded: the caller does both. */
  tapeTokens: db.query<{ token: string; quoted_at: number | null }, []>(
    `WITH pos AS (
       SELECT token, SUM(CASE WHEN side = 'buy' THEN amount ELSE -amount END) AS amount
         FROM fills WHERE dust = 0 GROUP BY wallet, token
     )
     SELECT x.token AS token, p.updated_at AS quoted_at
       FROM (SELECT DISTINCT token FROM pos WHERE amount > 0) x
       LEFT JOIN prices p ON p.token = x.token`,
  ),
  /** Positions read off our own tape, counting only wallets still long: a sale of tokens bought before the
   *  tape began nets negative and would hide what the others hold. `pnl` is average cost across the priced
   *  buys, no lot accounting. The window bounds the flow columns only. Parameters: window start, row limit. */
  tapeBags: db.query<BagRow, [number, number]>(
    `WITH pos AS (
       SELECT wallet, token,
         SUM(CASE WHEN side = 'buy' THEN amount ELSE -amount END) AS amount,
         SUM(CASE WHEN side = 'buy' AND usd IS NOT NULL THEN usd ELSE 0 END) AS bought_usd,
         SUM(CASE WHEN side = 'buy' AND usd IS NOT NULL THEN amount ELSE 0 END) AS bought_amount
         FROM fills WHERE dust = 0 GROUP BY wallet, token
     ),
     bag AS (
       SELECT token, COUNT(*) AS holders, SUM(amount) AS amount,
              SUM(bought_usd) AS bought_usd, SUM(bought_amount) AS bought_amount
         FROM pos WHERE amount > 0 GROUP BY token
     ),
     top AS (
       SELECT token, MAX(amount) AS amount, wallet AS holder FROM pos WHERE amount > 0 GROUP BY token
     ),
     flow AS (
       SELECT token, COUNT(*) AS fills, COALESCE(SUM(side = 'buy'), 0) AS buys,
              COALESCE(SUM(CASE WHEN side = 'buy' THEN usd END), 0) AS bought_usd,
              COALESCE(SUM(CASE WHEN side = 'sell' THEN usd END), 0) AS sold_usd,
              COUNT(DISTINCT wallet) AS traders_in
         FROM fills WHERE dust = 0 AND ts >= ?1 GROUP BY token
     ),
     life AS (
       SELECT token, MAX(ts) AS last_fill_ts FROM fills WHERE dust = 0 GROUP BY token
     ),
     opened AS (
       SELECT token, MIN(ts) AS first_buy_ts, wallet AS first_buyer
         FROM fills WHERE dust = 0 AND side = 'buy' GROUP BY token
     ),
     shown AS (
       SELECT token FROM bag
       UNION
       SELECT token FROM flow
     )
     SELECT s.token AS token, p.image_url AS image_url,
            t.symbol AS symbol, t.name AS name,
            COALESCE(b.holders, 0) AS holders, COALESCE(b.amount, 0) AS amount,
            b.amount * p.price_usd AS value,
            CASE WHEN b.amount > 0 AND p.price_usd IS NOT NULL AND b.bought_amount > 0
              THEN b.amount * (p.price_usd - b.bought_usd / b.bought_amount) END AS pnl,
            tp.amount * p.price_usd AS top_value,
            p.price_usd AS price, p.updated_at AS quoted_at,
            p.liquidity_usd AS liquidity, p.change24 AS change24,
            p.pair_created_at AS pair_created_at, p.pair_address AS pair_address,
            l.last_fill_ts AS updated_at,
            tp.holder AS top_holder,
            COALESCE(w.fills, 0) AS fills, COALESCE(w.buys, 0) AS buys,
            COALESCE(w.bought_usd, 0) AS bought_usd, COALESCE(w.sold_usd, 0) AS sold_usd,
            COALESCE(w.traders_in, 0) AS traders_in,
            l.last_fill_ts AS last_fill_ts,
            o.first_buyer AS first_buyer, o.first_buy_ts AS first_buy_ts,
            (SELECT y.holders FROM bag_hours y
              WHERE y.token = s.token AND y.ts <= ?1 ORDER BY y.ts DESC LIMIT 1) AS holders_then,
            (SELECT y.value FROM bag_hours y
              WHERE y.token = s.token AND y.ts <= ?1 ORDER BY y.ts DESC LIMIT 1) AS value_then
       FROM shown s
       LEFT JOIN bag b ON b.token = s.token
       LEFT JOIN tokens t ON t.address = s.token
       LEFT JOIN prices p ON p.token = s.token
       LEFT JOIN top tp ON tp.token = s.token
       LEFT JOIN flow w ON w.token = s.token
       LEFT JOIN life l ON l.token = s.token
       LEFT JOIN opened o ON o.token = s.token
      ORDER BY value DESC
      LIMIT ?2`,
  ),
};

/** What the bag query returns: the API's bag, less what the server adds on top.
 *  `first_buyer` and `top_holder` are still wallets here; the server makes them handles. */
export type BagRow = Omit<Bag, "is_stock" | "holders_list">;

/** Tokens the tracked wallets hold or moved lately: position columns from net fills, flow
 *  columns from the window. */
export const tapeBags = (sinceTs: number, limit: number): BagRow[] => stmt.tapeBags.all(sinceTs, limit);
export const tapeTokens = () => stmt.tapeTokens.all();

/** One bag's largest holders, as the screen lists them under the row. */
export interface Holder {
  wallet: string;
  value: number | null;
}

/**
 * The net-long wallets of a whole page of bags, largest position first, in one query: the
 * tokens are all known before the first of them is needed. Within a token the price is one
 * number, so ordering by amount held is ordering by what it is worth. The IN list varies
 * only by page size, so the connection caches a handful of prepared shapes.
 */
export function tapeHolders(tokens: string[], per = 8): Map<string, Holder[]> {
  const held = new Map<string, Holder[]>();
  if (tokens.length === 0) return held;
  const rows = db
    .query<{ token: string; wallet: string; value: number | null }, (string | number)[]>(
      `WITH pos AS (
         SELECT token, wallet, SUM(CASE WHEN side = 'buy' THEN amount ELSE -amount END) AS amount
           FROM fills WHERE dust = 0 AND token IN (${tokens.map(() => "?").join(", ")})
          GROUP BY token, wallet
       ),
       ranked AS (
         SELECT token, wallet, amount,
                ROW_NUMBER() OVER (PARTITION BY token ORDER BY amount DESC) AS place
           FROM pos WHERE amount > 0
       )
       SELECT r.token AS token, r.wallet AS wallet, r.amount * p.price_usd AS value
         FROM ranked r LEFT JOIN prices p ON p.token = r.token
        WHERE r.place <= ?
        ORDER BY r.token, r.place`,
    )
    .all(...tokens, per);
  for (const row of rows) {
    const list = held.get(row.token);
    if (list === undefined) held.set(row.token, [{ wallet: row.wallet, value: row.value }]);
    else list.push({ wallet: row.wallet, value: row.value });
  }
  return held;
}

export const unnamedBags = (limit: number) => stmt.unnamedBags.all(limit).map((row) => row.token);

/** The hour the last snapshot was taken for, so a pass that is not the first of its hour is free. */
const BAG_HOUR = "bags:hour";

/**
 * The hour's snapshot of every marked bag, and the history past the longest window let go:
 * a month and a day, since the widest window a page offers is thirty days. The reading
 * behind it is a grouped pass over every fill, so the hour it last wrote is kept in `meta`
 * and a call that is not the first of its hour costs one row.
 */
export function recordBagHistory(at: number, network: number): boolean {
  const hour = at - (at % 3_600);
  if (getMeta(BAG_HOUR) === `${hour}`) return false;
  db.transaction(() => {
    stmt.recordBagHistory.run(hour, network);
    stmt.pruneBagHistory.run(at - 31 * 86_400);
    setMeta(BAG_HOUR, hour);
  })();
  return true;
}
