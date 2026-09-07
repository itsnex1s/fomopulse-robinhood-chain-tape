import { compact, signed, usdCompact } from "./format.ts";
import type { Bag } from "./types.ts";

export const name = (bag: Bag) => bag.symbol ?? `${bag.token.slice(0, 8)}…`;

/**
 * What the bag returned on what it cost: the position and its profit are both measured, so
 * cost is the difference — and where the profit is the larger, some was taken out and cost
 * is unknowable. Those rows show the dollars alone rather than a ratio that is not there.
 */
export const ret = (value: number | null, pnl: number | null): number | null => {
  if (value === null) return null;
  const cost = value - (pnl ?? 0);
  return pnl === null || cost <= 0 ? null : pnl / cost;
};
/** Past ten times over, a percentage stops reading; on this leaderboard that is common. */
export const retLabel = (r: number) =>
  r >= 9 ? `${compact(r + 1)}×` : `${r >= 0 ? "+" : "−"}${Math.round(Math.abs(r) * 100)}%`;

// Log scale, in pixels: the largest bag is worth two hundred times the tenth, so a linear bar
// would leave every row below the third at one pixel.
const BAR_MAX = 96;
export const barWidth = (value: number) =>
  `${Math.round((Math.min(100, Math.max(4, (Math.log10(Math.max(value, 1)) - 3) * 20)) / 100) * BAR_MAX)}px`;

export const net = (bag: Bag) => bag.bought_usd - bag.sold_usd;

export type SortKey = "value" | "holders" | "pnl" | "change24" | "liquidity" | "flow" | "fills";
export const BY: Record<SortKey, (bag: Bag) => number> = {
  value: (bag) => bag.value ?? -Infinity,
  holders: (bag) => bag.holders,
  pnl: (bag) => bag.pnl ?? -Infinity,
  change24: (bag) => bag.change24 ?? -Infinity,
  liquidity: (bag) => bag.liquidity ?? -Infinity,
  flow: (bag) => (bag.fills > 0 ? net(bag) : -Infinity),
  fills: (bag) => bag.fills,
};

/**
 * What the bag cost the wallets holding it, on hover: value less profit. Quiet where either
 * number is missing, and where profit is the larger — a bag whose cost came out has none left
 * to show.
 */
export function cost(bag: Bag): string {
  if (bag.pnl === null || bag.value === null) return "";
  const paid = bag.value - bag.pnl;
  return paid <= 0 ? "" : `${usdCompact(paid)} paid for it, at the average price across the buys that carried one`;
}

/** One holder's position, on hover. */
export function holderTitle(holder: Bag["holders_list"][number]): string {
  const r = ret(holder.value, holder.pnl);
  const pnl = holder.pnl === null ? "" : ` · ${signed(holder.pnl)}${r === null ? "" : ` (${retLabel(r)})`}`;
  return `${holder.handle} · ${usdCompact(holder.value)}${pnl}`;
}
