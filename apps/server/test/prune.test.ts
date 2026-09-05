/** Retention: what the tape keeps, and what it lets go of once nothing reads it. */
import { expect, test } from "bun:test";
import "./support/memory.ts";
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
  const receipt = db.query<unknown, [Uint8Array, number, number | null]>(
    "INSERT INTO receipts (tx, block, ts) VALUES (?, ?, ?)",
  );
  receipt.run(new Uint8Array([0xaa, 0x01]), 1, now - (RECEIPT_DAYS + 1) * DAY);
  receipt.run(new Uint8Array([0xaa, 0x02]), 2, now);
  receipt.run(new Uint8Array([0xaa, 0x03]), 3, null);
  const id = db.query<{ id: number }, []>("SELECT id FROM receipts WHERE block = 1").get()!.id;
  db.query<unknown, [number, number, string, string, string, string]>(
    "INSERT INTO transfers (receipt_id, log_index, token, sender, recipient, value) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, 0, "0x9", "0x1", "0x2", "1");

  prune(now);

  const blocks = db
    .query<{ block: number }, []>("SELECT block FROM receipts WHERE block IN (1, 2, 3) ORDER BY block")
    .all()
    .map((r) => r.block);
  // The dated old one is gone; the recent one and the undated one — not old, unknown — stay.
  expect(blocks).toEqual([2, 3]);
  expect(db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM transfers WHERE receipt_id = ?").get(id)!.n).toBe(
    0,
  );
});
