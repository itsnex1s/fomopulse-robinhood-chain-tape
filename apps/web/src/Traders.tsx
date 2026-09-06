import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Avatar } from "./Avatar.tsx";
import { getStatus, getTraders, traderUrl } from "./api.ts";
import { ago, compact, signed, span, usd, usdCompact } from "./format.ts";
import { useUi } from "./store.ts";
import { cell, head, num, SortHeader, sorted, tone, useSort, wide } from "./table.tsx";
import type { Trader } from "./types.ts";

type Key = "rank" | "pnl" | "book" | "pos" | "flw" | "here" | "seen";
const BY: Record<Key, (t: Trader) => number> = {
  // Rank 1 is the best: negate it so the default strongest-first order holds.
  rank: (t) => (t.rank === null ? -Infinity : -t.rank),
  pnl: (t) => t.pnl ?? -Infinity,
  book: (t) => t.top_value ?? -Infinity,
  pos: (t) => t.holdings ?? -Infinity,
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
    // fomo's leaderboard is asked for every ten minutes; polling it twice a minute
    // asked the object twenty times for the same answer.
    refetchInterval: 120_000,
    placeholderData: keepPreviousData,
  });

  // The same query the bar polls, so this is the cache and not a second request.
  const status = useQuery({
    queryKey: ["status", window],
    queryFn: () => getStatus(window),
    placeholderData: keepPreviousData,
  });
  const board = status.data?.leaderboard;

  const rows = sorted(
    (data ?? [])
      .filter((t) => !filter || t.handle.toLowerCase().includes(filter))
      .filter((t) => !activeOnly || t.fills > 0),
    sort,
    BY,
  );
  const top = Math.max(...rows.map((t) => t.tape_volume), 1);
  const stamp = rows.find((t) => t.updated_at)?.updated_at;
  const active = (data ?? []).filter((t) => t.fills > 0).length;

  return (
    <div>
      {board?.refused && (
        // Five of the columns here are fomo's, and a refused read leaves them exactly as
        // they were: the same numbers, quietly older every minute. Said out loud instead.
        <div className="border-b border-line px-3 py-1 text-[10px] text-down">
          fomo is refusing this deployment, so pnl, rank, book, positions and followers are frozen
          {board.updated_at ? ` at ${ago(board.updated_at)} old` : ""}
          {board.asking_again_in ? ` · asking again in ${span(board.asking_again_in)}` : ""} · everything else on this
          screen is measured on the tape
        </div>
      )}
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
          {active} traded in {window} · pnl and rank are fomo's
        </span>
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <SortHeader sort={sort} flip={flip} sortKey="rank" title="fomo's rank for the selected window">
              #
            </SortHeader>
            <th className={`${head} w-full`} title="the tracked wallet, under the handle fomo shows it by">
              trader
            </th>
            <SortHeader sort={sort} flip={flip} sortKey="pnl" title="fomo's PnL for the selected window">
              pnl {rows[0]?.pnl_window ?? window}
            </SortHeader>
            <SortHeader sort={sort} flip={flip} sortKey="book" title="value of the positions fomo lists" extra={wide}>
              book
            </SortHeader>
            <SortHeader sort={sort} flip={flip} sortKey="pos" title="positions fomo lists" extra={wide}>
              pos
            </SortHeader>
            <SortHeader sort={sort} flip={flip} sortKey="flw" title="followers on fomo" extra={wide}>
              flw
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
          {rows.map((trader) => (
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
              <td className={`${num} ${tone(trader.pnl)}`}>{trader.pnl === null ? "—" : signed(trader.pnl)}</td>
              <td className={`${num} ${wide} text-dim`}>
                {trader.top_value === null ? "—" : usdCompact(trader.top_value)}
              </td>
              <td className={`${num} ${wide} text-dimmer`}>{trader.holdings ?? "—"}</td>
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
          ))}
        </tbody>
        {stamp && (
          <tfoot>
            <tr>
              <td colSpan={9} className="px-2 py-2 text-[10px] text-dimmer">
                {rows.length} tracked traders, {active} of them traded in this window · pnl, rank, book, positions and
                followers are fomo's own numbers, {ago(stamp)} old · volume and share are measured on this tape
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
