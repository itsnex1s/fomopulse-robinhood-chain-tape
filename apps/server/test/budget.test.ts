/**
 * What the month is on course to walk. The figure is a rate, and a rate is only as good as the
 * moment it is measured from — which on this platform is not the moment the module was read.
 */
import { expect, test } from "bun:test";
import "./support/memory.ts";
import { BUDGET, budget, meterRows, projected, resetBudget, spend } from "../src/api/budget.ts";

const MONTH_MS = 30 * 86_400_000;
const TEN_MINUTES = 10 * 60_000;

test("the clock starts when the counting does, not at the epoch", () => {
  // A Worker evaluates its global scope with the clock frozen before the first I/O, so a
  // module-level Date.now() is zero and every rate measured against it is off by the age of
  // the world. This is the state boot finds the module in.
  resetBudget(0);
  let walked = 0;
  meterRows(() => walked);
  const started = Date.now();
  // Ten minutes at a rate that comes to exactly one budget over a month.
  walked = BUDGET * (TEN_MINUTES / MONTH_MS);
  expect(projected(started + TEN_MINUTES) / BUDGET).toBeCloseTo(1, 1);
  resetBudget();
});

test("a rate past the budget is what holds the answers longer", () => {
  resetBudget(0);
  let walked = 0;
  meterRows(() => walked);
  const started = Date.now();
  walked = 4 * BUDGET * (TEN_MINUTES / MONTH_MS);
  expect(budget(started + TEN_MINUTES).holding).toBeCloseTo(4, 1);
  resetBudget();
});

test("without a meter the counting starts at the first answer that says what it walked", () => {
  resetBudget(0);
  const started = Date.now();
  spend(BUDGET * (TEN_MINUTES / MONTH_MS));
  expect(projected(started + TEN_MINUTES) / BUDGET).toBeCloseTo(1, 1);
  resetBudget();
});
