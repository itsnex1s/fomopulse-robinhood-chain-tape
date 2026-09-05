import { log } from "../log.ts";
import { db } from "./connection.ts";

/**
 * How long the tape keeps what it stores. Nothing dropped anything before this, and the
 * object's SQLite stops at ten gigabytes: with 294 wallets the store grew 62 MB a day on
 * 2026-09-05, which is half a year of room and no more.
 *
 * The two horizons differ because the rows do. A fill is what the screen reads, and the
 * longest window the API serves is thirty days, so three months of them is already more
 * than anything asks for. The receipts and their transfers are the evidence a fill was
 * derived from — kept long enough to rebuild the recent tape when the reconstruction
 * changes, and they are the bulk of the bytes.
 */
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

/**
 * Drops what is past its horizon and says how many rows went. The transfers go before the
 * receipts they hang off, in one transaction, so a pass that is interrupted leaves no
 * transfer whose receipt is gone.
 *
 * note: a first buy is read as the first one on the tape, so a wallet that bought a token
 * before the horizon and buys again after it is marked as opening a position. Three months
 * is long enough that this is rare, and the alternative is keeping every fill forever.
 */
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
