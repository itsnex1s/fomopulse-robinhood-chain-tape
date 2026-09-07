import limitsJson from "../../../config/limits.json" with { type: "json" };
import type { Window } from "./api/types.ts";

/**
 * Every operational number the tape runs on, in one file that can be read without reading the
 * code: what it keeps and for how long, how often each job runs, what the feed is asked for,
 * how long an answer may be served from memory, and what a month may spend before it is held
 * back. Served as it stands at `/api/limits`.
 *
 * What is deliberately not here: the constants that decide what a fill is — the fee ratio, the
 * dust threshold, the rounding residue below which a position is closed. Those live beside the
 * rule they belong to, because turning one changes the tape rather than the bill, and a tape
 * whose meaning is a config file is a tape nobody can reason about.
 */

/** Seconds a window's answer may be held, by window name. */
export type Ladder = Record<Window, number>;

export interface Limits {
  retention: { fillDays: number; receiptDays: number };
  pace: {
    tickSeconds: number;
    sweepSeconds: number;
    quoteSeconds: number;
    bagQuoteSeconds: number;
    tradersSeconds: number;
    tradersColdSeconds: number;
    tradersRefusedSeconds: number;
    /** The books walk is spaced off its own last measure, between these two. */
    booksMinSeconds: number;
    booksMaxSeconds: number;
    /** How much of the clock the walk may have: at 240, a walk costing a second is followed by
     *  four minutes of not walking. */
    booksShare: number;
    pruneSeconds: number;
    /** How much of one pass may be spent before the rest is left for the next, and how long
     *  the whole pass may run before the slot is given away. */
    passBudgetSeconds: number;
    passSeconds: number;
    /** How long the set of tokens somebody is long is kept before it is read again. */
    heldSeconds: number;
  };
  sweep: { blocks: number; marginBlocks: number };
  /** How much of the one-off transfer carry a boot and a pass may each do; see db/logs.ts. */
  migrate: { bootRows: number; passRows: number };
  feed: { batch: number; minLiquidityUsd: number; estimateMaxAgeSeconds: number; supplyMaxAgeSeconds: number };
  cache: {
    counted: Ladder;
    marked: Ladder;
    totalsSeconds: number;
    edge: Record<string, number>;
    /** How long a page taken behind a cursor is held: it is a page of the past and cannot change. */
    cursorSeconds: number;
    /** The row counts an answer may be asked for, ascending; anything else is rounded up. */
    limitSteps: number[];
  };
  budget: { rowsPerMonth: number; maxHold: number; warmupSeconds: number };
}

/** A mistake here should stop the process on the first line, not surface as a stalled job. */
function invalid(message: string): never {
  throw new Error(`limits: ${message}`);
}

const positive = (where: string, values: Record<string, unknown>): void => {
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith("$")) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
      invalid(`${where}.${key} is ${String(value)}, which is not a positive number`);
  }
};

/** Every window the API serves, widest last. Exported because the edge canonicalises a query
 *  against it before the cache is keyed on one. */
export const WINDOWS: Window[] = ["1h", "24h", "7d", "30d", "all"];

/** A ladder has every window the API serves, and never holds a wider one for less time than
 *  the window inside it — the wider window is the claim that less has to change. */
function ladder(where: string, given: Record<string, unknown>): Ladder {
  positive(where, given);
  const out = {} as Ladder;
  let last = 0;
  for (const window of WINDOWS) {
    const seconds = given[window];
    if (typeof seconds !== "number") invalid(`${where} has no entry for ${window}`);
    if (seconds < last) invalid(`${where}.${window} is ${seconds}s, less than the window inside it`);
    out[window] = seconds;
    last = seconds;
  }
  return out;
}

/** Exported so the checks can be held to, rather than only running once at import. */
export function validateLimits(given: typeof limitsJson): Limits {
  positive("retention", given.retention);
  positive("pace", given.pace);
  positive("sweep", given.sweep);
  positive("migrate", given.migrate);
  positive("feed", given.feed);
  positive("budget", given.budget);
  positive("cache.edge", given.cache.edge);
  const steps = given.cache.limitSteps;
  if (steps.length === 0) invalid("cache.limitSteps is empty, so no answer could be asked for at all");
  steps.forEach((step, i) => {
    if (!Number.isInteger(step) || step <= 0) invalid(`cache.limitSteps[${i}] is ${step}, which is not a row count`);
    if (i > 0 && step <= steps[i - 1]!) invalid(`cache.limitSteps[${i}] is ${step}, not past the step before it`);
  });
  if (given.cache.cursorSeconds <= 0) invalid("cache.cursorSeconds is not a positive number of seconds");
  if (given.pace.booksMaxSeconds < given.pace.booksMinSeconds)
    invalid("pace.booksMaxSeconds is below pace.booksMinSeconds");
  if (given.pace.passBudgetSeconds >= given.pace.passSeconds)
    invalid("pace.passBudgetSeconds reaches pace.passSeconds, leaving no time to finish what a pass started");
  if (given.retention.receiptDays > given.retention.fillDays)
    invalid("retention.receiptDays is past retention.fillDays, so a replay would outlive the tape it repairs");
  if (given.sweep.marginBlocks > given.sweep.blocks) invalid("sweep.marginBlocks is wider than sweep.blocks");
  if (given.budget.maxHold < 1) invalid("budget.maxHold below 1 would hold answers for less than their own lifetime");
  return {
    retention: given.retention,
    pace: given.pace,
    sweep: given.sweep,
    migrate: given.migrate,
    feed: given.feed,
    cache: {
      counted: ladder("cache.counted", given.cache.counted),
      marked: ladder("cache.marked", given.cache.marked),
      totalsSeconds: given.cache.totalsSeconds,
      edge: given.cache.edge,
      cursorSeconds: given.cache.cursorSeconds,
      limitSteps: steps,
    },
    budget: given.budget,
  };
}

export const limits: Limits = validateLimits(limitsJson);

/** Seconds as the timers want them. Spelled out once so no caller multiplies by a thousand. */
export const ms = (seconds: number): number => seconds * 1_000;
