/**
 * What the object recomputes and what it hands back from memory. Both caches in front of a
 * read are only worth the number of distinct questions behind them, and these are the two
 * places that number was larger than the answers justified: a page of the tape held for a
 * second behind an edge that holds it for a minute, and one discovery page asked for under
 * three different names.
 *
 * `measure` only counts where a meter is set, so each of these sets one. The count it
 * returns is not the point — the number of runs is.
 */
import { expect, test } from "bun:test";
import { measured, meterRows, resetBudget } from "../src/api/budget.ts";
import { tapeTtl } from "../src/api/routes.ts";
import { limits, ms } from "../src/limits.ts";
import { api } from "./support/api.ts";

/** Runs of one measured piece of work, over whatever the body of the test asked for. */
async function runs(label: string, work: () => Promise<unknown>): Promise<number> {
  resetBudget(0);
  let walked = 0;
  meterRows(() => ++walked);
  const before = measured()[label]?.runs ?? 0;
  await work();
  const after = measured()[label]?.runs ?? 0;
  resetBudget();
  return after - before;
}

const key = (before = "", beforeId = "") => ["1h", "true", "false", "400", before, beforeId].join("|");

test("a page of the tape is held for as long as the edge in front of it holds the same page", () => {
  // Anything less and every colo that misses reads again what another colo already has.
  expect(tapeTtl(key())).toBe(ms(limits.cache.edge.tape ?? 0));
  expect(tapeTtl(key())).toBeGreaterThan(1_000);
  // A page behind a cursor is the past and cannot change, so it is held far longer.
  expect(tapeTtl(key("1700000000", "42"))).toBe(ms(limits.cache.cursorSeconds));
  // Half a cursor is no cursor: that read is the first page again, and lives as long.
  expect(tapeTtl(key("1700000000", ""))).toBe(ms(limits.cache.edge.tape ?? 0));
  expect(tapeTtl(key("", "42"))).toBe(ms(limits.cache.edge.tape ?? 0));
});

test("a page of the tape is read once however many colos ask for it", async () => {
  // Page sizes nothing else asks for: the memo is process-wide and these hold for a minute,
  // so a key shared with another test would answer it out of this one's cache.
  const asked = "/api/tape?window=1h&limit=7";
  expect(await runs("tape:page", async () => void (await api.request(asked)))).toBe(1);
  expect(
    await runs("tape:page", async () => {
      for (let i = 0; i < 5; i++) await api.request(asked);
    }),
  ).toBe(0);
});

test("a page asked for differently is still a different page", async () => {
  // The fold is of questions with one answer, not of questions.
  expect(
    await runs("tape:page", async () => {
      await api.request("/api/tape?window=24h&limit=8");
      await api.request("/api/tape?window=24h&limit=9");
      await api.request("/api/tape?window=24h&limit=8&dust=true");
    }),
  ).toBe(3);
});

test("every window wider than the oldest pool shown is the same discovery page", async () => {
  const wide = ["7d", "30d", "all"];
  const pages = [];
  for (const window of wide) pages.push(await (await api.request(`/api/discover?window=${window}&limit=172`)).json());
  // Identical because the cut is the pool's age: since(window) is clamped to MAX_POOL_AGE.
  expect(new Set(pages.map((page) => JSON.stringify(page))).size).toBe(1);

  // And read once rather than three times over. A row count nothing has asked for yet makes
  // all three keys cold, so what this counts is the fold and not the memo warmed above.
  expect(
    await runs("discover:page", async () => {
      for (const window of wide) await api.request(`/api/discover?window=${window}&limit=171`);
    }),
  ).toBe(1);
  // A window narrower than the cut still cuts narrower, and is still its own page.
  expect(
    await runs("discover:page", async () => {
      for (const window of ["1h", "24h"]) await api.request(`/api/discover?window=${window}&limit=171`);
    }),
  ).toBe(2);
});

test("the page everybody asks for is not the one the cursors push out", async () => {
  // The memo holds sixty-four answers. A cursor is part of the key and there is one per
  // reader paging back, so the cold keys always outnumber the hot one; what decides whether
  // the tape is read once a minute or eighteen times is which of them is given up.
  const hot = "/api/tape?window=all&limit=301";
  await api.request(hot);
  const cold = Array.from({ length: 70 }, (_, i) => `/api/tape?window=all&limit=${400 + i}`);

  const read = await runs("tape:page", async () => {
    for (const page of cold) {
      await api.request(page);
      await api.request(hot);
    }
  });
  // Each cold page once, and the hot one never again: it was wanted most recently every time.
  expect(read).toBe(cold.length);
});
