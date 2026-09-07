import { compact } from "./format.ts";
import type { Discover } from "./types.ts";

export const name = (row: Discover) => row.symbol ?? `${row.token.slice(0, 8)}…`;

/** Net dollars the tracked wallets have put into it, which is what the column sorts on. */
export const net = (row: Discover) => row.bought_usd - row.sold_usd;

/** What the token has done since the first tracked wallet bought it, as a multiple of the
 *  market cap it paid. Null until both ends are known. */
export const growth = (row: Discover): number | null =>
  row.mcap_at === null || row.mcap_at <= 0 || row.market_cap === null ? null : row.market_cap / row.mcap_at;

/** A multiple reads better than a percentage once it is one: this column spans both. */
export const growthLabel = (times: number) =>
  times >= 2 ? `${compact(times)}×` : `${times >= 1 ? "+" : "−"}${Math.round(Math.abs(times - 1) * 100)}%`;

/** Day's volume against the depth it crossed. Deep churn is the shape wash trading leaves,
 *  and the server has already dropped anything past twenty. */
export const churn = (row: Discover): number | null =>
  row.liquidity === null || row.liquidity <= 0 || row.volume24 === null ? null : row.volume24 / row.liquidity;

/**
 * What the reader can turn off. The server has already dropped the pools that are too
 * shallow, too churned or nameless; these are the cuts that are about the wallets, so they
 * stay on the client and flip without another read.
 */
export interface Cuts {
  /** Tracked wallets that must have bought it. One buyer alone was down three times in four. */
  minBuyers: number;
  /** Hide tokens carrying round trips that cancelled inside five minutes at the same size. */
  hideWash: boolean;
  /** Only tokens a wallet with books behind it bought. */
  rankedOnly: boolean;
}

export const CUTS: Cuts = { minBuyers: 2, hideWash: true, rankedOnly: false };

export const keep = (row: Discover, cuts: Cuts): boolean =>
  row.buyers >= cuts.minBuyers && (!cuts.hideWash || row.wash === 0) && (!cuts.rankedOnly || row.best_rank !== null);

export type SortKey = "heat" | "age" | "flow" | "growth" | "buyers" | "holders" | "liquidity" | "last";

export const BY: Record<SortKey, (row: Discover) => number> = {
  // The page's own order: who came in just now, then how many have come in at all.
  heat: (row) => row.buyers_recent * 1_000 + Math.min(999, row.buyers),
  // Newest first, so the column sorts the way every other one does — largest at the top.
  age: (row) => row.pair_created_at ?? -Infinity,
  flow: (row) => net(row),
  growth: (row) => growth(row) ?? -Infinity,
  buyers: (row) => row.buyers,
  holders: (row) => row.holders,
  liquidity: (row) => row.liquidity ?? -Infinity,
  last: (row) => row.last_fill_ts ?? -Infinity,
};
