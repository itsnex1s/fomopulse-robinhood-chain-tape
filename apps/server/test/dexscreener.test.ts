import { afterEach, expect, test } from "bun:test";
import type { Address } from "viem";
import { fetchQuotes } from "../src/prices/dexscreener.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const token = "0x4444444444444444444444444444444444444444" as Address;

function answer(body: unknown, status = 200) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

test("the deepest pool carries the price", async () => {
  answer([
    { baseToken: { address: token }, priceUsd: "0.10", liquidity: { usd: 1_000 } },
    {
      pairAddress: "0xPOOL",
      baseToken: { address: token.toUpperCase() },
      priceUsd: "0.12",
      liquidity: { usd: 50_000 },
      priceChange: { h24: 3 },
      pairCreatedAt: 1,
    },
    { baseToken: { address: token }, priceUsd: "0", liquidity: { usd: 999_999 } }, // a dead pool
  ]);
  const quotes = await fetchQuotes([token]);
  expect(quotes.get(token)).toMatchObject({
    price: 0.12,
    liquidity: 50_000,
    change24: 3,
    pairCreatedAt: 1,
    pair: "0xpool",
  });
  // The rest of the card is carried through when the feed sends it, and null when it does not.
  expect(quotes.get(token)).toMatchObject({
    change1h: null,
    volume24: null,
    buys24: null,
    marketCap: null,
    imageUrl: null,
  });
});

test("no tokens means no request", async () => {
  globalThis.fetch = (async () => {
    throw new Error("should not be called");
  }) as unknown as typeof fetch;
  expect((await fetchQuotes([])).size).toBe(0);
});

test("an upstream error is thrown, not swallowed into a stale price", async () => {
  answer({ error: "rate limited" }, 429);
  await expect(fetchQuotes([token])).rejects.toThrow("dexscreener 429");
});

/**
 * An almost-empty pool prices whatever dust last crossed it. SCAMS came back at
 * $5,014,847.29 a token against no liquidity at all, and nine airdropped fills carried
 * $132.9 billion — the whole day's volume — until the floor went in.
 */
test("a quote from a pool with nothing in it is not a price", async () => {
  answer([{ baseToken: { address: token }, priceUsd: "5014847.29", liquidity: { usd: 0 } }]);
  expect((await fetchQuotes([token])).size).toBe(0);

  // Nor one the feed reports no liquidity for at all.
  answer([{ baseToken: { address: token }, priceUsd: "5014847.29" }]);
  expect((await fetchQuotes([token])).size).toBe(0);
});
