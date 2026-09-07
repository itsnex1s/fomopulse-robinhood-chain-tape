/** The held-token set the quote pass works from: kept between passes, but never behind a
 *  position that was opened since the last one. */
import { expect, test } from "bun:test";
import { tapeTokens } from "../src/db.ts";
import { fill, insertFills, now, wallets } from "./support/api.ts";

const held = () => new Set(tapeTokens().map((row) => row.token));

test("a token bought since the last pass is held straight away, and one nobody bought is not", () => {
  const trader = wallets[0]!;
  const opened = "0xhe1d0000000000000000000000000000000001";
  const never = "0xhe1d0000000000000000000000000000000002";

  // Read once so the set exists and is inside its hold; the buy below lands after it.
  expect(held().has(opened)).toBe(false);

  insertFills([
    fill({ tx: "0xheld-buy", block: 9_101, ts: now - 30, wallet: trader.address, token: opened, amount: 5, usd: 25 }),
  ]);

  const after = held();
  expect(after.has(opened)).toBe(true);
  expect(after.has(never)).toBe(false);
});

test("a sell does not put a token in the set", () => {
  const trader = wallets[0]!;
  const sold = "0xhe1d0000000000000000000000000000000003";
  held();
  insertFills([
    fill({
      tx: "0xheld-sell",
      block: 9_102,
      ts: now - 20,
      wallet: trader.address,
      token: sold,
      side: "sell",
      amount: 5,
      usd: 25,
    }),
  ]);
  expect(held().has(sold)).toBe(false);
});

test("the age of the quote is read fresh, not held with the set", async () => {
  const trader = wallets[0]!;
  const token = "0xhe1d0000000000000000000000000000000004";
  insertFills([
    fill({ tx: "0xheld-q", block: 9_103, ts: now - 10, wallet: trader.address, token, amount: 5, usd: 25 }),
  ]);
  expect(tapeTokens().find((row) => row.token === token)?.quoted_at ?? null).toBe(null);

  const { savePrice } = await import("./support/api.ts");
  savePrice(token, { price: 5, liquidity: 1_000, change24: 0, pairCreatedAt: null, pair: "0xq" }, now - 5);
  expect(tapeTokens().find((row) => row.token === token)?.quoted_at).toBe(now - 5);
});
