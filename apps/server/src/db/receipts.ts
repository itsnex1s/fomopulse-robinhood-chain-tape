import { bytesToBigInt, bytesToHex, type Hex, hexToBytes, numberToBytes } from "viem";
import type { Kind, ParsedReceipt, Transfer } from "../ingest/reconstruct.ts";
import { db } from "./connection.ts";

/**
 * What the chain said and what was learned about it: the transfers of every receipt
 * that touched a tracked wallet, the tokens' decimals and names, and whether an address
 * is a contract or an account. A rebuild reads all of this and nothing from the chain.
 */
const stmt = {
  insertReceipt: db.query("INSERT OR IGNORE INTO receipts (tx, block, ts) VALUES (?, ?, ?)"),
  /** A row stored before its timestamp was known takes the first one offered. */
  dateReceipt: db.query("UPDATE receipts SET ts = ? WHERE tx = ? AND ts IS NULL"),
  receiptByTx: db.query<{ id: number; block: number; ts: number | null }, [Uint8Array]>(
    "SELECT id, block, ts FROM receipts WHERE tx = ?",
  ),
  allReceipts: db.query<{ id: number; tx: Uint8Array; block: number; ts: number | null }, [number, number]>(
    "SELECT id, tx, block, ts FROM receipts WHERE id > ? ORDER BY id LIMIT ?",
  ),
  insertTransfer: db.query(
    `INSERT OR IGNORE INTO transfers (receipt_id, log_index, token, sender, recipient, value)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ),
  transfersOf: db.query<TransferRow, [number]>(
    "SELECT log_index, token, sender, recipient, value FROM transfers WHERE receipt_id = ? ORDER BY log_index",
  ),
  receiptCounts: db.query<{ receipts: number; transfers: number }, []>(
    "SELECT (SELECT COUNT(*) FROM receipts) AS receipts, (SELECT COUNT(*) FROM transfers) AS transfers",
  ),
  saveToken: db.query(
    `INSERT INTO tokens (address, decimals, symbol, name) VALUES (?, ?, ?, ?)
     ON CONFLICT (address) DO UPDATE SET decimals = excluded.decimals,
       symbol = COALESCE(excluded.symbol, tokens.symbol), name = COALESCE(excluded.name, tokens.name)`,
  ),
  allDecimals: db.query<{ address: string; decimals: number }, []>("SELECT address, decimals FROM tokens"),
  namelessTokens: db.query<{ address: string }, [number]>(
    "SELECT address FROM tokens WHERE symbol IS NULL OR name IS NULL LIMIT ?",
  ),
  saveKind: db.query("INSERT OR REPLACE INTO addresses (address, kind) VALUES (?, ?)"),
  allKinds: db.query<{ address: string; kind: Kind }, []>("SELECT address, kind FROM addresses"),
};

interface TransferRow {
  log_index: number;
  token: Uint8Array;
  sender: Uint8Array;
  recipient: Uint8Array;
  value: Uint8Array;
}

const bytes = (hex: string) => hexToBytes(hex as Hex);
const toAddress = (b: Uint8Array) => bytesToHex(b) as `0x${string}`;

const rowToTransfer = (r: TransferRow): Transfer => ({
  logIndex: r.log_index,
  token: toAddress(r.token),
  from: toAddress(r.sender),
  to: toAddress(r.recipient),
  value: bytesToBigInt(r.value),
});

export interface StoredReceipt extends ParsedReceipt {
  id: number;
  ts: number | null;
}

/** Stores the transfers of a receipt; a replay is a no-op, a missing timestamp is filled in. */
export function saveReceipt(receipt: ParsedReceipt, ts: number | null): void {
  const tx = bytes(receipt.tx);
  db.transaction(() => {
    stmt.insertReceipt.run(tx, receipt.block, ts);
    if (ts !== null) stmt.dateReceipt.run(ts, tx);
    const id = stmt.receiptByTx.get(tx)!.id;
    for (const t of receipt.transfers) {
      stmt.insertTransfer.run(id, t.logIndex, bytes(t.token), bytes(t.from), bytes(t.to), numberToBytes(t.value));
    }
  })();
}

export function getReceipt(tx: string): StoredReceipt | undefined {
  const row = stmt.receiptByTx.get(bytes(tx));
  if (!row) return undefined;
  return { id: row.id, tx: tx as Hex, block: row.block, ts: row.ts, transfers: transfersOf(row.id) };
}

export const transfersOf = (receiptId: number): Transfer[] => stmt.transfersOf.all(receiptId).map(rowToTransfer);

/**
 * Stored receipts, oldest first, without their transfers — a rebuild loads those one at a
 * time. Taken after an id and in a bounded run, so a replay can be spread over several
 * passes: inside a Durable Object the whole tape at once is more than one alarm has.
 */
export const allReceipts = (after = 0, limit = Number.MAX_SAFE_INTEGER) =>
  stmt.allReceipts.all(after, limit).map((r) => ({ id: r.id, tx: bytesToHex(r.tx) as Hex, block: r.block, ts: r.ts }));

export const dateReceipt = (tx: string, ts: number) => stmt.dateReceipt.run(ts, bytes(tx));
export const receiptCounts = () => stmt.receiptCounts.get()!;

export const saveToken = (address: string, decimals: number, symbol?: string, name?: string) =>
  stmt.saveToken.run(address, decimals, symbol ?? null, name ?? null);
export const loadDecimals = () => new Map(stmt.allDecimals.all().map((r) => [r.address, r.decimals]));
/** Tokens seen while the RPC was refusing calls, so their symbol never came back. */
export const namelessTokens = (limit: number) => stmt.namelessTokens.all(limit).map((r) => r.address);

/** Whether an address is a contract or an account, learned once from `eth_getCode`. */
export const saveKind = (address: string, kind: Kind) => stmt.saveKind.run(address, kind);
export const loadKinds = () => new Map<string, Kind>(stmt.allKinds.all().map((r) => [r.address, r.kind]));
