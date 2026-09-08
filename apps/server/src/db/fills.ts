import type { Fill, Priced, Side } from "../api/types.ts";
import type { StoredFill } from "../ingest/reconstruct.ts";
import { limits } from "../limits.ts";
import { noteHeld } from "./bags.ts";
import { db } from "./connection.ts";
import { refreshHeld, refreshPositions } from "./positions.ts";

/** The tape itself — one row per fill — and the reads the screen is built from. */
/** Seconds: how old a fill can be and still have a supply written onto it. Past this the feed's supply is no
 *  longer a reading of the moment the fill landed, and the row is better off falling back. */
const SUPPLY_MAX_AGE = limits.feed.supplyMaxAgeSeconds;

const stmt = {
  insertFill: db.query(
    `INSERT OR IGNORE INTO fills (tx, log_index, block, ts, wallet, token, side, amount, usd, price, priced, dust)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  deleteFill: db.query("DELETE FROM fills WHERE tx = ? AND log_index = ?"),
  tokenOfFill: db.query<{ token: string }, [string, number]>("SELECT token FROM fills WHERE tx = ? AND log_index = ?"),
  /** The feed's supply written onto a token's fills that have none. Run both when a fill lands and when its
   *  token is quoted, because the two happen in either order: a new pool trades before the feed has heard of
   *  it. Bounded to fresh rows — a fill from last week has no supply of its own left to recover. */
  stampSupply: db.query(
    `UPDATE fills
        SET supply = (SELECT market_cap / price_usd FROM prices WHERE token = ?1 AND price_usd > 0 AND market_cap IS NOT NULL)
      WHERE token = ?1 AND supply IS NULL AND ts >= ?2
        AND EXISTS (SELECT 1 FROM prices WHERE token = ?1 AND price_usd > 0 AND market_cap IS NOT NULL)`,
  ),
  /** The pardon: one paid trade or one sale says the token is real after all, and its whole dusty history
   *  comes back with it. Only `dust = 1` — a handout is `2` and stays dusted, because a token sprayed to
   *  seventy-three wallets also trades in a real pool, and one honest buy must not put the spray back. */
  clearDustOf: db.query(
    `UPDATE fills SET dust = 0
      WHERE dust = 1 AND token = ?1
        AND EXISTS (SELECT 1 FROM fills q WHERE q.token = ?1 AND (q.priced = 'cash_leg' OR q.side = 'sell'))`,
  ),
  /** Fills per wallet in a window — the part of a trader's activity we saw ourselves. */
  tapeStats: db.query<{ wallet: string; fills: number; volume: number; last_ts: number }, [number]>(
    `SELECT wallet, COUNT(*) AS fills, COALESCE(SUM(usd), 0) AS volume, MAX(ts) AS last_ts
       FROM fills WHERE ts >= ? GROUP BY wallet`,
  ),
  total: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM fills"),
  // Separate from the count on purpose: alone, each of these is one seek down fills_ts, while
  // the same query that also counts has to walk every row to do it.
  edges: db.query<{ first_ts: number | null; last_ts: number | null }, []>(
    "SELECT (SELECT MIN(ts) FROM fills) AS first_ts, (SELECT MAX(ts) FROM fills) AS last_ts",
  ),
};

/**
 * How many fills the tape holds. Counting them is a walk of every one, and the readout asks
 * for it on a timer, so it is counted once when this module loads and moved by hand after
 * that — the same shape as the decimals and kinds the ingest keeps in memory. A restart
 * counts again, which is also how any drift is put right.
 */
let held = -1;
/** Fills added or dropped outside `insertFills`: pruning, a reorg, a replay. */
export const noteFills = (delta: number): void => {
  if (held >= 0) held += delta;
};

/** Returns the fills that were new; the primary key drops replays after a reconnect. */
export function insertFills(fills: StoredFill[]): StoredFill[] {
  const fresh: StoredFill[] = [];
  const touched = new Set<string>();
  db.transaction(() => {
    for (const f of fills) {
      const { changes } = stmt.insertFill.run(
        f.tx,
        f.logIndex,
        f.block,
        f.ts,
        f.wallet,
        f.token,
        f.side,
        f.amount,
        f.usd,
        f.price,
        f.priced,
        f.dust,
      );
      if (changes > 0) {
        fresh.push(f);
        touched.add(f.token);
      }
    }
    const since = Math.floor(Date.now() / 1000) - SUPPLY_MAX_AGE;
    const pardoned = new Set<string>();
    for (const token of touched) {
      // Both in the same transaction as the insert that can have earned them.
      if (stmt.clearDustOf.run(token).changes > 0) pardoned.add(token);
      stmt.stampSupply.run(token, since);
    }
    // Last, and inside the same transaction: the pardon changes which fills count, so the
    // positions are read after it rather than before. A pardon reaches every wallet in the
    // token; an ordinary fill reaches the one wallet that made it, and nothing else.
    refreshPositions(pardoned);
    refreshHeld(
      new Map(fresh.filter((f) => !pardoned.has(f.token)).map((f) => [`${f.wallet}\u0000${f.token}`, f])).values(),
    );
  })();
  noteFills(fresh.length);
  // Outside the transaction: it changes nothing on disk, only what the quote pass believes
  // about which tokens are held. Buys only — a sell is not somebody going long.
  noteHeld(fresh.filter((f) => f.side === "buy").map((f) => f.token));
  return fresh;
}

/** A fill withdrawn by a reorg. The token is read first because the positions built on it
 *  have to be rewritten, and after the delete there is nothing left to name it. */
export function deleteFill(tx: string, logIndex: number): void {
  const token = stmt.tokenOfFill.get(tx, logIndex)?.token;
  noteFills(-stmt.deleteFill.run(tx, logIndex).changes);
  if (token !== undefined) refreshPositions([token]);
}
/** A quote arriving after the fills it belongs to; the price pass calls this with its own horizon. */
export const stampSupply = (token: string, notBefore: number) => stmt.stampSupply.run(token, notBefore);
export const tapeStats = (sinceTs: number) => stmt.tapeStats.all(sinceTs);
export function counts(): { trades: number; first_ts: number | null; last_ts: number | null } {
  if (held < 0) held = stmt.total.get()!.n;
  return { trades: held, ...stmt.edges.get()! };
}

/** The feed's card and the two signals read off the tape go to the client as they are. */
type Card = Pick<
  Fill,
  | "mark"
  | "liquidity"
  | "pair_created_at"
  | "change24"
  | "change1h"
  | "volume24"
  | "buys24"
  | "sells24"
  | "market_cap"
  | "dex"
  | "image_url"
  | "new_position"
  | "others"
>;

/** One stored fill joined with its token and the feed's card. */
export interface TapeRow extends Card {
  id: number;
  dust: number;
  ts: number;
  block: number;
  tx: string;
  wallet: string;
  token: string;
  symbol: string | null;
  name: string | null;
  side: Side;
  amount: number;
  usd: number | null;
  price: number | null;
  priced: Priced;
  /** The pool the quote came from; the API turns it into a link. */
  pair_address: string | null;
  /** The market cap this fill landed at; see the SELECT. */
  mcap_at: number | null;
}

/** One row of the tape with everything the screen says about it. `new_position` is the wallet's first buy of
 *  the token on this tape; `others` is how many other tracked wallets bought it in the hour before. */
const TAPE_SELECT = `
  SELECT f.rowid AS id, f.ts, f.block, f.tx, f.wallet, f.token, t.symbol, t.name, f.side,
         f.amount, f.usd, f.price, f.priced, f.dust,
         p.price_usd AS mark, p.liquidity_usd AS liquidity, p.pair_address, p.pair_created_at,
         p.change24, p.change1h, p.volume24, p.buys24, p.sells24, p.market_cap, p.dex, p.image_url,
         /* What the whole token was worth when this fill landed: its own price over the supply
            stamped on it. A row from before the column has none, and falls back to the supply
            the feed shows now — the same number the screen used to work out for itself. */
         f.price * COALESCE(f.supply, p.market_cap / NULLIF(p.price_usd, 0)) AS mcap_at,
         CASE WHEN f.side = 'buy' AND NOT EXISTS (
           SELECT 1 FROM fills q WHERE q.wallet = f.wallet AND q.token = f.token AND q.side = 'buy' AND q.ts < f.ts
         ) THEN 1 ELSE 0 END AS new_position,
         (SELECT COUNT(DISTINCT q.wallet) FROM fills q
           WHERE q.token = f.token AND q.side = 'buy' AND q.dust = 0 AND q.wallet != f.wallet
             AND q.ts BETWEEN f.ts - 3600 AND f.ts) AS others
    FROM fills f LEFT JOIN tokens t ON t.address = f.token LEFT JOIN prices p ON p.token = f.token`;

const TAPE_ORDER = "ORDER BY f.ts DESC, f.rowid DESC LIMIT ?";
const tapeStmt = db.query<TapeRow, [number, number]>(`${TAPE_SELECT} WHERE f.ts >= ? ${TAPE_ORDER}`);
/** The same read with the dusting left out. Two statements rather than one with a flag: filtering here keeps
 *  the correlated subqueries off rows the screen would hide anyway. */
const tapeCleanStmt = db.query<TapeRow, [number, number]>(
  `${TAPE_SELECT} WHERE f.ts >= ? AND f.dust = 0 ${TAPE_ORDER}`,
);
const tapeByTxStmt = db.query<TapeRow, [string]>(`${TAPE_SELECT} WHERE f.tx = ? ORDER BY f.rowid`);
/** The same two reads continued from a row already on the screen. The cursor is time and id together, not time
 *  alone: a busy second carries a dozen fills, and a cursor on `ts` would repeat or skip the rest of it. */
const OLDER = "AND (f.ts < ? OR (f.ts = ? AND f.rowid < ?))";
const olderStmt = db.query<TapeRow, [number, number, number, number, number]>(
  `${TAPE_SELECT} WHERE f.ts >= ? ${OLDER} ${TAPE_ORDER}`,
);
const olderCleanStmt = db.query<TapeRow, [number, number, number, number, number]>(
  `${TAPE_SELECT} WHERE f.ts >= ? AND f.dust = 0 ${OLDER} ${TAPE_ORDER}`,
);

/** Where a page of the tape carries on from: the last row the reader was given. */
export interface TapeCursor {
  ts: number;
  id: number;
}

export const tape = (sinceTs: number, limit: number, withDust = true, before?: TapeCursor): TapeRow[] =>
  before
    ? (withDust ? olderStmt : olderCleanStmt).all(sinceTs, before.ts, before.ts, before.id, limit)
    : (withDust ? tapeStmt : tapeCleanStmt).all(sinceTs, limit);
/** The stored rows of one transaction, so a broadcast carries the same shape as the REST tape. */
export const tapeOfTx = (tx: string): TapeRow[] => tapeByTxStmt.all(tx);

export interface OverviewRow {
  fills: number;
  volume: number;
  buys: number;
  sells: number;
  wallets: number;
  tokens: number;
  fills_5m: number;
  volume_5m: number;
}

/** The window in one row, dusting left out: what the original's readout shows above its tape. */
const overviewStmt = db.query<OverviewRow, [number, number]>(
  `SELECT COUNT(*) AS fills, COALESCE(SUM(usd), 0) AS volume,
          COALESCE(SUM(side = 'buy'), 0) AS buys, COALESCE(SUM(side = 'sell'), 0) AS sells,
          COUNT(DISTINCT wallet) AS wallets, COUNT(DISTINCT token) AS tokens,
          COALESCE(SUM(ts >= ?2), 0) AS fills_5m, COALESCE(SUM(CASE WHEN ts >= ?2 THEN usd END), 0) AS volume_5m
     FROM fills WHERE ts >= ?1 AND dust = 0`,
);

const biggestBuyStmt = db.query<
  { usd: number; wallet: string; token: string; symbol: string | null; ts: number },
  [number]
>(
  `SELECT f.usd, f.wallet, f.token, t.symbol, f.ts
     FROM fills f LEFT JOIN tokens t ON t.address = f.token
    WHERE f.ts >= ? AND f.dust = 0 AND f.side = 'buy' AND f.usd IS NOT NULL
    ORDER BY f.usd DESC LIMIT 1`,
);

export const overview = (sinceTs: number, now: number) => ({
  ...overviewStmt.get(sinceTs, now - 300)!,
  biggest_buy: biggestBuyStmt.get(sinceTs) ?? null,
});
