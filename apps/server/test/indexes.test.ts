/**
 * The two writes an arriving fill makes against its own token. Both look at a handful of the
 * token's rows and both were reading all of them, which was nearly half of everything this
 * tape walks: the plan is the check, because a query that has quietly stopped using its index
 * still returns the right answer and only shows up on the bill.
 */
import { expect, test } from "bun:test";
import "./support/memory.ts";
import { db } from "../src/db.ts";

/** The ranking half of the discover page, with the CTE it hangs off, as db/discover.ts writes it. */
const discoverPlan = `WITH young AS MATERIALIZED (
    SELECT q.token AS token FROM prices q WHERE q.pair_created_at >= 1 AND q.liquidity_usd >= 2
  ),
  flow AS (
    SELECT f.token AS token, COUNT(*) AS fills, COUNT(DISTINCT f.wallet) AS buyers
      FROM young y CROSS JOIN fills f ON f.token = y.token GROUP BY f.token
  )
  SELECT y.token, flow.fills, flow.buyers FROM young y JOIN flow ON flow.token = y.token`;

/** The half asked of the page's own tokens once the ranking has chosen them. */
const detailPlan = `SELECT w.value AS token,
    (SELECT COUNT(*) FROM positions po WHERE po.token = w.value AND po.amount > po.gross * 1e-12) AS holders,
    (SELECT COUNT(*) FROM fills a
       JOIN fills b ON b.wallet = a.wallet AND b.token = a.token AND b.ts > a.ts AND b.ts <= a.ts + 300
      WHERE a.token = w.value AND a.dust = 0 AND b.dust = 0 AND a.side = 'buy' AND b.side = 'sell') AS wash
   FROM json_each(?1) w LEFT JOIN prices p ON p.token = w.value`;

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

test("the discover ranking walks the young pools, not the whole tape", () => {
  // The pools are the small side of the join. Left to itself the planner walks the fills
  // instead, which is the entire tape read for a page about the last three days.
  const detail = plan(discoverPlan);
  expect(detail).not.toContain("SCAN f USING");
  expect(detail).toContain("SEARCH f USING INDEX fills_token_ts (token=?)");
});

test("what a discover row carries beyond its rank is a seek per token, not a pass per pool", () => {
  // Holders, the first buyer, the wash pairs: none of them decides the order, so none of them
  // is owed for a pool that never reaches the page.
  const detail = plan(detailPlan, "[]");
  expect(detail).toContain("SEARCH po USING PRIMARY KEY (token=?)");
  expect(detail).toContain("SEARCH a USING INDEX fills_token_ts (token=?)");
  expect(detail).toContain("SEARCH b USING INDEX fills_wallet_token_ts");
  expect(detail).not.toContain("SCAN fills");
  expect(detail).not.toContain("SCAN positions");
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

test("a page of bags reads the tape for its own tokens, not the tape for its own window", () => {
  // The flow columns are a GROUP BY token, and left to itself the planner takes the index that
  // grouping already wants and walks every fill down it — the same cost whatever the window
  // says, which is what this answer used to pay. Named tokens turn it into a seek apiece.
  const detail = plan(
    `WITH want AS (SELECT j.value AS token FROM json_each(?1) j)
     SELECT f.token AS token, COUNT(*) AS fills, COUNT(DISTINCT f.wallet) AS traders_in
       FROM want w CROSS JOIN fills f ON f.token = w.token
      WHERE f.dust = 0 AND f.ts >= ?2 GROUP BY f.token`,
    "[]",
    0,
  );
  expect(detail).toContain("SEARCH f USING INDEX fills_token_ts (token=? AND ts>?)");
  expect(detail).not.toContain("SCAN f");
  expect(detail).not.toContain("SCAN fills");
});

test("the bags behind a page are that page's positions, not every position four times over", () => {
  const detail = plan(
    `WITH want AS (SELECT j.value AS token FROM json_each(?1) j),
     pos AS (SELECT p.token AS token, p.wallet AS wallet, p.amount AS amount, p.gross AS gross
               FROM want w CROSS JOIN positions p ON p.token = w.token)
     SELECT token, COUNT(*) AS holders FROM pos WHERE amount > gross * 1e-12 GROUP BY token`,
    "[]",
  );
  expect(detail).toContain("SEARCH p USING PRIMARY KEY (token=?)");
  expect(detail).not.toContain("SCAN positions");
});

test("what the books have not seen yet is a row range, not the tape grouped again", () => {
  // The rows stored since the walk are a handful at the end of the table, but the aggregate is
  // a GROUP BY wallet — and left to itself the planner takes the index that grouping wants and
  // walks all of it, which is the pass the books exist to save.
  const detail = plan(
    `SELECT wallet, COUNT(*) AS fills, COALESCE(SUM(usd), 0) AS volume, MAX(ts) AS last_ts
       FROM fills NOT INDEXED WHERE rowid > ? GROUP BY wallet`,
    0,
  );
  expect(detail).toContain("SEARCH fills USING INTEGER PRIMARY KEY (rowid>?)");
  expect(detail).not.toContain("SCAN fills");
});

test("a page of the tape behind a cursor is walked backwards from it, not sorted out of everything below", () => {
  // Spelled out as `ts < ? OR (ts = ? AND rowid < ?)` the planner reads the cursor as two index
  // ranges, and two ranges have no single order — so it took every fill below the cursor and
  // sorted them to find the four hundred newest. Measured against the object: 343,604 rows for
  // a page of four hundred. As a row value it is one range, stopped by the LIMIT.
  const detail = plan(
    `SELECT f.rowid AS id, f.ts, f.wallet, f.token, t.symbol, f.usd, p.price_usd AS mark,
            CASE WHEN f.side = 'buy' AND NOT EXISTS (
              SELECT 1 FROM fills q WHERE q.wallet = f.wallet AND q.token = f.token AND q.side = 'buy' AND q.ts < f.ts
            ) THEN 1 ELSE 0 END AS new_position
       FROM fills f LEFT JOIN tokens t ON t.address = f.token LEFT JOIN prices p ON p.token = f.token
      WHERE f.ts >= ? AND (f.ts, f.rowid) < (?, ?)
      ORDER BY f.ts DESC, f.rowid DESC LIMIT ?`,
    0,
    0,
    0,
    1,
  );
  expect(detail).toContain("SEARCH f USING INDEX fills_ts");
  expect(detail).not.toContain("TEMP B-TREE FOR ORDER BY");
  expect(detail).not.toContain("MULTI-INDEX OR");
});
