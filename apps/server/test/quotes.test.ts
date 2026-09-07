/** Which tokens a quote pass asks the feed about, and how often. The queue used to be ordered
 *  inside one query, unpriced tokens first; it is now two reads on two clocks — the fills owed
 *  a price every pass, the marks that have gone stale once a sweep. */
import { expect, test } from "bun:test";
import type { Hex } from "viem";
import "./support/memory.ts";
import { tokensToPrice } from "../src/db.ts";
import { limits } from "../src/limits.ts";
import { refreshPrices } from "../src/prices/feed.ts";
import { fill, insertFills, now, savePrice } from "./support/api.ts";

const DAY = 86_400;
const quote = { price: 1, liquidity: 1_000_000, change24: null, pairCreatedAt: null, pair: null };

/** Answers nothing, and records what was asked. */
async function asked(work: () => Promise<unknown>): Promise<string> {
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify([]), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    await work();
  } finally {
    globalThis.fetch = realFetch;
  }
  return urls.join(" ");
}

test("a token nobody has quoted yet is still asked about, on the strength of its unpriced fills", async () => {
  const fresh: Hex = `0x${"c0".repeat(20)}`;
  insertFills([
    fill({ tx: `0x${"f7".repeat(32)}`, wallet: `0x${"a1".repeat(20)}`, token: fresh, priced: "unpriced", usd: null }),
  ]);
  expect(await asked(() => refreshPrices(() => {}))).toContain(fresh);
});

test("the sweep names a mark past its age and leaves one quoted inside it alone", () => {
  const cold: Hex = `0x${"c1".repeat(20)}`;
  const warm: Hex = `0x${"c2".repeat(20)}`;
  const sweep = limits.feed.staleSweepSeconds;
  for (const token of [cold, warm]) {
    insertFills([fill({ tx: `0x${token.slice(2, 4).repeat(32)}`, wallet: `0x${"a2".repeat(20)}`, token })]);
  }
  savePrice(cold, quote, now - sweep - 1);
  savePrice(warm, quote, now);

  const wanted = tokensToPrice(now - DAY, now - sweep, 100);
  expect(wanted).toContain(cold);
  expect(wanted).not.toContain(warm);
});

test("a pass inside the sweep asks about the fill owed a price and about no mark at all", async () => {
  const cold: Hex = `0x${"c3".repeat(20)}`;
  const owed: Hex = `0x${"c4".repeat(20)}`;
  insertFills([
    fill({ tx: `0x${"c5".repeat(32)}`, wallet: `0x${"a3".repeat(20)}`, token: cold }),
    fill({ tx: `0x${"c6".repeat(32)}`, wallet: `0x${"a3".repeat(20)}`, token: owed, priced: "unpriced", usd: null }),
  ]);
  savePrice(cold, quote, now - limits.feed.staleSweepSeconds - 1);

  // Whatever the sweep clock stood at, this pass sets it; the next one is inside the sweep.
  await asked(() => refreshPrices(() => {}));
  const inside = await asked(() => refreshPrices(() => {}));
  expect(inside).toContain(owed);
  expect(inside).not.toContain(cold);
});
