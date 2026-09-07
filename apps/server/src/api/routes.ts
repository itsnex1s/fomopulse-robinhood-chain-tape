import { Hono } from "hono";
import { chainConfig, env, wallets } from "../config.ts";
import { counts, getMeta, MAX_POOL_AGE, overview, positionsCount, tape } from "../db.ts";
import { discoverList } from "../discover.ts";
import { cursor } from "../ingest/cursor.ts";
import { latencyMs, latencySummary } from "../ingest/lag.ts";
import { limits, ms } from "../limits.ts";
import { describe, log } from "../log.ts";
import { sessionState } from "../privy.ts";
import { bagList, leaderboardState, ranking } from "../traders.ts";
import { since, WINDOW_SECONDS } from "../window.ts";
import { budget, pressure, spend } from "./budget.ts";
import { handleOf, onTape, toFill } from "./fills.ts";
import type { Overview, Status } from "./types.ts";

/**
 * Every open tab polls the same handful of queries, so each answer is computed at most once
 * per `ttlMs` per distinct query and the rest is served from memory. The lifetime may be a
 * function of the key, which is how a window pays for itself: see `byWindow`.
 */
function memo<T>(ttlMs: number | ((key: string) => number), compute: (key: string) => T) {
  const cache = new Map<string, { at: number; value: T }>();
  const lifetime = typeof ttlMs === "function" ? ttlMs : () => ttlMs;
  return (key = ""): T => {
    const hit = cache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < lifetime(key)) return hit.value;
    const value = compute(key);
    cache.set(key, { at: now, value });
    if (cache.size > 64) cache.delete(cache.keys().next().value!);
    return value;
  };
}

/**
 * How long an answer may be served from memory, by the window it covers. A window is a claim
 * about how much has to change before the answer does: five seconds of the last hour is most
 * of what the reader is looking at, and five seconds of all time is nothing at all.
 *
 * The two ladders and everything else this file paces by live in config/limits.json, with the
 * reasoning beside them; `cache.counted` is the readout, `cache.marked` the two pages carrying
 * positions priced at the feed. Neither is ever held longer than the poll behind it.
 */
const asMs = (ladder: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(ladder).map(([window, seconds]) => [window, ms(seconds)]));
export const COUNTED = asMs(limits.cache.counted);
export const MARKED = asMs(limits.cache.marked);
/** Every key here opens with the window, whatever else it carries. */
export const ttlBy =
  (ladder: Record<string, number>) =>
  (key: string): number =>
    (ladder[key.split("|")[0] ?? ""] ?? 15_000) * pressure();

/** The tape's own totals: a running count over every fill, and the first one on it. Neither
 *  is read closely enough to be worth a scan of the table twelve times a minute. */
const totals = memo(ms(limits.cache.totalsSeconds), () => {
  const row = counts();
  spend(row.trades);
  return row;
});

/**
 * Roughly how many fills a window holds, for pricing a read rather than answering one: the
 * tape's own count, times the share of its life the window covers. A window wider than the
 * tape is the whole tape, and a tape with one fill on it is one fill.
 */
function fillsIn(window: string): number {
  const { trades, first_ts, last_ts } = totals();
  const span = last_ts !== null && first_ts !== null ? Math.max(1, last_ts - first_ts) : 1;
  const seconds = WINDOW_SECONDS[window as keyof typeof WINDOW_SECONDS] ?? span;
  return Math.round(trades * Math.min(1, seconds / span));
}

/** The window in a line, as the original's readout has it: volume, buys against sells, breadth, pace, the biggest buy. */
const overviewFor = memo(ttlBy(COUNTED), (window): Overview => {
  const now = Math.floor(Date.now() / 1000);
  const o = overview(since(window), now);
  // Exactly what it walked: the window's own fills are both the answer and the cost.
  spend(o.fills);
  const big = o.biggest_buy;
  return {
    window,
    fills: o.fills,
    volume: o.volume,
    buys: o.buys,
    sells: o.sells,
    wallets: o.wallets,
    tokens: o.tokens,
    fills_5m: o.fills_5m,
    volume_5m: o.volume_5m,
    per_minute: o.fills_5m / 5,
    biggest_buy: big
      ? {
          usd: big.usd,
          ts: big.ts,
          token: big.token,
          symbol: big.symbol,
          handle: handleOf(big.wallet),
        }
      : null,
  };
});

const startedAt = Date.now();

const status = memo(5_000, (window): Status => {
  const { trades, first_ts, last_ts } = totals();
  const now = Math.floor(Date.now() / 1000);
  return {
    chain_id: chainConfig.id,
    wallets: wallets.length,
    trades,
    first_ts,
    last_block: cursor.highest,
    pending: cursor.pending,
    // The stored value appears once the catch-up is done; until then say what was configured.
    source: getMeta("source") ?? (env.wsUrl ? "websocket" : "polling"),
    // Two different numbers: how fast a fill reaches us, and how long the tape has been
    // quiet. On a chain with a trade a minute the second one is not a delay.
    latency_ms: latencyMs(),
    latency: latencySummary(),
    lag_seconds: last_ts === null ? null : Math.max(0, now - last_ts),
    last_ts,
    server_ts: now,
    uptime: Math.round((Date.now() - startedAt) / 1000),
    // The client builds explorer and DexScreener links from these, so the chain file stays the one source.
    explorer: chainConfig.explorer,
    dexscreener_slug: chainConfig.dexscreenerSlug,
    // Carried here so a tab polls one endpoint instead of two for one bar.
    overview: overviewFor(window),
    // Whose numbers are fomo's, and whether they are still arriving.
    leaderboard: leaderboardState(),
    // What the month is on course to walk, and whether the answers are being held longer
    // for it: a bill is better read here than at the end of the month.
    budget: budget(),
  };
});

const tapeFor = memo(1_000, (key) => {
  const [window, stocksFlag, dustFlag, limitText, beforeTs, beforeId] = key.split("|");
  const limit = Math.min(Number(limitText) || 400, 1_000);
  const stocks = stocksFlag !== "false";
  const dust = dustFlag === "true";
  // A page after the first carries the last row the reader holds; without both halves of
  // it there is no cursor, and the read is the first page again.
  const before =
    Number(beforeTs) > 0 && Number(beforeId) > 0 ? { ts: Number(beforeTs), id: Number(beforeId) } : undefined;
  // The dusting goes in the query; whether a token is a stock is decided in `toFill`, so both
  // filters that turn on one run here — and that is why the read is twice the page.
  const rows = tape(since(window), limit * 2, dust, before);
  // The page itself, and the two subqueries each row carries — the wallet's first buy of the
  // token, and who else bought it in the hour before — which walk an index apiece.
  spend(rows.length * 3);
  return rows
    .map(toFill)
    .filter((f) => onTape(f) && (stocks || f.is_stock === 0))
    .slice(0, limit);
});

/**
 * The two heaviest reads: the ranking walks every wallet, the bags group the tape by token
 * and join it, plus one holders query each. Both are polled by every open tab.
 */
const tradersFor = memo(ttlBy(MARKED), (key) => {
  const [window, limitText] = key.split("|");
  const resolved = window ?? "24h";
  // A grouped pass over the window's fills, plus one row per wallet from the books.
  spend(fillsIn(resolved) + wallets.length);
  return ranking(since(resolved), resolved, Math.min(Number(limitText) || 50, 300));
});

const bagsFor = memo(ttlBy(MARKED), (key) => {
  const [window, limitText] = key.split("|");
  // The positions, grouped by token four ways over — the bag, its largest holder, the
  // token's last fill and its first buy — and the window's own fills for the flow columns.
  spend(positionsCount() * 4 + fillsIn(window ?? "all"));
  return bagList(since(window), Math.min(Number(limitText) || 60, 200));
});

/**
 * The discover page: the young pools, and everyone who bought one. Bounded by the pool age
 * the storage layer cuts at rather than by the window, which here only says what "just now"
 * means — a token three days old belongs on the page whichever window the reader is in.
 */
const discoverFor = memo(ttlBy(MARKED), (key) => {
  const [window, limitText] = key.split("|");
  const limit = Math.min(Number(limitText) || 60, 200);
  // Only the pools younger than the cut are read, plus their own fills and one buyers query.
  spend(limit * 4 + fillsIn(window ?? "24h"));
  return discoverList(Math.max(since(window ?? "24h"), Math.floor(Date.now() / 1000) - MAX_POOL_AGE), limit);
});

/**
 * How long the edge in front of this may reuse an answer: the route's own lifetime from
 * config/limits.json, stretched by whatever the month is on course to spend. The cache is told
 * rather than left to decide, because holding answers longer is the one lever that answers a
 * surge, and a surge lands on the cache and not in here.
 */
const edgeTtl = (path: string, cursored: boolean): number | undefined => {
  // A page behind a cursor is a page of the past. It cannot change, so nothing is gained by
  // asking for it again, and it is the half of the tape a reader paging back asks for most.
  if (path === "/api/tape" && cursored) return limits.cache.cursorSeconds;
  return limits.cache.edge[path.slice("/api/".length)];
};

export const api = new Hono()
  .use("/api/*", async (c, next) => {
    await next();
    const seconds = edgeTtl(new URL(c.req.url).pathname, c.req.query("before") !== undefined);
    if (seconds !== undefined) c.header("x-ttl", String(Math.round(seconds * pressure())));
  })
  .get("/api/status", (c) => c.json(status(c.req.query("window") ?? "24h")))
  // The pulse. On Cloudflare the object answers this itself, with the alarm's beat as well;
  // here the process is the pulse, so it is the fomo session and how long it has been up.
  .get("/api/alive", (c) =>
    c.json({ session: sessionState(), uptime: Math.round((Date.now() - startedAt) / 1000), now: Date.now() }),
  )
  .get("/api/tape", (c) =>
    c.json(
      tapeFor(
        [
          c.req.query("window") ?? "all",
          c.req.query("stocks") ?? "true",
          c.req.query("dust") ?? "false",
          c.req.query("limit") ?? "400",
          c.req.query("before") ?? "",
          c.req.query("beforeId") ?? "",
        ].join("|"),
      ),
    ),
  )
  .get("/api/overview", (c) => c.json(overviewFor(c.req.query("window") ?? "24h")))
  // Every number this tape paces itself by, as it stands, next to what the month has spent
  // against it. Nothing here is a secret and all of it decides what the pages show.
  .get("/api/limits", (c) => c.json({ limits, budget: budget() }))
  .get("/api/traders", (c) =>
    c.json(tradersFor([c.req.query("window") ?? "24h", c.req.query("limit") ?? "50"].join("|"))),
  )
  .get("/api/bags", (c) => c.json(bagsFor([c.req.query("window") ?? "all", c.req.query("limit") ?? "60"].join("|"))))
  .get("/api/discover", (c) =>
    c.json(discoverFor([c.req.query("window") ?? "24h", c.req.query("limit") ?? "60"].join("|"))),
  )
  // A 500 with nothing behind it is a screen that stopped for a reason nobody can read.
  .onError((error, c) => {
    log.error(`api ${new URL(c.req.url).pathname}`, error);
    return c.json({ error: describe(error) }, 500);
  });
