import { getMeta, setMeta } from "../db.ts";

/**
 * Where a restart resumes. `last_block` may only name a block whose transactions
 * are all processed, so it lags behind the newest log while receipts are still
 * being read, and it never moves backwards. A transaction that failed for good
 * stays in flight on purpose: the block stays uncovered and the next start
 * rescans it.
 */
const inflight = new Map<string, number>();
let highest = Number(getMeta("last_block") ?? 0);
let persisted = highest;

function flush(): void {
  let floor = highest;
  for (const block of inflight.values()) if (block - 1 < floor) floor = block - 1;
  if (floor > persisted) {
    persisted = floor;
    setMeta("last_block", floor);
  }
}

export const cursor = {
  /** Newest block whose logs have arrived, processed or not. */
  get highest(): number {
    return highest;
  },
  /** Block to resume after: nothing at or below it is still pending. */
  get last(): number {
    return persisted;
  },
  /** A transaction of `block` is about to be read. */
  begin(tx: string, block: number): void {
    inflight.set(tx, block);
    if (block > highest) highest = block;
  },
  /** The transaction is stored (or dropped as a replay). */
  done(tx: string): void {
    inflight.delete(tx);
    flush();
  },
  /** Every log up to `block` has arrived; a range with no logs at all still counts as covered. */
  seen(block: number): void {
    if (block > highest) highest = block;
    flush();
  },
  /** Transactions still being read, for the status line. */
  get pending(): number {
    return inflight.size;
  },
};
