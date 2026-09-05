import type { Bag } from "../api/types.ts";
import { db } from "./connection.ts";
import type { StoredQuote } from "./prices.ts";

/**
 * What the tracked traders are sitting in, by token: fomo's numbers over the three
 * positions it publishes per trader, the feed's live quote, what the token did on this
 * tape inside the window, and how the bag has moved since the window opened. Names and
 * quotes for chains this tape does not follow sit beside the bag; every refresh takes
 * a snapshot, so the screen can say whether traders are piling in or leaving.
 */
const stmt = {
  /**
   * One row per token: how many tracked traders hold it and what it is worth to them
   * (fomo's numbers), the feed's live quote for it, what it did on this tape inside the
   * window (ours), and how the bag has moved since the window opened (from bag_history).
   * Parameters: the chain we follow, the start of the window, how many rows.
   */
  bags: db.query<BagRow, [number, number, number]>(
    `SELECT h.token AS token, h.network AS network, MAX(h.image_url) AS image_url,
            COALESCE(t.symbol, b.symbol) AS symbol, COALESCE(t.name, b.name) AS name,
            COUNT(*) AS holders, SUM(h.value) AS value, SUM(h.pnl) AS pnl, MAX(h.value) AS top_value,
            SUM(h.amount) AS amount,
            COALESCE(p.price_usd, b.price, MAX(h.price)) AS price,
            COALESCE(p.updated_at, b.quoted_at) AS quoted_at,
            COALESCE(p.liquidity_usd, b.liquidity) AS liquidity,
            COALESCE(p.change24, b.change24) AS change24,
            COALESCE(p.pair_created_at, b.pair_created_at) AS pair_created_at,
            COALESCE(p.pair_address, b.pair_address) AS pair_address,
            MAX(h.updated_at) AS updated_at,
            (SELECT handle FROM holdings x WHERE x.token = h.token AND x.network = h.network
              ORDER BY x.value DESC LIMIT 1) AS top_holder,
            COALESCE(w.fills, 0) AS fills, COALESCE(w.buys, 0) AS buys,
            COALESCE(w.bought_usd, 0) AS bought_usd, COALESCE(w.sold_usd, 0) AS sold_usd,
            COALESCE(w.traders_in, 0) AS traders_in,
            l.last_fill_ts AS last_fill_ts,
            o.first_buyer AS first_buyer, o.first_buy_ts AS first_buy_ts,
            (SELECT y.holders FROM bag_history y
              WHERE y.token = h.token AND y.network = h.network AND y.ts <= ?2 ORDER BY y.ts DESC LIMIT 1) AS holders_then,
            (SELECT y.value FROM bag_history y
              WHERE y.token = h.token AND y.network = h.network AND y.ts <= ?2 ORDER BY y.ts DESC LIMIT 1) AS value_then
       FROM holdings h
       LEFT JOIN tokens t ON t.address = h.token AND h.network = ?1
       LEFT JOIN bag_tokens b ON b.token = h.token AND b.network = h.network
       LEFT JOIN prices p ON p.token = h.token AND h.network = ?1
       LEFT JOIN (SELECT token, COUNT(*) AS fills, COALESCE(SUM(side = 'buy'), 0) AS buys,
                         COALESCE(SUM(CASE WHEN side = 'buy' THEN usd END), 0) AS bought_usd,
                         COALESCE(SUM(CASE WHEN side = 'sell' THEN usd END), 0) AS sold_usd,
                         COUNT(DISTINCT wallet) AS traders_in
                    FROM fills WHERE dust = 0 AND ts >= ?2 GROUP BY token) w
         ON w.token = h.token AND h.network = ?1
       LEFT JOIN (SELECT token, MAX(ts) AS last_fill_ts FROM fills WHERE dust = 0 GROUP BY token) l
         ON l.token = h.token AND h.network = ?1
       -- One MIN and a bare column beside it: SQLite answers that column from the row the
       -- MIN came from, which is the first buy and the wallet that made it, in one pass.
       LEFT JOIN (SELECT token, MIN(ts) AS first_buy_ts, wallet AS first_buyer
                    FROM fills WHERE dust = 0 AND side = 'buy' GROUP BY token) o
         ON o.token = h.token AND h.network = ?1
      GROUP BY h.token, h.network
      ORDER BY value DESC
      LIMIT ?3`,
  ),
  /** Names never overwrite a quote and a quote never overwrites a name: two writers, one row. */
  saveBagToken: db.query(
    `INSERT INTO bag_tokens (token, network, symbol, name, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (token, network) DO UPDATE SET symbol = excluded.symbol, name = excluded.name,
       updated_at = excluded.updated_at`,
  ),
  saveBagQuote: db.query(
    `INSERT INTO bag_tokens (token, network, updated_at, price, liquidity, change24, pair_created_at, pair_address, quoted_at)
     VALUES (?1, ?2, ?9, ?3, ?4, ?5, ?6, ?7, ?9)
     ON CONFLICT (token, network) DO UPDATE SET price = excluded.price, liquidity = excluded.liquidity,
       change24 = excluded.change24, pair_created_at = COALESCE(excluded.pair_created_at, bag_tokens.pair_created_at),
       pair_address = COALESCE(excluded.pair_address, bag_tokens.pair_address), quoted_at = excluded.quoted_at`,
  ),
  /**
   * Held tokens by chain, each with the age of its quote — the feed's for the tracked
   * chain, the one kept beside the bag elsewhere — so the stalest can go first.
   * Parameter: the chain we follow.
   */
  heldTokens: db.query<{ token: string; network: number; quoted_at: number | null }, [number]>(
    `SELECT h.token AS token, h.network AS network, COALESCE(MAX(p.updated_at), MAX(b.quoted_at)) AS quoted_at
       FROM holdings h
       LEFT JOIN prices p ON p.token = h.token AND h.network = ?1
       LEFT JOIN bag_tokens b ON b.token = h.token AND b.network = h.network
      GROUP BY h.token, h.network`,
  ),
  recordBagHistory: db.query(
    `INSERT OR IGNORE INTO bag_history (token, network, ts, holders, value, pnl)
     SELECT token, network, ?, COUNT(*), SUM(value), SUM(pnl) FROM holdings GROUP BY token, network`,
  ),
  pruneBagHistory: db.query("DELETE FROM bag_history WHERE ts < ?"),
  /** Held tokens still without a name, newest bag first, for the feed to look up. */
  unnamedBags: db.query<{ token: string; network: number }, [number, number]>(
    `SELECT h.token AS token, h.network AS network
       FROM holdings h
       LEFT JOIN tokens t ON t.address = h.token AND h.network = ?1
       LEFT JOIN bag_tokens b ON b.token = h.token AND b.network = h.network
      WHERE COALESCE(t.symbol, b.symbol) IS NULL
      GROUP BY h.token, h.network
      ORDER BY SUM(h.value) DESC
      LIMIT ?2`,
  ),
  holdersOf: db.query<{ handle: string; value: number; pnl: number | null }, [string, number]>(
    "SELECT handle, value, pnl FROM holdings WHERE token = ? AND network = ? ORDER BY value DESC LIMIT 8",
  ),
  /**
   * Tokens a tracked wallet is still long on this tape, with the age of their quote, for
   * the feed to mark when there are no holdings to read a position off. The caller sorts
   * the stalest first and keeps thirty, so nothing here is ordered or bounded twice.
   */
  tapeTokens: db.query<{ token: string; quoted_at: number | null }, []>(
    `WITH pos AS (
       SELECT token, SUM(CASE WHEN side = 'buy' THEN amount ELSE -amount END) AS amount
         FROM fills WHERE dust = 0 GROUP BY wallet, token
     )
     SELECT x.token AS token, p.updated_at AS quoted_at
       FROM (SELECT DISTINCT token FROM pos WHERE amount > 0) x
       LEFT JOIN prices p ON p.token = x.token`,
  ),
  /**
   * Positions read off our own tape: net tokens per tracked wallet, dusting left out,
   * and only the wallets still long — a sale of tokens bought before the tape began is
   * a negative position, and netting it against the others hid what they hold. `holders`
   * counts those wallets, `amount` is what they hold together, and `value`/`top_value`
   * mark it at the feed's price — null until the feed has quoted it. `pnl` is value less
   * the cost of what is held, at the average price paid across the buys that carry a
   * dollar amount; an approximation (no lot accounting), but measured, not published.
   * A token nobody is long any more still shows while it traded inside the window. The
   * window only bounds the flow columns; the position itself is over the whole tape.
   * Each aggregate is one grouped pass over the fills, joined by token, rather than a
   * subselect per token per row. Parameters: the start of the window, how many rows.
   */
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
            NULL AS holders_then, NULL AS value_then
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
  /** Net-long wallets of a token, largest position first, for a tape bag's holders. */
  tapeHolders: db.query<{ wallet: string; value: number | null }, [string, number]>(
    `SELECT wallet,
            SUM(CASE WHEN side = 'buy' THEN amount ELSE -amount END)
              * (SELECT price_usd FROM prices p WHERE p.token = fills.token) AS value
       FROM fills WHERE token = ? AND dust = 0
       GROUP BY wallet HAVING SUM(CASE WHEN side = 'buy' THEN amount ELSE -amount END) > 0
       ORDER BY value DESC LIMIT ?`,
  ),
};

/**
 * What the bags queries return: the API's bag, less what the server adds on top — which
 * source measured it, whether the token is a stock, and the holders with their avatars.
 * `first_buyer` is still the wallet here; the server turns it into a handle.
 */
export type BagRow = Omit<Bag, "source" | "is_stock" | "holders_list">;

export const bags = (chainId: number, sinceTs: number, limit: number): BagRow[] =>
  stmt.bags.all(chainId, sinceTs, limit);
export const holdersOf = (token: string, network: number) => stmt.holdersOf.all(token, network);
/**
 * Tokens the tracked wallets hold or moved lately, read off the tape instead of fomo:
 * the position columns come from net fills, the flow columns from the window.
 */
export const tapeBags = (sinceTs: number, limit: number): BagRow[] => stmt.tapeBags.all(sinceTs, limit);
export const tapeHolders = (token: string, limit = 8) => stmt.tapeHolders.all(token, limit);
export const tapeTokens = () => stmt.tapeTokens.all();
export const unnamedBags = (chainId: number, limit: number) => stmt.unnamedBags.all(chainId, limit);
export const saveBagToken = (token: string, network: number, symbol: string, name: string | null, at: number) =>
  stmt.saveBagToken.run(token, network, symbol, name, at);
export const heldTokens = (chainId: number) => stmt.heldTokens.all(chainId);
export const saveBagQuote = (token: string, network: number, q: StoredQuote, at: number) =>
  stmt.saveBagQuote.run(token, network, q.price, q.liquidity, q.change24, q.pairCreatedAt, q.pair, null, at);

/** One snapshot of every bag; history older than three months is let go. */
export function recordBagHistory(at: number): void {
  db.transaction(() => {
    stmt.recordBagHistory.run(at);
    stmt.pruneBagHistory.run(at - 90 * 86_400);
  })();
}
