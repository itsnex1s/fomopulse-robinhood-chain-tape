/** The bags: net positions read off the tape, what each of them counts, and how they moved. */
import { expect, test } from "bun:test";
import { tapeHolders } from "../src/db.ts";
import { api, fill, insertFills, now, recordBagHistory, savePrice, saveToken, wallets } from "./support/api.ts";

const CHAIN = 4663;

test("a bag is the net position, the feed's quote, its own tape flow and its change over the window", async () => {
  const trader = wallets[0]!;
  const seller = wallets[1]!;
  const token = "0x5555555555555555555555555555555555555555";
  saveToken(token, 18, "MARS", "MarsCoin");
  savePrice(
    token,
    { price: 3, liquidity: 50_000, change24: 12.5, pairCreatedAt: (now - 86_400) * 1000, pair: "0xpool" },
    now - 7200,
  );

  // Two hours ago the bag was one small position, and the hour's snapshot remembers it.
  insertFills([
    fill({ tx: "0xbag-old", block: 1, ts: now - 7800, wallet: trader.address, token, amount: 3, usd: 9, price: 3 }),
  ]);
  recordBagHistory(now - 7200, CHAIN);

  // Since then one wallet bought more and another sold into it.
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
  savePrice(
    token,
    { price: 3.3, liquidity: 50_000, change24: 12.5, pairCreatedAt: (now - 86_400) * 1000, pair: "0xpool" },
    now,
  );

  const res = await api.request("/api/bags?window=1h&limit=50");
  const bags = (await res.json()) as Record<string, unknown>[];
  const bag = bags.find((row) => row.token === token)!;

  expect(bag).toMatchObject({
    network: CHAIN,
    symbol: "MARS",
    // The seller went short on this tape and is not counted as holding anything.
    holders: 1,
    amount: 13,
    fills: 2,
    buys: 1,
    bought_usd: 30,
    sold_usd: 12,
    traders_in: 2,
    first_buyer: trader.handle,
    top_holder: trader.handle,
    first_buy_ts: now - 7800,
    last_fill_ts: now - 60,
    price: 3.3,
    liquidity: 50_000,
    change24: 12.5,
    pair_address: "0xpool",
    is_stock: 0,
    // What the snapshot two hours ago holds: one wallet, three tokens at three dollars.
    holders_then: 1,
    value_then: 9,
  });
  // Thirteen tokens at the feed's mark of 3.3, bought at 3.
  expect(bag.value as number).toBeCloseTo(42.9);
  expect(bag.pnl as number).toBeCloseTo(3.9);

  // Off the window there is no snapshot old enough to diff against.
  const all = (await (await api.request("/api/bags?window=all&limit=50")).json()) as Record<string, unknown>[];
  expect(all.find((row) => row.token === token)!.value_then).toBeNull();
});

test("a bag exists on the strength of the fills alone", async () => {
  const trader = wallets[5]!;
  const token = "0x7777777777777777777777777777777777777777";
  saveToken(token, 18, "TAPE", "TapeCoin");
  savePrice(token, { price: 3.3, liquidity: 50_000, change24: 12.5, pairCreatedAt: null, pair: null }, now);
  insertFills([fill({ tx: "0xtape-bag-1", block: 9, wallet: trader.address, token, amount: 10, usd: 30, price: 3 })]);

  const bags = (await (await api.request("/api/bags?window=all&limit=200")).json()) as Record<string, unknown>[];
  const row = bags.find((bag) => bag.token === token)!;
  expect(row).toMatchObject({
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

/**
 * The snapshot is one row an hour, but the reading behind it is a grouped pass over every
 * fill on the tape. The quote pass runs twenty times an hour, and nineteen of those used to
 * do the whole pass to write nothing.
 */
test("the hour is snapshotted once, however often the quote pass comes round", () => {
  // Off the hour itself, so a run in the last minute of one does not step into the next.
  const hour = now - (now % 3_600);
  expect(recordBagHistory(hour + 10, CHAIN)).toBe(true);
  expect(recordBagHistory(hour + 70, CHAIN)).toBe(false);
  // A new hour is a new snapshot.
  expect(recordBagHistory(hour + 3_600, CHAIN)).toBe(true);
});

/**
 * Durable Object SQL takes a hundred bound variables and bun:sqlite takes thousands, so a
 * page wider than one query only breaks where it is deployed. Two hundred bags is the
 * default the web app asks for.
 */
test("a page of bags wider than one query still finds every bag's holders", () => {
  const holder = wallets[9]!;
  const tokens = Array.from({ length: 120 }, (_, i): `0x${string}` => `0x9${i.toString(16).padStart(39, "0")}`);
  insertFills(
    tokens.map((token, i) =>
      fill({
        tx: `0xwide-${i}`,
        block: 200 + i,
        ts: now - 40,
        wallet: holder.address,
        token,
        amount: 2,
        usd: 1,
        price: 0.5,
      }),
    ),
  );
  for (const token of tokens)
    savePrice(token, { price: 0.5, liquidity: 10, change24: 0, pairCreatedAt: null, pair: null }, now);

  const held = tapeHolders(tokens);
  expect(held.size).toBe(tokens.length);
  for (const token of tokens) expect(held.get(token)).toEqual([{ wallet: holder.address, value: 1 }]);
});

/**
 * Buys and sells that cancel exactly leave a rounding residue behind, and `amount > 0` read
 * it as a position: wallets holding 1e-17 of a token counted as holders and put their whole
 * cost into the bag's average price.
 */
test("what buys and sells left behind as rounding is not a position", async () => {
  const [closed, holding] = [wallets[10]!, wallets[11]!];
  const token = "0xc105111111111111111111111111111111111111";
  saveToken(token, 18, "SHUT", "ShutCoin");
  savePrice(token, { price: 1, liquidity: 1_000, change24: 0, pairCreatedAt: null, pair: null }, now);
  insertFills([
    // In and out for the same tokens, less a trillionth of what went through.
    fill({ tx: "0xshut-in", block: 400, ts: now - 50, wallet: closed.address, token, amount: 1_000, usd: 500 }),
    fill({
      tx: "0xshut-out",
      block: 401,
      ts: now - 40,
      wallet: closed.address,
      token,
      side: "sell",
      amount: 1_000 - 1e-13,
      usd: 600,
      price: 0.6,
    }),
    // And one wallet that actually kept something.
    fill({ tx: "0xshut-hold", block: 402, ts: now - 30, wallet: holding.address, token, amount: 10, usd: 10 }),
  ]);

  // A limit of its own: answers are held for fifteen seconds per query, and the whole file
  // runs inside one of those.
  const bags = (await (await api.request("/api/bags?window=1h&limit=180")).json()) as Record<string, unknown>[];
  const row = bags.find((bag) => bag.token === token)!;
  // Both wallets traded it, only one is long, and the average cost is that one's alone.
  expect(row).toMatchObject({ holders: 1, amount: 10, traders_in: 2, pnl: 0 });
  expect((row.holders_list as { handle: string }[]).map((h) => h.handle)).toEqual([holding.handle]);
});
