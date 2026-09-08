/** The tape's own length. It used to be counted with a walk of every fill on every readout;
 *  it is now carried, so the one thing worth checking is that it never drifts from the table. */
import { expect, test } from "bun:test";
import "./support/memory.ts";
import type { Hex } from "viem";
import { counts, db, deleteFill, FILL_DAYS, prune } from "../src/db.ts";
import { fill, insertFills, now, wallets } from "./support/api.ts";

const DAY = 86_400;
const real = () => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM fills").get()!.n;
const token = "0xc0un700000000000000000000000000000000001";
const tx = (n: number) => `0x${"c8".repeat(30)}${n.toString(16).padStart(4, "0")}` as Hex;

test("the carried count follows every way a fill can arrive or leave", () => {
  const trader = wallets[0]!;
  // Seeded from the table on the first read, whatever the other files have already put there.
  expect(counts().trades).toBe(real());
  const start = counts().trades;

  insertFills([1, 2, 3].map((n) => fill({ tx: tx(n), wallet: trader.address, token, ts: now - 60 })));
  expect(counts().trades).toBe(start + 3);
  expect(counts().trades).toBe(real());

  // A replayed transaction: the primary key drops it, and the count must not move for it.
  insertFills([fill({ tx: tx(1), wallet: trader.address, token, ts: now - 60 })]);
  expect(counts().trades).toBe(start + 3);

  // A fill withdrawn by a reorg.
  deleteFill(tx(2), 0);
  expect(counts().trades).toBe(start + 2);
  expect(counts().trades).toBe(real());

  // And a pruning pass, which deletes by time rather than one row at a time.
  insertFills([fill({ tx: tx(9), wallet: trader.address, token, ts: now - (FILL_DAYS + 2) * DAY })]);
  expect(counts().trades).toBe(start + 3);
  prune(now);
  expect(counts().trades).toBe(start + 2);
  expect(counts().trades).toBe(real());
});

test("the first and last fill are read off the index, not counted with the rest", () => {
  const trader = wallets[1]!;
  const early = now - 5 * DAY;
  insertFills([
    fill({ tx: tx(21), wallet: trader.address, token, ts: early }),
    fill({ tx: tx(22), wallet: trader.address, token, ts: now - 1 }),
  ]);
  const { first_ts, last_ts } = counts();
  const truth = db.query<{ a: number; b: number }, []>("SELECT MIN(ts) AS a, MAX(ts) AS b FROM fills").get()!;
  expect(first_ts).toBe(truth.a);
  expect(last_ts).toBe(truth.b);
});

test("the readout carries the number rather than counting it again", () => {
  // A row put in behind the accounting: a carried count cannot see it, a counted one must.
  // This is the property the change is for, so it is asserted rather than left to a comment.
  const before = counts().trades;
  db.query(
    `INSERT INTO fills (tx, log_index, block, ts, wallet, token, side, amount, usd, price, priced, dust)
     VALUES (?, 0, 1, ?, ?, ?, 'buy', 1, 1, 1, 'cash_leg', 0)`,
  ).run(tx(31), now, wallets[2]!.address, token);
  expect(counts().trades).toBe(before);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM fills").get()!.n).toBe(before + 1);
  // Put back, so the count and the table agree again for whatever runs after this.
  db.query("DELETE FROM fills WHERE tx = ?").run(tx(31));
  expect(counts().trades).toBe(real());
});
