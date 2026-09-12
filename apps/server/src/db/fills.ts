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
  // The same aggregate, planned two ways; `tapeStats` picks between them. Left to itself the
  // planner takes the index that groups for free and walks all of it, so a window costs a
  // comparison per fill and saves nothing. Forced down fills_ts it reads the window and sorts
  // three hundred wallets instead — cheaper while the window is a slice, dearer once it is
  // the whole tape, because then it has paid for the sort and read everything anyway.
  perWalletGrouped: db.query<{ wallet: string; fills: number; volume: number; last_ts: number }, [number]>(
    `SELECT wallet, COUNT(*) AS fills, COALESCE(SUM(usd), 0) AS volume, MAX(ts) AS last_ts
       FROM fills WHERE ts >= ? GROUP BY wallet`,
  ),
  perWalletSeeked: db.query<{ wallet: string; fills: number; volume: number; last_ts: number }, [number]>(
    `SELECT wallet, COUNT(*) AS fills, COALESCE(SUM(usd), 0) AS volume, MAX(ts) AS last_ts
       FROM fills INDEXED BY fills_ts WHERE ts >= ? GROUP BY wallet`,
  ),
  /** The same aggregate over the fills stored since a given row: what the books have not seen.
   *  NOT INDEXED, or the planner takes the index its GROUP BY already wants and walks every
   *  fill down it to find the handful past the row — which is the pass this exists to avoid. */
  perWalletAfter: db.query<{ wallet: string; fills: number; volume: number; last_ts: number }, [number]>(
    `SELECT wallet, COUNT(*) AS fills, COALESCE(SUM(usd), 0) AS volume, MAX(ts) AS last_ts
       FROM fills NOT INDEXED WHERE rowid > ? GROUP BY wallet`,
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
/**
 * Whether a window is a small enough slice of the tape to be worth seeking into. Past about
 * half of it the grouped walk is the cheaper plan, measured against the object: a day of tape
 * costs forty thousand rows seeked and sixty-seven thousand grouped, a week a hundred and
 * thirty-five thousand seeked and the same sixty-seven thousand grouped.
 */
function slice(sinceTs: number): boolean {
  const { first_ts, last_ts } = counts();
  if (first_ts === null || last_ts === null) return false;
  return (last_ts - sinceTs) * 2 < Math.max(1, last_ts - first_ts);
}

export const tapeStats = (sinceTs: number) =>
  (slice(sinceTs) ? stmt.perWalletSeeked : stmt.perWalletGrouped).all(sinceTs);
/** What the tape has recorded since the row the books were walked through. */
export const tapeStatsAfter = (id: number) => stmt.perWalletAfter.all(id);
/** Whether a window reaches back past the first fill the tape still holds, which makes its
 *  answer the whole tape's — and the whole tape is what the books were walked over. */
export function coversTape(sinceTs: number): boolean {
  const { first_ts } = counts();
  return first_ts !== null && sinceTs <= first_ts;
}
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
 *  the token on this tape. The crowd count is not here; see `crowd`. */
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
         ) THEN 1 ELSE 0 END AS new_position
    FROM fills f LEFT JOIN tokens t ON t.address = f.token LEFT JOIN prices p ON p.token = f.token`;

const TAPE_ORDER = "ORDER BY f.ts DESC, f.rowid DESC LIMIT ?";
const tapeStmt = db.query<Row, [number, number]>(`${TAPE_SELECT} WHERE f.ts >= ? ${TAPE_ORDER}`);
/** The same read with the dusting left out. Two statements rather than one with a flag: filtering here keeps
 *  the correlated subquery off rows the screen would hide anyway. */
const tapeCleanStmt = db.query<Row, [number, number]>(`${TAPE_SELECT} WHERE f.ts >= ? AND f.dust = 0 ${TAPE_ORDER}`);
const tapeByTxStmt = db.query<Row, [string]>(`${TAPE_SELECT} WHERE f.tx = ? ORDER BY f.rowid`);
/**
 * The same two reads continued from a row already on the screen. The cursor is time and id
 * together, not time alone: a busy second carries a dozen fills, and a cursor on `ts` would
 * repeat or skip the rest of it.
 *
 * Written as a row value rather than as the OR it means. Spelled out, the planner reads it as
 * two index ranges, and two ranges cannot be walked in one order — so it took everything below
 * the cursor and sorted it in a temp b-tree to find the four hundred newest. As a row value it
 * is one range down `fills_ts`, walked backwards from the cursor and stopped by the LIMIT.
 */
const OLDER = "AND (f.ts, f.rowid) < (?, ?)";
const olderStmt = db.query<Row, [number, number, number, number]>(
  `${TAPE_SELECT} WHERE f.ts >= ? ${OLDER} ${TAPE_ORDER}`,
);
const olderCleanStmt = db.query<Row, [number, number, number, number]>(
  `${TAPE_SELECT} WHERE f.ts >= ? AND f.dust = 0 ${OLDER} ${TAPE_ORDER}`,
);

/** Where a page of the tape carries on from: the last row the reader was given. */
export interface TapeCursor {
  ts: number;
  id: number;
}

/** A page as the statements read it: everything about a fill except what only its neighbours know. */
type Row = Omit<TapeRow, "others">;

/** How far back a fill looks for company. Part of what the badge on the row means, not a limit. */
const CROWD_SECONDS = 3600;
/**
 * The longest stretch of tape one crowd read covers. The read is bounded by the span it is
 * asked for, and a page of a quiet window can span weeks; chunking keeps it bounded by the
 * page instead. Four hours is long enough that a busy page is one read.
 */
const CROWD_SPAN = 4 * 3600;

/** Every buy that could count as company for a page: its tokens, over its span and the hour before it. */
const crowdStmt = db.query<{ token: string; wallet: string; ts: number }, [string, number, number]>(
  `SELECT q.token AS token, q.wallet AS wallet, q.ts AS ts
     FROM json_each(?1) j
     CROSS JOIN fills q ON q.token = j.value
    WHERE q.side = 'buy' AND q.dust = 0 AND q.ts BETWEEN ?2 AND ?3`,
);

/**
 * How many other tracked wallets bought each row's token in the hour before it. Asked once for
 * the page rather than once per row: the hours a page covers overlap almost entirely, and read
 * row by row this one number was the whole cost of the tape.
 */
function crowd(rows: Row[]): TapeRow[] {
  const out: TapeRow[] = [];
  for (let from = 0; from < rows.length; ) {
    let to = from + 1;
    while (to < rows.length && Math.abs(rows[from]!.ts - rows[to]!.ts) <= CROWD_SPAN) to += 1;
    const page = rows.slice(from, to);
    const tokens = [...new Set(page.map((r) => r.token))];
    let first = page[0]!.ts;
    let last = first;
    for (const r of page) {
      if (r.ts < first) first = r.ts;
      if (r.ts > last) last = r.ts;
    }
    const buys = new Map<string, { wallet: string; ts: number }[]>();
    for (const b of crowdStmt.all(JSON.stringify(tokens), first - CROWD_SECONDS, last)) {
      const list = buys.get(b.token);
      if (list) list.push(b);
      else buys.set(b.token, [b]);
    }
    for (const row of page) {
      const seen = new Set<string>();
      for (const b of buys.get(row.token) ?? [])
        if (b.ts >= row.ts - CROWD_SECONDS && b.ts <= row.ts && b.wallet !== row.wallet) seen.add(b.wallet);
      out.push({ ...row, others: seen.size });
    }
    from = to;
  }
  return out;
}

export const tape = (sinceTs: number, limit: number, withDust = true, before?: TapeCursor): TapeRow[] =>
  crowd(
    before
      ? (withDust ? olderStmt : olderCleanStmt).all(sinceTs, before.ts, before.id, limit)
      : (withDust ? tapeStmt : tapeCleanStmt).all(sinceTs, limit),
  );
/** The stored rows of one transaction, so a broadcast carries the same shape as the REST tape. */
export const tapeOfTx = (tx: string): TapeRow[] => crowd(tapeByTxStmt.all(tx));

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
