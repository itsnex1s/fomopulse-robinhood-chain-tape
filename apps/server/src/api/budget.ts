/**
 * What the month is on course to spend, and what to do about it.
 *
 * The plan includes twenty-five billion rows read a month. Where the platform counts what a
 * query walks, that count is the one used, jobs and ingestion included — it is what the bill
 * is made of. Where it does not, each expensive answer says what it walked as it is worked
 * out, which is the API path and nothing behind it. Either way the total is projected forward
 * over the month from however long the object has been counting.
 *
 * Past the budget the answers are held for longer, in proportion, which is the only lever
 * that touches the half of the bill traffic decides: a hundred tabs asking for the same
 * window still cost one pass per lifetime, so a longer lifetime is fewer passes. Capped,
 * because a cache nobody ever misses is a page that never changes.
 */

/** All three from config/limits.json, where the reasoning sits beside them: rows a month may
 *  walk, the most a lifetime may be stretched, and how long to count before projecting at all. */
import { limits, ms } from "../limits.ts";

export const BUDGET = limits.budget.rowsPerMonth;
export const MAX_STRETCH = limits.budget.maxHold;
const WARMUP_MS = ms(limits.budget.warmupSeconds);
const MONTH_MS = 30 * 86_400_000;

let rows = 0;
let since = Date.now();

/**
 * The platform's own count of rows walked, where there is one. Handed in rather than imported:
 * the count lives in the Durable Object's storage shim, and nothing under `apps/server` may
 * reach into `apps/worker`. Whatever it read at the time is the mark everything after is
 * measured from, so an object that has been up for days does not project its whole life.
 */
let meter: (() => number) | undefined;
let mark = 0;
export const meterRows = (count: () => number): void => {
  meter = count;
  mark = count();
};

/** Rows an answer walked. Called by whatever worked it out, not guessed at from outside; only
 *  counted where the platform keeps no count of its own. */
export const spend = (walked: number): void => {
  rows += walked;
};

/** Rows walked since the counting began, the platform's number where there is one. */
export const walked = (): number => (meter ? meter() - mark : rows);

/**
 * Rows walked inside one named piece of work, where the platform counts them at all. Rows read
 * is most of the bill and the readers are the small half of it, so without this the only way to
 * tell whose rows they are is to reason about the queries — which says which of them could be
 * expensive, never which of them is.
 *
 * Synchronous on purpose: every query here is, and a synchronous stretch cannot be interleaved
 * with another, so the count belongs to the work that asked for it and to nothing else.
 */
const parts = new Map<string, { rows: number; runs: number }>();
export function measure<T>(label: string, work: () => T): T {
  if (meter === undefined) return work();
  const before = meter();
  try {
    return work();
  } finally {
    const part = parts.get(label) ?? { rows: 0, runs: 0 };
    part.rows += meter() - before;
    part.runs += 1;
    parts.set(label, part);
  }
}

export const measured = (): Record<string, { rows: number; runs: number }> => Object.fromEntries(parts);

/** Rows this month is on course to walk, at the rate seen so far. */
export function projected(now = Date.now()): number {
  const elapsed = now - since;
  if (elapsed < WARMUP_MS) return 0;
  return (walked() / elapsed) * MONTH_MS;
}

/**
 * How much longer to hold an answer: one while the month is inside its budget, and the ratio
 * past it, up to the cap. Deliberately proportional rather than a cliff — a tape that is ten
 * percent over should be a tape whose pages are ten percent staler, not one that stops.
 */
export const stretch = (over: number): number => Math.min(MAX_STRETCH, Math.max(1, over));
export const pressure = (now = Date.now()): number => stretch(projected(now) / BUDGET);

/** What the readout says, so a month heading past the plan is visible on the page rather
 *  than on the bill. */
export const budget = (now = Date.now()) => ({
  /** Rows read since the object started counting. */
  rows_walked: walked(),
  /** And what that rate comes to over a month, against the plan's allowance. */
  rows_projected: Math.round(projected(now)),
  budget: BUDGET,
  /** How much longer answers are being held because of it; 1 while there is room. */
  holding: Number(pressure(now).toFixed(2)),
});

/** Testing only: the counter is process-wide and every test file shares one. */
export const resetBudget = (at = Date.now()): void => {
  rows = 0;
  parts.clear();
  meter = undefined;
  mark = 0;
  since = at;
};
