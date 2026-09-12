import { db } from "./connection.ts";

/** Where the books record the last fill their walk read, so a reader can add on what has
 *  landed since. In `meta` rather than on the rows: it is one number for the whole table. */
export const WALK_THROUGH = "books:through";

/** The windows the books are kept per, exactly the ones the pages offer. */
export const STAT_WINDOWS = ["24h", "7d", "30d", "all"] as const;
export type StatWindow = (typeof STAT_WINDOWS)[number];

const COLUMNS = [
  "wallet",
  ...STAT_WINDOWS.flatMap((w) => [`realized_${w}`, `trips_${w}`, `wins_${w}`]),
  "unrealized",
  "open_value",
  "open_tokens",
  "free",
  "buys",
  "sells",
  "volume",
  "tape_volume",
  "tokens",
  "first_ts",
  "last_ts",
  "computed_at",
];

/** The books table: written by pnl.ts as one sequential pass, read by the ranking as a
 *  lookup per row. */
const stmt = {
  /** Fills in the order the books have to be walked in: a sell is priced against what came before it. */
  page: db.query<StatFill, [number, number, number]>(
    `SELECT ts, rowid AS id, wallet, token, side, amount, usd, dust FROM fills
      WHERE (ts > ?1 OR (ts = ?1 AND rowid > ?2)) ORDER BY ts, rowid LIMIT ?3`,
  ),
  /** The last price the tape itself paid for a token, for what the feed has never quoted. */
  lastPrice: db.query<{ price: number }, [string]>(
    "SELECT price FROM fills WHERE token = ? AND price IS NOT NULL ORDER BY ts DESC LIMIT 1",
  ),
  save: db.query(
    `INSERT OR REPLACE INTO trader_stats (${COLUMNS.join(", ")})
     VALUES (${COLUMNS.map((c) => `$${c}`).join(", ")})`,
  ),
  all: db.query<StatRow, []>("SELECT * FROM trader_stats"),
  clear: db.query("DELETE FROM trader_stats"),
};

/** What the walk reads off a fill; everything else about it is the tape's business. */
export interface StatFill {
  ts: number;
  id: number;
  wallet: string;
  token: string;
  side: "buy" | "sell";
  amount: number;
  usd: number | null;
  dust: number;
}

/** A wallet's books as stored. Wins is over trips, and both count only measurable round trips. */
export interface StatRow {
  wallet: string;
  realized_24h: number;
  realized_7d: number;
  realized_30d: number;
  realized_all: number;
  trips_24h: number;
  trips_7d: number;
  trips_30d: number;
  trips_all: number;
  wins_24h: number;
  wins_7d: number;
  wins_30d: number;
  wins_all: number;
  /** What the open positions are worth against their cost, and what they are worth at all. */
  unrealized: number;
  open_value: number;
  open_tokens: number;
  free: number;
  buys: number;
  sells: number;
  volume: number;
  /** Every priced fill, dust included: what the tape's own aggregate reports. */
  tape_volume: number;
  tokens: number;
  first_ts: number | null;
  last_ts: number | null;
  computed_at: number;
}

export const fillsAfter = (ts: number, id: number, limit: number): StatFill[] => stmt.page.all(ts, id, limit);
export const lastPriceOf = (token: string): number | undefined => stmt.lastPrice.get(token)?.price;
export const allStats = (): StatRow[] => stmt.all.all();

/** Rewrites of the table in this process. Nothing else writes it, so a reader holding a
 *  copy knows exactly when the copy went stale. */
let version = 0;
export const statsVersion = (): number => version;

export const saveStats = (rows: StatRow[]): void => {
  db.transaction(() => {
    stmt.clear.run();
    for (const row of rows) {
      // bun:sqlite binds named parameters by their `$name`, not by the bare column name.
      stmt.save.run(Object.fromEntries(Object.entries(row).map(([k, v]) => [`$${k}`, v])) as never);
    }
  })();
  version++;
};
