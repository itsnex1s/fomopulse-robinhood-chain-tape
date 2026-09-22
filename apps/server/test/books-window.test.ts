/**
 * The ranking's window, read off the books instead of grouped out of the window's fills.
 * The saving is only worth having if the two agree, so that is what this holds: for every
 * window the books keep, and with fills on both edges — ones that have fallen out of the
 * window since the walk, and ones that landed after it — the two answers are the same.
 */
import { expect, test } from "bun:test";
import { allStats, BOOKS_SHAPE_KEY, getMeta, type StatRow, setMeta, tapeStats } from "../src/db.ts";
import { rebuildStats } from "../src/pnl.ts";
import { walked } from "../src/traders.ts";
import { WINDOW_SECONDS } from "../src/window.ts";
import { fill, insertFills, now, wallets } from "./support/api.ts";

const DAY = 86_400;
const token = "0xb00c000000000000000000000000000000000001";

/** Both answers in one comparable shape; volume is a sum of floats on either side. */
const shape = (rows: { wallet: string; fills: number; volume: number; last_ts: number }[]) =>
  rows
    .map((r) => ({ wallet: r.wallet, fills: r.fills, volume: Math.round(r.volume * 100), last_ts: r.last_ts }))
    .sort((a, b) => a.wallet.localeCompare(b.wallet));

test("the window read off the books is the window walked off the tape", () => {
  const [a, b, c] = [wallets[1]!, wallets[2]!, wallets[3]!];
  // An hour from now is when the reader asks; the books are walked as of `now`. Everything
  // between the two cutoffs is what the window sheds in that hour, which is the edge this
  // exists for — the fills at 24h and 7d fall out of their window and nothing else.
  insertFills([
    fill({ tx: "0xbw-1", wallet: a.address, token, ts: now - DAY + 600, amount: 1, usd: 100 }),
    fill({ tx: "0xbw-2", wallet: a.address, token, ts: now - 7 * DAY + 600, amount: 2, usd: 200 }),
    fill({ tx: "0xbw-3", wallet: b.address, token, ts: now - 30 * DAY + 600, amount: 3, usd: 300 }),
    fill({ tx: "0xbw-4", wallet: b.address, token, ts: now - 2 * DAY, amount: 4, usd: 400 }),
    fill({ tx: "0xbw-5", wallet: c.address, token, ts: now - 600, amount: 5, usd: 500 }),
  ]);

  rebuildStats(now);
  const books = new Map(allStats().map((row): [string, StatRow] => [row.wallet, row]));
  expect(books.size).toBeGreaterThan(0);

  // And one that lands after the walk, which the books cannot know about.
  insertFills([fill({ tx: "0xbw-6", wallet: c.address, token, ts: now + 60, amount: 6, usd: 600 })]);

  const later = now + 3_600;
  for (const window of ["24h", "7d", "30d", "all"] as const) {
    const sinceTs = window === "all" ? 0 : later - WINDOW_SECONDS[window];
    expect({ window, rows: shape(walked(sinceTs, window, books)) }).toEqual({
      window,
      rows: shape(tapeStats(sinceTs)),
    });
  }

  // A window the books keep no figure for still reads the tape, and still agrees.
  const hour = later - WINDOW_SECONDS["1h"];
  expect(shape(walked(hour, "1h", books))).toEqual(shape(tapeStats(hour)));

  // Left as the suite found them: every other file reads these books too.
  rebuildStats();
});

test("books written before the columns existed are walked, not believed", () => {
  const books = new Map(allStats().map((row): [string, StatRow] => [row.wallet, row]));
  const sinceTs = now - DAY;
  const stamp = getMeta(BOOKS_SHAPE_KEY);
  try {
    // What the live database looks like the moment the process starts: ALTER TABLE has given
    // every column its default and no walk has filled one in yet.
    setMeta(BOOKS_SHAPE_KEY, "0");
    const zeroed = new Map(
      [...books].map(([wallet, row]): [string, StatRow] => [wallet, { ...row, tape_fills_24h: 0, tape_volume_24h: 0 }]),
    );
    expect(shape(walked(sinceTs, "24h", zeroed))).toEqual(shape(tapeStats(sinceTs)));
  } finally {
    if (stamp !== undefined) setMeta(BOOKS_SHAPE_KEY, stamp);
  }
});
