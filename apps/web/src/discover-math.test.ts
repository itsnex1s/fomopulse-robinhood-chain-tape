import { expect, test } from "bun:test";
import { BY, CUTS, churn, growth, growthLabel, keep, name, net } from "./discover-math.ts";
import type { Discover } from "./types.ts";

const row = (over: Partial<Discover>): Discover => ({
  token: "0xd15c000000000000000000000000000000000001",
  symbol: "NEWCO",
  name: "New Company",
  image_url: null,
  is_stock: 0,
  price: 2,
  quoted_at: 1_700_000_000,
  liquidity: 50_000,
  change24: 10,
  volume24: 100_000,
  buys24: 40,
  sells24: 10,
  market_cap: 200_000,
  dex: "uniswap v4",
  pair_created_at: 1_700_000_000_000,
  pair_address: "0xpool",
  buyers: 3,
  buyers_recent: 2,
  sellers: 1,
  fills: 4,
  bought_usd: 300,
  sold_usd: 50,
  last_fill_ts: 1_700_000_100,
  holders: 3,
  holders_then: 1,
  first_buyer: "alice",
  first_buy_ts: 1_700_000_050,
  first_lag: 3_600,
  mcap_at: 100_000,
  dusted: 0,
  wash: 0,
  best_rank: 7,
  buyers_list: [],
  ...over,
});

test("what a token has done is measured against the cap the first tracked wallet paid", () => {
  expect(growth(row({}))).toBeCloseTo(2);
  expect(growthLabel(2)).toBe("2×");
  expect(growthLabel(1.4)).toBe("+40%");
  expect(growthLabel(0.25)).toBe("−75%");
  // Nothing priced the first buy, or the feed has no cap now: there is no multiple to show.
  expect(growth(row({ mcap_at: null }))).toBeNull();
  expect(growth(row({ market_cap: null }))).toBeNull();
  expect(growth(row({ mcap_at: 0 }))).toBeNull();
});

test("flow is what went in less what came out, and churn is the day over the depth", () => {
  expect(net(row({}))).toBe(250);
  expect(churn(row({}))).toBeCloseTo(2);
  expect(churn(row({ liquidity: 0 }))).toBeNull();
  expect(churn(row({ volume24: null }))).toBeNull();
  expect(name(row({ symbol: null }))).toBe("0xd15c00…");
});

test("the cuts the reader keeps: a lone buyer, a wash, and a token no ranked wallet touched", () => {
  expect(keep(row({}), CUTS)).toBe(true);
  expect(keep(row({ buyers: 1 }), CUTS)).toBe(false);
  expect(keep(row({ buyers: 1 }), { ...CUTS, minBuyers: 1 })).toBe(true);
  expect(keep(row({ wash: 2 }), CUTS)).toBe(false);
  expect(keep(row({ wash: 2 }), { ...CUTS, hideWash: false })).toBe(true);
  expect(keep(row({ best_rank: null }), { ...CUTS, rankedOnly: true })).toBe(false);
});

test("heat puts who came in just now over who has ever been in", () => {
  const busy = row({ buyers_recent: 5, buyers: 6 });
  const crowded = row({ buyers_recent: 1, buyers: 40 });
  expect(BY.heat(busy)).toBeGreaterThan(BY.heat(crowded));
  // Newest pool first, like every other column's largest-first order.
  expect(BY.age(row({ pair_created_at: 2 }))).toBeGreaterThan(BY.age(row({ pair_created_at: 1 })));
  expect(BY.growth(row({ mcap_at: null }))).toBe(-Infinity);
});
