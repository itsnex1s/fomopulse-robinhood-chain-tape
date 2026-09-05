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
