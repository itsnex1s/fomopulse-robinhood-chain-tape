/**
 * The crowd count on a tape row: how many other tracked wallets bought the same token in the
 * hour before it. Read once for a page rather than once per row, so what a page spans and how
 * it is cut into reads is part of the answer being right.
 */
import { expect, test } from "bun:test";
import "./support/memory.ts";
import type { Hex } from "viem";
import { db, deleteFill, tape } from "../src/db.ts";
import { fill, insertFills, now, wallets } from "./support/api.ts";

const HOUR = 3_600;
/** A token nothing else in the run writes to: the suite shares one database. */
const address = (n: number): Hex => `0xc0ffee${n.toString(16).padStart(34, "0")}`;

/** The crowd count of one transaction, off a page wide enough to hold everything a test wrote. */
const othersOf = (token: string, tx: string): number =>
  tape(0, 400).find((row) => row.token === token && row.tx === tx)!.others;

test("the hour before is counted, and only other wallets in it", () => {
  const token = address(1);
  const [a, b, c] = [wallets[0]!, wallets[1]!, wallets[2]!];
  insertFills([
    // Older than the hour: outside the window the badge is about.
    fill({ tx: "0xcrowd-out", ts: now - HOUR - 1, wallet: a.address, token }),
    // On the boundary, which the window includes.
    fill({ tx: "0xcrowd-edge", ts: now - HOUR, wallet: b.address, token }),
    fill({ tx: "0xcrowd-near", ts: now - 60, wallet: c.address, token }),
    // The row's own wallet, twice, and neither counts as company for it.
    fill({ tx: "0xcrowd-self-1", ts: now - 120, wallet: a.address, token, logIndex: 1 }),
    fill({ tx: "0xcrowd-self", ts: now, wallet: a.address, token }),
  ]);
  expect(othersOf(token, "0xcrowd-self")).toBe(2);
});

test("a sell is not company", () => {
  const token = address(2);
  const [a, b] = [wallets[3]!, wallets[4]!];
  insertFills([
    fill({ tx: "0xcrowd-sell", ts: now - 300, wallet: b.address, token, side: "sell" }),
    fill({ tx: "0xcrowd-real", ts: now, wallet: a.address, token }),
  ]);
  expect(othersOf(token, "0xcrowd-real")).toBe(0);
});

test("a dusting is not company", () => {
  const token = address(4);
  const [a, b] = [wallets[9]!, wallets[10]!];
  // Nothing on this token pardons the dusting: no cash leg and no sell, which is what the
  // dust rule looks for. A pardoned row is a real trade and would count.
  insertFills([
    fill({ tx: "0xcrowd-dust", ts: now - 200, wallet: b.address, token, dust: 1, priced: "estimate" }),
    fill({ tx: "0xcrowd-kept", ts: now, wallet: a.address, token, priced: "estimate" }),
  ]);
  expect(othersOf(token, "0xcrowd-kept")).toBe(0);
});

test("a page wider than one read still counts each row's own hour", () => {
  const token = address(3);
  const [a, b, c] = [wallets[6]!, wallets[7]!, wallets[8]!];
  // Five hours apart, so the page is cut into more than one read and neither half may
  // borrow the other's company.
  insertFills([
    fill({ tx: "0xcrowd-old-friend", ts: now - 5 * HOUR - 600, wallet: b.address, token }),
    fill({ tx: "0xcrowd-old", ts: now - 5 * HOUR, wallet: a.address, token }),
    fill({ tx: "0xcrowd-new-friend", ts: now - 600, wallet: c.address, token }),
    fill({ tx: "0xcrowd-new", ts: now, wallet: a.address, token, logIndex: 2 }),
  ]);
  expect(othersOf(token, "0xcrowd-old")).toBe(1);
  expect(othersOf(token, "0xcrowd-new")).toBe(1);
});

test("the page's count is the count the row would have been asked for on its own", () => {
  // The read was a correlated subquery per row and is now one read per page. This is the
  // equivalence: the same question, asked the old way, of every row the tape hands back.
  const own = db.query<{ n: number }, [string, string, number, number]>(
    `SELECT COUNT(DISTINCT q.wallet) AS n FROM fills q
      WHERE q.token = ?1 AND q.side = 'buy' AND q.dust = 0 AND q.wallet != ?2
        AND q.ts BETWEEN ?3 AND ?4`,
  );
  // A spread of fills over ten hours, so the page is cut into reads and the hours overlap.
  let seed = 1;
  const next = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const tokens = [5, 6, 7].map(address);
  // Wallets of this test's own, not the tracked list: the books walk every fill in the shared
  // database, and two hundred of them on a tracked wallet is another test's answer changed.
  const crowdWallets = [1, 2, 3, 4, 5, 6].map((n): Hex => `0xbeef${n.toString(16).padStart(36, "0")}`);
  const spread = Array.from({ length: 200 }, (_, i) =>
    fill({
      tx: `0xcrowd-spread-${i}`,
      wallet: crowdWallets[next(crowdWallets.length)]!,
      token: tokens[next(tokens.length)]!,
      ts: now - next(10 * HOUR),
      side: next(3) === 0 ? "sell" : "buy",
      dust: next(4) === 0 ? 1 : 0,
      priced: "estimate",
    }),
  );
  insertFills(spread);

  try {
    const rows = tape(0, 400);
    expect(rows.filter((r) => (tokens as string[]).includes(r.token))).not.toBeEmpty();
    // Otherwise the comparison below is two columns of zeroes agreeing with each other.
    expect(rows.filter((r) => r.others > 0).length).toBeGreaterThan(20);
    for (const row of rows)
      expect([row.tx, row.others]).toEqual([row.tx, own.get(row.token, row.wallet, row.ts - HOUR, row.ts)!.n]);
  } finally {
    // The suite shares one database and one tape, and a page of it is every test's page:
    // two hundred fills at the top of it push another test's oldest row off the end.
    for (const f of spread) deleteFill(f.tx, f.logIndex);
  }
});
