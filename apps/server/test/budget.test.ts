/**
 * What the month is on course to walk. The figure is a rate, and a rate is only as good as the
 * moment it is measured from — which on this platform is not the moment the module was read.
 */
import { expect, test } from "bun:test";
import "./support/memory.ts";
import { BUDGET, budget, measured, meterRows, projected, resetBudget, spend } from "../src/api/budget.ts";

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

test("the halves of the two heaviest pages each keep what they walked", async () => {
  const { api } = await import("./support/api.ts");
  resetBudget(0);
  // A meter the pages read through, standing in for the platform's own row count.
  let walked = 0;
  meterRows(() => (walked += 100));
  await api.request("/api/bags?window=24h&limit=7");
  await api.request("/api/discover?window=24h&limit=7");
  // Named apart, because a page and the query that fills in its strip are two different costs.
  expect(Object.keys(measured()).sort()).toEqual(["bags:holders", "bags:page", "discover:buyers", "discover:page"]);
  for (const part of Object.values(measured())) expect(part.runs).toBeGreaterThan(0);
  resetBudget();
});

test("where the platform counts, nothing is spent working out what a page might have cost", () => {
  resetBudget(0);
  const walked = 0;
  meterRows(() => walked);
  let asked = 0;
  // The bags page priced its own read by counting every position it holds. On the object that
  // figure is never looked at, so reading the database for it is the whole cost and none of
  // the answer.
  spend(() => {
    asked++;
    return 1_000;
  });
  expect(asked).toBe(0);
  resetBudget();
  // Without a meter it is the only figure there is, so it is worked out and counted.
  spend(() => {
    asked++;
    return 1_000;
  });
  expect(asked).toBe(1);
  resetBudget();
});
