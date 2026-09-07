import { getMeta, setMeta } from "../db.ts";
import { log } from "../log.ts";

/**
 * Where a restart resumes. `last_block` may only name a block whose transactions are all
 * processed, so it lags behind the newest log while receipts are still being read, and it
 * never moves backwards.
 *
 * A transaction that fails for good used to stay in flight, which held the cursor below its
 * block for the rest of the run: the tape kept ingesting, but `last_block` stopped moving,
 * and a restart a month later had twenty-six million blocks to rescan before it was live.
 * The block is written down instead, in `meta` so it outlives the process. The cursor goes
 * on and the sweep goes back for the block a few at a time, which is the whole difference:
 * before, nothing ever retried it. Everything at or below `last` is stored except the blocks
 * `owed` names, and a block leaves that list only when a read of it finishes.
 */
const inflight = new Map<string, number>();
/** How many open gaps are worth keeping. Past this something is wrong with the endpoint, not the chain. */
const MAX_GAPS = 500;

let highest = Number(getMeta("last_block") ?? 0);
let persisted = highest;
let gaps = read();

function read(): number[] {
  const stored = getMeta("gaps");
  if (!stored) return [];
  try {
    const list = JSON.parse(stored) as unknown;
    return Array.isArray(list) ? list.filter((block): block is number => Number.isInteger(block)) : [];
  } catch {
    return [];
  }
}

function save(): void {
  setMeta("gaps", JSON.stringify(gaps));
}

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
  /**
   * Block to resume after: nothing at or below it is still being read. Blocks that were
   * given up on are the exception, and they are named in `owed` rather than held against
   * this number — a restart resumes from here and the sweep goes back for them.
   */
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
  /**
   * The transaction could not be read at all. Its block is remembered so the sweep can come
   * back to it, and the cursor stops waiting on a read that is not going to finish.
   */
  abandon(tx: string): void {
    const block = inflight.get(tx);
    inflight.delete(tx);
    if (block !== undefined) cursor.owe(block);
    flush();
  },
  /** This block is owed a read. Idempotent, and the oldest are dropped past MAX_GAPS. */
  owe(block: number): void {
    if (gaps.includes(block)) return;
    gaps.push(block);
    if (gaps.length > MAX_GAPS) {
      const dropped = gaps.slice(0, gaps.length - MAX_GAPS);
      gaps = gaps.slice(-MAX_GAPS);
      log.error(`more than ${MAX_GAPS} blocks are owed a read; forgetting ${dropped.join(", ")}`);
    }
    save();
  },
  /** Blocks still owed a read, oldest first. */
  get owed(): number[] {
    return [...gaps].sort((a, b) => a - b);
  },
  /** The block was read after all. */
  mend(block: number): void {
    const at = gaps.indexOf(block);
    if (at === -1) return;
    gaps.splice(at, 1);
    save();
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
