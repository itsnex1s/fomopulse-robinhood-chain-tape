import { describe, expect, test } from "bun:test";
import { unaccounted } from "../src/live.ts";

const at = (...blocks: number[]) => blocks.map((block) => ({ block }));

describe("what the sweep holds against the socket", () => {
  test("a fill past everything the socket delivered is proof the subscription is gone", () => {
    expect(unaccounted(at(1_004, 1_005), 1_000n)).toBe(2);
  });

  test("a fill the socket already accounted for is a dropped log, not a dead socket", () => {
    // The sweep re-reads a minute of blocks the socket did deliver, and a provider can lose
    // one log of a block it otherwise handed over. Neither says the subscription stopped.
    expect(unaccounted(at(1_000, 999, 40), 1_000n)).toBe(0);
  });

  test("only the fills above the mark count, in a sweep that spans it", () => {
    expect(unaccounted(at(998, 999, 1_000, 1_001, 1_002), 1_000n)).toBe(2);
  });

  test("a socket that has delivered nothing yet holds nothing against itself", () => {
    // The mark is seeded from the chain head when the socket subscribes, so it is only zero
    // before that answer arrives; a sweep in that window must not resubscribe on its own.
    expect(unaccounted([], 0n)).toBe(0);
  });
});
