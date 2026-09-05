import { expect, test } from "bun:test";
import { sweeper } from "../src/ingest/sweep.ts";

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
