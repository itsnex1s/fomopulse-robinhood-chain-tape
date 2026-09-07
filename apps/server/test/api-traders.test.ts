/** The traders page: every number on it walked from this tape's own fills. */
import { expect, test } from "bun:test";
import { rebuildStats } from "../src/pnl.ts";
import { api, fill, insertFills, now, wallets } from "./support/api.ts";

const winner = wallets[15]!;
const loser = wallets[16]!;
const token = "0xa11c111111111111111111111111111111111111";

type Row = Record<string, number | string | null>;
const page = async (query: string) => (await (await api.request(`/api/traders?${query}`)).json()) as Row[];

// Every file of a run shares one database, so a fill here is a fill on everyone's tape:
// sizes stay under the biggest buy another file asserts on.
const leg = (n: number, side: "buy" | "sell", usd: number, ts: number) =>
  fill({ tx: `0xtr-${side}-${n}`, wallet: winner.address, token, side, amount: 100, usd, price: usd / 100, ts });

test("the ranking is the books: what closed in the window, what is still open, and the place that puts a wallet in", async () => {
  insertFills([
    // Three hundred tokens bought at $20 and sold at $40: three round trips, all ahead.
    leg(1, "buy", 2_000, now - 300),
    leg(2, "buy", 2_000, now - 290),
    leg(3, "buy", 2_000, now - 280),
    leg(4, "sell", 4_000, now - 200),
    leg(5, "sell", 4_000, now - 190),
    leg(6, "sell", 4_000, now - 180),
    // And one that halved.
    fill({ tx: "0xtr-lose-buy", wallet: loser.address, token, amount: 100, usd: 100, price: 1, ts: now - 300 }),
    fill({
      tx: "0xtr-lose-sell",
      wallet: loser.address,
      token,
      side: "sell",
      amount: 100,
      usd: 50,
      price: 0.5,
      ts: now - 200,
    }),
  ]);
  rebuildStats();

  const rows = await page("window=24h&limit=300");
  const won = rows.find((row) => row.address === winner.address)!;
  const lost = rows.find((row) => row.address === loser.address)!;

  expect(won).toMatchObject({
    handle: winner.handle,
    pnl_window: "24h",
    realized: 6_000,
    unrealized: 0,
    total: 6_000,
    trips: 3,
    wins: 3,
    open_tokens: 0,
  });
  expect(lost).toMatchObject({ realized: -50, total: -50, trips: 1, wins: 0 });
  // Everything sold, so there is nothing left to mark and the tape's own volume is both legs.
  expect(won.tape_volume).toBe(18_000);
  expect(won.stats_at).not.toBeNull();
  expect((won.rank as number) < (lost.rank as number)).toBe(true);
});

/**
 * A rank that changed with the page size meant a wallet was #7 on one screen and #3 on the
 * next. It is worked out over every wallet with books, once, and the page is cut afterwards.
 */
test("a rank means the same thing at any page size", async () => {
  const [small, large] = await Promise.all([page("window=24h&limit=8"), page("window=24h&limit=300")]);
  const ranks = new Map(large.map((row) => [row.address, row.rank]));
  expect(small.length).toBe(8);
  for (const row of small) expect(row.rank).toBe(ranks.get(row.address) ?? null);
});
