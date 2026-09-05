/** What a real receipt reconstructs to: the fills, who made them, and what they cost —
 *  the numbers pinned against what the original site published for the same transactions. */
import { expect, test } from "bun:test";
import type { Address } from "viem";
import { QUOTE_TOKENS } from "../src/config.ts";
import { participants, type RawReceipt, reconstruct, tokensToResolve } from "../src/ingest/reconstruct.ts";
import airdropReceipt from "./fixtures/airdrop-chad.json" with { type: "json" };
import deliveryReceipt from "./fixtures/delivery-rkthd.json" with { type: "json" };
import { buy, context, kindsFor, sell } from "./support/receipts.ts";

for (const c of [buy, sell]) {
  test(c.name, () => {
    expect(tokensToResolve(c.receipt, new Set([c.wallet]), QUOTE_TOKENS)).toEqual([c.token]);

    const fills = reconstruct(c.receipt, context(c.receipt, [c.wallet]));

    expect(fills).toHaveLength(1);
    const f = fills[0]!;
    expect(f.wallet).toBe(c.wallet);
    expect(f.token).toBe(c.token);
    expect(f.side).toBe(c.side);
    expect(f.priced).toBe("cash_leg");
    expect(f.amount).toBeCloseTo(c.amount, 6);
    expect(f.usd!).toBeCloseTo(c.usd, 6);
    expect(f.price!).toBeCloseTo(c.price, 12);
    expect(f.tx).toBe(c.receipt.transactionHash);
  });
}

test("the traders are the only accounts whose token balance changed", () => {
  const seen = participants(buy.receipt, QUOTE_TOKENS);
  expect(seen).toContain(buy.wallet);
  // Relay's pass-through addresses net to zero and are not participants at all.
  expect(seen.length).toBeLessThan(buy.receipt.logs.length);
});

test("a transfer between two tracked wallets is inventory, not a fill", () => {
  const counterparty = "0xb92fe9b3d0d5b1f0c34a7cd2b1ab3f8a9c1b1a5c" as Address;
  const fills = reconstruct(buy.receipt, context(buy.receipt, [buy.wallet, counterparty]));
  expect(fills).toHaveLength(1); // the counterparty above is not the sender of the token leg
});

/**
 * Real transaction, one transfer long: fomo hands a tokenised stock to the trader from
 * an account of its own, with no pool and no cash anywhere in the receipt. The original
 * publishes it as a buy, and the same settlement to many wallets at once is already
 * recorded, so the single-recipient shape has to be too.
 */
test("a delivery from an account that is not tracked is the trader's buy", () => {
  const receipt = (deliveryReceipt as { result: RawReceipt }).result;
  const wallet = "0x0a6ebed0155edb4b21d92ad02897a626cd90119e" as Address;
  const token = "0x5803bc61b4c37d8231d4f39476f2749065b20136" as Address;
  const fills = reconstruct(receipt, context(receipt, [wallet], { prices: new Map([[token, 0.00004276]]) }));
  expect(fills).toHaveLength(1);
  expect(fills[0]!.side).toBe("buy");
  expect(fills[0]!.wallet).toBe(wallet);
  expect(fills[0]!.amount).toBeCloseTo(5_500_000, 6);
  expect(fills[0]!.priced).toBe("estimate");
});

test("no quote leg and no price leaves the fill unpriced instead of guessing", () => {
  const fills = reconstruct(buy.receipt, context(buy.receipt, [buy.wallet], { quote: new Map() }));
  expect(fills[0]!.priced).toBe("unpriced");
  expect(fills[0]!.usd).toBeNull();
});

test("no quote leg falls back to the price feed", () => {
  const fills = reconstruct(
    buy.receipt,
    context(buy.receipt, [buy.wallet], { quote: new Map(), prices: new Map([[buy.token, 0.0001]]) }),
  );
  expect(fills[0]!.priced).toBe("estimate");
  expect(fills[0]!.usd!).toBeCloseTo(buy.amount * 0.0001, 6);
  expect(fills[0]!.price!).toBe(0.0001);
});

test("an unknown participant sends the fill to the feed rather than mispricing it", () => {
  const kinds = kindsFor(buy.receipt, [buy.wallet]);
  const someone = [...kinds.keys()].find((a) => a !== buy.wallet)!;
  kinds.delete(someone);
  const fills = reconstruct(buy.receipt, context(buy.receipt, [buy.wallet], { kinds }));
  expect(fills).toHaveLength(1);
  expect(fills[0]!.priced).toBe("unpriced");
  expect(fills[0]!.usd).toBeNull();
});

/** Real transaction: one sender pushes one token to eleven wallets and no quote token moves. */
test("a distribution is recorded for the tracked recipients and left to the feed", () => {
  const receipt = (airdropReceipt as { result: RawReceipt }).result;
  const tracked = [
    "0x0121525f755c9e7bbc525bba6672716ab46ced57",
    "0x8224c04a8f66557df682fd0581eb3724bd2bee07",
  ] as Address[];
  const fills = reconstruct(receipt, context(receipt, tracked, { decimals: new Map() }));
  expect(fills.map((f) => f.wallet).sort()).toEqual([...tracked].sort());
  expect(fills.map((f) => f.side)).toEqual(["buy", "buy"]);
  expect(fills.map((f) => f.priced)).toEqual(["unpriced", "unpriced"]);
});
