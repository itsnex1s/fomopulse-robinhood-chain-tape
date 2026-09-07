import { expect, test } from "bun:test";
import { booksSpacing } from "../src/pnl.ts";
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

test("the books walk is spaced off its own cost, between a floor and a ceiling", () => {
  const floor = 10 * 60_000;
  const ceiling = 60 * 60_000;
  // A quarter of a second, which is the walk at the size the tape is now: the floor decides.
  expect(booksSpacing(240, floor, ceiling)).toBe(floor);
  // Five and a half seconds, the walk over 900k fills: twenty minutes rather than ten.
  expect(booksSpacing(5_433, floor, ceiling)).toBe(5_433 * 240);
  // And nothing walks less often than the ceiling, however long it takes.
  expect(booksSpacing(60_000, floor, ceiling)).toBe(ceiling);
  // A database that has never walked has no measure to go on.
  expect(booksSpacing(0, floor, ceiling)).toBe(floor);
});
