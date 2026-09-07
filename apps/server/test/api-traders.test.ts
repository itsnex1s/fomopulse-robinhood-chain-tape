/** The traders page: every number on it walked from this tape's own fills. */
import { expect, test } from "bun:test";
import { rebuildStats } from "../src/pnl.ts";
import { api, fill, insertFills, now, wallets } from "./support/api.ts";

const winner = wallets[15]!;
const loser = wallets[16]!;
const token = "0xa11c111111111111111111111111111111111111";

type Row = Record<string, number | string | null>;
const page = async (query: string) => (await (await api.request(`/api/traders?${query}`)).json()) as Row[];

test("the ranking is the books: what closed in the window, what is still open, and the place that puts a wallet in", async () => {
  insertFills([
    // A round trip that doubled: bought a hundred thousand dollars of it, sold for two.
    fill({ tx: "0xtr-win-buy", wallet: winner.address, token, amount: 100, usd: 100_000, price: 1_000, ts: now - 300 }),
    fill({
      tx: "0xtr-win-sell",
      wallet: winner.address,
      token,
      side: "sell",
      amount: 100,
      usd: 200_000,
      price: 2_000,
      ts: now - 200,
    }),
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
    realized: 100_000,
    unrealized: 0,
    total: 100_000,
    trips: 1,
    wins: 1,
    open_tokens: 0,
  });
  expect(lost).toMatchObject({ realized: -50, total: -50, trips: 1, wins: 0 });
  // Everything sold, so there is nothing left to mark and the tape's own volume is both legs.
  expect(won.tape_volume).toBe(300_000);
  expect(won.stats_at).not.toBeNull();
  expect((won.rank as number) < (lost.rank as number)).toBe(true);
});

/**
 * A rank that changed with the page size meant a wallet was #7 on one screen and #3 on the
 * next. It is worked out over every wallet with books, once, and the page is cut afterwards.
 */
test("a rank means the same thing at any page size", async () => {
  const [small, large] = await Promise.all([page("window=24h&limit=8"), page("window=24h&limit=300")]);
  const on = (rows: Row[]) => rows.find((row) => row.address === winner.address)!;
  // The loudest wallet on the tape in this window, so it is on the short page as well.
  expect(on(small).rank).toBe(on(large).rank);
});
