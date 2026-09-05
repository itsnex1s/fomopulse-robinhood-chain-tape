/**
 * Replay every stored receipt through the current reconstruction and rewrite `fills`.
 * The receipts exist for exactly this: pricing rules keep changing, and a rebuild
 * costs no chain calls.
 */

import { QUOTE_TOKENS, rpc, WALLET_SET } from "../apps/server/src/config.ts";
import {
  allReceipts,
  dateReceipt,
  db,
  insertFills,
  loadDecimals,
  loadKinds,
  loadPrices,
  transfersOf,
} from "../apps/server/src/db.ts";
import { reconstruct } from "../apps/server/src/ingest/reconstruct.ts";
import { isStock } from "../apps/server/src/stocks.ts";

const decimals = loadDecimals();
const prices = loadPrices();
// Participant kinds come from the same table the ingester filled; a tracked wallet is an account by definition.
const kinds = loadKinds();
for (const wallet of WALLET_SET) kinds.set(wallet, "eoa");
const before = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM fills").get()!.n;

/**
 * A receipt stored before its block timestamp arrived borrows one from a fill of its own
 * or of its block; failing that, one call per block fills it in for good — the only chain
 * calls a rebuild makes, and only once per database.
 */
const fillTs = db.query<{ ts: number | null }, [string, number]>(
  "SELECT COALESCE((SELECT MIN(ts) FROM fills WHERE tx = ?1), (SELECT MIN(ts) FROM fills WHERE block = ?2)) AS ts",
);
const blockTs = new Map<number, number>();
async function timestampOf(tx: string, block: number): Promise<number> {
  const local = fillTs.get(tx, block)?.ts ?? blockTs.get(block);
  if (local !== undefined && local !== null) {
    dateReceipt(tx, local);
    return local;
  }
  const { timestamp } = await rpc.getBlock({ blockNumber: BigInt(block), includeTransactions: false });
  const ts = Number(timestamp);
  blockTs.set(block, ts);
  dateReceipt(tx, ts);
  return ts;
}

const receipts = allReceipts();
// Timestamps first, while the old fills are still there to borrow from.
const dated = new Map<string, number>();
for (const r of receipts) dated.set(r.tx, r.ts ?? (await timestampOf(r.tx, r.block)));

db.exec("DELETE FROM fills");
let written = 0;
for (const r of receipts) {
  const receipt = { tx: r.tx, block: r.block, transfers: transfersOf(r.id) };
  const ts = dated.get(r.tx)!;
  written += insertFills(
    reconstruct(receipt, { wallets: WALLET_SET, quote: QUOTE_TOKENS, decimals, kinds, prices, isStock, ts }),
  ).length;
}

// Dusting is decided per fill, and pardoned by the insert that earns it: a token whose
// first paid trade or first sale lands brings the fills already stored for it back.

const byPricing = db
  .query<{ priced: string; n: number }, []>("SELECT priced, COUNT(*) n FROM fills GROUP BY priced ORDER BY n DESC")
  .all();
console.log(`${receipts.length} receipts, ${blockTs.size} block timestamps read → ${written} fills (was ${before})`);
for (const row of byPricing) console.log(`  ${row.priced.padEnd(10)} ${row.n}`);
console.log(`  ${"dust".padEnd(10)} ${db.query<{ n: number }, []>("SELECT SUM(dust) n FROM fills").get()!.n ?? 0}`);
