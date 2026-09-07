/** The packed transfers of a receipt: the only form the evidence is kept in, so what goes in
 *  has to come back exactly — an amount is a uint256 and a wrong byte is a wrong trade. */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { type Hex, hexToBytes } from "viem";
import {
  carryTransfersOntoReceipts,
  legacyTransfers,
  migrating,
  packTransfers,
  unpackTransfers,
} from "../src/db/logs.ts";
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

const legacy = (): Database => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE receipts (id INTEGER PRIMARY KEY, tx BLOB NOT NULL UNIQUE, block INTEGER NOT NULL, ts INTEGER,
      logs BLOB NOT NULL DEFAULT x'');
    CREATE TABLE transfers (receipt_id INTEGER NOT NULL, log_index INTEGER NOT NULL,
      token BLOB NOT NULL, sender BLOB NOT NULL, recipient BLOB NOT NULL, value BLOB NOT NULL,
      PRIMARY KEY (receipt_id, log_index)) WITHOUT ROWID;
  `);
  return db;
};

const b = (n: number) => hexToBytes(address(n));
/** `n` transfers on the receipt, distinguishable by their log index and their amount. */
const putReceipt = (db: Database, id: number, n: number): void => {
  db.query("INSERT INTO receipts (id, tx, block, ts) VALUES (?, ?, ?, ?)").run(id, new Uint8Array([id]), id, id * 100);
  const put = db.query("INSERT INTO transfers VALUES (?, ?, ?, ?, ?, ?)");
  for (let i = 0; i < n; i++) put.run(id, i, b(9), b(1), b(2), hexToBytes(`0x${(id * 10 + i).toString(16)}`));
};

const logsOf = (db: Database, id: number) =>
  unpackTransfers(db.query<{ logs: Uint8Array }, [number]>("SELECT logs FROM receipts WHERE id = ?").get(id)!.logs);

test("a database from before the packing carries its transfers across and loses none", () => {
  const db = legacy();
  db.query("INSERT INTO receipts (tx, block, ts) VALUES (?, ?, ?)").run(new Uint8Array([1]), 1, 100);
  db.query("INSERT INTO receipts (tx, block, ts) VALUES (?, ?, ?)").run(new Uint8Array([2]), 2, 200);
  const put = db.query("INSERT INTO transfers VALUES (?, ?, ?, ?, ?, ?)");
  put.run(1, 0, b(9), b(1), b(2), hexToBytes("0x0de0b6b3a7640000")); // one whole token
  put.run(1, 7, b(9), b(2), b(3), hexToBytes("0x01"));
  put.run(2, 3, b(0xa), b(4), b(5), hexToBytes("0xffffffff"));

  expect(carryTransfersOntoReceipts(db, 1_000)).toBe(false);
  expect(migrating()).toBe(true);
  // The next slice finds nothing left, drops the table, and says so.
  expect(carryTransfersOntoReceipts(db, 1_000)).toBe(true);
  expect(migrating()).toBe(false);
  expect(carryTransfersOntoReceipts(db, 1_000)).toBe(true);

  expect(logsOf(db, 1)).toEqual([
    { logIndex: 0, token: address(9), from: address(1), to: address(2), value: 10n ** 18n },
    { logIndex: 7, token: address(9), from: address(2), to: address(3), value: 1n },
  ]);
  expect(logsOf(db, 2)).toEqual([
    { logIndex: 3, token: address(0xa), from: address(4), to: address(5), value: 0xffffffffn },
  ]);
  db.close();
});

test("a slice never leaves a receipt half carried, and picks up where it stopped", () => {
  const db = legacy();
  for (const id of [1, 2, 3]) putReceipt(db, id, 2);
  // Three rows a slice against two-transfer receipts: every slice ends mid-receipt.
  let slices = 0;
  while (!carryTransfersOntoReceipts(db, 3)) {
    slices++;
    // Whatever has been written is whole: a receipt has both its transfers or neither.
    for (const id of [1, 2, 3]) expect([0, 2]).toContain(logsOf(db, id).length);
    expect(slices).toBeLessThan(10);
  }
  expect(slices).toBeGreaterThan(1);
  for (const id of [1, 2, 3])
    expect(logsOf(db, id).map((t) => t.value)).toEqual([BigInt(id * 10), BigInt(id * 10 + 1)]);
  db.close();
});

test("a receipt with more transfers than a whole slice is still carried", () => {
  const db = legacy();
  putReceipt(db, 1, 5);
  putReceipt(db, 2, 1);
  while (!carryTransfersOntoReceipts(db, 2));
  expect(logsOf(db, 1)).toHaveLength(5);
  expect(logsOf(db, 2)).toHaveLength(1);
  db.close();
});

test("a receipt the carry has not reached is read where its transfers still are", () => {
  const db = legacy();
  putReceipt(db, 1, 2);
  putReceipt(db, 2, 2);
  carryTransfersOntoReceipts(db, 2);
  // Receipt 1 is packed; receipt 2 is not, and its blob is empty rather than its transfers.
  expect(logsOf(db, 2)).toEqual([]);
  expect(legacyTransfers(db, 2).map((t) => t.value)).toEqual([20n, 21n]);
  db.close();
});
