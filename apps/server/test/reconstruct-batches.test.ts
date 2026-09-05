/** One transaction, several trades: which cash belongs to which leg, what a fee taken on
 *  the side does to the sum, and a delivery that arrives in pieces. */
import { expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { QUOTE_TOKENS } from "../src/config.ts";
import { participants, type RawReceipt, reconstruct } from "../src/ingest/reconstruct.ts";
import { alice, blue, bob, buy, context, pool, red, sell, transferLog, twoBuyers, USDG } from "./support/receipts.ts";

test("a batched route prices each leg from the cash in its own range", () => {
  const receipt: RawReceipt = {
    transactionHash: "0xba7c",
    blockNumber: "0x1",
    logs: [
      transferLog(0, USDG, pool, "0x6666666666666666666666666666666666666666", 200_000_000n),
      transferLog(1, red, pool, alice, 2_000000000000000000n),
      transferLog(2, USDG, pool, "0x6666666666666666666666666666666666666666", 600_000_000n),
      transferLog(3, blue, pool, bob, 3_000000000000000000n),
    ],
  };
  const fills = reconstruct(receipt, twoBuyers);
  expect(fills.map((f) => f.priced)).toEqual(["cash_leg", "cash_leg"]);
  expect(fills[0]!.usd).toBe(200);
  expect(fills[1]!.usd).toBe(600);
});

test("legs with no cash in range are estimated from the feed", () => {
  const receipt: RawReceipt = {
    transactionHash: "0xba7d",
    blockNumber: "0x1",
    logs: [
      transferLog(0, red, pool, alice, 2_000000000000000000n),
      transferLog(1, blue, pool, bob, 3_000000000000000000n),
    ],
  };
  const fills = reconstruct(receipt, twoBuyers);
  expect(fills.map((f) => f.priced)).toEqual(["estimate", "estimate"]);
  expect(fills[0]!.usd).toBe(200); // 2 × $100
  expect(fills[1]!.usd).toBe(600); // 3 × $200
});

/** Two real transactions glued into one receipt, the way a relayer batches several traders' swaps. */
function batched(first: RawReceipt, second: RawReceipt): RawReceipt {
  const logs = [...first.logs, ...second.logs].map((log, i) => ({ ...log, logIndex: `0x${i.toString(16)}` as Hex }));
  return { transactionHash: "0xbatch", blockNumber: first.blockNumber, logs };
}

test("a batch of two traders' swaps prices each from its own log range", () => {
  for (const [a, b] of [
    [buy, sell],
    [sell, buy],
  ] as const) {
    const receipt = batched(a.receipt, b.receipt);
    const traders = [buy.wallet, sell.wallet];
    const fills = reconstruct(receipt, context(receipt, traders));
    expect(fills).toHaveLength(2);
    const ofBuy = fills.find((f) => f.wallet === buy.wallet)!;
    const ofSell = fills.find((f) => f.wallet === sell.wallet)!;
    expect(ofBuy.amount).toBeCloseTo(buy.amount, 6);
    expect(ofSell.amount).toBeCloseTo(sell.amount, 6);
    if (a === buy) {
      // buy then sell: both ranges are clean
      expect(ofBuy.priced).toBe("cash_leg");
      expect(ofBuy.usd!).toBeCloseTo(buy.usd, 6);
      expect(ofSell.priced).toBe("cash_leg");
      expect(ofSell.usd!).toBeCloseTo(sell.usd, 6);
    } else {
      // sell then buy by another trader: their cash shares one gap, so neither is guessed
      expect(ofSell.priced).toBe("unpriced");
      expect(ofBuy.priced).toBe("unpriced");
    }
  }
});

/** The buy receipt with an extra transfer of the bought token to `collector`, placed just before the trader's own leg. */
function withSideTransfer(collector: Address, share: bigint): RawReceipt {
  const receipt = structuredClone(buy.receipt);
  const own = receipt.logs.findIndex(
    (log) => log.address.toLowerCase() === buy.token && log.topics[2]?.toLowerCase().endsWith(buy.wallet.slice(2)),
  );
  const template = receipt.logs[own]!;
  const value = (BigInt(template.data) * share) / 1000n;
  receipt.logs.splice(own, 0, {
    ...template,
    topics: [template.topics[0]!, template.topics[1]!, `0x${collector.slice(2).padStart(64, "0")}` as Hex],
    data: `0x${value.toString(16).padStart(64, "0")}` as Hex,
    logIndex: `0x${(Number(template.logIndex) - 1).toString(16)}` as Hex,
  });
  return receipt;
}

test("a hook's fee to a collector wallet does not split the trader's cash away", () => {
  const collector = "0x92d435d8f6a5b1c2d3e4f5a6b7c8d9e0f1a2b3c4" as Address;
  const receipt = withSideTransfer(collector, 2n); // 0.2 % of the buy, like a launchpad hook
  const ctx = context(receipt, [buy.wallet]);
  expect(participants(receipt, QUOTE_TOKENS)).not.toContain(collector);
  const fills = reconstruct(receipt, { ...ctx, kinds: new Map([...ctx.kinds, [collector, "eoa"]]) });
  expect(fills).toHaveLength(1);
  expect(fills[0]!.priced).toBe("cash_leg");
  expect(fills[0]!.usd!).toBeCloseTo(buy.usd, 6);
});

test("a tracked wallet's fill is kept however small it is next to the rest of the transaction", () => {
  const tracked = "0x6ac31557234e5fe1582eb6f338c169315c433095" as Address;
  const receipt = withSideTransfer(tracked, 2n); // an airdrop-sized 0.2 % of the big buy
  const fills = reconstruct(receipt, context(receipt, [buy.wallet, tracked]));
  expect(fills.map((f) => f.wallet).sort()).toEqual([tracked, buy.wallet].sort());
  const small = fills.find((f) => f.wallet === tracked)!;
  expect(small.side).toBe("buy");
  expect(small.amount).toBeCloseTo(buy.amount * 0.002, 3);
});

test("another account taking a real share of the token is a trader, and its leg bounds ours", () => {
  const other = "0x92d435d8f6a5b1c2d3e4f5a6b7c8d9e0f1a2b3c4" as Address;
  const receipt = withSideTransfer(other, 500n); // half the size of the buy
  const ctx = context(receipt, [buy.wallet]);
  expect(participants(receipt, QUOTE_TOKENS)).toContain(other);
  const fills = reconstruct(receipt, { ...ctx, kinds: new Map([...ctx.kinds, [other, "eoa"]]) });
  expect(fills).toHaveLength(1);
  // The cash sits before the other trader's leg, so ours is left to the feed instead of borrowing it.
  expect(fills[0]!.priced).toBe("unpriced");
});

test("a token delivered in two transfers is one fill with the full amount", () => {
  const receipt = structuredClone(buy.receipt);
  const last = receipt.logs.findLast((log) => log.address.toLowerCase() === buy.token)!;
  const value = BigInt(last.data);
  const half = value / 2n;
  last.data = `0x${half.toString(16).padStart(64, "0")}` as Hex;
  receipt.logs.push({
    ...last,
    data: `0x${(value - half).toString(16).padStart(64, "0")}` as Hex,
    logIndex: "0xff" as Hex,
  });
  const fills = reconstruct(receipt, context(receipt, [buy.wallet]));
  expect(fills).toHaveLength(1);
  expect(fills[0]!.amount).toBeCloseTo(buy.amount, 6);
  expect(fills[0]!.usd!).toBeCloseTo(buy.usd, 6);
});
