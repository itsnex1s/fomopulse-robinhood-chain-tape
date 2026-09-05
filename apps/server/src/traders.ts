import type { Bag, Trader } from "./api/types.ts";
import { chainConfig, wallets } from "./config.ts";
import {
  allTraders,
  bags,
  holdersOf,
  recordBagHistory,
  saveHoldings,
  saveTraders,
  type TraderRow,
  tapeBags,
  tapeHolders,
  tapeStats,
} from "./db.ts";
import { leaderboard, WINDOWS } from "./fomo.ts";
import { log } from "./log.ts";
import { nameBags, quoteBags } from "./prices/bags.ts";
import { hasSession } from "./privy.ts";
import { sleep } from "./sleep.ts";
import { isStock } from "./stocks.ts";
import { pnlWindow } from "./window.ts";

/** Re-exported for the worker, which alarms quotes and trader maintenance separately. */
export { quoteBags };

/**
 * fomo's side of the screen: the leaderboard, read into the traders and holdings tables
 * and kept in memory by handle, and the two lists built from it — who moved the tape,
 * and what the tracked traders are sitting in.
 */
let byHandle = new Map<string, TraderRow>();

export function reload(): void {
  byHandle = new Map(allTraders().map((row) => [row.handle, row]));
}
reload();

export const traderOf = (handle: string): TraderRow | undefined => byHandle.get(handle);

/** Whether fomo has ever answered for this database. Nothing stored means no ranks, no
 *  PnL and no avatars on screen, which is not a state worth holding for ten minutes. */
export function ranked(): boolean {
  for (const row of byHandle.values()) if (row.updated_at !== null) return true;
  return false;
}

/** Failed leaderboard reads in a row; cleared by the next one that answers. */
let failures = 0;

/**
 * How long to wait before asking fomo again. The regular interval once the table has
 * answers. While it has none — a first run, a fresh database — the cold one, since a
 * screen without ranks, PnL or avatars is missing half of what it is for; doubling after
 * every failed read, so a dead token is asked a few times an hour and not four times a
 * minute for as long as it stays dead.
 */
export const retryInterval = (regularMs: number, coldMs: number, answered: boolean, failed: number): number =>
  answered ? regularMs : Math.min(regularMs, coldMs * 2 ** failed);
export const traderInterval = (regularMs = 10 * 60_000, coldMs = 60_000): number =>
  retryInterval(regularMs, coldMs, ranked(), failures);

/** Pull all four leaderboard windows and store them. One pass is four requests. */
export async function refresh(): Promise<number> {
  const at = Math.floor(Date.now() / 1000);
  let seen = 0;
  for (const window of WINDOWS) {
    const rows = await leaderboard(window);
    saveTraders(
      rows.map(({ holdings_list: _, ...trader }) => trader),
      window,
      at,
    );
    for (const row of rows) if (row.holdings_list.length > 0) saveHoldings(row.handle, row.holdings_list, at);
    seen = Math.max(seen, rows.length);
    await sleep(300);
  }
  // The bags as they stand after this read; the screen diffs against it for the window's change.
  recordBagHistory(at);
  reload();
  return seen;
}

/**
 * One round of everything fomo and the feed have to say about a trader: the leaderboard,
 * then the names of the tokens they hold. The process runs it on a timer, the Durable
 * Object on an alarm, and neither wants the other's loop. A Privy token lives for hours,
 * so a failure here is expected and not fatal: the stored numbers stay and the UI shows
 * how old they are.
 */
export async function maintain(): Promise<void> {
  const failure = hasSession()
    ? await refresh().then(
        (n) => {
          log.info(`traders: ${n} from the leaderboard`);
          failures = 0;
          return null;
        },
        (error: unknown) => {
          failures++;
          return error;
        },
      )
    : null;
  // Symbols and names come from the chain and the price feed, so an expired fomo session
  // does not stop them.
  await nameBags();
  // Kept until after the naming, then raised: swallowed here, an expired token showed as
  // a tape with no ranks and nothing anywhere to say why — the whole of a session went
  // into finding a 401 that had been happening every ten minutes in silence.
  if (failure) throw failure;
}

/**
 * The leaderboard on a timer; the bags are named right after each read, so a position
 * that arrived just now is not a hex string for ten minutes. Logged, never thrown: a
 * rejection out of the tick would end the loop with it, and a tape whose leaderboard
 * stopped after one failed read looks exactly like one that never had a session.
 */
export function startTraders(minutes = 10): void {
  if (!hasSession()) log.warn("no fomo session is deployed; trader PnL and avatars stay as last stored");
  const tick = async () => {
    await maintain().catch((error) => log.error("traders", error));
    setTimeout(tick, traderInterval(minutes * 60_000));
  };
  void tick();
}

const walletOf = new Map(wallets.map((w) => [w.address, w]));

/**
 * Who moved the tape in this window, with fomo's own numbers attached. Everything
 * before `pnl` is what we saw; everything from `pnl` on is what fomo publishes.
 */
export function ranking(sinceTs: number, window: string, limit: number): Trader[] {
  const label = pnlWindow(window);
  const field = `pnl_${label}` as const;
  const rankField = `rank_${label}` as const;
  const stats = new Map(tapeStats(sinceTs).map((row) => [row.wallet, row]));
  // Every tracked wallet is a row. Listing only those who traded inside the window
  // shrinks the table to a handful on `1h` and hides a leaderboard name who is simply
  // between trades; an empty `here` says that better than an absent row.
  return (
    [...new Set([...wallets.map((w) => w.address as string), ...stats.keys()])]
      .map((address) => {
        const row = stats.get(address);
        const wallet = walletOf.get(address as `0x${string}`);
        const handle = wallet?.handle ?? address.slice(0, 10);
        const fomo = byHandle.get(handle);
        return {
          handle,
          address,
          display_name: fomo?.display_name ?? wallet?.display_name ?? null,
          avatar_url: fomo?.avatar_url ?? null,
          clan: fomo?.clan ?? null,
          verified: fomo?.verified ?? 0,
          followers: fomo?.followers ?? wallet?.followers ?? null,
          profile_url: wallet?.profile_url ?? null,
          fills: row?.fills ?? 0,
          tape_volume: row?.volume ?? 0,
          last_ts: row?.last_ts ?? null,
          pnl: fomo?.[field] ?? null,
          rank: fomo?.[rankField] ?? null,
          pnl_window: label,
          pnl_all: fomo?.pnl_all ?? null,
          volume: fomo?.volume ?? null,
          trades: fomo?.trades ?? null,
          holdings: fomo?.holdings ?? null,
          top_value: fomo?.top_value ?? null,
          updated_at: fomo?.updated_at ?? null,
        };
      })
      // Loudest on this tape first, then fomo's strongest among the ones that sat still.
      .sort((a, b) => b.tape_volume - a.tape_volume || (b.pnl ?? -Infinity) - (a.pnl ?? -Infinity) || 0)
      .slice(0, limit)
  );
}

/**
 * What the tracked traders are sitting in, by token. fomo publishes three positions per
 * trader, so this is the top of their book, not all of it; the one column measured here
 * is how often the token crossed our own tape inside the window. Tokens fomo never
 * published — or has not since the token expired — come from the tape itself: net
 * positions read off the fills, marked at the feed's price. Those rows carry no fomo
 * numbers and no window-ago snapshot, so the page works with no session at all. Both
 * kinds share one limit, the largest first whichever source measured it.
 */
export function bagList(sinceTs: number, limit: number): Bag[] {
  const seen = new Set<string>();
  const fomo = bags(chainConfig.id, sinceTs, limit).map((bag): Bag => {
    seen.add(`${bag.network}:${bag.token}`);
    const firstBuyer = bag.first_buyer ? walletOf.get(bag.first_buyer as `0x${string}`) : undefined;
    return {
      ...bag,
      source: "fomo",
      is_stock: bag.network === chainConfig.id && isStock(bag.token) ? 1 : 0,
      // The tracked wallet that bought it first on this tape, by handle.
      first_buyer: firstBuyer?.handle ?? bag.first_buyer,
      holders_list: holdersOf(bag.token, bag.network).map((h) => ({
        ...h,
        avatar_url: byHandle.get(h.handle)?.avatar_url ?? null,
      })),
    };
  });
  const tape = tapeBags(sinceTs, limit)
    .filter((bag) => !seen.has(`${chainConfig.id}:${bag.token}`))
    .map((bag): Bag => {
      const firstBuyer = bag.first_buyer ? walletOf.get(bag.first_buyer as `0x${string}`) : undefined;
      const topHolder = bag.top_holder ? walletOf.get(bag.top_holder as `0x${string}`) : undefined;
      return {
        ...bag,
        source: "tape",
        network: chainConfig.id,
        is_stock: isStock(bag.token) ? 1 : 0,
        first_buyer: firstBuyer?.handle ?? bag.first_buyer,
        top_holder: topHolder?.handle ?? bag.top_holder,
        holders_list: tapeHolders(bag.token).flatMap((h) => {
          // Unmarked positions have no dollars to show; the count in `holders` keeps them.
          if (h.value === null) return [];
          const wallet = walletOf.get(h.wallet as `0x${string}`);
          return [
            {
              handle: wallet?.handle ?? h.wallet.slice(0, 10),
              value: h.value,
              pnl: null,
              avatar_url: wallet ? (byHandle.get(wallet.handle)?.avatar_url ?? null) : null,
            },
          ];
        }),
      };
    });
  return [...fomo, ...tape].sort((a, b) => (b.value ?? -1) - (a.value ?? -1)).slice(0, limit);
}
