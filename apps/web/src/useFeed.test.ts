import { expect, test } from "bun:test";
import { backoff, silent } from "./useFeed.ts";

test("a socket is doubted only after it has missed three pings", () => {
  const heard = 1_000_000;
  // The server answers every ping, and a busy tape sends fills between them.
  expect(silent(heard, heard + 20_000)).toBe(false);
  expect(silent(heard, heard + 59_999)).toBe(false);
  // Three pings out with nothing back: the connection is open on this side only.
  expect(silent(heard, heard + 60_001)).toBe(true);
  // A pong or a fill resets it, so a quiet chain alone never trips this.
  expect(silent(heard + 60_000, heard + 60_001)).toBe(false);
});

test("a socket that keeps being refused is retried less and less often, never in step", () => {
  // The first drop is a blip and is retried within two seconds.
  expect(backoff(0, () => 0)).toBe(1_000);
  expect(backoff(0, () => 1)).toBe(2_000);
  // Each failure in a row doubles the wait, and it stops growing at a minute.
  expect(backoff(3, () => 1)).toBe(16_000);
  expect(backoff(10, () => 1)).toBe(60_000);
  expect(backoff(50, () => 0)).toBe(30_000);
  // Half of every wait is random, so tabs refused together do not come back together.
  expect(backoff(4, () => 0)).toBeLessThan(backoff(4, () => 0.5));
});
