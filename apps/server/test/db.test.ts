import { expect, test } from "bun:test";
import type { Address } from "viem";
import { QUOTE_TOKENS } from "../src/config.ts";
import { getReceipt, saveReceipt } from "../src/db.ts";
import { parse, participants, type RawReceipt, reconstruct } from "../src/ingest/reconstruct.ts";
import buyReceipt from "./fixtures/buy-bbl.json" with { type: "json" };

const raw = (buyReceipt as { result: RawReceipt }).result;
const wallet = "0x662053fd75f1f7da7e524d884b96552a13d2800b" as Address;
const token = "0xdf2e15395bc8a2078187eecee8eb024aa57e0265" as Address;

function context(receipt: RawReceipt) {
  const kinds = new Map(
    participants(receipt, QUOTE_TOKENS).map((a) => [a, a === wallet ? "eoa" : "contract"] as const),
  );
  return { wallets: new Set([wallet]), quote: QUOTE_TOKENS, decimals: new Map([[token, 18]]), kinds, ts: 1 };
}

test("a receipt comes back as the transfers that went in, amounts exact to the wei", () => {
  const parsed = parse(raw);
  saveReceipt(parsed, 1788536209);
  const stored = getReceipt(raw.transactionHash)!;
  expect(stored.ts).toBe(1788536209);
  expect(stored.block).toBe(parsed.block);
  expect(stored.transfers).toEqual(parsed.transfers);
  // The same fill, whichever shape the reconstruction is handed.
  expect(reconstruct(stored, context(raw))).toEqual(reconstruct(raw, context(raw)));
});

test("storing a receipt twice is a no-op, and a missing timestamp is filled in later", () => {
  const parsed = { ...parse(raw), tx: `0x${"ab".repeat(32)}` as `0x${string}` };
  saveReceipt(parsed, null);
  expect(getReceipt(parsed.tx)!.ts).toBeNull();
  saveReceipt(parsed, 42);
  const stored = getReceipt(parsed.tx)!;
  expect(stored.ts).toBe(42);
  expect(stored.transfers).toHaveLength(parsed.transfers.length);
});
