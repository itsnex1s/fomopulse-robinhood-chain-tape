import { db } from "./connection.ts";

/**
 * What fomo publishes about its traders — their standing and the positions on their
 * cards. The bags built from those positions live in ./bags.ts.
 */
const stmt = {
  saveTrader: db.query(
    `INSERT INTO traders (handle, id, display_name, avatar_url, clan, verified, followers, volume, trades,
                          holdings, top_value, updated_at)
     VALUES ($handle, $id, $display_name, $avatar_url, $clan, $verified, $followers, $volume, $trades,
             $holdings, $top_value, $updated_at)
     ON CONFLICT (handle) DO UPDATE SET
       id = excluded.id, display_name = excluded.display_name, avatar_url = excluded.avatar_url,
       clan = excluded.clan, verified = excluded.verified, followers = excluded.followers,
       volume = excluded.volume, trades = excluded.trades, holdings = excluded.holdings,
       top_value = excluded.top_value, updated_at = excluded.updated_at`,
  ),
  allTraders: db.query<TraderRow, []>("SELECT * FROM traders"),
  clearHoldings: db.query("DELETE FROM holdings WHERE handle = ?"),
  saveHolding: db.query(
    `INSERT OR REPLACE INTO holdings (handle, token, network, image_url, amount, price, value, pnl, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
};

/** A trader as stored: fomo's card, with PnL and rank kept per leaderboard window. */
export interface TraderRow {
  handle: string;
  id: string | null;
  display_name: string | null;
  avatar_url: string | null;
  clan: string | null;
  verified: number;
  followers: number | null;
  volume: number | null;
  trades: number | null;
  holdings: number | null;
  /** Value of the three positions fomo shows on the leaderboard card. */
  top_value: number | null;
  pnl_all: number | null;
  pnl_24h: number | null;
  pnl_7d: number | null;
  pnl_30d: number | null;
  rank_all: number | null;
  rank_24h: number | null;
  rank_7d: number | null;
  rank_30d: number | null;
  updated_at: number;
}

/** PnL and rank land in the columns of the window they came from, so one row holds all four. */
const PNL_COLUMN = { "": "pnl_all", "/24h": "pnl_24h", "/7d": "pnl_7d", "/30d": "pnl_30d" } as const;
const RANK_COLUMN = { "": "rank_all", "/24h": "rank_24h", "/7d": "rank_7d", "/30d": "rank_30d" } as const;

/** What one leaderboard page carries about a trader; `pnl` and `rank` belong to the window it came from. */
export type IncomingTrader = Omit<
  TraderRow,
  "pnl_all" | "pnl_24h" | "pnl_7d" | "pnl_30d" | "rank_all" | "rank_24h" | "rank_7d" | "rank_30d" | "updated_at"
> & { pnl: number | null; rank: number };

export function saveTraders(rows: IncomingTrader[], window: keyof typeof PNL_COLUMN, at: number): void {
  const setPnl = db.query(`UPDATE traders SET ${PNL_COLUMN[window]} = ?, ${RANK_COLUMN[window]} = ? WHERE handle = ?`);
  db.transaction(() => {
    for (const { pnl, rank, ...row } of rows) {
      // bun:sqlite binds named parameters by their `$name`, not by the bare column name.
      const params = Object.fromEntries(Object.entries({ ...row, updated_at: at }).map(([k, v]) => [`$${k}`, v]));
      stmt.saveTrader.run(params as never);
      setPnl.run(pnl, rank, row.handle);
    }
  })();
}

export const allTraders = (): TraderRow[] => stmt.allTraders.all();

/** One position on a trader's card, on whichever chain fomo reports it. */
export interface HoldingRow {
  token: string;
  network: number;
  image_url: string | null;
  amount: number;
  price: number | null;
  value: number;
  pnl: number | null;
}

export function saveHoldings(handle: string, rows: HoldingRow[], at: number): void {
  db.transaction(() => {
    stmt.clearHoldings.run(handle);
    for (const h of rows) {
      stmt.saveHolding.run(handle, h.token, h.network, h.image_url, h.amount, h.price, h.value, h.pnl, at);
    }
  })();
}
