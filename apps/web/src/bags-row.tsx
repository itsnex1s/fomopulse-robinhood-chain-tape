import { Avatar } from "./Avatar.tsx";
import { bagUrl, chainName, fomoTokenUrl, TRACKED_CHAIN, traderUrl } from "./api.ts";
import { barWidth, holderTitle, name, net, remarked, ret, retLabel } from "./bags-math.ts";
import { ago, price as fmtPrice, pct, signed, span, usdCompact } from "./format.ts";
import { useUi } from "./store.ts";
import { cell, mid, num, roomy, tone, wide } from "./table.tsx";
import type { Bag } from "./types.ts";

/** A change since the window opened, next to the number it changed: `+2`, `−14%`. */
function Delta({ now, then, percent = false }: { now: number; then: number | null; percent?: boolean }) {
  if (then === null) return null;
  const diff = now - then;
  if (diff === 0 || (percent && then === 0)) return null;
  const text = percent ? pct((diff / then) * 100) : `${diff > 0 ? "+" : "−"}${Math.abs(diff)}`;
  return <span className={`ml-1 text-[10px] ${diff > 0 ? "text-up" : "text-down"}`}>{text}</span>;
}

export function BagRow({ bag, top, now, window }: { bag: Bag; top: number; now: number; window: string }) {
  const set = useUi((state) => state.set);
  const url = bagUrl(bag);
  const fomo = fomoTokenUrl(bag);
  const chain = chainName(bag.network);
  const r = ret(bag.value, bag.pnl);
  const [first, ...rest] = bag.holders_list;
  const share = bag.value && bag.top_value ? Math.round((bag.top_value / bag.value) * 100) : 0;
  const live = bag.quoted_at !== null;
  const flow = net(bag);
  return (
    <tr key={`${bag.network}:${bag.token}`} className="hover:bg-hover">
      <td className={cell}>
        <span className="flex items-center gap-2">
          <Avatar src={bag.image_url} seed={bag.token} size={16} />
          {url ? (
            <a className="hover:text-accent" href={url} target="_blank" rel="noreferrer" title="chart">
              {name(bag)}
            </a>
          ) : (
            name(bag)
          )}
          {chain && <span className="text-[9px] text-dimmer">{chain}</span>}
          {bag.is_stock === 1 && (
            <span className="text-[9px] text-dimmer" title="tokenised stock">
              STK
            </span>
          )}
          {bag.name && bag.name !== bag.symbol && <span className="hidden xl:inline text-dimmer">{bag.name}</span>}
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
      <td
        className={`${num} text-dim`}
        title={
          bag.source === "tape"
            ? "wallets still long on this tape"
            : "tracked traders who list it among their top positions"
        }
      >
        {bag.holders}
        <Delta now={bag.holders} then={bag.holders_then} />
      </td>
      <td
        className={num}
        title={
          bag.value === null ? "no quote yet" : `${usdCompact(bag.value)} of ${usdCompact(top)} across the top bags`
        }
      >
        {bag.value === null ? <span className="text-dimmer">—</span> : usdCompact(bag.value)}
        {bag.value !== null && <Delta now={bag.value} then={bag.value_then} percent />}
      </td>
      {/* The same number, drawn: the table is scanned down this column, not read. */}
      <td className={`${cell} ${roomy} pr-3`}>
        {bag.value !== null && (
          <span className="block h-[6px] rounded-[1px] bg-accent/55" style={{ width: barWidth(bag.value) }} />
        )}
      </td>
      <td className={`${num} ${tone(bag.pnl)}`} title={remarked(bag)}>
        {bag.pnl === null ? "—" : signed(bag.pnl)}
        {/* Always drawn, so the dollars stay in a column of their own. */}
        <span className="ml-2 hidden w-14 text-right text-dim md:inline-block">{r === null ? "" : retLabel(r)}</span>
      </td>
      <td
        className={`${num} ${mid} ${live ? "text-dim" : "text-dimmer"}`}
        title={
          bag.price === null
            ? ""
            : live
              ? `feed price, ${ago(bag.quoted_at!)} old`
              : "fomo's price from the last leaderboard read"
        }
      >
        {bag.price === null ? "" : fmtPrice(bag.price)}
      </td>
      <td className={`${num} ${mid} ${tone(bag.change24)}`}>{bag.change24 === null ? "" : pct(bag.change24)}</td>
      <td className={`${num} ${wide} text-dimmer`}>{bag.liquidity === null ? "" : usdCompact(bag.liquidity)}</td>
      <td className={`${num} ${wide} text-dimmer`}>
        {bag.pair_created_at === null ? "" : span(now - bag.pair_created_at / 1000)}
      </td>
      <td
        className={`${num} ${roomy} ${bag.fills > 0 ? tone(flow) : "text-dimmer"}`}
        title={
          bag.fills > 0
            ? `${bag.buys} buys ${usdCompact(bag.bought_usd)} · ${bag.fills - bag.buys} sells ${usdCompact(bag.sold_usd)} · ${bag.traders_in} traders`
            : bag.network === TRACKED_CHAIN
              ? "no fills on this tape in the window"
              : "off the tracked chain"
        }
      >
        {bag.fills > 0 ? signed(flow) : "—"}
      </td>
      <td className={`${num} ${roomy}`}>
        {bag.fills > 0 ? (
          <button
            type="button"
            className="text-dim hover:text-accent"
            title={`fills on this tape in the ${window} window — click to filter the tape by this token`}
            onClick={() => set({ filter: name(bag), view: "tape" })}
          >
            {bag.fills}
          </button>
        ) : (
          <span className="text-dimmer">—</span>
        )}
      </td>
      <td className={`${cell} ${wide} text-dimmer`}>
        {bag.first_buyer && bag.first_buy_ts !== null && (
          <a
            className="hover:text-accent"
            href={traderUrl({ handle: bag.first_buyer })}
            target="_blank"
            rel="noreferrer"
          >
            {bag.first_buyer} <span className="font-mono">{span(now - bag.first_buy_ts)}</span>
          </a>
        )}
      </td>
      <td className={`${num} ${wide} text-dimmer`}>{bag.last_fill_ts === null ? "" : ago(bag.last_fill_ts)}</td>
      <td className={`${cell} ${wide}`}>
        <span className="flex items-center gap-2">
          {first && (
            <a
              className="flex items-center gap-1.5 text-dim hover:text-accent"
              href={traderUrl({ handle: first.handle })}
              target="_blank"
              rel="noreferrer"
              title={holderTitle(first)}
            >
              <Avatar src={first.avatar_url} seed={first.handle} size={14} />
              {first.handle}
              {/* How much of the bag is this one trader: a consensus reads differently from a whale. */}
              <span className="text-[10px] text-dimmer" title="share of the bag held by its largest holder">
                {share}%
              </span>
            </a>
          )}
          {rest.slice(0, 6).map((holder) => (
            <a
              key={holder.handle}
              href={traderUrl({ handle: holder.handle })}
              target="_blank"
              rel="noreferrer"
              title={holderTitle(holder)}
            >
              <Avatar src={holder.avatar_url} seed={holder.handle} size={14} />
            </a>
          ))}
          {bag.holders > 7 && <span className="text-[10px] text-dimmer">+{bag.holders - 7}</span>}
        </span>
      </td>
    </tr>
  );
}
