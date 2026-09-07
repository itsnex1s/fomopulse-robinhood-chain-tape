import { QUOTE_TOKENS } from "../config.ts";
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
  /**
   * Quotes for a token this tape no longer holds a fill of. Nothing reads them and nothing
   * ever dropped them, so the table only grew — and the quote pass walks all of it four times
   * a minute looking for the stalest, which makes a quote kept for a token pruned months ago
   * something this object reads six thousand times a day for nothing.
   *
   * The quote tokens themselves stay whatever the tape holds: a cash leg is priced from them
   * and they are not traded as a position, so they have no fills to be kept by.
   */
  quotes: db.query<never, string[]>(
    `DELETE FROM prices
      WHERE token NOT IN (${[...QUOTE_TOKENS.keys()].map(() => "?").join(", ")})
        AND NOT EXISTS (SELECT 1 FROM fills f WHERE f.token = prices.token)`,
  ),
};

/** Drops what is past its horizon and says how many rows went. note: a first buy is the first one on the
 *  tape, so a wallet that bought before the horizon and buys again after reads as opening a position. */
export function prune(now: number): { fills: number; receipts: number; quotes: number } {
  // Counted outside the closure: on the object a transaction returns nothing to its caller.
  const gone = { fills: 0, receipts: 0, quotes: 0 };
  db.transaction(() => {
    const receiptsBefore = now - RECEIPT_DAYS * 86_400;
    gone.receipts = stmt.receipts.run(receiptsBefore).changes;
    gone.fills = stmt.fills.run(now - FILL_DAYS * 86_400).changes;
    // After the fills, so a quote is dropped in the same pass as the last fill that kept it.
    gone.quotes = stmt.quotes.run(...QUOTE_TOKENS.keys()).changes;
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
  if (gone.fills > 0 || gone.receipts > 0 || gone.quotes > 0)
    log.info(
      `pruned ${gone.receipts} receipts past ${RECEIPT_DAYS} days, ${gone.fills} fills past ${FILL_DAYS}, ` +
        `and ${gone.quotes} quotes with no fill left to keep them`,
    );
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
