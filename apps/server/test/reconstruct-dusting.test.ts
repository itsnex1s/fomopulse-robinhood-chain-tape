/** The dusting rule: what a token handed over for nothing is worth, decided without any
 *  history of the token at all. */
import { expect, test } from "bun:test";
import type { Address } from "viem";
import {
  DUSTED,
  HANDOUT,
  type Kind,
  type RawReceipt,
  type ReconstructContext,
  reconstruct,
  TRADE,
} from "../src/ingest/reconstruct.ts";
import airdropReceipt from "./fixtures/airdrop-chad.json" with { type: "json" };
import { alice, buy, context, pool, red, transferLog, twoBuyers } from "./support/receipts.ts";

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

  expect(of({ prices: worth(0.04) }).dust).toBe(DUSTED);
  // The same delivery of something worth having is not dusting.
  expect(of({ prices: worth(400) }).dust).toBe(TRADE);
  // Neither is a tokenised stock, which fomo settles out of an account of its own.
  expect(of({ prices: worth(0.04), isStock: () => true }).dust).toBe(TRADE);
  // Nor one handed over by something that took payment in the same transaction: the buy
  // fixture is a real swap, and its counterparty receives the cash leg back.
  const swap = reconstruct(buy.receipt, context(buy.receipt, [buy.wallet], { prices: worth(0.04) }));
  expect(swap[0]!.dust).toBe(TRADE);
});

test("a fill paid for in the same transaction is never dusting, however small", () => {
  const fills = reconstruct(buy.receipt, context(buy.receipt, [buy.wallet]));
  expect(fills[0]!.priced).toBe("cash_leg");
  expect(fills[0]!.dust).toBe(TRADE);
});

/** One sender pushing the same amount to `count` wallets at once, the tracked one among them. */
function spray(count: number): { receipt: RawReceipt; ctx: ReconstructContext } {
  const each = 1_000000000000000000n;
  // Distinct from the named addresses above, which are all one repeated digit.
  const wallets = [
    alice,
    ...Array.from({ length: count - 1 }, (_, i) => `0x${(0xa1 + i).toString(16).repeat(20)}` as Address),
  ];
  const kinds = new Map<string, Kind>([[pool, "contract"]]);
  for (const w of wallets) kinds.set(w, "eoa");
  return {
    receipt: {
      transactionHash: "0x5c1d",
      blockNumber: "0x1",
      logs: wallets.map((to, i) => transferLog(i, red, pool, to, each)),
    },
    ctx: { ...twoBuyers, kinds },
  };
}

/**
 * The half of the rule value cannot decide. A token with a live pool prices its own
 * airdrop, so a spray of it reads as a five-figure buy per wallet — which is how one
 * token's handouts came to be a third of a day's reported volume.
 */
test("the same amount handed to many wallets at once is a handout, whatever the pool says it is worth", () => {
  const many = spray(6);
  const fill = reconstruct(many.receipt, many.ctx)[0]!;
  expect(fill.wallet).toBe(alice);
  expect(fill.usd).toBe(100); // priced, and still not a trade
  expect(fill.dust).toBe(HANDOUT);

  // Under the threshold it is an ordinary delivery again, and worth enough to keep.
  const few = spray(4);
  expect(reconstruct(few.receipt, few.ctx)[0]!.dust).toBe(TRADE);
});
