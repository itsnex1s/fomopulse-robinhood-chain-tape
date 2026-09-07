import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getDiscover, TRACKED_CHAIN } from "./api.ts";
import { BY, CUTS, type Cuts, keep, name, type SortKey } from "./discover-math.ts";
import { DiscoverRow } from "./discover-row.tsx";
import { useUi } from "./store.ts";
import { head, mid, roomy, SortHeader, sorted, useSort, wide } from "./table.tsx";

/** A cut the reader can turn off, drawn as the two words it chooses between. */
function Toggle({ on, off, active, onClick }: { on: string; off: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className={active ? "text-dim" : "hover:text-dim"} onClick={onClick}>
      {active ? on : off}
    </button>
  );
}

export function Discover() {
  const window = useUi((state) => state.window);
  const filter = useUi((state) => state.filter.trim().toLowerCase());
  const { sort, flip } = useSort<SortKey>("heat");
  const [cuts, setCuts] = useState<Cuts>(CUTS);
  const { data } = useQuery({
    queryKey: ["discover", window],
    queryFn: () => getDiscover(window),
    // The pools are re-quoted on the three-minute bag sweep; a faster poll returns the same list.
    refetchInterval: 120_000,
    placeholderData: keepPreviousData,
  });

  const all = data ?? [];
  const rows = sorted(
    all
      .filter((row) => keep(row, cuts))
      .filter((row) => !filter || `${name(row)} ${row.name ?? ""}`.toLowerCase().includes(filter)),
    sort,
    BY,
  );
  const now = Math.floor(Date.now() / 1000);

  if (data === undefined) return <p className="px-3 py-4 text-dimmer">loading…</p>;
  if (all.length === 0)
    return (
      <p className="px-3 py-4 text-dim">
        Nothing new yet — a token shows up here once its pool is under three days old, deep enough to be a market, and a
        tracked wallet has bought it.
      </p>
    );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-line px-3 py-1 text-[10px] text-dimmer">
        <span>
          {rows.length} of {all.length} new tokens
        </span>
        <span>·</span>
        <Toggle
          on="2+ buyers"
          off="any buyer"
          active={cuts.minBuyers > 1}
          onClick={() => setCuts((was) => ({ ...was, minBuyers: was.minBuyers > 1 ? 1 : 2 }))}
        />
        <Toggle
          on="no wash"
          off="wash shown"
          active={cuts.hideWash}
          onClick={() => setCuts((was) => ({ ...was, hideWash: !was.hideWash }))}
        />
        <Toggle
          on="ranked only"
          off="any wallet"
          active={cuts.rankedOnly}
          onClick={() => setCuts((was) => ({ ...was, rankedOnly: !was.rankedOnly }))}
        />
        <span className="ml-auto">pools under 3 days old · thin and self-traded pools never reach this page</span>
      </div>
      <table className="w-full border-collapse text-[11px] sm:text-[12px]">
        <thead>
          <tr>
            <th className={head} title="a token whose pool opened in the last three days and a tracked wallet bought">
              token
            </th>
            <SortHeader sort={sort} flip={flip} sortKey="age" title="how long ago the pool opened">
              age
            </SortHeader>
            <SortHeader
              sort={sort}
              flip={flip}
              sortKey="heat"
              title="tracked wallets that bought it in this window, over all that ever did, less the ones that sold"
            >
              in
            </SortHeader>
            <SortHeader
              sort={sort}
              flip={flip}
              sortKey="flow"
              title="dollars the tracked wallets put in less what they took out, measured on this tape"
            >
              flow
            </SortHeader>
            <SortHeader
              sort={sort}
              flip={flip}
              sortKey="growth"
              title="the feed's market cap now against the one the first tracked wallet bought at"
            >
              since
            </SortHeader>
            <SortHeader
              sort={sort}
              flip={flip}
              sortKey="holders"
              title="tracked wallets still long it, and the change since the window opened"
              extra={roomy}
            >
              holders
            </SortHeader>
            <SortHeader sort={sort} flip={flip} sortKey="liquidity" title="liquidity in the pool" extra={mid}>
              liq
            </SortHeader>
            <th className={`${head} text-right ${wide}`} title="the day's volume over the depth it crossed">
              churn
            </th>
            <th className={`${head} text-right ${mid}`} title="the token's day, from the feed">
              24h
            </th>
            <th className={`${head} ${roomy}`} title="the tracked wallet in first, and how long after the pool opened">
              first in
            </th>
            <SortHeader sort={sort} flip={flip} sortKey="last" title="time since the last fill" extra={wide}>
              last
            </SortHeader>
            <th className={`${head} ${wide}`}>who bought it</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <DiscoverRow key={row.token} row={row} now={now} network={TRACKED_CHAIN} />
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={12} className="px-2 py-2 text-[10px] text-dimmer">
              in, flow, holders, first in and last are measured on this tape · age, liq, churn, 24h and the market cap
              behind "since" are the price feed's · a pool under $10k, or one whose day's volume is more than twenty
              times its own depth, never reaches this page · over this tape's first days a token only one tracked wallet
              bought was down three times in four, which is what the buyer cut is for · none of this is contract
              analysis: it says who bought, not that a token is safe
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
