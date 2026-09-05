/** The dusting rule: what a token handed over for nothing is worth, decided without any
 *  history of the token at all. */
import { expect, test } from "bun:test";
import type { Address } from "viem";
import { type RawReceipt, type ReconstructContext, reconstruct } from "../src/ingest/reconstruct.ts";
import airdropReceipt from "./fixtures/airdrop-chad.json" with { type: "json" };
import { buy, context } from "./support/receipts.ts";

/**
 * The point of the rule is that it needs no history: a token first seen a second ago is
 * already off the tape if nothing was paid for it anywhere in the transaction, it came
 * from an account rather than a pool, and it is worth cents.
 */
test("a token first seen in this transaction is dusting when nobody paid for it", () => {
  const receipt = (airdropReceipt as { result: RawReceipt }).result;
  const tracked = ["0x0121525f755c9e7bbc525bba6672716ab46ced57"] as Address[];
  const base = context(receipt, tracked, { decimals: new Map() });
  const delivered = reconstruct(receipt, base)[0]!;
  const worth = (usd: number) => new Map([[delivered.token, usd / delivered.amount]]);
  const of = (overrides: Partial<ReconstructContext>) => reconstruct(receipt, { ...base, ...overrides })[0]!;

  expect(of({ prices: worth(0.04) }).dust).toBe(true);
  // The same delivery of something worth having is not dusting.
  expect(of({ prices: worth(400) }).dust).toBe(false);
  // Neither is a tokenised stock, which fomo settles out of an account of its own.
  expect(of({ prices: worth(0.04), isStock: () => true }).dust).toBe(false);
  // Nor one handed over by something that took payment in the same transaction: the buy
  // fixture is a real swap, and its counterparty receives the cash leg back.
  const swap = reconstruct(buy.receipt, context(buy.receipt, [buy.wallet], { prices: worth(0.04) }));
  expect(swap[0]!.dust).toBe(false);
});

test("a fill paid for in the same transaction is never dusting, however small", () => {
  const fills = reconstruct(buy.receipt, context(buy.receipt, [buy.wallet]));
  expect(fills[0]!.priced).toBe("cash_leg");
  expect(fills[0]!.dust).toBe(false);
});
