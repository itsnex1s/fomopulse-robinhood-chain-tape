import { measure } from "./api/budget.ts";
import type { Discover } from "./api/types.ts";
import { chainConfig, wallets } from "./config.ts";
import { discoverBuyers, discoverTokens } from "./db.ts";
import { isStock } from "./stocks.ts";
import { bookOf, traderOf } from "./traders.ts";

/**
 * The discover page: young pools the tracked wallets are buying into, with who is in each of
 * them. The storage layer applies the cuts that are about the pool — how old, how deep, how
 * much of its volume is its own — and this adds the half that is about the wallets.
 */

/** Buyers carried on a row. The count is the number that matters; the strip is who to show. */
const SHOWN = 10;

const walletOf = new Map(wallets.map((w) => [w.address, w]));

export function discoverList(recentTs: number, limit: number): Discover[] {
  const now = Math.floor(Date.now() / 1000);
  // A tokenised stock has a pool like anything else and is never a discovery.
  const rows = measure("discover:page", () => discoverTokens(now, recentTs, limit, chainConfig.id)).filter(
    (row) => !isStock(row.token),
  );
  const bought = measure("discover:buyers", () => discoverBuyers(rows.map((row) => row.token)));

  return rows.map((row): Discover => {
    const buyers = bought.get(row.token) ?? [];
    const ranks = buyers.map((buyer) => bookOf(buyer.wallet).rank).filter((rank): rank is number => rank !== null);
    const firstBuyer = row.first_buyer ? walletOf.get(row.first_buyer as `0x${string}`) : undefined;
    return {
      ...row,
      is_stock: 0,
      first_buyer: firstBuyer?.handle ?? row.first_buyer,
      // How long the pool ran before the first tracked wallet found it.
      first_lag:
        row.first_buy_ts === null || row.pair_created_at === null
          ? null
          : Math.max(0, row.first_buy_ts - Math.floor(row.pair_created_at / 1000)),
      best_rank: ranks.length === 0 ? null : Math.min(...ranks),
      buyers_list: buyers.slice(0, SHOWN).map((buyer) => {
        const wallet = walletOf.get(buyer.wallet as `0x${string}`);
        return {
          handle: wallet?.handle ?? buyer.wallet.slice(0, 10),
          ts: buyer.ts,
          usd: buyer.usd,
          rank: bookOf(buyer.wallet).rank,
          avatar_url: wallet ? (traderOf(wallet.handle)?.avatar_url ?? null) : null,
        };
      }),
    };
  });
}
