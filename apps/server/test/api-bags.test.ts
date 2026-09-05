/** The bags: fomo's positions, the ones read off the tape when fomo published none, and
 *  what each of them counts. */
import { expect, test } from "bun:test";
import {
  api,
  fill,
  insertFills,
  now,
  recordBagHistory,
  saveBagQuote,
  saveBagToken,
  saveHoldings,
  savePrice,
  saveToken,
  wallets,
} from "./support/api.ts";

test("a bag carries fomo's numbers, the feed's quote, its own tape flow and its change over the window", async () => {
  const trader = wallets[0]!;
  const seller = wallets[1]!;
  const token = "0x5555555555555555555555555555555555555555";

  // Two hours ago the bag was one small position; a snapshot remembers that.
  saveHoldings(
    trader.handle,
    [{ token, network: 4663, image_url: null, amount: 3, price: 3, value: 10, pnl: 2 }],
    now - 7200,
  );
  recordBagHistory(now - 7200);
  // The same address held on the tracked chain and on BSC: two bags, one of them ours.
  saveHoldings(
    trader.handle,
    [{ token, network: 4663, image_url: null, amount: 10, price: 3, value: 30, pnl: 20 }],
    now,
  );
  saveHoldings("someone", [{ token, network: 56, image_url: null, amount: 4, price: 5, value: 20, pnl: 5 }], now);
  saveBagToken(token, 56, "MARS", "MarsCoin", now);
  // The feed quotes both: ours into prices, the BSC one beside its name.
  savePrice(
    token,
    { price: 3.3, liquidity: 50_000, change24: 12.5, pairCreatedAt: (now - 86_400) * 1000, pair: "0xpool" },
    now,
  );
  saveBagQuote(token, 56, { price: 5.5, liquidity: 9_000, change24: -4, pairCreatedAt: null, pair: null }, now);
  insertFills([
    fill({ tx: "0xbag-test", block: 2, ts: now - 600, wallet: trader.address, token, amount: 10, usd: 30, price: 3 }),
    fill({
      tx: "0xbag-test-sell",
      block: 3,
      ts: now - 60,
      wallet: seller.address,
      token,
      side: "sell",
      amount: 4,
      usd: 12,
      price: 3,
    }),
  ]);

  const res = await api.request("/api/bags?window=1h&limit=50");
  const bags = (await res.json()) as Record<string, unknown>[];
  const here = bags.find((bag) => bag.token === token && bag.network === 4663)!;
  const abroad = bags.find((bag) => bag.token === token && bag.network === 56)!;

  // Ours: the fills, who bought first, the net flow, and the live quote from prices.
  expect(here).toMatchObject({
    source: "fomo",
    holders: 1,
    value: 30,
    pnl: 20,
    top_value: 30,
    fills: 2,
    buys: 1,
    bought_usd: 30,
    sold_usd: 12,
    traders_in: 2,
    first_buyer: trader.handle,
    first_buy_ts: now - 600,
    last_fill_ts: now - 60,
    price: 3.3,
    liquidity: 50_000,
    change24: 12.5,
    pair_address: "0xpool",
    is_stock: 0,
    holders_then: 1,
    value_then: 10,
  });
  // The one on BSC shares the address and nothing else: no fills, a name and a quote from the feed.
  expect(abroad).toMatchObject({
    fills: 0,
    symbol: "MARS",
    price: 5.5,
    liquidity: 9_000,
    change24: -4,
    holders_then: null,
  });
  // Off the window, there is no snapshot to diff against.
  const all = (await (await api.request("/api/bags?window=all&limit=50")).json()) as Record<string, unknown>[];
  expect(all.find((bag) => bag.token === token && bag.network === 4663)!.value_then).toBeNull();
});

test("bags read off the tape when fomo published nothing", async () => {
  const trader = wallets[5]!;
  const token = "0x7777777777777777777777777777777777777777";
  saveToken(token, 18, "TAPE", "TapeCoin");
  savePrice(token, { price: 3.3, liquidity: 50_000, change24: 12.5, pairCreatedAt: null, pair: null }, now);
  // No saveHoldings anywhere: the position comes from the fills alone.
  insertFills([fill({ tx: "0xtape-bag-1", block: 9, wallet: trader.address, token, amount: 10, usd: 30, price: 3 })]);

  const bags = (await (await api.request("/api/bags?window=all&limit=200")).json()) as Record<string, unknown>[];
  const row = bags.find((bag) => bag.token === token)!;
  expect(row).toMatchObject({
    source: "tape",
    network: 4663,
    symbol: "TAPE",
    holders: 1,
    amount: 10,
    fills: 1,
    buys: 1,
    bought_usd: 30,
    sold_usd: 0,
    traders_in: 1,
    first_buyer: trader.handle,
    top_holder: trader.handle,
    price: 3.3,
    holders_then: null,
    value_then: null,
    is_stock: 0,
  });
  // Net ten tokens at the feed's mark of 3.3, bought at 3: value and profit, measured.
  expect(row.value as number).toBeCloseTo(33);
  expect(row.top_value as number).toBeCloseTo(33);
  expect(row.pnl as number).toBeCloseTo(3);
  expect(row.holders_list as unknown[]).toHaveLength(1);
});

test("a tape bag counts the wallets still long; a sale of tokens bought before the tape does not cancel them", async () => {
  const [first, second, seller] = [wallets[6]!, wallets[7]!, wallets[8]!];
  const token = "0x8888888888888888888888888888888888888888";
  savePrice(token, { price: 2, liquidity: 1_000, change24: 0, pairCreatedAt: null, pair: null }, now);
  insertFills([
    fill({ tx: "0xlong-1", block: 11, ts: now - 30, wallet: first.address, token, amount: 10, usd: 10, price: 1 }),
    fill({ tx: "0xlong-2", block: 12, ts: now - 20, wallet: second.address, token, amount: 10, usd: 10, price: 1 }),
    // Bought before the tape began and sold on it: a position this tape only saw the end of.
    fill({
      tx: "0xexit",
      block: 13,
      ts: now - 10,
      wallet: seller.address,
      token,
      side: "sell",
      amount: 100,
      usd: 200,
      price: 2,
    }),
  ]);

  const bags = (await (await api.request("/api/bags?window=1h&limit=200")).json()) as Record<string, unknown>[];
  const row = bags.find((bag) => bag.token === token)!;
  // Two wallets long twenty tokens at a mark of 2, bought at 1; the exit is flow, not a holding.
  expect(row).toMatchObject({
    source: "tape",
    holders: 2,
    amount: 20,
    value: 40,
    top_value: 20,
    pnl: 20,
    fills: 3,
    buys: 2,
    bought_usd: 20,
    sold_usd: 200,
    traders_in: 3,
    first_buyer: first.handle,
  });
  const holders = (row.holders_list as { handle: string; value: number }[]).map((h) => h.handle).sort();
  expect(holders).toEqual([first.handle, second.handle].sort());
});
