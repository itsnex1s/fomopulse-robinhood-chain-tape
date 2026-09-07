/**
 * The two writes an arriving fill makes against its own token. Both look at a handful of the
 * token's rows and both were reading all of them, which was nearly half of everything this
 * tape walks: the plan is the check, because a query that has quietly stopped using its index
 * still returns the right answer and only shows up on the bill.
 */
import { expect, test } from "bun:test";
import "./support/memory.ts";
import { db } from "../src/db.ts";

const plan = (sql: string, ...bindings: (string | number)[]): string =>
  db
    .query<{ detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...bindings)
    .map((row) => row.detail)
    .join(" | ");

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
