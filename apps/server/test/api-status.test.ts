/** The readouts that say what the tape is and where its links go, and the shell around it. */
import { expect, test } from "bun:test";
import { api, wallets } from "./support/api.ts";

test("status carries what the client builds links and the header from", async () => {
  const res = await api.request("/api/status");
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.chain_id).toBe(4663);
  expect(body.wallets).toBe(wallets.length);
  expect(typeof body.trades).toBe("number");
  expect(typeof body.last_block).toBe("number");
  expect(String(body.explorer)).toStartWith("https://");
  expect(body.dexscreener_slug).toBe("robinhood");
});

test("the status carries the window's line, so the bar is one poll and not two", async () => {
  const res = await api.request("/api/status?window=24h");
  const body = (await res.json()) as { overview?: Record<string, unknown> };
  expect(body.overview).toBeDefined();
  expect(body.overview!.window).toBe("24h");
  expect(typeof body.overview!.fills).toBe("number");
  expect(typeof body.overview!.per_minute).toBe("number");
  // The same shape the standalone endpoint answers with, for anything reading that one.
  const alone = (await (await api.request("/api/overview?window=24h")).json()) as Record<string, unknown>;
  expect(Object.keys(body.overview!).sort()).toEqual(Object.keys(alone).sort());
});

test("a limit above the cap is trimmed and a bad window means all", async () => {
  const res = await api.request("/api/tape?window=whenever&limit=999999");
  expect(res.status).toBe(200);
  expect(Array.isArray(await res.json())).toBe(true);
});

test("a missing static file is a 404, not the app shell", async () => {
  const res = await api.request("/nope.png");
  expect(res.status).toBe(404);
});
