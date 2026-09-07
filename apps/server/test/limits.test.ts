/**
 * The operational limits and the checks on them. A wrong number here is a job that never runs
 * or a page held for an hour, and neither announces itself, so the file is refused on the way
 * in rather than obeyed.
 */
import { expect, test } from "bun:test";
import limitsJson from "../../../config/limits.json" with { type: "json" };
import { limits, ms, validateLimits } from "../src/limits.ts";

/** The file as it stands, with one path changed. */
const withChange = (path: string, value: unknown): typeof limitsJson => {
  const copy = structuredClone(limitsJson) as unknown as Record<string, Record<string, unknown>>;
  const [group, key, window] = path.split(".") as [string, string, string | undefined];
  if (window === undefined) copy[group]![key] = value;
  else (copy[group]![key] as Record<string, unknown>)[window] = value;
  return copy as unknown as typeof limitsJson;
};

test("the file this tape ships with passes its own checks", () => {
  expect(validateLimits(limitsJson)).toEqual(limits);
  // And the units in the names are the units in the values: a tick is seconds, not milliseconds.
  expect(ms(limits.pace.tickSeconds)).toBe(15_000);
});

test("a number that is not a positive number is refused, and said which", () => {
  expect(() => validateLimits(withChange("retention.fillDays", 0))).toThrow(/retention.fillDays/);
  expect(() => validateLimits(withChange("pace.sweepSeconds", -1))).toThrow(/pace.sweepSeconds/);
  expect(() => validateLimits(withChange("feed.batch", "thirty"))).toThrow(/feed.batch/);
  expect(() => validateLimits(withChange("budget.rowsPerMonth", Number.NaN))).toThrow(/budget.rowsPerMonth/);
});

test("a ladder may not hold a wider window for less time than the one inside it", () => {
  expect(() => validateLimits(withChange("cache.counted.all", 1))).toThrow(/cache.counted.all/);
  expect(() => validateLimits(withChange("cache.marked.7d", 1))).toThrow(/cache.marked.7d/);
  // Equal is fine: a ladder is allowed to stop climbing where the poll behind it stops.
  expect(() => validateLimits(withChange("cache.marked.all", limits.cache.marked["30d"]))).not.toThrow();
});

test("the checks that are about two numbers together", () => {
  // Evidence that outlives the tape it repairs is evidence for nothing.
  expect(() => validateLimits(withChange("retention.receiptDays", 400))).toThrow(/receiptDays/);
  // A sweep whose overlap is wider than its reach never moves forward.
  expect(() => validateLimits(withChange("sweep.marginBlocks", 99_999))).toThrow(/marginBlocks/);
  // A pass with no time left after its budget can never finish what it started.
  expect(() => validateLimits(withChange("pace.passBudgetSeconds", limits.pace.passSeconds))).toThrow(/passBudget/);
  // The books cannot be spaced further apart than they are allowed to be.
  expect(() => validateLimits(withChange("pace.booksMaxSeconds", 1))).toThrow(/booksMax/);
});

test("the limits are served as they stand, with what the month has spent against them", async () => {
  const { api } = await import("./support/api.ts");
  const body = (await (await api.request("/api/limits")).json()) as {
    limits: typeof limits;
    budget: { budget: number; holding: number };
  };
  expect(body.limits).toEqual(limits);
  // Holding is 1 until a month's projection says otherwise, and the budget is the one configured.
  expect(body.budget.budget).toBe(limits.budget.rowsPerMonth);
  expect(body.budget.holding).toBe(1);
});

test("the platform is configured with the ceiling this file states", async () => {
  // The rate limit is enforced by the binding, which reads wrangler.jsonc and not this repo's
  // config; the number lives in both, so the two are held to each other here.
  const jsonc = await Bun.file(new URL("../../worker/wrangler.jsonc", import.meta.url)).text();
  const configured = JSON.parse(jsonc.replace(/^\s*\/\/.*$/gm, "")) as {
    unsafe: { bindings: { name: string; simple: { limit: number; period: number } }[] };
  };
  const binding = configured.unsafe.bindings.find((b) => b.name === "OBJECT_LIMIT");
  expect(binding?.simple.period).toBe(60);
  expect(binding?.simple.limit).toBe(limits.cache.objectRequestsPerMinute);
});
