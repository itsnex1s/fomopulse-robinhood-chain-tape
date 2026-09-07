/**
 * How long each answer is allowed to be served from memory. The numbers are a judgement, but
 * what they are for is not: a wider window is a claim that less has to change before the
 * answer does, and a lifetime past the poll behind it saves nothing while making one
 * reader's page slower than it looks.
 */
import { expect, test } from "bun:test";
import { resetBudget, spend } from "../src/api/budget.ts";
import { COUNTED, MARKED, ttlBy } from "../src/api/routes.ts";
import { limits } from "../src/limits.ts";
import { api, fill, insertFills, now, wallets } from "./support/api.ts";

/** What the client itself asks for, from App.tsx, Bags.tsx and Traders.tsx. */
const STATUS_POLL = 15_000;
const PAGE_POLL = 120_000;
const ORDER = ["1h", "24h", "7d", "30d", "all"] as const;
const ttl = (ladder: Record<string, number>, window: string): number => ladder[window] ?? -1;

test("no answer outlives the poll that asks for it", () => {
  // The status carries the counted readout and is asked for every fifteen seconds; holding it
  // longer would only hide fills the reader is already being sent over the socket.
  expect(ttl(COUNTED, "1h")).toBeLessThanOrEqual(STATUS_POLL);
  expect(ttl(COUNTED, "24h")).toBeLessThanOrEqual(STATUS_POLL);
  // The two marked pages poll every two minutes, and none of theirs reaches half of it.
  for (const window of ORDER) expect(ttl(MARKED, window)).toBeLessThanOrEqual(PAGE_POLL / 2);
});

test("each wider window is held longer than the one inside it, up to where the poll stops it", () => {
  for (const ladder of [COUNTED, MARKED]) {
    // Widening has to buy something: all time is held at least ten times the last hour.
    expect(ttl(ladder, "all")).toBeGreaterThanOrEqual(ttl(ladder, "1h") * 10);
    for (let i = 1; i < ORDER.length; i++)
      expect(ttl(ladder, ORDER[i]!)).toBeGreaterThanOrEqual(ttl(ladder, ORDER[i - 1]!));
  }
});

test("the lifetime is read off the window the key opens with, whatever else it carries", () => {
  const of = ttlBy(MARKED);
  expect(of("all|200")).toBe(ttl(MARKED, "all"));
  expect(of("24h|50")).toBe(ttl(MARKED, "24h"));
  // A window nobody serves falls back to the middle of the ladder rather than to forever.
  expect(of("nonsense|1")).toBe(15_000);
});

/** The clock the memo reads, wound forward by hand. */
async function at<T>(msFromNow: number, body: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => real() + msFromNow;
  try {
    return await body();
  } finally {
    Date.now = real;
  }
}

test("a window is asked again once its own lifetime is up, and not before", async () => {
  const trader = wallets[0]!;
  const token = "0xtt10000000000000000000000000000000000a1";
  const fillsIn = async (window: string) =>
    ((await (await api.request(`/api/overview?window=${window}`)).json()) as { fills: number }).fills;

  const day = await fillsIn("24h");
  const ever = await fillsIn("all");
  insertFills([
    fill({ tx: "0xttl-one", block: 9_301, ts: now - 5, wallet: trader.address, token, amount: 1, usd: 10 }),
  ]);

  // Half a minute on: the day is held for fifteen seconds and has noticed, all time is held
  // for five minutes and has not. Counted as more or the same rather than as an exact
  // number — the run shares one database, and other files are putting fills on it too.
  await at(30_000, async () => {
    expect(await fillsIn("24h")).toBeGreaterThan(day);
    expect(await fillsIn("all")).toBe(ever);
  });
  // Ten minutes on, all time has noticed too.
  await at(600_000, async () => {
    expect(await fillsIn("all")).toBeGreaterThan(ever);
  });
});

test("every cached route tells the edge how long to hold it, and a cursor page for far longer", async () => {
  resetBudget();
  const ttlOf = async (path: string) => Number((await api.request(path)).headers.get("x-ttl"));
  // The readout has a ladder of its own, tested below; every other route is its one number.
  for (const [name, seconds] of Object.entries(limits.cache.edge))
    if (name !== "limits" && name !== "status" && name !== "overview")
      expect(await ttlOf(`/api/${name}`)).toBe(seconds);
  // A page of the past cannot change, and it is the half a reader paging back asks for most.
  expect(await ttlOf("/api/tape?before=1&beforeId=1")).toBe(limits.cache.cursorSeconds);
  expect(await ttlOf("/api/tape?before=1&beforeId=1")).toBeGreaterThan(limits.cache.edge.tape!);
});

test("a month heading past its budget holds the edge's answers longer too", async () => {
  resetBudget(Date.now() - 10 * 60_000);
  const plain = Number((await api.request("/api/status?window=1h")).headers.get("x-ttl"));
  expect(plain).toBe(limits.cache.edge.status!);
  // Ten minutes at a rate that comes to four budgets over a month.
  spend(4 * limits.budget.rowsPerMonth * ((10 * 60_000) / (30 * 86_400_000)));
  const held = Number((await api.request("/api/status?window=1h")).headers.get("x-ttl"));
  expect(held).toBeGreaterThan(plain * 3);
  expect(held).toBeLessThanOrEqual(plain * limits.budget.maxHold);
  resetBudget();
});

test("a wider window is held at the edge for as long as the memo behind it, not for the poll", async () => {
  resetBudget();
  const ttlOf = async (path: string) => Number((await api.request(path)).headers.get("x-ttl"));
  // The readout of thirty days walks a month of fills to answer; holding it for the twelve
  // seconds an hour's readout is worth would ask for that again five times a minute.
  const base = limits.cache.edge.status!;
  expect(await ttlOf("/api/status?window=1h")).toBe(base);
  expect(await ttlOf("/api/status?window=30d")).toBe(limits.cache.counted["30d"]);
  expect(await ttlOf("/api/status?window=all")).toBe(limits.cache.counted.all);
  expect(await ttlOf("/api/status?window=30d")).toBeGreaterThan(base);
});
