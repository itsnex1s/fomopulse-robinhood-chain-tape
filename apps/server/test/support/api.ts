/**
 * What the API tests share: one in-memory database, the app under test, and a stored fill
 * with plain defaults, so a test spells out only what it is about.
 *
 * `bun test` gives every file of a run the same module registry, so this is loaded once
 * and the three API files write to the same database — the one ./memory.ts points the
 * run at. Each test therefore finds its own
 * rows by transaction or by token rather than counting the whole tape, and the counts it
 * does assert are its own token's.
 */
import { site as api } from "../../src/api/static.ts";
import { wallets } from "../../src/config.ts";
import {
  insertFills,
  recordBagHistory,
  saveBagQuote,
  saveBagToken,
  saveHoldings,
  savePrice,
  saveToken,
} from "../../src/db.ts";
import type { StoredFill } from "../../src/ingest/reconstruct.ts";

export { api, insertFills, recordBagHistory, saveBagQuote, saveBagToken, saveHoldings, savePrice, saveToken, wallets };

export const now = Math.floor(Date.now() / 1000);

/** A stored fill with plain defaults, so a test spells out only what it is about. */
export const fill = (over: Partial<StoredFill> & Pick<StoredFill, "tx" | "wallet" | "token">): StoredFill => ({
  logIndex: 0,
  block: 1,
  ts: now,
  side: "buy",
  amount: 1,
  usd: 100,
  price: 100,
  priced: "cash_leg",
  dust: 0,
  ...over,
});
