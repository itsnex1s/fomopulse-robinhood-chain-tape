/** Discover: the young pools a tracked wallet bought into, and everything the page cuts before it. */
import { expect, test } from "bun:test";
import { api, fill, insertFills, now, savePrice, saveToken, wallets } from "./support/api.ts";

const HOUR = 3_600;
/** The memo in front of the route is keyed on window and limit, so each test asks for its own
 *  page size rather than reading the answer the one before it left behind. */
const page = async (limit: number) => {
  const res = await api.request(`/api/discover?window=24h&limit=${limit}`);
  return (await res.json()) as Record<string, unknown>[];
};

const pool = (token: string, over: Partial<{ liquidity: number; volume24: number; born: number; mcap: number }> = {}) =>
  savePrice(
    token,
    {
      price: 2,
      liquidity: over.liquidity ?? 50_000,
      change24: 10,
      pairCreatedAt: (now - (over.born ?? 6 * HOUR)) * 1_000,
      pair: `${token}pool`,
      volume24: over.volume24 ?? 30_000,
      marketCap: over.mcap ?? 200_000,
    },
    now,
  );

test("a young pool carries this tape's own count of who is in it, and the feed's card for the pool", async () => {
  const token = "0xd15c000000000000000000000000000000000001";
  const [first, second, third, seller] = [wallets[20]!, wallets[21]!, wallets[22]!, wallets[23]!];
  saveToken(token, 18, "NEWCO", "New Company");
  pool(token);

  insertFills([
    // The first tracked wallet in, an hour after the pool opened, at half the price it marks now.
    fill({
      tx: "0xdisc-1",
      block: 1,
      ts: now - 5 * HOUR,
      wallet: first.address,
      token,
      amount: 100,
      usd: 100,
      price: 1,
    }),
    fill({
      tx: "0xdisc-2",
      block: 2,
      ts: now - 4 * HOUR,
      wallet: second.address,
      token,
      amount: 50,
      usd: 100,
      price: 2,
    }),
    fill({
      tx: "0xdisc-3",
      block: 3,
      ts: now - 3 * HOUR,
      wallet: third.address,
      token,
      amount: 50,
      usd: 100,
      price: 2,
    }),
    fill({
      tx: "0xdisc-4",
      block: 4,
      ts: now - 2 * HOUR,
      wallet: seller.address,
      token,
      side: "sell",
      amount: 25,
      usd: 50,
      price: 2,
    }),
    // A handout of the same token is counted apart and never as a buyer. Dusted as a handout
    // rather than on value, which the pardon would undo once the token trades for real.
    fill({ tx: "0xdisc-5", block: 5, ts: now - HOUR, wallet: wallets[24]!.address, token, amount: 9, usd: 0, dust: 2 }),
  ]);

  const row = (await page(61)).find((r) => r.token === token)!;
  expect(row).toMatchObject({
    symbol: "NEWCO",
    is_stock: 0,
    buyers: 3,
    buyers_recent: 3,
    sellers: 1,
    fills: 4,
    dusted: 1,
    bought_usd: 300,
    sold_usd: 50,
    holders: 3,
    first_buyer: first.handle,
    first_buy_ts: now - 5 * HOUR,
    // The pool opened an hour before the first tracked wallet found it.
    first_lag: HOUR,
    liquidity: 50_000,
    market_cap: 200_000,
    wash: 0,
  });
  // Bought at a dollar against a two-dollar mark on a $200k token: half the market cap now.
  expect(row.mcap_at).toBeCloseTo(100_000, 6);
  const buyers = row.buyers_list as { handle: string; usd: number }[];
  expect(buyers.map((b) => b.handle)).toEqual([first.handle, second.handle, third.handle]);
  expect(buyers[0]!.usd).toBe(100);
});

test("a pool too shallow, too churned or too old to be a discovery never reaches the page", async () => {
  const thin: `0x${string}` = "0xd15c000000000000000000000000000000000002";
  const churned: `0x${string}` = "0xd15c000000000000000000000000000000000003";
  const old: `0x${string}` = "0xd15c000000000000000000000000000000000004";
  const buyer = wallets[25]!;
  for (const [token, symbol] of [
    [thin, "THIN"],
    [churned, "CHURN"],
    [old, "OLD"],
  ] as const)
    saveToken(token, 18, symbol, symbol);
  pool(thin, { liquidity: 2_000 });
  // Twenty-five times its own depth crossed the pool in a day, which is not the market's volume.
  pool(churned, { liquidity: 20_000, volume24: 500_000 });
  pool(old, { born: 5 * 86_400 });

  insertFills(
    [thin, churned, old].map((token, n) =>
      fill({
        tx: `0xdisc-cut-${n}`,
        block: 10 + n,
        ts: now - HOUR,
        wallet: buyer.address,
        token,
        amount: 10,
        usd: 100,
      }),
    ),
  );

  const tokens = (await page(62)).map((r) => r.token);
  expect(tokens).not.toContain(thin);
  expect(tokens).not.toContain(churned);
  expect(tokens).not.toContain(old);
});

test("a token that was only sprayed is not a token anybody bought", async () => {
  const token = "0xd15c000000000000000000000000000000000005";
  saveToken(token, 18, "SPRAYED", "Sprayed");
  pool(token);
  insertFills([
    fill({
      tx: "0xdisc-spray",
      block: 20,
      ts: now - HOUR,
      wallet: wallets[26]!.address,
      token,
      amount: 1_000,
      usd: 0,
      price: null,
      priced: "unpriced",
      dust: 2,
    }),
  ]);

  expect((await page(63)).map((r) => r.token)).not.toContain(token);
});

test("a buy cancelled by a sell of the same size minutes later is counted, not hidden", async () => {
  const token = "0xd15c000000000000000000000000000000000006";
  const washer = wallets[27]!;
  saveToken(token, 18, "WASHED", "Washed");
  pool(token);
  insertFills([
    fill({ tx: "0xdisc-w1", block: 30, ts: now - 2 * HOUR, wallet: washer.address, token, amount: 1_000, usd: 500 }),
    fill({
      tx: "0xdisc-w2",
      block: 31,
      ts: now - 2 * HOUR + 60,
      wallet: washer.address,
      token,
      side: "sell",
      amount: 1_000,
      usd: 500,
    }),
    // A real buyer after it, so the token still has somebody in it to show.
    fill({ tx: "0xdisc-w3", block: 32, ts: now - HOUR, wallet: wallets[28]!.address, token, amount: 10, usd: 100 }),
  ]);

  const row = (await page(64)).find((r) => r.token === token)!;
  expect(row).toMatchObject({ wash: 1, buyers: 2, sellers: 1, holders: 1 });
});

test("a first buy that took its price from the quote still standing measures nothing", async () => {
  const token = "0xd15c000000000000000000000000000000000007";
  saveToken(token, 18, "GUESSED", "Guessed");
  pool(token);
  insertFills([
    // Priced off the feed at the very quote the page marks against: the two ends of the
    // multiple are one number, and a token that never moved is not what that says.
    fill({
      tx: "0xdisc-est",
      block: 40,
      ts: now - 3 * HOUR,
      wallet: wallets[29]!.address,
      token,
      amount: 50,
      usd: 100,
      price: 2,
      priced: "estimate",
    }),
    fill({
      tx: "0xdisc-est-2",
      block: 41,
      ts: now - HOUR,
      wallet: wallets[30]!.address,
      token,
      amount: 10,
      usd: 20,
      price: 2,
    }),
  ]);

  const row = (await page(65)).find((r) => r.token === token)!;
  expect(row.mcap_at).toBeNull();
  expect(row.buyers).toBe(2);
});
