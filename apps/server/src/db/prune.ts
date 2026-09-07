import { limits, ms } from "../limits.ts";
import { log } from "../log.ts";
import { db } from "./connection.ts";
import { rebuildPositions } from "./positions.ts";

/** Days, from config/limits.json: a Durable Object's SQLite stops at ten gigabytes, so nothing is
 *  kept forever. Re-exported because the horizons are what this module is about. */
export const { fillDays: FILL_DAYS, receiptDays: RECEIPT_DAYS } = limits.retention;

const stmt = {
  // A receipt whose timestamp never arrived is left alone: it is not old, it is unknown. Its
  // transfers are a column on it, so they go in the same row.
  receipts: db.query("DELETE FROM receipts WHERE ts IS NOT NULL AND ts < ?"),
  fills: db.query("DELETE FROM fills WHERE ts < ?"),
};

/** Drops what is past its horizon and says how many rows went. note: a first buy is the first one on the
 *  tape, so a wallet that bought before the horizon and buys again after reads as opening a position. */
export function prune(now: number): { fills: number; receipts: number } {
  // Counted outside the closure: on the object a transaction returns nothing to its caller.
  const gone = { fills: 0, receipts: 0 };
  db.transaction(() => {
    const receiptsBefore = now - RECEIPT_DAYS * 86_400;
    gone.receipts = stmt.receipts.run(receiptsBefore).changes;
    gone.fills = stmt.fills.run(now - FILL_DAYS * 86_400).changes;
  })();
  // Dropped fills are positions nobody can name from here — the pass deleted by time, not by
  // token — so the table is read off the tape again. Once every six hours, against a read
  // that answers every poll.
  if (gone.fills > 0) rebuildPositions();
  return gone;
}

/** One pass, with the count in the log when it dropped anything. */
export function pruneOnce(): void {
  const gone = prune(Math.floor(Date.now() / 1000));
  if (gone.fills > 0 || gone.receipts > 0)
    log.info(`pruned ${gone.receipts} receipts past ${RECEIPT_DAYS} days and ${gone.fills} fills past ${FILL_DAYS}`);
}

/** The horizons are days, so the pass runs on the hours-apart clock the limits give it. */
export function startPrune(seconds = limits.pace.pruneSeconds): void {
  const tick = () => {
    try {
      pruneOnce();
    } catch (error) {
      log.error("prune", error);
    }
    setTimeout(tick, ms(seconds));
  };
  tick();
}
