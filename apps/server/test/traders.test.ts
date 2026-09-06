import { expect, test } from "bun:test";
import { retryInterval } from "../src/traders.ts";

const REGULAR = 600_000;
const COLD = 60_000;

test("fomo is asked every minute while nothing is stored, less often after each failure, every ten minutes once it has answered", () => {
  expect(retryInterval(REGULAR, COLD, false, 0)).toBe(60_000);
  expect(retryInterval(REGULAR, COLD, false, 3)).toBe(480_000);
  // Never later than the regular turn.
  expect(retryInterval(REGULAR, COLD, false, 8)).toBe(REGULAR);
  // With a table to show, a failing token waits the regular ten minutes like everyone else.
  expect(retryInterval(REGULAR, COLD, true, 5)).toBe(REGULAR);
});

/**
 * A refusal is not a failure to be retried: fomo accepted the token and declined the
 * caller, so the answer is the same in ten minutes. Measured 2026-09-06 — twenty hours of
 * 403s, asked for every ten minutes throughout.
 */
test("a refusal stands the tick down for hours, whatever the other clocks say", () => {
  const hour = 3_600_000;
  // Cold table, so the fast clock would otherwise win.
  expect(retryInterval(600_000, 60_000, false, 0, 6 * hour)).toBe(6 * hour);
  expect(retryInterval(600_000, 60_000, true, 0, 6 * hour)).toBe(6 * hour);
  // And it goes back to the ordinary pace once the wait is over.
  expect(retryInterval(600_000, 60_000, true, 0, 0)).toBe(600_000);
});
