import { Database } from "bun:sqlite";
import { env } from "../config.ts";
import { SCHEMA } from "./schema.ts";

/** The one connection every module prepares its statements on; the schema is applied on open. */
export const db = new Database(env.dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL");
// With WAL, NORMAL only risks the last transactions on a power cut — and the cursor never moves past unstored work.
db.exec("PRAGMA synchronous = NORMAL");
// The ingester runs while a script rebuilds or enriches; a writer waits its turn instead of failing.
db.exec("PRAGMA busy_timeout = 5000");
db.exec(SCHEMA);
/** The one addition a replay cannot stand in for: the receipts hold transfers, not what a token was worth,
 *  so re-syncing would fill this column with today's supply for every past fill. Added in place instead,
 *  and the rows that predate it keep the derived number they already showed. */
try {
  db.exec("ALTER TABLE fills ADD COLUMN supply REAL");
} catch {
  // already there, which is the ordinary case
}
