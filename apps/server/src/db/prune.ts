import { log } from "../log.ts";
import { db } from "./connection.ts";

/** Days. A Durable Object's SQLite stops at ten gigabytes, so nothing is kept forever. The longest window the
 *  API serves is thirty days, which is what fills are held against; the receipts are only the evidence a
 *  rebuild replays, and they are the bulk of the bytes. */
export const FILL_DAYS = 90;
export const RECEIPT_DAYS = 14;

const stmt = {
  // A receipt whose timestamp never arrived is left alone: it is not old, it is unknown.
  transfers: db.query(
    "DELETE FROM transfers WHERE receipt_id IN (SELECT id FROM receipts WHERE ts IS NOT NULL AND ts < ?)",
  ),
  receipts: db.query("DELETE FROM receipts WHERE ts IS NOT NULL AND ts < ?"),
  fills: db.query("DELETE FROM fills WHERE ts < ?"),
};

/** Drops what is past its horizon and says how many rows went; transfers go before the receipts they hang off,
 *  in one transaction, so an interrupted pass leaves no orphan. note: a first buy is the first one on the
 *  tape, so a wallet that bought before the horizon and buys again after reads as opening a position. */
export function prune(now: number): { fills: number; receipts: number } {
  // Counted outside the closure: on the object a transaction returns nothing to its caller.
  const gone = { fills: 0, receipts: 0 };
  db.transaction(() => {
    const receiptsBefore = now - RECEIPT_DAYS * 86_400;
    stmt.transfers.run(receiptsBefore);
    gone.receipts = stmt.receipts.run(receiptsBefore).changes;
    gone.fills = stmt.fills.run(now - FILL_DAYS * 86_400).changes;
  })();
  return gone;
}

/** One pass, with the count in the log when it dropped anything. */
export function pruneOnce(): void {
  const gone = prune(Math.floor(Date.now() / 1000));
  if (gone.fills > 0 || gone.receipts > 0)
    log.info(`pruned ${gone.receipts} receipts past ${RECEIPT_DAYS} days and ${gone.fills} fills past ${FILL_DAYS}`);
}

/** The horizons are days; reading them every six hours is often enough to hold the line. */
export function startPrune(hours = 6): void {
  const tick = () => {
    try {
      pruneOnce();
    } catch (error) {
      log.error("prune", error);
    }
    setTimeout(tick, hours * 3_600_000);
  };
  tick();
}
