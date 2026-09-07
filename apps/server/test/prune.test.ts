/** Retention: what the tape keeps, and what it lets go of once nothing reads it. */
import { expect, test } from "bun:test";
import "./support/memory.ts";
import type { Hex } from "viem";
import { QUOTE_TOKENS } from "../src/config.ts";
import { packTransfers } from "../src/db/logs.ts";
import { db, FILL_DAYS, prune, RECEIPT_DAYS, savePrice } from "../src/db.ts";
import { fill, insertFills, now, wallets } from "./support/api.ts";

const DAY = 86_400;

/** The parts of a feed card that `savePrice` insists on. */
const quote = (price: number) => ({
  price,
  liquidity: 1_000_000,
  change24: null,
  pairCreatedAt: null,
  pair: null,
  marketCap: null,
});

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

test("a quote outlives the fill that wanted it only until the next pass", () => {
  const orphan: Hex = `0x${"d4".repeat(20)}`;
  const kept: Hex = `0x${"d5".repeat(20)}`;
  savePrice(orphan, quote(1), now);
  savePrice(kept, quote(1), now);
  insertFills([fill({ tx: `0x${"d6".repeat(32)}`, wallet: `0x${"d7".repeat(20)}`, token: kept })]);
  prune(now);
  const left = db
    .query<{ token: string }, []>("SELECT token FROM prices")
    .all()
    .map((r) => r.token);
  expect(left).toContain(kept);
  expect(left).not.toContain(orphan);
  // The quote tokens have no fills of their own and are what a cash leg is priced from.
  for (const token of QUOTE_TOKENS.keys()) savePrice(token, quote(1), now);
  prune(now);
  const after = db
    .query<{ token: string }, []>("SELECT token FROM prices")
    .all()
    .map((r) => r.token);
  for (const token of QUOTE_TOKENS.keys()) expect(after).toContain(token);
});
