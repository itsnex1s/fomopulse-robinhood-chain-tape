import { expect, test } from "bun:test";
import { BY, barWidth, holderTitle, name, net, remarked, ret, retLabel } from "./bags-math.ts";
import type { Bag } from "./types.ts";

const bag = (over: Partial<Bag>): Bag => ({
  token: "0x5555555555555555555555555555555555555555",
  network: 4663,
  image_url: null,
  symbol: "MARS",
  name: "MarsCoin",
  is_stock: 0,
  source: "fomo",
  holders: 2,
  value: 30,
  pnl: 20,
  top_value: 30,
  amount: 10,
  price: 3.3,
  quoted_at: 1_700_000_000,
  liquidity: 50_000,
  change24: 12.5,
  pair_created_at: null,
  pair_address: "0xpool",
  updated_at: 1_700_000_100,
  top_holder: "alice",
  fills: 2,
  buys: 1,
  bought_usd: 30,
  sold_usd: 12,
  traders_in: 2,
  last_fill_ts: 1_700_000_050,
  first_buyer: "alice",
  first_buy_ts: 1_700_000_000,
  holders_then: 1,
  value_then: 10,
  holders_list: [],
  ...over,
});

test("return on cost, and when it cannot be read", () => {
  // $20 of profit out of $10 of cost is a 200% return.
  expect(ret(30, 20)).toBeCloseTo(2);
  expect(retLabel(2)).toBe("+200%");
  expect(retLabel(19)).toBe("20×");
  // No profit, no cost, no value: the dollars stand alone.
  expect(ret(30, null)).toBeNull();
  expect(ret(10, 20)).toBeNull();
  expect(ret(null, 5)).toBeNull();
});

test("the bar fits $1 and $500M on one scale", () => {
  expect(barWidth(1)).toBe("4px");
  expect(barWidth(500_000_000)).toBe("96px");
  expect(barWidth(1000)).toBe(barWidth(1000));
});

test("flow is bought less sold, and sorts below everything when there is none", () => {
  expect(net(bag({}))).toBe(18);
  expect(BY.flow(bag({ fills: 0 }))).toBe(-Infinity);
  expect(BY.value(bag({ value: null }))).toBe(-Infinity);
  expect(name(bag({ symbol: null }))).toBe("0x555555…");
});

test("the hover re-marks the position at the feed's price", () => {
  expect(remarked(bag({}))).toContain("at the feed's mark:");
  expect(remarked(bag({ price: null }))).toBe("");
  expect(remarked(bag({ pnl: null }))).toBe("");
  expect(holderTitle({ handle: "alice", value: 30, pnl: 20, avatar_url: null })).toContain("alice · $30");
});
