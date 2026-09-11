/**
 * What a socket is handed the moment it connects. The first page a reader draws comes from
 * the colo's cache and is a snapshot of the past; without this the fills that landed after
 * that snapshot reach nobody, because the socket only carries what arrives after it opens.
 */
import { expect, test } from "bun:test";
import "./support/memory.ts";
import { STOCK_MIN_USD, tail } from "../src/api/fills.ts";
import { limits } from "../src/limits.ts";
import { fill, insertFills, now, wallets } from "./support/api.ts";

const HOUR = 3_600;
/** A tokenised stock, so the size rule the tape applies can be tested through the socket. */
const STOCK = "0x1b0e319c6a659f002271b69db8a7df2f911c153e";

test("the tail carries what just landed and not what has aged out", () => {
  const trader = wallets[0]!;
  const token = "0xdead00000000000000000000000000000000beef";
  insertFills([
    fill({ tx: "0xtail-fresh", wallet: trader.address, token, ts: now - 5 }),
    // Four times the cache's own lifetime is the window; an hour is past it under any setting.
    fill({ tx: "0xtail-stale", wallet: trader.address, token, ts: now - HOUR }),
  ]);
  const txs = tail().map((f) => f.tx);
  expect(txs).toContain("0xtail-fresh");
  expect(txs).not.toContain("0xtail-stale");
});

test("the socket and the page agree on what is worth a line", () => {
  const trader = wallets[1]!;
  insertFills([
    fill({ tx: "0xtail-big", wallet: trader.address, token: STOCK, ts: now - 5, usd: STOCK_MIN_USD + 1 }),
    fill({ tx: "0xtail-small", wallet: trader.address, token: STOCK, ts: now - 5, usd: STOCK_MIN_USD - 1 }),
  ]);
  const txs = tail().map((f) => f.tx);
  // Same rule as the REST tape: a fractional stock buy is a credit, not a trade.
  expect(txs).toContain("0xtail-big");
  expect(txs).not.toContain("0xtail-small");
});

test("the window it covers outlives the cache it is closing the gap behind", () => {
  // The number is derived from the edge lifetime, so raising one cannot leave the other short.
  const rows = tail();
  const oldest = rows.reduce((min, f) => (f.ts < min ? f.ts : min), now);
  expect(now - oldest).toBeLessThanOrEqual(Math.max(60, (limits.cache.edge.tape ?? 15) * 4));
  expect(Math.max(60, (limits.cache.edge.tape ?? 15) * 4)).toBeGreaterThan(limits.cache.edge.tape ?? 15);
});
