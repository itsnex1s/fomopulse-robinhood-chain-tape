/** Which tokens a quote pass asks the feed about. The queue used to be ordered inside one
 *  query, unpriced tokens first; it is now two reads, and the stale-quote half can only ever
 *  name a token that has a quote already. */
import { expect, test } from "bun:test";
import type { Hex } from "viem";
import "./support/memory.ts";
import { refreshPrices } from "../src/prices/feed.ts";
import { fill, insertFills } from "./support/api.ts";

test("a token nobody has quoted yet is still asked about, on the strength of its unpriced fills", async () => {
  const fresh: Hex = `0x${"c0".repeat(20)}`;
  insertFills([
    fill({ tx: `0x${"f7".repeat(32)}`, wallet: `0x${"a1".repeat(20)}`, token: fresh, priced: "unpriced", usd: null }),
  ]);
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    asked.push(String(url));
    return new Response(JSON.stringify([]), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    await refreshPrices(() => {});
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(asked.join(" ")).toContain(fresh);
});
