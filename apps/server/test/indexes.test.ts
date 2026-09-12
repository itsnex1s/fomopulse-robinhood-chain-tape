/**
 * The two writes an arriving fill makes against its own token. Both look at a handful of the
 * token's rows and both were reading all of them, which was nearly half of everything this
 * tape walks: the plan is the check, because a query that has quietly stopped using its index
 * still returns the right answer and only shows up on the bill.
 */
import { expect, test } from "bun:test";
import "./support/memory.ts";
import { db } from "../src/db.ts";

/** The two joins of the discover page, with the CTE they hang off, as db/discover.ts writes them. */
const discoverPlan = `WITH young AS MATERIALIZED (
    SELECT p.token AS token FROM prices p WHERE p.pair_created_at >= 1 AND p.liquidity_usd >= 2
  ),
  per_wallet AS (
    SELECT f.token AS token, f.wallet AS wallet, f.side AS side, f.dust AS dust,
           COUNT(*) AS fills, SUM(f.usd) AS usd, MIN(f.ts) AS first_ts, MAX(f.ts) AS last_ts
      FROM young y CROSS JOIN fills f ON f.token = y.token
     GROUP BY f.token, f.wallet, f.side, f.dust
  ),
  flow AS (SELECT token, SUM(fills) AS fills FROM per_wallet GROUP BY token),
  washed AS (
    SELECT a.token AS token, COUNT(*) AS flips
      FROM young y
      CROSS JOIN fills a ON a.token = y.token
      JOIN fills b ON b.wallet = a.wallet AND b.token = a.token AND b.ts > a.ts AND b.ts <= a.ts + 300
     WHERE a.dust = 0 AND b.dust = 0 AND a.side = 'buy' AND b.side = 'sell'
     GROUP BY a.token
  )
  SELECT y.token, flow.fills, washed.flips FROM young y
    LEFT JOIN flow ON flow.token = y.token LEFT JOIN washed ON washed.token = y.token`;

// Prepared rather than queried, and let go of by hand: `query` keeps its statement in the
// database's cache, and a cached plan over a write is a statement bun still counts as running
// when the next test's transaction tries to commit.
const plan = (sql: string, ...bindings: (string | number)[]): string => {
  const statement = db.prepare<{ detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN ${sql}`);
  try {
    return statement
      .all(...bindings)
      .map((row) => row.detail)
      .join(" | ");
  } finally {
    statement.finalize();
  }
};

test("the dust pardon reads the dusty rows of a token, not every row of it", () => {
  const detail = plan(
    `UPDATE fills SET dust = 0
      WHERE dust = 1 AND token = ?1
        AND EXISTS (SELECT 1 FROM fills q WHERE q.token = ?1 AND (q.priced = 'cash_leg' OR q.side = 'sell'))`,
    "0xtoken",
  );
  expect(detail).toContain("fills_dusty");
  expect(detail).not.toContain("SCAN fills");
});

test("the supply stamp reads the unstamped rows of a token, not every row of it", () => {
  const detail = plan(
    `UPDATE fills
        SET supply = (SELECT market_cap / price_usd FROM prices WHERE token = ?1 AND price_usd > 0 AND market_cap IS NOT NULL)
      WHERE token = ?1 AND supply IS NULL AND ts >= ?2
        AND EXISTS (SELECT 1 FROM prices WHERE token = ?1 AND price_usd > 0 AND market_cap IS NOT NULL)`,
    "0xtoken",
    0,
  );
  expect(detail).toContain("fills_unstamped");
  expect(detail).not.toContain("SCAN fills");
});

test("choosing what to quote reads the quotes, not every fill on the tape", () => {
  const detail = plan(
    `SELECT p.token AS token FROM prices p
      WHERE p.updated_at < ?1
        AND EXISTS (SELECT 1 FROM fills f WHERE f.token = p.token AND f.ts >= ?2)
      LIMIT ?3`,
    0,
    0,
    10,
  );
  // One row per token ever priced, and the fills asked only whether each of them traded.
  expect(detail).toContain("SCAN p");
  expect(detail).toContain("SEARCH f USING COVERING INDEX fills_token_ts (token=? AND ts>?)");
  expect(detail).not.toContain("SCAN fills");
  expect(detail).not.toContain("SCAN f USING");
  // No sort, so the scan stops at the first call's worth instead of ordering every quote to
  // find the oldest. The age cut is the rotation: quoting a token puts it out of the next one.
  expect(detail).not.toContain("TEMP B-TREE FOR ORDER BY");
});

test("the fills owed a price are read by time, not token by token", () => {
  const detail = plan("SELECT token, tx, log_index, amount FROM fills WHERE priced = 'unpriced' AND ts >= ?", 0);
  expect(detail).toContain("fills_unpriced");
  expect(detail).not.toContain("SCAN fills");
});

test("the discover page walks the young pools, not the whole tape twice over", () => {
  // The pools are the small side of every join on that page. Left to itself the planner walks
  // the fills instead — once for the flow and once for the wash pairs — which is the entire
  // tape read twice for a page about the last three days.
  const detail = plan(discoverPlan);
  expect(detail).not.toContain("SCAN f USING");
  expect(detail).not.toContain("SCAN a USING");
  // Not covering any more: the one grouping that serves both the flow columns and the
  // buyer strip reads the wallet and the side off the row, which is what saved a second walk.
  expect(detail).toContain("SEARCH f USING INDEX fills_token_ts (token=?)");
  expect(detail).toContain("SEARCH a USING INDEX fills_token_ts (token=?)");
});

test("the quotes carry no index that every sweep would have to rewrite", () => {
  // Deliberately not indexed. `prices` is a few hundred rows and every one the sweep quotes is
  // rewritten: scanning them is a read, indexing them is a write per quote, and a row written
  // is priced at a thousand times a row read.
  const columns = db
    .query<{ name: string }, []>("SELECT name FROM pragma_index_list('prices')")
    .all()
    .map((row) => row.name);
  expect(columns.filter((name) => !name.startsWith("sqlite_autoindex"))).toEqual([]);
});

test("the window's biggest buy is the first row of an index, not the window sorted", () => {
  const detail = plan(
    `SELECT f.usd, f.wallet, f.token, t.symbol, f.ts
       FROM fills f LEFT JOIN tokens t ON t.address = f.token
      WHERE f.ts >= ? AND f.dust = 0 AND f.side = 'buy' AND f.usd IS NOT NULL
      ORDER BY f.usd DESC LIMIT 1`,
    0,
  );
  expect(detail).toContain("fills_big_buys");
  expect(detail).not.toContain("TEMP B-TREE FOR ORDER BY");
});

test("the tape's first and last fill are two seeks, not a walk of the tape", () => {
  const detail = plan("SELECT (SELECT MIN(ts) FROM fills) AS a, (SELECT MAX(ts) FROM fills) AS b");
  // Asked together with COUNT(*), as they were, the same statement has to walk every row.
  expect(detail).toContain("fills_ts");
  expect(detail).not.toContain("SCAN fills");
});

test("the traders' aggregate is planned two ways, and each is the plan it is chosen for", () => {
  const body = "SELECT wallet, COUNT(*) AS fills, COALESCE(SUM(usd), 0) AS volume, MAX(ts) AS last_ts";
  // Left to itself the planner takes the index whose order the GROUP BY already wants and
  // walks all of it: the window costs a comparison per fill and saves nothing. That is the
  // right plan only when the window is most of the tape.
  const grouped = plan(`${body} FROM fills WHERE ts >= ? GROUP BY wallet`, 0);
  expect(grouped).toContain("SCAN fills USING INDEX fills_wallet_token_ts");
  expect(grouped).not.toContain("TEMP B-TREE");

  // Forced down fills_ts it reads the window and sorts the wallets, which is what a page about
  // the last hour wants: measured against the object, two thousand rows against sixty-seven.
  const seeked = plan(`${body} FROM fills INDEXED BY fills_ts WHERE ts >= ? GROUP BY wallet`, 0);
  expect(seeked).toContain("SEARCH fills USING INDEX fills_ts (ts>?)");
  expect(seeked).not.toContain("SCAN fills");
});

test("the crowd behind a page is one seek per token, not a walk of the tape", () => {
  // The count each tape row carries, read for the page at once. Left to itself the planner
  // has no idea how many tokens the list holds and can decide to walk the fills instead.
  const detail = plan(
    `SELECT q.token AS token, q.wallet AS wallet, q.ts AS ts
       FROM json_each(?1) j
       CROSS JOIN fills q ON q.token = j.value
      WHERE q.side = 'buy' AND q.dust = 0 AND q.ts BETWEEN ?2 AND ?3`,
    "[]",
    0,
    0,
  );
  expect(detail).toContain("SEARCH q USING INDEX fills_token_ts (token=? AND ts>? AND ts<?)");
  expect(detail).not.toContain("SCAN q");
});

test("the page's first buyer is a seek per pool, not a walk of every position", () => {
  // Written the other way round — positions joined to the pools — the planner takes the
  // positions as the outer table and walks all of them to name the first buyer of a couple
  // of hundred tokens, which was three quarters of what the page read.
  const detail = plan(`WITH young AS MATERIALIZED (
      SELECT q.token AS token FROM prices q WHERE q.pair_created_at >= 1 AND q.liquidity_usd >= 2
    )
    SELECT token, first_buy_ts, wallet AS first_buyer FROM (
      SELECT y.token AS token, p.first_buy_ts AS first_buy_ts, p.wallet AS wallet,
             ROW_NUMBER() OVER (PARTITION BY y.token ORDER BY p.first_buy_ts, p.wallet) AS place
        FROM young y CROSS JOIN positions p ON p.token = y.token
       WHERE p.first_buy_ts IS NOT NULL
    ) WHERE place = 1`);
  expect(detail).toContain("SEARCH p USING PRIMARY KEY (token=?)");
  expect(detail).not.toContain("SCAN p");
});
