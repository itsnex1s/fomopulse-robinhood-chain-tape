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
