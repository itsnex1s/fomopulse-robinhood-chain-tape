import { bytesToHex, type Hex, hexToBytes } from "viem";
import type { Kind, ParsedReceipt, Transfer } from "../ingest/reconstruct.ts";
import { db } from "./connection.ts";
import { carryTransfersOntoReceipts, legacyTransfers, migrating, packTransfers, unpackTransfers } from "./logs.ts";

/** What the chain said and what was learned about it: the transfers of every receipt that touched a tracked
 *  wallet, token decimals and names, and whether an address is a contract. A rebuild reads only this. */
const stmt = {
  insertReceipt: db.query("INSERT OR IGNORE INTO receipts (tx, block, ts, logs) VALUES (?, ?, ?, ?)"),
  /** A row stored before its timestamp was known takes the first one offered. */
  dateReceipt: db.query("UPDATE receipts SET ts = ? WHERE tx = ? AND ts IS NULL"),
  receiptByTx: db.query<{ id: number; block: number; ts: number | null; logs: Uint8Array }, [Uint8Array]>(
    "SELECT id, block, ts, logs FROM receipts WHERE tx = ?",
  ),
  allReceipts: db.query<{ id: number; tx: Uint8Array; block: number; ts: number | null }, [number, number]>(
    "SELECT id, tx, block, ts FROM receipts WHERE id > ? ORDER BY id LIMIT ?",
  ),
  logsOf: db.query<{ logs: Uint8Array }, [number]>("SELECT logs FROM receipts WHERE id = ?"),
  receiptCount: db.query<{ receipts: number }, []>("SELECT COUNT(*) AS receipts FROM receipts"),
  saveToken: db.query(
    `INSERT INTO tokens (address, decimals, symbol, name) VALUES (?, ?, ?, ?)
     ON CONFLICT (address) DO UPDATE SET decimals = excluded.decimals,
       symbol = COALESCE(excluded.symbol, tokens.symbol), name = COALESCE(excluded.name, tokens.name)`,
  ),
  trimSymbols: db.query<unknown, [number, number]>(
    "UPDATE tokens SET symbol = substr(symbol, 1, ?) WHERE length(symbol) > ?",
  ),
  trimNames: db.query<unknown, [number, number]>("UPDATE tokens SET name = substr(name, 1, ?) WHERE length(name) > ?"),
  allDecimals: db.query<{ address: string; decimals: number }, []>("SELECT address, decimals FROM tokens"),
  namelessTokens: db.query<{ address: string }, [number]>(
    "SELECT address FROM tokens WHERE symbol IS NULL OR name IS NULL LIMIT ?",
  ),
  saveKind: db.query("INSERT OR REPLACE INTO addresses (address, kind) VALUES (?, ?)"),
  allKinds: db.query<{ address: string; kind: Kind }, []>("SELECT address, kind FROM addresses"),
};

const bytes = (hex: string) => hexToBytes(hex as Hex);

export interface StoredReceipt extends ParsedReceipt {
  id: number;
  ts: number | null;
}

/** Stores the transfers of a receipt; a replay is a no-op, a missing timestamp is filled in. */
export function saveReceipt(receipt: ParsedReceipt, ts: number | null): void {
  const tx = bytes(receipt.tx);
  db.transaction(() => {
    stmt.insertReceipt.run(tx, receipt.block, ts, packTransfers(receipt.transfers));
    if (ts !== null) stmt.dateReceipt.run(ts, tx);
  })();
}

export function getReceipt(tx: string): StoredReceipt | undefined {
  const row = stmt.receiptByTx.get(bytes(tx));
  if (!row) return undefined;
  return { id: row.id, tx: tx as Hex, block: row.block, ts: row.ts, transfers: unpackTransfers(row.logs) };
}

/** One receipt's transfers, unpacked. The replay reads them this way, by id, one row. */
export const transfersOf = (receiptId: number): Transfer[] => {
  const row = stmt.logsOf.get(receiptId);
  if (!row) return [];
  // An empty blob is a transaction with no transfers — or one the carry has not reached.
  if (row.logs.length > 0 || !migrating()) return unpackTransfers(row.logs);
  return legacyTransfers(db, receiptId);
};

/** Stored receipts, oldest first, without their transfers. Taken after an id and bounded so a replay can be
 *  spread over passes: inside a Durable Object the whole tape at once is more than one alarm has. */
export const allReceipts = (after = 0, limit = Number.MAX_SAFE_INTEGER) =>
  stmt.allReceipts.all(after, limit).map((r) => ({ id: r.id, tx: bytesToHex(r.tx) as Hex, block: r.block, ts: r.ts }));

export const dateReceipt = (tx: string, ts: number) => stmt.dateReceipt.run(ts, bytes(tx));
export const receiptCounts = () => stmt.receiptCount.get()!;

/**
 * A ticker and a name are whatever the contract returns, and a contract has returned nine
 * thousand characters of one. Long enough for anything real, short enough that no token
 * decides how wide a column is.
 */
const SYMBOL_CHARS = 24;
const NAME_CHARS = 48;
const label = (text: string | undefined, chars: number): string | null =>
  text === undefined ? null : text.slice(0, chars);

export const saveToken = (address: string, decimals: number, symbol?: string, name?: string) =>
  stmt.saveToken.run(address, decimals, label(symbol, SYMBOL_CHARS), label(name, NAME_CHARS));

/** The same cut over what was stored before there was one. Matches nothing after the first run. */
export function trimLabels(): void {
  stmt.trimSymbols.run(SYMBOL_CHARS, SYMBOL_CHARS);
  stmt.trimNames.run(NAME_CHARS, NAME_CHARS);
}
trimLabels();
export const loadDecimals = () => new Map(stmt.allDecimals.all().map((r) => [r.address, r.decimals]));
/** Tokens seen while the RPC was refusing calls, so their symbol never came back. */
export const namelessTokens = (limit: number) => stmt.namelessTokens.all(limit).map((r) => r.address);

/** Whether an address is a contract or an account, learned once from `eth_getCode`. */
export const saveKind = (address: string, kind: Kind) => stmt.saveKind.run(address, kind);
export const loadKinds = () => new Map<string, Kind>(stmt.allKinds.all().map((r) => [r.address, r.kind]));

/** One bounded slice of the transfer carry, true once there is none left. Reached through this
 *  module because `logs.ts` takes the database as an argument rather than importing the
 *  connection that imports it. */
export const carryTransfers = (rows: number): boolean => carryTransfersOntoReceipts(db, rows);
