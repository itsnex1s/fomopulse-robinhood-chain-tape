/**
 * The positions table against the fills it stands for. Every screen that says anything about
 * a holding reads the table now, so the one thing worth proving is that it never says
 * something the fills would not: after a buy, after the sell that closes it, after a token is
 * pardoned out of the dusting, and after a price turns an unpriced buy into a cost.
 */
import { expect, test } from "bun:test";
import { refreshPositions } from "../src/db/positions.ts";
import { db, prune, setEstimate } from "../src/db.ts";
import { fill, insertFills, now, wallets } from "./support/api.ts";

/** The table's rows for one token, and the same rows derived from the fills the old way. */
function both(token: string) {
  const stored = db
    .query<Record<string, unknown>, [string]>(
      "SELECT wallet, amount, gross, bought_usd, bought_amount, last_ts, first_buy_ts FROM positions WHERE token = ? ORDER BY wallet",
    )
    .all(token);
  const derived = db
    .query<Record<string, unknown>, [string]>(
      `SELECT wallet,
          SUM(CASE WHEN side = 'buy' THEN amount ELSE -amount END) AS amount,
          SUM(amount) AS gross,
          SUM(CASE WHEN side = 'buy' AND usd IS NOT NULL THEN usd ELSE 0 END) AS bought_usd,
          SUM(CASE WHEN side = 'buy' AND usd IS NOT NULL THEN amount ELSE 0 END) AS bought_amount,
          MAX(ts) AS last_ts, MIN(CASE WHEN side = 'buy' THEN ts END) AS first_buy_ts
        FROM fills WHERE dust = 0 AND token = ? GROUP BY wallet ORDER BY wallet`,
    )
    .all(token);
  return { stored, derived };
}

const agrees = (token: string) => {
  const { stored, derived } = both(token);
  expect(stored).toEqual(derived);
  return stored;
};

test("a buy, then the sell that closes it, leave the table saying what the fills say", () => {
  const trader = wallets[0]!;
  const token = "0xp0s0000000000000000000000000000000000a1";
  insertFills([
    fill({ tx: "0xpos-buy", block: 9_201, ts: now - 300, wallet: trader.address, token, amount: 10, usd: 100 }),
  ]);
  expect(agrees(token)[0]?.amount).toBe(10);

  insertFills([
    fill({
      tx: "0xpos-sell",
      block: 9_202,
      ts: now - 100,
      wallet: trader.address,
      token,
      side: "sell",
      amount: 10,
      usd: 130,
    }),
  ]);
  // The row stays — the token's first buy and last fill are read off it — but nothing is held.
  const after = agrees(token);
  expect(after).toHaveLength(1);
  expect(after[0]?.amount).toBe(0);
});

test("a token pardoned out of the dusting brings its whole history into the table", () => {
  const trader = wallets[0]!;
  const token = "0xp0s0000000000000000000000000000000000a2";
  // Landed as a handout: dusted, and no position as far as any screen is concerned.
  insertFills([
    fill({
      tx: "0xpos-dust",
      block: 9_203,
      ts: now - 600,
      wallet: trader.address,
      token,
      amount: 500,
      usd: null,
      price: null,
      priced: "unpriced",
      dust: 1,
    }),
  ]);
  expect(agrees(token)).toHaveLength(0);

  // One paid trade says the token is real, and the dusted fill comes back with it.
  insertFills([
    fill({ tx: "0xpos-real", block: 9_204, ts: now - 60, wallet: trader.address, token, amount: 4, usd: 40 }),
  ]);
  expect(agrees(token)[0]?.amount).toBe(504);
});

test("a price arriving after the fill turns it into a cost the table carries", () => {
  const trader = wallets[0]!;
  const token = "0xp0s0000000000000000000000000000000000a3";
  insertFills([
    fill({
      tx: "0xpos-late",
      block: 9_205,
      ts: now - 30,
      wallet: trader.address,
      token,
      amount: 8,
      usd: null,
      price: null,
      priced: "unpriced",
    }),
  ]);
  expect(agrees(token)[0]?.bought_usd).toBe(0);

  // What the price feed does when it finally quotes the token: price the fills, then say
  // which token they were in. The second half is the contract — a statement that writes to
  // `fills` leaves the table behind until its caller names the token.
  setEstimate("0xpos-late", 0, 8 * 2.5, 2.5);
  refreshPositions([token]);
  expect(agrees(token)[0]?.bought_usd).toBe(20);
});

test("a prune drops fills by time, and the table is read off the tape again", () => {
  const trader = wallets[0]!;
  const token = "0xp0s0000000000000000000000000000000000a4";
  const old = now - 200 * 86_400;
  insertFills([
    fill({ tx: "0xpos-ancient", block: 9_206, ts: old, wallet: trader.address, token, amount: 3, usd: 30 }),
  ]);
  expect(agrees(token)).toHaveLength(1);
  prune(now);
  expect(agrees(token)).toHaveLength(0);
});
