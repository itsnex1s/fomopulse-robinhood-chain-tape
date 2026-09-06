/**
 * Replay every stored receipt through the current reconstruction and rewrite `fills`.
 * The rebuild itself lives in the server, so the object can run one on itself after a
 * deploy; this is the same pass with a reader of the chain attached, for the receipts
 * whose block timestamp never arrived and whose block left no fill behind.
 */

import { rpc } from "../apps/server/src/config.ts";
import { dateReceipt, db } from "../apps/server/src/db.ts";
import { rebuildFills } from "../apps/server/src/ingest/rebuild.ts";

const blockTs = new Map<number, number>();
async function timestampOf(tx: string, block: number): Promise<number> {
  const known = blockTs.get(block);
  if (known !== undefined) {
    dateReceipt(tx, known);
    return known;
  }
  const { timestamp } = await rpc.getBlock({ blockNumber: BigInt(block), includeTransactions: false });
  const ts = Number(timestamp);
  blockTs.set(block, ts);
  dateReceipt(tx, ts);
  return ts;
}

const { receipts, fills, before, thin, unpriced } = await rebuildFills(timestampOf);

// Dusting is decided per fill, and pardoned by the insert that earns it: a token whose
// first paid trade or first sale lands brings the fills already stored for it back.

const byPricing = db
  .query<{ priced: string; n: number }, []>("SELECT priced, COUNT(*) n FROM fills GROUP BY priced ORDER BY n DESC")
  .all();
console.log(
  `${receipts} receipts, ${blockTs.size} block timestamps read, ${thin} thin quotes dropped, ${unpriced} fills unpriced → ${fills} fills (was ${before})`,
);
for (const row of byPricing) console.log(`  ${row.priced.padEnd(10)} ${row.n}`);
console.log(`  ${"dust".padEnd(10)} ${db.query<{ n: number }, []>("SELECT SUM(dust) n FROM fills").get()!.n ?? 0}`);
