/** The books: what a wallet made, walked from its own fills and nobody else's numbers. */
import { expect, test } from "bun:test";
import { allStats, tapeStats } from "../src/db.ts";
import { HANDOUT } from "../src/ingest/reconstruct.ts";
import { rebuildStats } from "../src/pnl.ts";
import { ranking } from "../src/traders.ts";
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

test("a handout leaving again takes nothing from the inventory the wallet paid for", () => {
  // Bought a hundred for a hundred dollars, then a spray of the same token went back out
  // priced at three. Counting that as a sale booked a $200 win and emptied a position the
  // wallet still holds — the bags page, which nets the amounts, kept showing all hundred.
  const held = "0xb00c444444444444444444444444444444444444";
  // An index no other test file writes: the whole suite shares one in-memory database,
  // so a wallet used twice makes these counts read another file's fills.
  const seller = wallets[40]!.address;
  insertFills([
    fill({ tx: "0xb030", wallet: seller, token: held, side: "buy", amount: 100, usd: 100, price: 1, ts: now - 300 }),
    fill({
      tx: "0xb031",
      wallet: seller,
      token: held,
      side: "sell",
      amount: 100,
      usd: 300,
      price: 3,
      dust: HANDOUT,
      ts: now - 100,
    }),
  ]);
  const book = booksOf(seller)!;
  expect(book.trips_all).toBe(0);
  expect(book.wins_all).toBe(0);
  expect(book.realized_all).toBe(0);
  expect(book.volume).toBe(100); // the purchase only; a handout is not turnover
  expect(book.open_tokens).toBe(1);

  // And the inventory really is still there: selling it for real afterwards books the trip
  // against the hundred dollars it cost, which it cannot do if the handout consumed it.
  insertFills([
    fill({ tx: "0xb032", wallet: seller, token: held, side: "sell", amount: 100, usd: 200, price: 2, ts: now - 50 }),
  ]);
  const after = booksOf(seller)!;
  expect(after.trips_all).toBe(1);
  expect(after.realized_all).toBeCloseTo(100, 6);
  expect(after.open_tokens).toBe(0);
});

test("a sale nothing could price still closes the position", () => {
  // The feed had no quote when this one landed, so the fill carries no dollars. The tokens
  // are gone either way: holding the position open marked a wallet against a position it
  // had sold out of, and the bags page, which nets amounts, showed it holding nothing.
  const gone = "0xb00c555555555555555555555555555555555555";
  const quiet = wallets[41]!.address;
  insertFills([
    fill({ tx: "0xb040", wallet: quiet, token: gone, side: "buy", amount: 100, usd: 500, price: 5, ts: now - 300 }),
    fill({
      tx: "0xb041",
      wallet: quiet,
      token: gone,
      side: "sell",
      amount: 100,
      usd: null,
      price: null,
      priced: "unpriced",
      ts: now - 100,
    }),
  ]);
  const book = booksOf(quiet)!;
  expect(book.open_tokens).toBe(0);
  expect(book.open_value).toBe(0);
  expect(book.unrealized).toBe(0);
  // Nothing priced the sale, so there is no trip to score either way — not a win, not a loss.
  expect(book.trips_all).toBe(0);
  expect(book.realized_all).toBe(0);
});

test("a window covering the whole tape is answered off the books and comes to the same numbers", () => {
  // The costly half of the traders page is a pass over every fill in the window, grouped by
  // wallet. A window that starts before the tape does asks for the whole tape, and the walk
  // behind the books already read all of it — so the two have to agree exactly, including the
  // fills that landed after the walk and the wallets whose first trade was one of them.
  const trader = wallets[13]!.address;
  const coin = "0xb00c000000000000000000000000000000000001";
  insertFills([
    fill({ tx: "0xbooks-1", ts: now - 600, wallet: trader, token: coin, amount: 10, usd: 40 }),
    // A handout with a price: the tape counts it as volume, the books' own `volume` does not.
    fill({ tx: "0xbooks-2", ts: now - 500, wallet: trader, token: coin, amount: 5, usd: 7, dust: 2 }),
  ]);
  rebuildStats(now);
  // Landed after the walk, so it can only come from the seek the books are topped up with.
  insertFills([
    fill({ tx: "0xbooks-3", ts: now - 100, wallet: trader, token: coin, side: "sell", amount: 4, usd: 20 }),
  ]);

  const live = new Map(tapeStats(0).map((row) => [row.wallet, row]));
  const off = new Map(ranking(0, "all", 1_000).map((row) => [row.address, row]));
  for (const [address, row] of live) {
    const shown = off.get(address)!;
    expect([address, shown.fills, shown.tape_volume, shown.last_ts]).toEqual([
      address,
      row.fills,
      row.volume,
      row.last_ts,
    ]);
  }
});
