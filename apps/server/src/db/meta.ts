import { db } from "./connection.ts";

const get = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?");
const set = db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");

export const getMeta = (key: string) => get.get(key)?.value;
export const setMeta = (key: string, value: string | number) => set.run(key, `${value}`);
