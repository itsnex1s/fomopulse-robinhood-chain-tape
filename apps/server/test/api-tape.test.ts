/** The tape itself: the shape of a row, what the row says about the trade around it,
 *  and the dusting the screen is spared. */
import { expect, test } from "bun:test";
import { api, fill, insertFills, now, savePrice, saveToken, wallets } from "./support/api.ts";

test("the tape serves stored fills in the original site's shape", async () => {
  const trader = wallets[0]!;
  const token = "0x4444444444444444444444444444444444444444";
  const fresh = insertFills([fill({ tx: "0xapi-test", wallet: trader.address, token, amount: 2, usd: 200 })]);
  expect(fresh).toHaveLength(1);
  // The primary key makes a replay a no-op, which is what a reconnect relies on.
  expect(insertFills(fresh)).toHaveLength(0);

  const res = await api.request("/api/tape?window=1h&limit=5");
  expect(res.status).toBe(200);
  const rows = (await res.json()) as Record<string, unknown>[];
  const row = rows.find((r) => r.tx === "0xapi-test")!;
  expect(row).toMatchObject({
    side: "buy",
    usd: 200,
    priced: "cash_leg",
    handle: trader.handle,
    followers: trader.followers ?? 0,
    is_stock: 0,
    // The wallet's first buy of this token on the tape.
    new_position: 1,
    others: 0,
  });
});

test("a row carries the token's card, whether the buy opened a position, and the crowd before it", async () => {
  const early = wallets[2]!;
  const late = wallets[3]!;
  const token = "0x6666666666666666666666666666666666666666";
  savePrice(
    token,
    {
      price: 2,
      liquidity: 4_000,
      change24: 30,
      change1h: -2,
      volume24: 250_000,
      buys24: 1_200,
      sells24: 900,
      marketCap: 9_000_000,
      pairCreatedAt: (now - 600) * 1000,
      pair: "0xpool6",
      dex: "uniswap v4",
      imageUrl: "https://img.example/6.png",
    },
    now,
  );
  insertFills([
    fill({ tx: "0xcrowd-1", block: 5, ts: now - 300, wallet: early.address, token, amount: 50, usd: 50, price: 1 }),
    fill({ tx: "0xcrowd-2", block: 6, ts: now - 10, wallet: late.address, token, amount: 5_000, usd: 5_000, price: 1 }),
  ]);

  const rows = (await (await api.request("/api/tape?limit=400")).json()) as Record<string, unknown>[];
  const first = rows.find((r) => r.tx === "0xcrowd-1")!;
  const second = rows.find((r) => r.tx === "0xcrowd-2")!;
  // Both are first buys for their wallets; only the later one had company in the hour before.
  expect(first).toMatchObject({ new_position: 1, others: 0 });
  expect(second).toMatchObject({
    new_position: 1,
    others: 1,
    mark: 2,
    liquidity: 4_000,
    market_cap: 9_000_000,
    volume24: 250_000,
    buys24: 1_200,
    sells24: 900,
    change1h: -2,
    dex: "uniswap v4",
    image_url: "https://img.example/6.png",
    pair_created_at: (now - 600) * 1000,
    pair_url: "https://dexscreener.com/robinhood/0xpool6",
  });

  // The window in one line, with the biggest buy named.
  const o = (await (await api.request("/api/overview?window=1h")).json()) as Record<string, unknown> & {
    biggest_buy: { usd: number; handle: string } | null;
  };
  expect(o.buys as number).toBeGreaterThanOrEqual(2);
  expect(o.volume as number).toBeGreaterThanOrEqual(5_050);
  expect(o.wallets as number).toBeGreaterThanOrEqual(2);
  expect(typeof o.per_minute).toBe("number");
  expect(o.biggest_buy).toMatchObject({ usd: 5_000, handle: late.handle });
});

test("dusting is hidden from the tape, and one real trade brings the token back", async () => {
  const dusted = "0xdead44444444444444444444444444444444dead" as `0x${string}`;
  saveToken(dusted, 18, "SPAM", "Free Money");
  // Reconstruction already decided these: cents, from an account, nothing paid in the transaction.
  insertFills(
    wallets.slice(0, 3).map((trader, i) =>
      fill({
        tx: `0xdust-${i}`,
        block: 2,
        wallet: trader.address,
        token: dusted,
        amount: 110,
        usd: 0.04,
        price: 0.0004,
        priced: "estimate",
        dust: true,
      }),
    ),
  );

  type Row = { tx: string; token: string; is_dust: number };
  const hidden = (await (await api.request("/api/tape?limit=400")).json()) as Row[];
  expect(hidden.some((f) => f.token === dusted)).toBe(false);
  const shown = (await (await api.request("/api/tape?limit=400&dust=true")).json()) as Row[];
  expect(shown.filter((f) => f.token === dusted)).toHaveLength(3);
  expect(shown.find((f) => f.tx === "0xapi-test")!.is_dust).toBe(0);

  // Somebody pays for it: the token is real, and the fills that were hidden come back.
  insertFills([
    fill({
      tx: "0xdust-real",
      block: 3,
      wallet: wallets[0]!.address,
      token: dusted,
      amount: 1_000,
      usd: 900,
      price: 0.9,
    }),
  ]);
  // A different limit is a different cache key, so this reads the tape again rather than the memo.
  const back = (await (await api.request("/api/tape?limit=399")).json()) as Row[];
  expect(back.filter((f) => f.token === dusted)).toHaveLength(4);
});

test("a page continues from the cursor, and a shared second is neither repeated nor skipped", async () => {
  const trader = wallets[1]!;
  const token = "0x9999999999999999999999999999999999999999";
  // Three of the four share a second: a cursor on time alone would hand back the rest of
  // that second or lose it, which is why the row's id travels with it.
  insertFills([
    fill({ tx: "0xpage-a", logIndex: 1, wallet: trader.address, token, ts: now - 30 }),
    fill({ tx: "0xpage-b", logIndex: 2, wallet: trader.address, token, ts: now - 30 }),
    fill({ tx: "0xpage-c", logIndex: 3, wallet: trader.address, token, ts: now - 30 }),
    fill({ tx: "0xpage-d", logIndex: 4, wallet: trader.address, token, ts: now - 31 }),
  ]);

  const mine = (rows: { tx: string }[]) => rows.filter((r) => r.tx.startsWith("0xpage-")).map((r) => r.tx);
  const first = (await (await api.request("/api/tape?window=1h&limit=400")).json()) as {
    tx: string;
    ts: number;
    id: number;
  }[];
  const page = mine(first);
  expect(page.length).toBeGreaterThanOrEqual(4);

  const last = first.find((r) => r.tx === page[1])!;
  const older = (await (
    await api.request(`/api/tape?window=1h&limit=400&before=${last.ts}&beforeId=${last.id}`)
  ).json()) as { tx: string }[];

  // Everything after the cursor, nothing on or before it, and no row twice.
  expect(mine(older)).toEqual(page.slice(2));
  expect(new Set(mine(older)).size).toBe(mine(older).length);
});
