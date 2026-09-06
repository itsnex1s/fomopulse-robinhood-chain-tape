import { Hono } from "hono";
import { chainConfig, env, wallets } from "../config.ts";
import { counts, getMeta, overview, tape } from "../db.ts";
import { cursor } from "../ingest/cursor.ts";
import { latencyMs, latencySummary } from "../ingest/lag.ts";
import { sessionState } from "../privy.ts";
import { bagList, leaderboardState, ranking } from "../traders.ts";
import { since } from "../window.ts";
import { handleOf, toFill } from "./fills.ts";
import type { Overview, Status } from "./types.ts";

/**
 * Every open tab polls `/api/status` and reloads the tape on each window change; the
 * answers barely change between polls, so they are computed at most once per `ttlMs`
 * per distinct query and the rest is served from memory.
 */
function memo<T>(ttlMs: number, compute: (key: string) => T) {
  const cache = new Map<string, { at: number; value: T }>();
  return (key = ""): T => {
    const hit = cache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < ttlMs) return hit.value;
    const value = compute(key);
    cache.set(key, { at: now, value });
    if (cache.size > 64) cache.delete(cache.keys().next().value!);
    return value;
  };
}

/** The window in a line, as the original's readout has it: volume, buys against sells, breadth, pace, the biggest buy. */
const overviewFor = memo(5_000, (window): Overview => {
  const now = Math.floor(Date.now() / 1000);
  const o = overview(since(window), now);
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
  const { trades, first_ts, last_ts } = counts();
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
    // Every tab used to poll this and /api/overview on two timers a couple of seconds
    // apart, which is two round trips to the object for one bar. One answer carries both.
    overview: overviewFor(window),
    // Whose numbers are fomo's, and whether they are still arriving.
    leaderboard: leaderboardState(),
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
  // The dusting goes in the query; whether a token is a stock is decided in `toFill`, so
  // that one filter still runs here — and only then is it worth reading twice the rows.
  const rows = tape(since(window), stocks ? limit : limit * 2, dust, before);
  return rows
    .map(toFill)
    .filter((f) => stocks || f.is_stock === 0)
    .slice(0, limit);
});

/**
 * The two heaviest reads: the ranking walks every wallet, the bags group the tape by
 * token and join it, plus one holders query each. Every open tab polls both, so they are
 * cached like the tape — a second request inside the TTL never touches SQLite.
 */
const tradersFor = memo(10_000, (key) => {
  const [window, limitText] = key.split("|");
  const resolved = window ?? "24h";
  return ranking(since(resolved), resolved, Math.min(Number(limitText) || 50, 300));
});

const bagsFor = memo(15_000, (key) => {
  const [window, limitText] = key.split("|");
  return bagList(since(window), Math.min(Number(limitText) || 60, 200));
});

export const api = new Hono()
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
  .get("/api/traders", (c) =>
    c.json(tradersFor([c.req.query("window") ?? "24h", c.req.query("limit") ?? "50"].join("|"))),
  )
  .get("/api/bags", (c) => c.json(bagsFor([c.req.query("window") ?? "all", c.req.query("limit") ?? "60"].join("|"))));
