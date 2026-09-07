/** The packed transfers of a receipt: the only form the evidence is kept in, so what goes in
 *  has to come back exactly — an amount is a uint256 and a wrong byte is a wrong trade. */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { type Hex, hexToBytes } from "viem";
import { carryTransfersOntoReceipts, packTransfers, unpackTransfers } from "../src/db/logs.ts";
import type { Transfer } from "../src/ingest/reconstruct.ts";

const address = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const MAX_UINT256 = (1n << 256n) - 1n;

test("what goes in comes back, amounts exact from zero to the widest a uint256 goes", () => {
  const transfers: Transfer[] = [
    { logIndex: 0, token: address(0x9), from: address(1), to: address(2), value: 0n },
    { logIndex: 1, token: address(0x9), from: address(2), to: address(3), value: 1n },
    { logIndex: 65_536, token: address(0xa), from: address(3), to: address(4), value: 10n ** 18n },
    { logIndex: 4_294_967_295, token: address(0xb), from: address(4), to: address(5), value: MAX_UINT256 },
  ];
  expect(unpackTransfers(packTransfers(transfers))).toEqual(transfers);
});

test("a receipt with no transfers packs and unpacks as none", () => {
  expect(unpackTransfers(packTransfers([]))).toEqual([]);
  // And a column that was never written is not a format error, it is an empty receipt.
  expect(unpackTransfers(new Uint8Array())).toEqual([]);
});

test("a value packs to the bytes it needs and no more", () => {
  const one = (value: bigint) =>
    packTransfers([{ logIndex: 0, token: address(1), from: address(2), to: address(3), value }]).length;
  // The head is the same either way; only the amount grows.
  expect(one(0n)).toBe(one(1n) - 1);
  expect(one(MAX_UINT256)).toBe(one(0n) + 32);
});

test("a blob written under another layout is refused rather than half-read", () => {
  const packed = packTransfers([{ logIndex: 0, token: address(1), from: address(2), to: address(3), value: 5n }]);
  packed[0] = 99;
  expect(() => unpackTransfers(packed)).toThrow(/format 99/);
  const cut = packTransfers([{ logIndex: 0, token: address(1), from: address(2), to: address(3), value: 5n }]);
  expect(() => unpackTransfers(cut.subarray(0, cut.length - 2))).toThrow(/truncated/);
});

test("a database from before the packing carries its transfers across and loses none", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE receipts (id INTEGER PRIMARY KEY, tx BLOB NOT NULL UNIQUE, block INTEGER NOT NULL, ts INTEGER,
      logs BLOB NOT NULL DEFAULT x'');
    CREATE TABLE transfers (receipt_id INTEGER NOT NULL, log_index INTEGER NOT NULL,
      token BLOB NOT NULL, sender BLOB NOT NULL, recipient BLOB NOT NULL, value BLOB NOT NULL,
      PRIMARY KEY (receipt_id, log_index)) WITHOUT ROWID;
  `);
  db.query("INSERT INTO receipts (tx, block, ts) VALUES (?, ?, ?)").run(new Uint8Array([1]), 1, 100);
  db.query("INSERT INTO receipts (tx, block, ts) VALUES (?, ?, ?)").run(new Uint8Array([2]), 2, 200);
  const put = db.query("INSERT INTO transfers VALUES (?, ?, ?, ?, ?, ?)");
  const b = (n: number) => hexToBytes(address(n));
  put.run(1, 0, b(9), b(1), b(2), hexToBytes("0x0de0b6b3a7640000")); // one whole token
  put.run(1, 7, b(9), b(2), b(3), hexToBytes("0x01"));
  put.run(2, 3, b(0xa), b(4), b(5), hexToBytes("0xffffffff"));

  expect(carryTransfersOntoReceipts(db)).toBe(3);
  // The table is gone, and a second open finds nothing left to do.
  expect(carryTransfersOntoReceipts(db)).toBe(0);

  const logsOf = (id: number) =>
    unpackTransfers(db.query<{ logs: Uint8Array }, [number]>("SELECT logs FROM receipts WHERE id = ?").get(id)!.logs);
  expect(logsOf(1)).toEqual([
    { logIndex: 0, token: address(9), from: address(1), to: address(2), value: 10n ** 18n },
    { logIndex: 7, token: address(9), from: address(2), to: address(3), value: 1n },
  ]);
  expect(logsOf(2)).toEqual([
    { logIndex: 3, token: address(0xa), from: address(4), to: address(5), value: 0xffffffffn },
  ]);
  db.close();
});
