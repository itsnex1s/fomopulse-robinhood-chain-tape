import { expect, test } from "bun:test";
import { getMeta } from "../src/db.ts";
import { cursor } from "../src/ingest/cursor.ts";

const stored = () => Number(getMeta("last_block") ?? 0);

test("the cursor never moves past a transaction still being read", () => {
  cursor.seen(100);
  expect(cursor.last).toBe(100);
  expect(stored()).toBe(100);

  cursor.begin("0xa", 105);
  cursor.begin("0xb", 108);
  cursor.seen(110);
  expect(cursor.highest).toBe(110);
  expect(cursor.last).toBe(104); // 0xa at 105 is pending, so 104 is the last safe block

  cursor.done("0xb");
  expect(cursor.last).toBe(104); // still waiting on the older one
  cursor.done("0xa");
  expect(cursor.last).toBe(110);
  expect(stored()).toBe(110);
  expect(cursor.pending).toBe(0);
});

test("the cursor is monotonic", () => {
  cursor.seen(50);
  expect(cursor.last).toBe(110);
  expect(cursor.highest).toBe(110);
});

test("a transaction given up on stops holding the cursor, and its block is owed a read", () => {
  cursor.begin("0xc", 120);
  cursor.seen(125);
  expect(cursor.last).toBe(119); // 0xc at 120 is still being read

  cursor.abandon("0xc");
  // The block is written down instead of pinning the cursor for the rest of the run.
  expect(cursor.owed).toEqual([120]);
  expect(cursor.last).toBe(125);
  expect(cursor.pending).toBe(0);
  // and it outlives the process, so a restart still knows the block is unread
  expect(JSON.parse(getMeta("gaps") ?? "[]")).toEqual([120]);

  cursor.mend(120);
  expect(cursor.owed).toEqual([]);
  expect(JSON.parse(getMeta("gaps") ?? "[]")).toEqual([]);
});
