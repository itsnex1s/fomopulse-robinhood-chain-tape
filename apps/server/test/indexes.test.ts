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
  flow AS (
    SELECT f.token AS token, COUNT(*) AS fills FROM young y CROSS JOIN fills f ON f.token = y.token GROUP BY f.token
  ),
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
      WHERE EXISTS (SELECT 1 FROM fills f WHERE f.token = p.token AND f.ts >= ?1)
      ORDER BY p.updated_at ASC
      LIMIT ?2`,
    0,
    10,
  );
  // One row per token ever priced, and the fills asked only whether each of them traded.
  expect(detail).toContain("SCAN p");
  expect(detail).toContain("SEARCH f USING COVERING INDEX fills_token_ts (token=? AND ts>?)");
  expect(detail).not.toContain("SCAN fills");
  expect(detail).not.toContain("SCAN f USING");
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
  expect(detail).toContain("SEARCH f USING COVERING INDEX fills_token_ts (token=?)");
  expect(detail).toContain("SEARCH a USING INDEX fills_token_ts (token=?)");
});

test("the quotes are ordered by a sort rather than by an index that every pass would rewrite", () => {
  // Deliberately not indexed. `prices` is a few hundred rows and the quote pass rewrites most
  // of them four times a minute: sorting them is a read, indexing them is a write per quote,
  // and a row written is priced at a thousand times a row read.
  const columns = db
    .query<{ name: string }, []>("SELECT name FROM pragma_index_list('prices')")
    .all()
    .map((row) => row.name);
  expect(columns.filter((name) => !name.startsWith("sqlite_autoindex"))).toEqual([]);
});
