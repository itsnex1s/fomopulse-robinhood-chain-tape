import { QUOTE_TOKENS, WALLET_SET } from "../config.ts";
import {
  allReceipts,
  dateReceipt,
  db,
  dropThinPrices,
  getMeta,
  insertFills,
  loadDecimals,
  loadKinds,
  loadPrices,
  setMeta,
  transfersOf,
} from "../db.ts";
import { log } from "../log.ts";
import { isStock } from "../stocks.ts";
import { reconstruct } from "./reconstruct.ts";

/**
 * The rules a stored fill was written under. Raise it when reconstruction or pricing
 * changes what an already-stored row would have been, and every deployment replays its
 * receipts once on the next tick instead of carrying the mistake until the rows age out.
 *
 * 1 — the liquidity floor under a quote, and airdrops read as handouts rather than buys.
 * 2 — a handout is its own verdict, and a paid trade in the token no longer pardons it.
 */
export const RULES = 2;
const RULES_KEY = "rules";

export interface RebuildResult {
  receipts: number;
  fills: number;
  before: number;
  undated: number;
  /** Quotes dropped for being too shallow to be a price, and fills that were estimated from one. */
  thin: number;
  unpriced: number;
  /** The last receipt replayed, and whether that was the last one there is. */
  lastId: number;
  done: boolean;
}

/** A receipt stored before its block timestamp arrived borrows one from a fill of its own or of its block. */
const fillTs = db.query<{ ts: number | null }, [string, number]>(
  "SELECT COALESCE((SELECT MIN(ts) FROM fills WHERE tx = ?1), (SELECT MIN(ts) FROM fills WHERE block = ?2)) AS ts",
);
/**
 * A fill priced off a quote that has since been dropped for being too shallow. Its token
 * has no price row at all now, so there is nothing to reprice it from — it goes back to
 * unpriced, which the tape shows as a dash. Reaches the fills a replay cannot: receipts
 * are kept for a fortnight and fills for a quarter, so the older ones are only ever this.
 */
const unprice = db.query(
  "UPDATE fills SET usd = NULL, price = NULL, priced = 'unpriced' WHERE priced = 'estimate' AND token NOT IN (SELECT token FROM prices)",
);
/**
 * One receipt's fills, cleared before it is replayed — including the ones the new rules
 * no longer produce at all. By transaction rather than by range: receipts are kept for a
 * fortnight and fills for a quarter, and a range would throw away the older ten weeks of
 * the tape to rewrite the newest two. Indexed, being the leading half of the fills key.
 */
const dropFillsOf = db.query("DELETE FROM fills WHERE tx = ?");

/**
 * Replay every stored receipt through the current reconstruction and rewrite `fills`.
 * The receipts exist for exactly this: the pricing and dusting rules keep changing, and a
 * replay costs no chain calls — which is what lets the object run one on itself after a
 * deploy, rather than carrying a mistake until the rows age out.
 *
 * `dateOf` fills in a receipt whose timestamp never arrived and whose block left no fill
 * behind. On the object there is nobody to ask inside a pass, so those receipts are
 * counted and skipped; the script passes a reader of the chain and keeps them.
 */
export async function rebuildFills(
  dateOf?: (tx: string, block: number) => Promise<number>,
  after = 0,
  limit = Number.MAX_SAFE_INTEGER,
): Promise<RebuildResult> {
  const decimals = loadDecimals();
  // Participant kinds come from the same table the ingester filled; a tracked wallet is an account by definition.
  const kinds = loadKinds();
  for (const wallet of WALLET_SET) kinds.set(wallet, "eoa");
  const before = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM fills").get()!.n;

  // The quotes first, once, before the first receipt is replayed: a price from a pool with
  // nothing in it is not a price, and an estimate made from one is the whole reason a
  // rebuild is being run.
  const thin = after === 0 ? dropThinPrices() : 0;
  const unpriced = after === 0 ? unprice.run().changes : 0;

  const receipts = allReceipts(after, limit);
  // Timestamps next, while the old fills are still there to borrow from.
  const dated = new Map<string, number>();
  let undated = 0;
  for (const r of receipts) {
    const known = r.ts ?? fillTs.get(r.tx, r.block)?.ts ?? null;
    if (known !== null) {
      if (r.ts === null) dateReceipt(r.tx, known);
      dated.set(r.tx, known);
      continue;
    }
    const asked = await dateOf?.(r.tx, r.block);
    if (asked === undefined) undated++;
    else dated.set(r.tx, asked);
  }

  const prices = loadPrices();
  let fills = 0;
  for (const r of receipts) {
    const ts = dated.get(r.tx);
    if (ts === undefined) continue;
    dropFillsOf.run(r.tx);
    const receipt = { tx: r.tx, block: r.block, transfers: transfersOf(r.id) };
    const ctx = { wallets: WALLET_SET, quote: QUOTE_TOKENS, decimals, kinds, prices, isStock, ts };
    fills += insertFills(reconstruct(receipt, ctx)).length;
  }
  return {
    receipts: receipts.length,
    fills,
    before,
    undated,
    thin,
    unpriced,
    lastId: receipts.at(-1)?.id ?? after,
    done: receipts.length < limit,
  };
}

/**
 * Receipts replayed in one go. A whole tape at once is a second or two of unbroken CPU,
 * which is fine in a script and is not what a Durable Object's alarm is for: the replay
 * picks up where it left off on the next pass, and each receipt is corrected whole, so
 * being halfway through leaves the tape consistent rather than half-empty.
 */
const CHUNK = 2_000;
/** Where a replay spread over several passes has got to. */
const AT_KEY = "rules:at";

/** Runs a rebuild if the stored fills were written under older rules, and remembers that it did. */
export async function repairFills(
  dateOf?: (tx: string, block: number) => Promise<number>,
  chunk = CHUNK,
): Promise<RebuildResult | undefined> {
  if (Number(getMeta(RULES_KEY) ?? 0) >= RULES) return undefined;
  const at = Date.now();
  const after = Number(getMeta(AT_KEY) ?? 0);
  const done = await rebuildFills(dateOf, after, chunk);
  if (done.done) setMeta(RULES_KEY, String(RULES));
  setMeta(AT_KEY, done.done ? "0" : String(done.lastId));
  log.warn(
    `rules ${RULES}${done.done ? "" : " (partly)"}: replayed ${done.receipts} receipts into ${done.fills} fills ` +
      `(${done.before} before), ${done.thin} thin quotes dropped, ${done.unpriced} older fills unpriced, ` +
      `${done.undated} undated, in ${Date.now() - at}ms`,
  );
  return done;
}
