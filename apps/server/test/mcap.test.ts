/**
 * The market cap a fill landed at. The feed only ever answers for the token now, so the
 * one number that cannot be recovered later is the supply the cap was taken over: these
 * are the two orders a fill and its quote can arrive in, and what a burn does afterwards.
 */
import { expect, test } from "bun:test";
import type { Address } from "viem";
import { savePrice, stampSupply } from "../src/db.ts";
import { api, fill, insertFills, now } from "./support/api.ts";

const quote = (price: number, marketCap: number | null) => ({
  price,
  liquidity: 1_000_000,
  change24: null,
  pairCreatedAt: null,
  pair: null,
  marketCap,
});

/**
 * The tape route holds its answer for a second, keyed by the whole query, and these tests
 * write and read back well inside that second. Each read carries a cursor id of its own,
 * which the route ignores without the timestamp that goes with it but the key does not:
 * a different key, and so a read that reaches SQLite rather than the last one's answer.
 */
let reads = 0;
const rowOf = async (tx: string) => {
  const rows = (await (await api.request(`/api/tape?window=all&dust=true&beforeId=${9_000_001 + reads++}`)).json()) as {
    tx: string;
    mcap_at: number | null;
  }[];
  return rows.find((r) => r.tx.toLowerCase() === tx.toLowerCase())!;
};

const wallet = "0x662053fd75f1f7da7e524d884b96552a13d2800b" as Address;

test("a fill quoted before it lands is stamped with the supply of that moment", async () => {
  const token = `0x${"c1".repeat(20)}` as Address;
  const tx = `0x${"e1".repeat(32)}`;
  // A billion tokens at a cent: the cap is $10M, and this buy paid half the mark.
  savePrice(token, quote(0.01, 10_000_000), now);
  insertFills([fill({ tx, wallet, token, price: 0.005, usd: 50, amount: 10_000 })]);
  expect((await rowOf(tx)).mcap_at).toBeCloseTo(5_000_000, 0);

  // Seven tenths of the supply burns. The token's cap now is the feed's business, but the
  // cap this fill was bought at happened once and does not move with it.
  savePrice(token, quote(0.01, 3_000_000), now);
  expect((await rowOf(tx)).mcap_at).toBeCloseTo(5_000_000, 0);
});

test("a fill that lands before its token is quoted is stamped when the quote arrives", async () => {
  const token = `0x${"c2".repeat(20)}` as Address;
  const tx = `0x${"e2".repeat(32)}`;
  insertFills([fill({ tx, wallet, token, price: 2, usd: 200, amount: 100 })]);
  // No quote yet, so nothing to work the cap out from, and the row says so rather than guessing.
  expect((await rowOf(tx)).mcap_at).toBeNull();

  savePrice(token, quote(4, 8_000_000), now);
  stampSupply(token, now - 3_600);
  // Two million tokens behind an $8M cap; this one paid 2, so it bought a $4M token.
  expect((await rowOf(tx)).mcap_at).toBeCloseTo(4_000_000, 0);
});

test("a fill older than the horizon is never stamped, and falls back to the feed", async () => {
  const token = `0x${"c3".repeat(20)}` as Address;
  const tx = `0x${"e3".repeat(32)}`;
  const old = now - 7 * 86_400;
  savePrice(token, quote(1, 1_000_000), now);
  insertFills([fill({ tx, wallet, token, ts: old, price: 0.5, usd: 50, amount: 100 })]);
  // Derived, not stamped — and so it moves with the feed, which is the best a row this
  // old can do: a million tokens now, half of them when it was bought.
  expect((await rowOf(tx)).mcap_at).toBeCloseTo(500_000, 0);
  savePrice(token, quote(1, 2_000_000), now);
  expect((await rowOf(tx)).mcap_at).toBeCloseTo(1_000_000, 0);
});
