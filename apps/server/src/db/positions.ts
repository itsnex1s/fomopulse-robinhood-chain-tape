import { db } from "./connection.ts";
import { getMeta, setMeta } from "./meta.ts";

/**
 * The net position of every wallet in every token, held as a table instead of worked out
 * again on each read. Five queries used to open with the same grouped pass over the whole
 * tape — the bags, their holders, the tokens worth quoting, the ones still without a name,
 * the hourly snapshot — and the busiest of them answers a poll from every open tab.
 *
 * The fills stay the truth. This is written from them: for one token when a fill lands in
 * it or its price arrives, and in full after a prune or a replay, which move rows this has
 * no name for. Nothing reads it before the first full pass has run.
 */

/** The columns, in the order both writers use. */
const COLUMNS = "wallet, token, amount, gross, bought_usd, bought_amount, last_ts, first_buy_ts";
/** A position off the fills: what is left, what the priced buys cost, and the two timestamps
 *  the token's own row is built from. `dust = 0` throughout, as every reader wants it. */
const READ = `SELECT wallet, token,
    SUM(CASE WHEN side = 'buy' THEN amount ELSE -amount END),
    SUM(amount),
    SUM(CASE WHEN side = 'buy' AND usd IS NOT NULL THEN usd ELSE 0 END),
    SUM(CASE WHEN side = 'buy' AND usd IS NOT NULL THEN amount ELSE 0 END),
    MAX(ts), MIN(CASE WHEN side = 'buy' THEN ts END)
  FROM fills WHERE dust = 0`;

const stmt = {
  count: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM positions"),
  dropAll: db.query("DELETE FROM positions"),
  dropToken: db.query("DELETE FROM positions WHERE token = ?"),
  dropOne: db.query("DELETE FROM positions WHERE token = ?1 AND wallet = ?2"),
  fillAll: db.query(`INSERT INTO positions (${COLUMNS}) ${READ} GROUP BY wallet, token`),
  /** The same read for one token, off the fills' own index on it. */
  fillToken: db.query(`INSERT INTO positions (${COLUMNS}) ${READ} AND token = ?1 GROUP BY wallet`),
  /** And for the one wallet in it that traded, which is what a fill landing actually changes. */
  fillOne: db.query(`INSERT INTO positions (${COLUMNS}) ${READ} AND token = ?1 AND wallet = ?2 GROUP BY wallet`),
};

/** Set once the table has been built from the fills at least once, so an empty tape is not
 *  mistaken for an unbuilt table and rebuilt on every read. */
const BUILT = "positions:built";
let built = false;

/** Rebuild the whole table from the fills. Called after anything that moved rows without
 *  naming their token — a prune, a replay — and once on a database that predates the table. */
export function rebuildPositions(): void {
  db.transaction(() => {
    stmt.dropAll.run();
    stmt.fillAll.run();
    setMeta(BUILT, "1");
  })();
  built = true;
}

/**
 * The positions of one token, every wallet in it rewritten from the fills. For the two things
 * that reach a whole token at once: the pardon that brings its dusted history back, and a
 * price arriving for fills that landed without one.
 *
 * No check that the table has been built: this runs inside the insert's own transaction, and
 * a rebuild started from in there would be a transaction inside a transaction. On an unbuilt
 * table these rows are right for their token and the first full pass replaces them anyway.
 */
export function refreshPositions(tokens: Iterable<string>): void {
  for (const token of tokens) {
    stmt.dropToken.run(token);
    stmt.fillToken.run(token);
  }
}

/** One wallet's position in one token. What a fill landing actually changes — and rows
 *  written is the allowance this tape is nearest to spending, so a fill in a token twenty
 *  wallets hold rewrites one row rather than twenty. */
export function refreshHeld(pairs: Iterable<{ wallet: string; token: string }>): void {
  for (const { wallet, token } of pairs) {
    stmt.dropOne.run(token, wallet);
    stmt.fillOne.run(token, wallet);
  }
}

/** Whether the table can be read yet, building it the first time it is asked for. */
export function positionsReady(): boolean {
  if (built) return true;
  if (getMeta(BUILT) === "1") {
    built = true;
    return true;
  }
  rebuildPositions();
  return true;
}

/** How many rows the positions table holds, which is what every bag read walks. Kept for
 *  half a minute: it is asked for to price a read, not to answer one. */
let counted: { at: number; n: number } | undefined;
export function positionsCount(now = Date.now()): number {
  if (counted === undefined || now - counted.at > 30_000) counted = { at: now, n: stmt.count.get()?.n ?? 0 };
  return counted.n;
}
