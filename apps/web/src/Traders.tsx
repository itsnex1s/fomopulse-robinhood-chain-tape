import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Avatar } from "./Avatar.tsx";
import { getTraders, traderUrl } from "./api.ts";
import { ago, compact, signed, usd, usdCompact } from "./format.ts";
import { useUi } from "./store.ts";
import { cell, head, num, SortHeader, sorted, tone, useSort, wide } from "./table.tsx";
import type { Trader } from "./types.ts";

type Key = "rank" | "pnl" | "sold" | "open" | "win" | "book" | "pos" | "flw" | "here" | "seen";

/** Wins over trips, or null where there were no closed round trips to count. */
const winRate = (t: Trader) => (t.trips ? ((t.wins ?? 0) / t.trips) * 100 : null);

const BY: Record<Key, (t: Trader) => number> = {
  // Rank 1 is the best: negate it so the default strongest-first order holds.
  rank: (t) => (t.rank === null ? -Infinity : -t.rank),
  pnl: (t) => t.total ?? -Infinity,
  sold: (t) => t.realized ?? -Infinity,
  open: (t) => t.unrealized ?? -Infinity,
  win: (t) => winRate(t) ?? -Infinity,
  book: (t) => t.open_value ?? -Infinity,
  pos: (t) => t.open_tokens ?? -Infinity,
  flw: (t) => t.followers ?? -Infinity,
  here: (t) => t.tape_volume,
  seen: (t) => t.last_ts ?? -Infinity,
};

export function Traders() {
  const window = useUi((state) => state.window);
  const filter = useUi((state) => state.filter.trim().toLowerCase());
  const { sort, flip } = useSort<Key>("pnl");
  const [activeOnly, setActiveOnly] = useState(false);
  const { data } = useQuery({
    queryKey: ["traders", window],
    queryFn: () => getTraders(window),
    // The books are walked every ten minutes; a faster poll returns the same answer.
    refetchInterval: 120_000,
    placeholderData: keepPreviousData,
  });

  // Both counts come off the same set. Taken from `data`, "N of them traded" described the
  // whole roster while the number beside it described the filter, so one handle typed into
  // the box read as "1 tracked trader, 118 of them traded in this window".
  const matching = (data ?? []).filter((t) => !filter || t.handle.toLowerCase().includes(filter));
  const rows = sorted(
    matching.filter((t) => !activeOnly || t.fills > 0),
    sort,
    BY,
  );
  const top = Math.max(...rows.map((t) => t.tape_volume), 1);
  const stamp = rows.find((t) => t.stats_at)?.stats_at;
  const active = matching.filter((t) => t.fills > 0).length;
  const label = rows[0]?.pnl_window ?? window;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-line px-3 py-1 text-[10px] text-dimmer">
        <span>{rows.length} traders</span>
        <span>·</span>
        <button
          type="button"
          className={activeOnly ? "hover:text-dim" : "text-dim"}
          onClick={() => setActiveOnly(false)}
          title="every tracked wallet, trading or not"
        >
          all
        </button>
        <button
          type="button"
          className={activeOnly ? "text-dim" : "hover:text-dim"}
          onClick={() => setActiveOnly(true)}
          title={`only the wallets that traded in the ${window} window`}
        >
          traded
        </button>
        <span className="ml-auto">
          {active} traded in {window} · every number here is measured on this chain
        </span>
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <SortHeader sort={sort} flip={flip} sortKey="rank" title="place among the tracked wallets by total p/l">
              #
            </SortHeader>
            <th className={`${head} w-full`} title="the tracked wallet, under the handle fomo shows it by">
              trader
            </th>
            <SortHeader
              sort={sort}
              flip={flip}
              sortKey="pnl"
              title="what the closed trips made in the window plus what the open ones are worth against cost"
            >
              p/l {label}
            </SortHeader>
            <SortHeader sort={sort} flip={flip} sortKey="sold" title="profit on the round trips closed in the window">
              sold
            </SortHeader>
            <SortHeader sort={sort} flip={flip} sortKey="open" title="what the open positions are worth against cost">
              open
            </SortHeader>
            <SortHeader
              sort={sort}
              flip={flip}
              sortKey="win"
              title="round trips that came out ahead, over the ones that closed in the window"
            >
              win
            </SortHeader>
            <SortHeader
              sort={sort}
              flip={flip}
              sortKey="book"
              title="what the open positions are worth at the feed's price"
              extra={wide}
            >
              book
            </SortHeader>
            <SortHeader sort={sort} flip={flip} sortKey="pos" title="tokens still held" extra={wide}>
              pos
            </SortHeader>
            <SortHeader sort={sort} flip={flip} sortKey="flw" title="followers on fomo" extra={wide}>
              followers
            </SortHeader>
            <SortHeader sort={sort} flip={flip} sortKey="here" title="volume this tape saw in the window">
              here
            </SortHeader>
            <th className={`${head} ${wide}`} title="share of the tape volume in this window">
              share
            </th>
            <SortHeader sort={sort} flip={flip} sortKey="seen" title="time since the last fill" extra={wide}>
              seen
            </SortHeader>
          </tr>
        </thead>
        <tbody>
          {rows.map((trader) => {
            const win = winRate(trader);
            return (
              <tr key={trader.address} className="hover:bg-hover">
                <td className={`${cell} text-right font-mono text-dimmer`}>{trader.rank ? `#${trader.rank}` : ""}</td>
                <td className={cell}>
                  <a
                    className="flex items-center gap-2 hover:text-accent"
                    href={traderUrl({ handle: trader.handle, profile_url: trader.profile_url ?? undefined })}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Avatar src={trader.avatar_url} seed={trader.address} size={16} />
                    {trader.handle}
                    {trader.verified === 1 && (
                      <span className="text-[10px] text-dimmer" title="verified on fomo">
                        ✓
                      </span>
                    )}
                    {trader.clan && <span className="text-[10px] text-dimmer">{trader.clan}</span>}
                  </a>
                </td>
                <td className={`${num} ${tone(trader.total)}`}>{trader.total === null ? "—" : signed(trader.total)}</td>
                <td className={`${num} ${tone(trader.realized)}`}>
                  {trader.realized === null ? "—" : signed(trader.realized)}
                </td>
                <td className={`${num} ${tone(trader.unrealized)}`}>
                  {trader.unrealized === null ? "—" : signed(trader.unrealized)}
                </td>
                <td
                  className={`${num} text-dim`}
                  title={
                    trader.trips
                      ? `${trader.wins} of ${trader.trips} round trips closed ahead`
                      : "no round trip closed in this window with a price on both halves"
                  }
                >
                  {win === null ? "—" : `${Math.round(win)}%`}
                </td>
                <td className={`${num} ${wide} text-dim`}>{trader.open_value ? usdCompact(trader.open_value) : "—"}</td>
                <td className={`${num} ${wide} text-dimmer`}>{trader.open_tokens || "—"}</td>
                <td className={`${num} ${wide} text-dimmer`}>{compact(trader.followers ?? 0)}</td>
                <td
                  className={`${num} ${trader.fills === 0 ? "text-dimmer" : "text-dim"}`}
                  title={
                    trader.fills === 0
                      ? "no fills on this tape in the window"
                      : `${trader.fills} fills${trader.last_ts === null ? "" : ` · last ${ago(trader.last_ts)} ago`}`
                  }
                >
                  {trader.fills === 0 ? "—" : usd(trader.tape_volume)}
                </td>
                <td className={`${cell} ${wide}`}>
                  <span className="block h-[6px] w-[120px] rounded-[1px] bg-line">
                    <span
                      className="block h-full rounded-[1px] bg-accent/60"
                      style={{ width: trader.fills === 0 ? 0 : `${Math.max(2, (trader.tape_volume / top) * 100)}%` }}
                    />
                  </span>
                </td>
                <td className={`${num} ${wide} text-dimmer`}>{trader.last_ts === null ? "—" : ago(trader.last_ts)}</td>
              </tr>
            );
          })}
        </tbody>
        {stamp && (
          <tfoot>
            <tr>
              <td colSpan={12} className="px-2 py-2 text-[10px] text-dimmer">
                {rows.length} tracked traders, {active} of them traded in this window · p/l, win rate and positions are
                walked from this tape's own fills on Robinhood Chain, {ago(stamp)} old · a trip counts in the window it
                closed in, and what is still held is marked at the feed's price · the avatar and the handle are fomo's
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
