import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getBags } from "./api.ts";
import { BY, name, type SortKey } from "./bags-math.ts";
import { BagRow } from "./bags-row.tsx";
import { useUi } from "./store.ts";
import { head, mid, roomy, SortHeader, sorted, useSort, wide } from "./table.tsx";

export function Bags() {
  const filter = useUi((state) => state.filter.trim().toLowerCase());
  const window = useUi((state) => state.window);
  const { sort, flip } = useSort<SortKey>("value");
  const { data } = useQuery({
    queryKey: ["bags", window],
    queryFn: () => getBags(window),
    // The bag quotes are refreshed on the two-minute sweep; there is nothing newer to get.
    refetchInterval: 120_000,
    placeholderData: keepPreviousData,
  });

  const rows = sorted(
    (data ?? []).filter((bag) => !filter || `${name(bag)} ${bag.name ?? ""}`.toLowerCase().includes(filter)),
    sort,
    BY,
  );
  const top = Math.max(...rows.map((bag) => bag.value ?? 0), 1);
  const crossed = rows.filter((bag) => bag.fills > 0).length;
  const now = Math.floor(Date.now() / 1000);

  if (data === undefined) return <p className="px-3 py-4 text-dimmer">loading…</p>;
  if (data.length === 0)
    return <p className="px-3 py-4 text-dim">No bags yet — once the tape records a trade, its token shows up here.</p>;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1 text-[10px] text-dimmer">
        <span>{rows.length} tokens</span>
        <span className="ml-auto">
          {crossed} crossed this tape in {window} · Δ is since the window opened
        </span>
      </div>
      <table className="w-full border-collapse text-[11px] sm:text-[12px]">
        <thead>
          <tr>
            <th className={head} title="a token a tracked wallet is still long on this tape">
              token
            </th>
            <SortHeader
              sort={sort}
              flip={flip}
              sortKey="holders"
              title="tracked wallets still long it, and how many more or fewer than when the window opened"
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
              title="the position against what it cost, at the average price the buys were paid at"
            >
              pnl
            </SortHeader>
            <th className={`${head} text-right ${mid}`} title="the feed's price for the token">
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
              <td colSpan={14} className="px-2 py-2 text-[10px] text-dimmer">
                holders, value and pnl are measured on this tape: a position is what the fills leave a wallet still
                long, marked at the feed's price against the average price its buys were paid at · mark, 24h, liquidity
                and age are the price feed's · flow, tape, first in and last are measured on this tape · Δ compares with
                the snapshot taken when the {window} window opened · the multiple beside a profit is what it made on its
                cost, left off where the profit is larger than the position
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
