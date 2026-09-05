/**
 * The original site is the oracle: every transaction it published in the window
 * has to be in our fills too. Run the ingester over the same range first.
 *
 *   bun run scripts/verify-tape.ts [minutes=60]
 */
import { db } from "../apps/server/src/db.ts";

const minutes = Number(process.argv[2] ?? 60);
const since = Math.floor(Date.now() / 1000) - minutes * 60;

const tape = (await (await fetch("https://robinhoodtrenches.com/api/tape?limit=400&stocks=true")).json()) as {
  tx: string;
  ts: number;
  side: string;
  usd: number;
  symbol: string;
}[];
const expected = tape.filter((f) => f.ts >= since);

const have = db.query<{ tx: string }, []>("SELECT DISTINCT tx FROM fills").all();
const ours = new Set(have.map((r) => r.tx.toLowerCase()));

const missing = expected.filter((f) => !ours.has(f.tx.toLowerCase()));
const covered = expected.length - missing.length;

console.log(`window: last ${minutes} min · original ${expected.length} fills · ours ${covered}`);
if (missing.length > 0) {
  console.log("missing:");
  for (const f of missing.slice(0, 20)) console.log(`  ${f.tx} ${f.side} $${f.usd?.toFixed?.(2)} ${f.symbol}`);
}
process.exit(missing.length === 0 ? 0 : 1);
