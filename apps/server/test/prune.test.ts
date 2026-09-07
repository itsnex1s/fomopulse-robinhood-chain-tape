/** Retention: what the tape keeps, and what it lets go of once nothing reads it. */
import { expect, test } from "bun:test";
import "./support/memory.ts";
import type { Hex } from "viem";
import { packTransfers } from "../src/db/logs.ts";
import { db, FILL_DAYS, prune, RECEIPT_DAYS } from "../src/db.ts";
import { fill, insertFills, now, wallets } from "./support/api.ts";

const DAY = 86_400;

test("fills past their horizon go, and everything younger stays", () => {
  const trader = wallets[4]!;
  const token = "0xaaaa111111111111111111111111111111111111";
  insertFills([
    fill({ tx: "0xprune-old", wallet: trader.address, token, ts: now - (FILL_DAYS + 1) * DAY }),
    fill({ tx: "0xprune-edge", wallet: trader.address, token, ts: now - (FILL_DAYS - 1) * DAY }),
    fill({ tx: "0xprune-new", wallet: trader.address, token, ts: now }),
  ]);

  const gone = prune(now);
  expect(gone.fills).toBeGreaterThanOrEqual(1);

  const left = db.query<{ tx: string }, [string]>("SELECT hex(tx) AS tx FROM fills WHERE token = ?").all(token).length;
  expect(left).toBe(2);
});

test("a receipt past its horizon takes its transfers, and one with no timestamp is left alone", () => {
  const receipt = db.query<unknown, [Uint8Array, number, number | null, Uint8Array]>(
    "INSERT INTO receipts (tx, block, ts, logs) VALUES (?, ?, ?, ?)",
  );
  // The transfers are a column on the receipt, so there is nothing left behind to orphan.
  const logs = packTransfers([
    {
      logIndex: 0,
      token: "0x9".padEnd(42, "0") as Hex,
      from: "0x1".padEnd(42, "0") as Hex,
      to: "0x2".padEnd(42, "0") as Hex,
      value: 1n,
    },
  ]);
  receipt.run(new Uint8Array([0xaa, 0x01]), 1, now - (RECEIPT_DAYS + 1) * DAY, logs);
  receipt.run(new Uint8Array([0xaa, 0x02]), 2, now, logs);
  receipt.run(new Uint8Array([0xaa, 0x03]), 3, null, logs);

  prune(now);

  const blocks = db
    .query<{ block: number }, []>("SELECT block FROM receipts WHERE block IN (1, 2, 3) ORDER BY block")
    .all()
    .map((r) => r.block);
  // The dated old one is gone; the recent one and the undated one — not old, unknown — stay.
  expect(blocks).toEqual([2, 3]);
});
