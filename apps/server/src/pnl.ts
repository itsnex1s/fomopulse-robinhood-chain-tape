import {
  fillsAfter,
  lastPriceOf,
  STAT_WINDOWS,
  type StatFill,
  type StatRow,
  type StatWindow,
  saveStats,
} from "./db/stats.ts";
import { loadPrices } from "./db.ts";
import { log } from "./log.ts";
import { WINDOW_SECONDS } from "./window.ts";

/** Fills read per pass: the object has 128 MB, and the books it keeps are three numbers
 *  per wallet and token. */
const PAGE = 20_000;

interface Book {
  amount: number;
  cost: number;
  /** Held but never paid for; sold, it is proceeds rather than profit. */
  given: number;
}

type PerWindow = Record<StatWindow, number>;
const zero = (): PerWindow => ({ "24h": 0, "7d": 0, "30d": 0, all: 0 });

interface Stat {
  realized: PerWindow;
  trips: PerWindow;
  wins: PerWindow;
  free: number;
  buys: number;
  sells: number;
  volume: number;
  first: number;
  last: number;
}

const blank = (): Stat => ({
  realized: zero(),
  trips: zero(),
  wins: zero(),
  free: 0,
  buys: 0,
  sells: 0,
  volume: 0,
  first: 0,
  last: 0,
});

/** Where each window starts, worked out once per walk rather than once per fill. */
const cutoffs = (now: number): [StatWindow, number][] =>
  STAT_WINDOWS.map((w) => [w, w === "all" ? 0 : now - WINDOW_SECONDS[w]] as [StatWindow, number]);

/** One fill against the books, in the order the chain put them in. */
function apply(fill: StatFill, stat: Stat, book: Book, windows: [StatWindow, number][]): void {
  if (stat.first === 0) stat.first = fill.ts;
  stat.last = fill.ts;

  if (fill.side === "buy") {
    stat.buys++;
    // A handout has a price the moment its token has a pool, and it is still not a purchase.
    if (fill.usd !== null && fill.dust === 0) {
      stat.volume += fill.usd;
      book.amount += fill.amount;
      book.cost += fill.usd;
    } else {
      book.given += fill.amount;
    }
    return;
  }

  stat.sells++;
  // A handout going back out is not a sale, whatever the token is worth by the time it
  // leaves. It takes from what was handed over, never from inventory the wallet paid for,
  // and it is not a round trip: the buy side already files a handout under `given`.
  if (fill.dust !== 0) {
    book.given = book.given > fill.amount ? book.given - fill.amount : 0;
    return;
  }
  if (fill.usd !== null) stat.volume += fill.usd;
  const price = fill.amount > 0 && fill.usd !== null ? fill.usd / fill.amount : null;
  let left = fill.amount;

  const paid = Math.min(left, book.amount);
  if (paid > 0 && price !== null) {
    const cost = (book.cost * paid) / book.amount;
    const gain = paid * price - cost;
    book.amount -= paid;
    book.cost -= cost;
    left -= paid;
    for (const [window, from] of windows) {
      if (fill.ts < from) continue;
      stat.realized[window] += gain;
      stat.trips[window]++;
      if (gain > 0) stat.wins[window]++;
    }
  }
  if (left > 0 && price !== null) {
    const free = Math.min(left, book.given);
    book.given -= free;
    stat.free += free * price;
  }
}

/**
 * Walk every fill in order and rewrite `trader_stats`: average cost per wallet and token, a
 * sell taking the paid-for inventory first, and only that part counted as a round trip.
 */
export function rebuildStats(now = Math.floor(Date.now() / 1000)): { wallets: number; fills: number; ms: number } {
  const at = Date.now();
  const windows = cutoffs(now);
  const books = new Map<string, Book>();
  const stats = new Map<string, Stat>();
  let ts = -1;
  let id = 0;
  let fills = 0;

  for (;;) {
    const page = fillsAfter(ts, id, PAGE);
    if (page.length === 0) break;
    for (const fill of page) {
      let stat = stats.get(fill.wallet);
      if (stat === undefined) {
        stat = blank();
        stats.set(fill.wallet, stat);
      }
      const key = `${fill.wallet}:${fill.token}`;
      let book = books.get(key);
      if (book === undefined) {
        book = { amount: 0, cost: 0, given: 0 };
        books.set(key, book);
      }
      apply(fill, stat, book, windows);
    }
    const last = page[page.length - 1]!;
    ts = last.ts;
    id = last.id;
    fills += page.length;
    if (page.length < PAGE) break;
  }

  // What is still held, marked at the feed's price — or, for a token the feed has never
  // quoted, at the last price the tape itself saw paid for it.
  const marks = loadPrices();
  const priceOf = new Map<string, number | undefined>();
  const open = new Map<string, { pnl: number; value: number; tokens: number }>();
  const tokens = new Map<string, number>();
  for (const [key, book] of books) {
    const [wallet, token] = key.split(":") as [string, string];
    tokens.set(wallet, (tokens.get(wallet) ?? 0) + 1);
    if (book.amount <= 0) continue;
    if (!priceOf.has(token)) priceOf.set(token, marks.get(token) ?? lastPriceOf(token));
    const price = priceOf.get(token);
    if (price === undefined) continue;
    const held = open.get(wallet) ?? { pnl: 0, value: 0, tokens: 0 };
    held.value += book.amount * price;
    held.pnl += book.amount * price - book.cost;
    held.tokens++;
    open.set(wallet, held);
  }

  const rows: StatRow[] = [...stats].map(([wallet, s]) => {
    const held = open.get(wallet);
    return {
      wallet,
      realized_24h: s.realized["24h"],
      realized_7d: s.realized["7d"],
      realized_30d: s.realized["30d"],
      realized_all: s.realized.all,
      trips_24h: s.trips["24h"],
      trips_7d: s.trips["7d"],
      trips_30d: s.trips["30d"],
      trips_all: s.trips.all,
      wins_24h: s.wins["24h"],
      wins_7d: s.wins["7d"],
      wins_30d: s.wins["30d"],
      wins_all: s.wins.all,
      unrealized: held?.pnl ?? 0,
      open_value: held?.value ?? 0,
      open_tokens: held?.tokens ?? 0,
      free: s.free,
      buys: s.buys,
      sells: s.sells,
      volume: s.volume,
      tokens: tokens.get(wallet) ?? 0,
      first_ts: s.first || null,
      last_ts: s.last || null,
      computed_at: now,
    };
  });
  saveStats(rows);
  const ms = Date.now() - at;
  log.info(`books: ${rows.length} wallets over ${fills.toLocaleString()} fills in ${ms}ms`);
  return { wallets: rows.length, fills, ms };
}

/** The same walk on a clock, for the process that is its own tape rather than an object. */
export function startBooks(minutes = 10): void {
  const tick = () => {
    try {
      rebuildStats();
    } catch (error) {
      log.error("books", error);
    }
    setTimeout(tick, minutes * 60_000);
  };
  tick();
}
