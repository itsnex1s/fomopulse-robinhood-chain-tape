import type { Fill, Priced, Side } from "../api/types.ts";
import type { StoredFill } from "../ingest/reconstruct.ts";
import { db } from "./connection.ts";

/**
 * The tape itself — one row per fill — and the reads the screen is built from: the
 * tape with each row's card, the window in one line, and the counts the status shows.
 */
const stmt = {
  insertFill: db.query(
    `INSERT OR IGNORE INTO fills (tx, log_index, block, ts, wallet, token, side, amount, usd, price, priced, dust)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  deleteFill: db.query("DELETE FROM fills WHERE tx = ? AND log_index = ?"),
  /**
   * Dusting by value is decided per fill, as it is reconstructed, so the first one is
   * already off the tape. This is the way back: one paid trade or one sale of the token
   * says the token is real after all, and its whole history comes back with it. Only
   * that kind — `dust = 1`. A handout is `2` and is not pardoned here: fomocat trades in
   * a real pool and is sprayed to seventy-three wallets at a time, and one honest buy in
   * it must not put the spray back on the tape.
   *
   * One token at a time, run as its fills land. The sweeping form of this — every dusty
   * row whose token appears anywhere with a cash leg or a sale — was two full scans of
   * the table with no index to help either, and it ran on every price tick, four times a
   * minute, for a set that a price cannot change: repricing writes `estimate`, which is
   * neither of the two things the condition asks for. Only a new fill moves this, and a
   * new fill knows its token.
   */
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
  counts: db.query<{ trades: number; first_ts: number | null; last_ts: number | null }, []>(
    "SELECT COUNT(*) AS trades, MIN(ts) AS first_ts, MAX(ts) AS last_ts FROM fills",
  ),
};

/** Returns the fills that were new; the primary key drops replays after a reconnect. */
export function insertFills(fills: StoredFill[]): StoredFill[] {
  const fresh: StoredFill[] = [];
  db.transaction(() => {
    const touched = new Set<string>();
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
    // In the same transaction as the insert that can have earned it: a token whose first
    // paid trade or first sale just landed brings its whole dusty history back with it.
    for (const token of touched) stmt.clearDustOf.run(token);
  })();
  return fresh;
}

export const deleteFill = (tx: string, logIndex: number) => stmt.deleteFill.run(tx, logIndex);
export const tapeStats = (sinceTs: number) => stmt.tapeStats.all(sinceTs);
export const counts = () => stmt.counts.get()!;

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
}

/**
 * One row of the tape with everything the screen says about it: the token's card
 * from the feed, whether the buy opened a position (first buy of the token by that
 * wallet on this tape), and how many other tracked wallets bought the same token in
 * the hour before — the crowd, read off the tape itself.
 */
const TAPE_SELECT = `
  SELECT f.rowid AS id, f.ts, f.block, f.tx, f.wallet, f.token, t.symbol, t.name, f.side,
         f.amount, f.usd, f.price, f.priced, f.dust,
         p.price_usd AS mark, p.liquidity_usd AS liquidity, p.pair_address, p.pair_created_at,
         p.change24, p.change1h, p.volume24, p.buys24, p.sells24, p.market_cap, p.dex, p.image_url,
         CASE WHEN f.side = 'buy' AND NOT EXISTS (
           SELECT 1 FROM fills q WHERE q.wallet = f.wallet AND q.token = f.token AND q.side = 'buy' AND q.ts < f.ts
         ) THEN 1 ELSE 0 END AS new_position,
         (SELECT COUNT(DISTINCT q.wallet) FROM fills q
           WHERE q.token = f.token AND q.side = 'buy' AND q.dust = 0 AND q.wallet != f.wallet
             AND q.ts BETWEEN f.ts - 3600 AND f.ts) AS others
    FROM fills f LEFT JOIN tokens t ON t.address = f.token LEFT JOIN prices p ON p.token = f.token`;

const TAPE_ORDER = "ORDER BY f.ts DESC, f.rowid DESC LIMIT ?";
const tapeStmt = db.query<TapeRow, [number, number]>(`${TAPE_SELECT} WHERE f.ts >= ? ${TAPE_ORDER}`);
/** The same read with the dusting left out. Two statements rather than one with a flag in
 *  it: the screen asks for four hundred rows and hides the dusting itself, which meant
 *  reading eight hundred — twice the correlated subqueries — to throw half of them away. */
const tapeCleanStmt = db.query<TapeRow, [number, number]>(
  `${TAPE_SELECT} WHERE f.ts >= ? AND f.dust = 0 ${TAPE_ORDER}`,
);
const tapeByTxStmt = db.query<TapeRow, [string]>(`${TAPE_SELECT} WHERE f.tx = ? ORDER BY f.rowid`);
/**
 * The same two reads again, continued from a row already on the screen: the reader who
 * reaches the end of what they hold asks for what came before it. The cursor is the row's
 * time and its id together, not the time alone — a busy second carries a dozen fills, and
 * a cursor on `ts` would hand back the rest of that second or skip it.
 */
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
