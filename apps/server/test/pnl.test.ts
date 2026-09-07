/** The books: what a wallet made, walked from its own fills and nobody else's numbers. */
import { expect, test } from "bun:test";
import { allStats } from "../src/db.ts";
import { HANDOUT } from "../src/ingest/reconstruct.ts";
import { rebuildStats } from "../src/pnl.ts";
import { fill, insertFills, now, wallets } from "./support/api.ts";

const token = "0xb00c111111111111111111111111111111111111";
const wallet = wallets[12]!.address;

/** The whole tape is walked, so a test reads back only the wallet it wrote. */
const booksOf = (address: string) => {
  rebuildStats();
  return allStats().find((row) => row.wallet === address);
};

test("a round trip is measured against what the position cost, and a losing one still counts", () => {
  // Bought a hundred at a dollar, sold half at $1.50 and the rest at $0.50: one trip
  // ahead, one behind, and the two cancel out.
  insertFills([
    fill({ tx: "0xb001", wallet, token, side: "buy", amount: 100, usd: 100, price: 1, ts: now - 300 }),
    fill({ tx: "0xb002", wallet, token, side: "sell", amount: 50, usd: 75, price: 1.5, ts: now - 200 }),
    fill({ tx: "0xb003", wallet, token, side: "sell", amount: 50, usd: 25, price: 0.5, ts: now - 100 }),
  ]);
  const book = booksOf(wallet)!;
  expect(book.trips_all).toBe(2);
  expect(book.wins_all).toBe(1);
  expect(book.realized_all).toBeCloseTo(0, 6);
  // Both sells landed minutes ago, so every window holds the same two trips.
  expect([book.trips_24h, book.trips_7d, book.trips_30d]).toEqual([2, 2, 2]);
  expect(book.free).toBe(0);
  // Everything was sold, so there is nothing left to mark.
  expect(book.unrealized).toBe(0);
  expect(book.open_tokens).toBe(0);
});

/**
 * The half that makes a win rate honest. A sprayed token arrives at no cost, and counting
 * its sale as profit would make every wallet on the receiving end of a spray a winner —
 * which is what a tape that reads handouts as buys says about a farm.
 */
test("selling what was handed over is proceeds, not a won trade", () => {
  const other = wallets[13]!.address;
  const free = "0xb00c222222222222222222222222222222222222";
  insertFills([
    fill({
      tx: "0xb010",
      wallet: other,
      token: free,
      side: "buy",
      amount: 5000,
      usd: 400,
      dust: HANDOUT,
      ts: now - 90,
    }),
    fill({
      tx: "0xb011",
      wallet: other,
      token: free,
      side: "sell",
      amount: 5000,
      usd: 380,
      price: 0.076,
      ts: now - 80,
    }),
  ]);
  const book = booksOf(other)!;
  expect(book.trips_all).toBe(0);
  expect(book.wins_all).toBe(0);
  expect(book.realized_all).toBe(0);
  expect(book.free).toBeCloseTo(380, 6);
});

test("what is still held is marked, and what has no price at all is left out of the books", () => {
  const holder = wallets[14]!.address;
  const held = "0xb00c333333333333333333333333333333333333";
  const unknown = "0xb00c444444444444444444444444444444444444";
  insertFills([
    fill({ tx: "0xb020", wallet: holder, token: held, side: "buy", amount: 10, usd: 100, price: 10, ts: now - 70 }),
    // A later fill of the same token at a higher price is the only mark the tape has for it.
    fill({ tx: "0xb021", wallet: holder, token: held, side: "buy", amount: 1, usd: 15, price: 15, ts: now - 60 }),
    fill({
      tx: "0xb022",
      wallet: holder,
      token: unknown,
      side: "buy",
      amount: 7,
      usd: null,
      price: null,
      priced: "unpriced",
      ts: now - 50,
    }),
  ]);
  const book = booksOf(holder)!;
  // Eleven tokens cost $115 and mark at $15 apiece.
  expect(book.unrealized).toBeCloseTo(11 * 15 - 115, 6);
  expect(book.open_tokens).toBe(1);
  expect(book.tokens).toBe(2);
  // The unpriced buy bought nothing as far as the books are concerned.
  expect(book.trips_all).toBe(0);
  expect(book.realized_all).toBe(0);
});
