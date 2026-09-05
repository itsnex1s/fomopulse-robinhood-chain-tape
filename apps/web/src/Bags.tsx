import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { chainLabel, getBags, TRACKED_CHAIN } from "./api.ts";
import { BY, name, type SortKey } from "./bags-math.ts";
import { BagRow } from "./bags-row.tsx";
import { ago } from "./format.ts";
import { useUi } from "./store.ts";
import { head, mid, roomy, SortHeader, sorted, useSort, wide } from "./table.tsx";

export function Bags() {
  const filter = useUi((state) => state.filter.trim().toLowerCase());
  const window = useUi((state) => state.window);
  const { sort, flip } = useSort<SortKey>("value");
  /** Which chain's positions to show; null is all of them. */
  const [chain, setChain] = useState<number | null>(null);
  const { data } = useQuery({
    queryKey: ["bags", window],
    queryFn: () => getBags(window),
    // The bag quotes are refreshed on the two-minute sweep; there is nothing newer to get.
    refetchInterval: 120_000,
    placeholderData: keepPreviousData,
  });

  const rows = sorted(
    (data ?? [])
      .filter((bag) => chain === null || bag.network === chain)
      .filter((bag) => !filter || `${name(bag)} ${bag.name ?? ""}`.toLowerCase().includes(filter)),
    sort,
    BY,
  );
  // The chains the list actually holds, the tape's own first and the rest by how much of
  // the list they are. fomo reports a trader's positions on every chain it follows, so a
  // bag list is five chains deep and the filter has to say which is which.
  const counts = new Map<number, number>();
  for (const bag of data ?? []) counts.set(bag.network, (counts.get(bag.network) ?? 0) + 1);
  const chains = [...counts.entries()].sort(
    ([a, countA], [b, countB]) => Number(b === TRACKED_CHAIN) - Number(a === TRACKED_CHAIN) || countB - countA || a - b,
  );
  const top = Math.max(...rows.map((bag) => bag.value ?? 0), 1);
  // How old fomo's numbers are, read off the rows that carry them: a row measured on this
  // tape is as fresh as its last fill and would call a day-old leaderboard current.
  const stamp = rows.reduce((newest, bag) => (bag.source === "fomo" ? Math.max(newest, bag.updated_at) : newest), 0);
  const measured = rows.filter((bag) => bag.source === "tape").length;
  const crossed = rows.filter((bag) => bag.fills > 0).length;
  const now = Math.floor(Date.now() / 1000);

  if (data === undefined) return <p className="px-3 py-4 text-dimmer">loading…</p>;
  if (data.length === 0)
    return (
      <p className="px-3 py-4 text-dim">
        No bags yet — once the tape records a trade, its token shows up here on its own. fomo's own numbers (holders,
        value, pnl) additionally need <span className="font-mono text-fg">FOMO_ACCESS_TOKEN</span> and{" "}
        <span className="font-mono text-fg">bun run enrich</span>.
      </p>
    );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1 text-[10px] text-dimmer">
        <span>{rows.length} tokens</span>
        <span>·</span>
        <button
          type="button"
          className={chain === null ? "text-accent" : "hover:text-fg"}
          onClick={() => setChain(null)}
          title="every chain fomo reports a position on"
        >
          all chains
        </button>
        {chains.map(([id, count]) => (
          <button
            key={id}
            type="button"
            className={chain === id ? "text-accent" : "hover:text-fg"}
            onClick={() => setChain(chain === id ? null : id)}
            title={
              id === TRACKED_CHAIN
                ? `positions on the chain this tape follows — the ${count} rows that can have tape flow`
                : `${count} positions fomo reports on ${chainLabel(id)}, which this tape does not follow`
            }
          >
            {chainLabel(id)} <span className="text-dimmer">{count}</span>
          </button>
        ))}
        <span className="ml-auto">
          {crossed} crossed this tape in {window} · Δ is since the window opened
        </span>
      </div>
      <table className="w-full border-collapse text-[11px] sm:text-[12px]">
        <thead>
          <tr>
            <th className={head} title="a token the tracked traders hold, as fomo lists their positions">
              token
            </th>
            <SortHeader
              sort={sort}
              flip={flip}
              sortKey="holders"
              title="tracked traders who list it among their top positions, and how many more or fewer than when the window opened"
            >
              holders
            </SortHeader>
            <SortHeader
              sort={sort}
              flip={flip}
              sortKey="value"
              title="what the position is worth to all of them together, and its change since the window opened"
            >
              value
            </SortHeader>
            <th className={`${head} ${roomy}`} />
            <SortHeader
              sort={sort}
              flip={flip}
              sortKey="pnl"
              title="fomo's profit on the position, added up, and what it is against the cost"
            >
              pnl
            </SortHeader>
            <th
              className={`${head} text-right ${mid}`}
              title="live price from the feed; dim when it is fomo's snapshot"
            >
              mark
            </th>
            <SortHeader sort={sort} flip={flip} sortKey="change24" title="the token's day, from the feed" extra={mid}>
              24h
            </SortHeader>
            <SortHeader
              sort={sort}
              flip={flip}
              sortKey="liquidity"
              title="liquidity in the pool the price comes from"
              extra={wide}
            >
              liq
            </SortHeader>
            <th className={`${head} text-right ${wide}`} title="age of that pool">
              age
            </th>
            <SortHeader
              sort={sort}
              flip={flip}
              sortKey="flow"
              title={`net dollars the tracked wallets put into it on this tape in the ${window} window`}
              extra={roomy}
            >
              flow
            </SortHeader>
            <SortHeader
              sort={sort}
              flip={flip}
              sortKey="fills"
              title={`fills of this token on this tape in the ${window} window`}
              extra={roomy}
            >
              tape
            </SortHeader>
            <th className={`${head} ${wide}`} title="the tracked trader who bought it first on this tape, and when">
              first in
            </th>
            <th className={`${head} text-right ${wide}`} title="time since the last fill on this tape">
              last
            </th>
            <th className={`${head} ${wide}`}>who holds it</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((bag) => (
            <BagRow key={`${bag.network}:${bag.token}`} bag={bag} top={top} now={now} window={window} />
          ))}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr>
              <td colSpan={15} className="px-2 py-2 text-[10px] text-dimmer">
                {stamp > 0
                  ? `holders, value and pnl are fomo's own numbers over the three positions it publishes per trader, ${ago(stamp)} old`
                  : "holders, value and pnl are measured on this tape, from the fills it has seen — fomo's own numbers need a session"}
                {stamp > 0 &&
                  measured > 0 &&
                  ` — ${measured} rows fomo has not published are measured on this tape instead`}{" "}
                · mark, 24h, liquidity and age are the price feed's · flow, tape, first in and last are measured on this
                tape · Δ compares with the snapshot taken when the {window} window opened · the multiple beside a profit
                is what it made on its cost, left off where the profit is larger than the position
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
