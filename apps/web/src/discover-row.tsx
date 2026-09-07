import { Avatar } from "./Avatar.tsx";
import { bagUrl, fomoTokenUrl, traderUrl } from "./api.ts";
import { churn, growth, growthLabel, name, net } from "./discover-math.ts";
import { ago, pct, signed, span, usdCompact } from "./format.ts";
import { useUi } from "./store.ts";
import { cell, mid, num, roomy, tone, wide } from "./table.tsx";
import type { Discover } from "./types.ts";

/** The change in holders since the window opened, beside the count it changed from. */
function Delta({ now, then }: { now: number; then: number | null }) {
  if (then === null || now === then) return null;
  return (
    <span className={`ml-1 text-[10px] ${now > then ? "text-up" : "text-down"}`}>
      {now > then ? "+" : "−"}
      {Math.abs(now - then)}
    </span>
  );
}

export function DiscoverRow({ row, now, network }: { row: Discover; now: number; network: number }) {
  const set = useUi((state) => state.set);
  const url = bagUrl({ network, token: row.token, pair_address: row.pair_address });
  const fomo = fomoTokenUrl({ network, token: row.token });
  const times = growth(row);
  const turn = churn(row);
  const flow = net(row);
  const [first, ...rest] = row.buyers_list;

  return (
    <tr className="hover:bg-hover">
      <td className={cell}>
        <span className="flex items-center gap-2">
          <Avatar src={row.image_url} seed={row.token} size={16} />
          {url ? (
            <a className="hover:text-accent" href={url} target="_blank" rel="noreferrer" title="chart">
              {name(row)}
            </a>
          ) : (
            name(row)
          )}
          {row.dusted > 0 && (
            <span className="text-[9px] text-dimmer" title={`${row.dusted} fills of it were sprayed, not bought`}>
              SPRAY
            </span>
          )}
          {row.wash > 0 && (
            <span
              className="text-[9px] text-down"
              title={`${row.wash} buys cancelled by a sell of the same size within five minutes`}
            >
              WASH
            </span>
          )}
          {row.name && row.name !== row.symbol && <span className="hidden xl:inline text-dimmer">{row.name}</span>}
          {fomo && (
            <a
              className="hidden xl:inline text-[10px] text-dimmer hover:text-accent"
              href={fomo}
              target="_blank"
              rel="noreferrer"
              title="the token on fomo"
            >
              fomo
            </a>
          )}
        </span>
      </td>
      <td className={`${num} text-dimmer`}>
        {row.pair_created_at === null ? "" : span(now - row.pair_created_at / 1000)}
      </td>
      <td
        className={`${num} text-dim`}
        title={`${row.buyers} tracked wallets have bought it, ${row.buyers_recent} of them in this window · ${row.sellers} have sold`}
      >
        {row.buyers_recent > 0 && <span className="text-up">{row.buyers_recent}</span>}
        {row.buyers_recent > 0 && <span className="text-dimmer">/</span>}
        {row.buyers}
        {row.sellers > 0 && <span className="ml-1 text-[10px] text-down">−{row.sellers}</span>}
      </td>
      <td
        className={`${num} ${tone(flow)}`}
        title={`${usdCompact(row.bought_usd)} in, ${usdCompact(row.sold_usd)} out`}
      >
        {signed(flow)}
      </td>
      <td
        className={`${num} ${times === null ? "text-dimmer" : tone(times - 1)}`}
        title={
          row.mcap_at === null
            ? "nothing priced the first buy"
            : `${usdCompact(row.mcap_at)} market cap when the first tracked wallet bought it`
        }
      >
        {times === null ? "—" : growthLabel(times)}
      </td>
      <td className={`${num} ${roomy} text-dim`} title="tracked wallets still long it">
        {row.holders}
        <Delta now={row.holders} then={row.holders_then} />
      </td>
      <td className={`${num} ${mid} text-dimmer`}>{row.liquidity === null ? "" : usdCompact(row.liquidity)}</td>
      <td
        className={`${num} ${wide} text-dimmer`}
        title={turn === null ? "" : "the day's volume over the depth it crossed"}
      >
        {turn === null ? "" : `${turn < 10 ? turn.toFixed(1) : Math.round(turn)}×`}
      </td>
      <td className={`${num} ${mid} ${tone(row.change24)}`}>{row.change24 === null ? "" : pct(row.change24)}</td>
      <td className={`${cell} ${roomy} text-dimmer`}>
        {row.first_buyer && (
          <a
            className="hover:text-accent"
            href={traderUrl({ handle: row.first_buyer })}
            target="_blank"
            rel="noreferrer"
          >
            {row.first_buyer}
            {row.first_lag !== null && (
              <span className="ml-1 font-mono" title="after the pool opened">
                +{span(row.first_lag)}
              </span>
            )}
          </a>
        )}
      </td>
      <td className={`${num} ${wide} text-dimmer`}>{row.last_fill_ts === null ? "" : ago(row.last_fill_ts)}</td>
      <td className={`${cell} ${wide}`}>
        <span className="flex items-center gap-2">
          {first && (
            <a
              className="flex items-center gap-1.5 text-dim hover:text-accent"
              href={traderUrl({ handle: first.handle })}
              target="_blank"
              rel="noreferrer"
              title={`${first.handle}${first.rank === null ? "" : ` · #${first.rank}`} · first in`}
            >
              <Avatar src={first.avatar_url} seed={first.handle} size={14} />
              {first.handle}
            </a>
          )}
          {rest.slice(0, 6).map((buyer) => (
            <a
              key={buyer.handle}
              href={traderUrl({ handle: buyer.handle })}
              target="_blank"
              rel="noreferrer"
              title={`${buyer.handle}${buyer.rank === null ? "" : ` · #${buyer.rank}`}${buyer.usd === null ? "" : ` · ${usdCompact(buyer.usd)} in`}`}
            >
              <Avatar src={buyer.avatar_url} seed={buyer.handle} size={14} />
            </a>
          ))}
          {row.buyers > 7 && <span className="text-[10px] text-dimmer">+{row.buyers - 7}</span>}
          <button
            type="button"
            className="ml-auto text-[10px] text-dimmer hover:text-accent"
            title="filter the tape by this token"
            onClick={() => set({ filter: name(row), view: "tape" })}
          >
            tape
          </button>
        </span>
      </td>
    </tr>
  );
}
