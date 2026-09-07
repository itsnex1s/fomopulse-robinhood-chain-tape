import { db } from "./connection.ts";

/** Who a tracked trader is, as fomo shows them: avatar, clan, tick. Only identity — every
 *  number beside it on both screens is walked from this tape's own fills. */
const stmt = {
  saveTrader: db.query(
    `INSERT INTO traders (handle, id, display_name, avatar_url, clan, verified, followers, updated_at)
     VALUES ($handle, $id, $display_name, $avatar_url, $clan, $verified, $followers, $updated_at)
     ON CONFLICT (handle) DO UPDATE SET
       id = excluded.id, display_name = excluded.display_name, avatar_url = excluded.avatar_url,
       clan = excluded.clan, verified = excluded.verified, followers = excluded.followers,
       updated_at = excluded.updated_at`,
  ),
  allTraders: db.query<TraderRow, []>("SELECT * FROM traders"),
};

/** A trader as stored: the card, without any of its numbers. */
export interface TraderRow {
  handle: string;
  id: string | null;
  display_name: string | null;
  avatar_url: string | null;
  clan: string | null;
  verified: number;
  followers: number | null;
  updated_at: number;
}

/** What one leaderboard page carries about a trader that is still worth storing. */
export type IncomingTrader = Omit<TraderRow, "updated_at">;

export function saveTraders(rows: IncomingTrader[], at: number): void {
  db.transaction(() => {
    for (const row of rows) {
      // bun:sqlite binds named parameters by their `$name`, not by the bare column name.
      const params = Object.fromEntries(Object.entries({ ...row, updated_at: at }).map(([k, v]) => [`$${k}`, v]));
      stmt.saveTrader.run(params as never);
    }
  })();
}

export const allTraders = (): TraderRow[] => stmt.allTraders.all();
