import type { Database } from "bun:sqlite";
import { bytesToBigInt, bytesToHex, hexToBytes } from "viem";
import type { Transfer } from "../ingest/reconstruct.ts";
import { log } from "../log.ts";

/**
 * A receipt's transfers, packed into one value.
 *
 * They are only ever read whole and by receipt — the replay hands the whole list to
 * `reconstruct`, which needs every leg of the transaction to find where the cash sits — so a
 * row apiece bought nothing and cost fourteen writes a fill, which was seven eighths of
 * everything this tape writes.
 *
 * Fixed-width fields and a length-prefixed value, in log order. No compression: the bytes are
 * addresses and amounts, which do not compress, and the point of this is the row count.
 */

/** The first byte of every packed value. A blob written under another layout is a wrong answer
 *  rather than a short read, so it says which layout it is and the reader refuses the rest. */
const FORMAT = 1;
/** Log index, token, sender, recipient, and the length of the value that follows. */
const HEAD = 4 + 20 + 20 + 20 + 1;
/** A uint256 at its widest; anything longer is not an ERC-20 amount. */
const MAX_VALUE = 32;

export function packTransfers(transfers: readonly Transfer[]): Uint8Array {
  // Minimal big-endian, so the common small amount costs a byte or two rather than thirty-two.
  const values = transfers.map((t) => minimal(t.value));
  const out = new Uint8Array(1 + values.reduce((n, v) => n + HEAD + v.length, 0));
  const view = new DataView(out.buffer);
  out[0] = FORMAT;
  let at = 1;
  transfers.forEach((t, i) => {
    const value = values[i]!;
    view.setUint32(at, t.logIndex);
    out.set(hexToBytes(t.token), at + 4);
    out.set(hexToBytes(t.from), at + 24);
    out.set(hexToBytes(t.to), at + 44);
    out[at + 64] = value.length;
    out.set(value, at + HEAD);
    at += HEAD + value.length;
  });
  return out;
}

export function unpackTransfers(packed: Uint8Array): Transfer[] {
  if (packed.length === 0) return [];
  if (packed[0] !== FORMAT) throw new Error(`receipt logs are format ${packed[0]}, not ${FORMAT}`);
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  const transfers: Transfer[] = [];
  let at = 1;
  while (at < packed.length) {
    // The head has to be whole before its last byte can be trusted to be a length.
    if (at + HEAD > packed.length) throw new Error("receipt logs are truncated");
    const length = packed[at + 64]!;
    if (length > MAX_VALUE || at + HEAD + length > packed.length) throw new Error("receipt logs are truncated");
    transfers.push({
      logIndex: view.getUint32(at),
      token: bytesToHex(packed.subarray(at + 4, at + 24)),
      from: bytesToHex(packed.subarray(at + 24, at + 44)),
      to: bytesToHex(packed.subarray(at + 44, at + 64)),
      value: length === 0 ? 0n : bytesToBigInt(packed.subarray(at + HEAD, at + HEAD + length)),
    });
    at += HEAD + length;
  }
  return transfers;
}

/** Big-endian, no leading zero byte; zero is no bytes at all. */
function minimal(value: bigint): Uint8Array {
  if (value <= 0n) return new Uint8Array();
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  return hexToBytes(`0x${hex}`);
}

/**
 * The one thing a re-sync would be a poor answer to. The transfers used to be a row apiece and
 * are now one packed value on the receipt they belong to; dropping the old table on its own
 * would leave the receipts standing with no evidence under them, and the next replay would walk
 * them, find nothing, and take the tape's fills with it.
 *
 * So they are carried across first, once, and only then is the table dropped. Returns how many
 * rows moved; a database that never had the table does no work and returns zero.
 */
export function carryTransfersOntoReceipts(db: Database): number {
  const old = db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'transfers'")
    .get();
  if (!old || old.n === 0) return 0;
  const rows = db
    .query<
      {
        receipt_id: number;
        log_index: number;
        token: Uint8Array;
        sender: Uint8Array;
        recipient: Uint8Array;
        value: Uint8Array;
      },
      []
    >("SELECT receipt_id, log_index, token, sender, recipient, value FROM transfers ORDER BY receipt_id, log_index")
    .all();
  const byReceipt = new Map<number, Transfer[]>();
  for (const row of rows) {
    const list = byReceipt.get(row.receipt_id) ?? [];
    list.push({
      logIndex: row.log_index,
      token: bytesToHex(row.token),
      from: bytesToHex(row.sender),
      to: bytesToHex(row.recipient),
      value: bytesToBigInt(row.value),
    });
    byReceipt.set(row.receipt_id, list);
  }
  const set = db.query("UPDATE receipts SET logs = ? WHERE id = ?");
  db.transaction(() => {
    for (const [id, transfers] of byReceipt) set.run(packTransfers(transfers), id);
  })();
  db.exec("DROP TABLE transfers");
  if (rows.length > 0) log.info(`carried ${rows.length} transfer rows onto ${byReceipt.size} receipts`);
  return rows.length;
}
