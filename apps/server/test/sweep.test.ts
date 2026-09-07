import { expect, test } from "bun:test";
import { sweeper, unaccounted } from "../src/ingest/sweep.ts";

test("the first sweep reads the whole window; the next ones start where the last left off", () => {
  const recent = sweeper(6_000n, 600n);
  expect(recent.range(10_000n)).toEqual([4_000n, 10_000n]);
  recent.done(10_000n);
  // Two minutes on: the blocks since, with a minute of overlap for receipts still in flight.
  expect(recent.range(11_200n)).toEqual([9_400n, 11_200n]);
  recent.done(11_200n);
  // After a long silence, never further back than the window.
  expect(recent.range(30_000n)).toEqual([24_000n, 30_000n]);
  // A cap narrower than the window wins.
  expect(recent.range(30_000n, 200n)).toEqual([29_800n, 30_000n]);
  // Near the genesis block nothing goes negative.
  expect(sweeper().range(100n)).toEqual([0n, 100n]);
});

const at = (...blocks: number[]) => blocks.map((block) => ({ block }));

test("a fill past everything the socket delivered is proof the subscription is gone", () => {
  expect(unaccounted(at(1_004, 1_005), 1_000n)).toBe(2);
  // The sweep re-reads a minute of blocks the socket did deliver, and a provider can lose one
  // log of a block it otherwise handed over. Neither of those says the subscription stopped.
  expect(unaccounted(at(1_000, 999, 40), 1_000n)).toBe(0);
  // A sweep that spans the mark holds only the blocks above it against the socket.
  expect(unaccounted(at(998, 999, 1_000, 1_001, 1_002), 1_000n)).toBe(2);
  // The mark is seeded from the head when the socket subscribes, so it is only zero before
  // that answer arrives; a sweep in that window must not resubscribe on its own.
  expect(unaccounted([], 0n)).toBe(0);
});
