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
