/** The replay: what a deploy that changed the rules does to the fills already stored. */
import { expect, test } from "bun:test";
import "./support/memory.ts";
import type { Address, Hex } from "viem";
import { db, getMeta, saveKind, savePrice, saveReceipt, saveToken } from "../src/db.ts";
import { RULES, rebuildFills, repairFills } from "../src/ingest/rebuild.ts";
import { fill, insertFills, now, wallets } from "./support/api.ts";

const trader = wallets[6]!.address as Address;
const shallow = "0xbbbb111111111111111111111111111111111111" as Address;
const sender = "0xbbbb222222222222222222222222222222222222" as Address;
const tx = "0xbeb1";

const fillsOf = (token: string) =>
  db
    .query<{ tx: string; usd: number | null; priced: string; dust: number }, [string]>(
      "SELECT tx, usd, priced, dust FROM fills WHERE token = ?",
    )
    .all(token);

test("a replay reprices the fills a dropped quote had inflated, and keeps the rest of the tape", () => {
  saveToken(shallow, 18);
  saveKind(sender, "eoa");
  // What the feed said before the floor went in: a price with no pool behind it.
  savePrice(shallow, { price: 1_000, liquidity: 0, change24: null, pairCreatedAt: null, pair: null }, now);
  saveReceipt(
    {
      tx,
      block: 500_000,
      transfers: [{ logIndex: 0, token: shallow, from: sender, to: trader, value: 3_000000000000000000n }],
    },
    now,
  );
  insertFills([
    fill({
      tx,
      wallet: trader,
      token: shallow,
      block: 500_000,
      amount: 3,
      usd: 3_000,
      price: 1_000,
      priced: "estimate",
    }),
  ]);
  // A fill of the same token from before the receipts were kept: nothing to replay it from.
  insertFills([fill({ tx: "0xbeb0", wallet: trader, token: shallow, usd: 5_000, price: 1_000, priced: "estimate" })]);
  // A fill of a token nothing in this test touches: the replay must leave it exactly as it is.
  const untouched = "0xbbbb333333333333333333333333333333333333";
  savePrice(untouched, { price: 2, liquidity: 90_000, change24: null, pairCreatedAt: null, pair: null }, now);
  insertFills([fill({ tx: "0xbeb2", wallet: trader, token: untouched, usd: 42, price: 2, priced: "estimate" })]);

  const done = rebuildFills();
  expect(done).resolves.toBeDefined();

  return done.then(() => {
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM prices WHERE token = ?").get(shallow)!.n).toBe(
      0,
    );
    const rows = fillsOf(shallow);
    expect(rows).toHaveLength(2);
    // The replayed one: reconstructed again, and now with no price to reconstruct it from.
    const replayed = rows.find((r) => r.tx === tx)!;
    expect(replayed.priced).toBe("unpriced");
    expect(replayed.usd).toBeNull();
    // The one older than its receipt is unpriced in place rather than left at the old number.
    const older = rows.find((r) => r.tx === "0xbeb0")!;
    expect(older.priced).toBe("unpriced");
    expect(older.usd).toBeNull();
    // And a fill the replay has no receipt for, whose quote is deep enough to keep, is as it was.
    expect(fillsOf(untouched)).toEqual([{ tx: "0xbeb2", usd: 42, priced: "estimate", dust: 0 }]);
  });
});

/**
 * The replay is spread over passes because a whole tape at once is more unbroken CPU
 * than an alarm has. What has to hold across them: the rules are only marked done when
 * the last receipt is in, and the cursor between passes says where to pick up.
 */
test("a replay too big for one pass is finished by the next, and only then marked done", async () => {
  // Enough receipts of this test's own that two passes of one cannot be the last: the
  // rest of the run shares the database, and what else is in it is not this test's to assume.
  for (const [i, tx] of (["0xbeb3", "0xbeb4", "0xbeb5"] as Hex[]).entries())
    saveReceipt({ tx, block: 500_001 + i, transfers: [] }, now);

  expect(await repairFills(undefined, 1)).toMatchObject({ receipts: 1, done: false });
  expect(getMeta("rules")).toBeUndefined();
  const cursor = Number(getMeta("rules:at"));
  expect(cursor).toBeGreaterThan(0);

  expect(await repairFills(undefined, 1)).toMatchObject({ done: false });
  expect(Number(getMeta("rules:at"))).toBeGreaterThan(cursor);

  expect((await repairFills())!.done).toBe(true);
  expect(getMeta("rules")).toBe(String(RULES));
  expect(getMeta("rules:at")).toBe("0");
  // And a tape already written under these rules is not replayed again.
  expect(await repairFills()).toBeUndefined();
});
