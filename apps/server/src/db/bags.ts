import type { Bag } from "../api/types.ts";
import { db } from "./connection.ts";
import { getMeta, setMeta } from "./meta.ts";
import { positionsReady } from "./positions.ts";

/** What the tracked traders are sitting in, by token: net positions off this tape's fills,
 *  the feed's quote against them, and the token's flow inside the window. */

/**
 * What counts as still holding something. Buys and sells that cancel exactly leave a
 * rounding residue behind — doubles carry sixteen digits, so a wallet that bought and sold
 * the same tokens ends on 1e-17 of one — and `amount > 0` reads that as a position: it put
 * wallets holding nothing in the holder count and, worse, their whole cost into the bag's
 * average price. A trillionth of what passed through the position is nobody's holding.
 */
export const RESIDUE = 1e-12;

/**
 * Net position per wallet and token. Read from `positions`, which holds exactly this off the
 * fills and is rewritten as they land — see `positions.ts`. Every query below opened with the
 * derivation until it was measured: a grouped pass over the whole tape, on a read that every
 * open tab polls.
 */
const POSITIONS = "SELECT * FROM positions";
/** Still long, as against left holding the rounding. */
const LONG = `amount > gross * ${RESIDUE}`;
const stmt = {
  /** One row per token per hour, so a window can be compared against its own start.
   *  Stamped on the hour with OR IGNORE: a job on any clock still leaves one row an hour. */
  recordBagHistory: db.query(
    `WITH pos AS (${POSITIONS})
     INSERT OR IGNORE INTO bag_hours (token, network, ts, holders, value, pnl)
     SELECT pos.token, ?2, ?1, COUNT(*), SUM(pos.amount * p.price_usd),
            SUM(CASE WHEN pos.bought_amount > 0
                     THEN pos.amount * (p.price_usd - pos.bought_usd / pos.bought_amount) END)
       FROM pos JOIN prices p ON p.token = pos.token
      WHERE ${LONG}
      GROUP BY pos.token`,
  ),
  pruneBagHistory: db.query("DELETE FROM bag_hours WHERE ts < ?"),
  /** Held tokens still without a name, largest bag first, for the chain to be asked about. */
  unnamedBags: db.query<{ token: string }, [number]>(
    `WITH pos AS (${POSITIONS})
     SELECT pos.token AS token FROM pos
       LEFT JOIN tokens t ON t.address = pos.token
       LEFT JOIN prices p ON p.token = pos.token
      WHERE ${LONG} AND t.symbol IS NULL
      GROUP BY pos.token
      ORDER BY SUM(pos.amount) * COALESCE(MAX(p.price_usd), 0) DESC
      LIMIT ?1`,
  ),
  /** Tokens a tracked wallet is still long. A grouped pass over every fill, which is why
   *  the answer is kept — see `tapeTokens` below. */
  heldTokens: db.query<{ token: string }, []>(
    `WITH pos AS (${POSITIONS})
     SELECT DISTINCT token FROM pos WHERE ${LONG}`,
  ),
  /** When each token was last quoted. One row per token the tape has ever priced, which is
   *  a few hundred against a tape of millions of fills, and it is the half that moves. */
  quotedAt: db.query<{ token: string; updated_at: number }, []>("SELECT token, updated_at FROM prices"),
  /** Positions read off our own tape, counting only wallets still long: a sale of tokens bought before the
   *  tape began nets negative and would hide what the others hold. `pnl` is average cost across the priced
   *  buys, no lot accounting. The window bounds the flow columns only. Parameters: window start, row limit. */
  tapeBags: db.query<BagRow, [number, number]>(
    `WITH pos AS (${POSITIONS}),
     bag AS (
       SELECT token, COUNT(*) AS holders, SUM(amount) AS amount,
              SUM(bought_usd) AS bought_usd, SUM(bought_amount) AS bought_amount
         FROM pos WHERE ${LONG} GROUP BY token
     ),
     top AS (
       SELECT token, MAX(amount) AS amount, wallet AS holder FROM pos WHERE ${LONG} GROUP BY token
     ),
     flow AS (
       SELECT token, COUNT(*) AS fills, COALESCE(SUM(side = 'buy'), 0) AS buys,
              COALESCE(SUM(CASE WHEN side = 'buy' THEN usd END), 0) AS bought_usd,
              COALESCE(SUM(CASE WHEN side = 'sell' THEN usd END), 0) AS sold_usd,
              COUNT(DISTINCT wallet) AS traders_in
         FROM fills WHERE dust = 0 AND ts >= ?1 GROUP BY token
     ),
     life AS (
       SELECT token, MAX(last_ts) AS last_fill_ts FROM pos GROUP BY token
     ),
     opened AS (
       SELECT token, MIN(first_buy_ts) AS first_buy_ts, wallet AS first_buyer
         FROM pos WHERE first_buy_ts IS NOT NULL GROUP BY token
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
export const tapeBags = (sinceTs: number, limit: number): BagRow[] => (
  positionsReady(), stmt.tapeBags.all(sinceTs, limit)
);
/**
 * How long the held set is kept before it is read off the fills again. The set is a grouped
 * pass over every fill and it barely moves — a token joins it when a wallet opens a position
 * and leaves when the last one closes — while the thing the caller actually sorts by, the
 * age of the quote, is read fresh every time. Every three minutes this pass was thirty
 * full scans of the tape an hour, for a list that changes a few times a day.
 */
const HELD_MS = 30 * 60_000;
let held: { at: number; tokens: Set<string> } | undefined;

/** Tokens a tracked wallet is still long, with the age of their quote, so the feed knows
 *  what to mark. Neither ordered nor bounded: the caller does both. */
export function tapeTokens(): { token: string; quoted_at: number | null }[] {
  const now = Date.now();
  positionsReady();
  if (held === undefined || now - held.at > HELD_MS)
    held = { at: now, tokens: new Set(stmt.heldTokens.all().map((row) => row.token)) };
  const quoted = new Map(stmt.quotedAt.all().map((row) => [row.token, row.updated_at]));
  return [...held.tokens].map((token) => ({ token, quoted_at: quoted.get(token) ?? null }));
}

/**
 * Tokens a buy just landed in: somebody is long them now, so they belong in the set at
 * once rather than whenever it is next read off the fills. Added rather than treated as a
 * reason to read it again — this tape opens a couple of dozen new tokens an hour, and
 * dropping the set on each of them would cost more passes than keeping none.
 *
 * Nothing here removes: a position closing is the one thing the set learns late, and the
 * cost of that is a token quoted for a while after the last wallet left it.
 */
export const noteHeld = (tokens: Iterable<string>): void => {
  if (held === undefined) return;
  for (const token of tokens) held.tokens.add(token);
};

/** One bag's largest holders, as the screen lists them under the row. */
export interface Holder {
  wallet: string;
  value: number | null;
}

/**
 * Tokens per holders query. Durable Object SQL takes at most 100 bound variables, and the
 * row limit is one of them; bun:sqlite would take thousands, so only the deployment finds
 * this. A page of two hundred bags is three queries rather than two hundred.
 */
const PER_QUERY = 99;

/**
 * The net-long wallets of a whole page of bags, largest position first. The tokens are all
 * known before the first of them is needed, so they go together instead of a query a row.
 * Within a token the price is one number, so ordering by amount held is ordering by worth.
 */
export function tapeHolders(tokens: string[], per = 8): Map<string, Holder[]> {
  positionsReady();
  const held = new Map<string, Holder[]>();
  for (let from = 0; from < tokens.length; from += PER_QUERY) {
    const batch = tokens.slice(from, from + PER_QUERY);
    const rows = db
      .query<{ token: string; wallet: string; value: number | null }, (string | number)[]>(
        `WITH pos AS (
           SELECT token, wallet, amount, gross FROM positions
            WHERE token IN (${batch.map(() => "?").join(", ")})
         ),
         ranked AS (
           SELECT token, wallet, amount,
                  ROW_NUMBER() OVER (PARTITION BY token ORDER BY amount DESC) AS place
             FROM pos WHERE ${LONG}
         )
         SELECT r.token AS token, r.wallet AS wallet, r.amount * p.price_usd AS value
           FROM ranked r LEFT JOIN prices p ON p.token = r.token
          WHERE r.place <= ?
          ORDER BY r.token, r.place`,
      )
      .all(...batch, per);
    for (const row of rows) {
      const list = held.get(row.token);
      if (list === undefined) held.set(row.token, [{ wallet: row.wallet, value: row.value }]);
      else list.push({ wallet: row.wallet, value: row.value });
    }
  }
  return held;
}

export const unnamedBags = (limit: number) => (positionsReady(), stmt.unnamedBags.all(limit).map((row) => row.token));

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
  positionsReady();
  db.transaction(() => {
    stmt.recordBagHistory.run(hour, network);
    stmt.pruneBagHistory.run(at - 31 * 86_400);
    setMeta(BAG_HOUR, hour);
  })();
  return true;
}
