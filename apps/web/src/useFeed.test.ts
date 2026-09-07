import { expect, test } from "bun:test";
import { silent } from "./useFeed.ts";

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
