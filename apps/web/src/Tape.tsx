import { memo, useState } from "react";
import { useShallow } from "zustand/shallow";
import { Avatar } from "./Avatar.tsx";
import { getTape, tokenUrl, traderUrl, txUrl } from "./api.ts";
import { type Links, NEW_POOL_S, poolAge, THIN_LIQUIDITY, TokenCard, TraderCard, vsNowPct } from "./cards.tsx";
import { clock, compact, pct, price, short, usd, usdCompact } from "./format.ts";
import { Hover } from "./Hover.tsx";
import { useTape, useUi } from "./store.ts";
import { denseCell as cell, head, mid, roomy, tone, wide } from "./table.tsx";
import type { Window } from "./types.ts";

/**
 * Log scale, so $500 and $50k are both visible instead of one pixel and a full bar.
 * Pixels, not percent: the column has to size itself from the widest bar, and a
 * percentage inside an auto-layout table cell has nothing to resolve against.
 */
const BAR_MAX = 220;
const barWidth = (value: number) =>
  `${Math.round((Math.min(100, Math.max(3, (Math.log10(value) - 1.5) * 26)) / 100) * BAR_MAX)}px`;

const num = `${cell} text-right`;
const badge = "ml-1 align-top text-[9px]";

const Row = memo(function Row({ id, explorer, slug }: Links & { id: string }) {
  const fill = useTape((state) => state.byId[id]);
  // A phone has no hover: the same two cards open under the row when it is tapped.
  const [open, setOpen] = useState(false);
  if (!fill) return null;

  const buy = fill.side === "buy";
  const side = buy ? "text-up" : "text-down";
  const tint = buy ? "rgba(47,208,138,0.13)" : "rgba(255,84,112,0.13)";
  const vsNow = vsNowPct(fill);
  const age = poolAge(fill, fill.ts);
  const launch = age !== null && age < NEW_POOL_S;
  const thin = fill.liquidity !== null && fill.liquidity < THIN_LIQUIDITY;

  return (
    <>
      <tr
        className={`${fill.tick ? "tick" : ""} hover:bg-hover`}
        style={{ "--tint": tint } as React.CSSProperties}
        onClick={(event) => {
          // A tap on the token or on the trader is a tap on their link, not on the row.
          if (!(event.target as HTMLElement).closest("a")) setOpen((was) => !was);
        }}
      >
        <td className={`${cell} text-[10px] text-dim font-mono sm:text-[11px]`}>{clock(fill.ts)}</td>
        <td className={`${cell} ${roomy} ${side} font-mono`}>{buy ? "BUY" : "SELL"}</td>
        <td
          className={`${num} ${side} font-mono`}
          title={
            fill.priced === "cash_leg"
              ? "the settled amount, read off the cash leg of the transaction"
              : fill.priced === "estimate"
                ? "priced from the feed: this one settled in a batch that carried no cash leg of its own"
                : "no price for this token yet"
          }
        >
          {fill.usd === null ? (
            <span className="text-dimmer">—</span>
          ) : (
            <>
              {fill.priced === "estimate" ? "~" : ""}
              {/* A phone spends every pixel of this column on the token and the trader
                  beside it: $12.3k here, the cents in the card a tap away. */}
              <span className="sm:hidden">{usdCompact(fill.usd)}</span>
              <span className="hidden sm:inline">{usd(fill.usd)}</span>
            </>
          )}
        </td>
        <td className={`${num} ${mid} text-dim font-mono`}>{fill.price === null ? "" : price(fill.price)}</td>
        {/* The trade against the price now: the one number a reader of a tape wants next to a
            price. Both numbers are spelled out in the title, because a percentage on its own
            leaves the reader to work out which way round it was taken. */}
        <td
          className={`${num} ${mid} font-mono ${tone(vsNow)}`}
          title={
            vsNow === null || fill.price === null || fill.mark === null
              ? "no mark for this token yet"
              : `${buy ? "bought" : "sold"} at ${price(fill.price)}, the token trades at ${price(fill.mark)} now`
          }
        >
          {vsNow === null ? "" : pct(vsNow)}
        </td>
        <td className={cell}>
          <Hover card={() => <TokenCard fill={fill} explorer={explorer} slug={slug} />}>
            <Avatar src={fill.image_url} seed={fill.token} size={12} />
            <a
              className={`ml-1.5 inline-block max-w-[22vw] truncate align-bottom hover:text-accent sm:max-w-none ${thin ? "underline decoration-dotted decoration-dimmer underline-offset-2" : ""}`}
              href={fill.pair_url ?? tokenUrl(slug, fill.token)}
              target="_blank"
              rel="noreferrer"
            >
              {fill.symbol ?? short(fill.token)}
            </a>
            {launch && (
              <b className={`${badge} font-medium text-accent`} title="pool under an hour old when this landed">
                NEW
              </b>
            )}
            {buy && fill.new_position === 1 && (
              <span className={`${badge} text-dimmer`} title="first buy of this token by this wallet on this tape">
                1st
              </span>
            )}
            {buy && fill.others > 0 && (
              <span
                className={`${badge} text-up`}
                title={`${fill.others} other tracked wallets bought it in the hour before`}
              >
                +{fill.others}
              </span>
            )}
            {fill.is_stock === 1 && (
              <span className={`${badge} text-dimmer`} title="tokenised stock">
                STK
              </span>
            )}
          </Hover>
        </td>
        <td className={cell}>
          <Hover card={() => <TraderCard fill={fill} />}>
            <a
              className="flex items-center gap-1.5 text-dim hover:text-accent"
              href={traderUrl(fill)}
              target="_blank"
              rel="noreferrer"
            >
              <Avatar src={fill.avatar_url} seed={fill.wallet} />
              <span className="max-w-[20vw] truncate sm:max-w-none">{fill.handle}</span>
              {fill.verified === 1 && <span className="text-[9px] text-dimmer">✓</span>}
            </a>
          </Hover>
        </td>
        <td className={`${num} ${wide} text-dimmer font-mono`}>{compact(fill.followers)}</td>
        <td className={`${num} ${wide} text-dimmer font-mono`}>{compact(fill.amount)}</td>
        <td className={`${cell} ${mid}`}>
          <a
            className="text-dimmer hover:text-accent font-mono"
            href={txUrl(explorer, fill.tx)}
            target="_blank"
            rel="noreferrer"
          >
            {fill.tx.slice(2, 8)}
          </a>
        </td>
        {/* The same number as the usd cell, drawn — a tape is scanned, not read. Capped so
          it stays a gauge instead of taking every pixel the table has spare. */}
        <td className={`${cell} ${wide} pr-3`}>
          {fill.usd !== null && (
            <span
              className="block h-[6px] rounded-[1px] opacity-55"
              style={{ width: barWidth(fill.usd), background: buy ? "#2fd08a" : "#ff5470" }}
            />
          )}
        </td>
      </tr>
      {open && (
        <tr className="sm:hidden">
          <td colSpan={6} className="whitespace-normal px-2 pb-2">
            <div className="grid gap-2 rounded-[2px] border border-line bg-panel p-2 text-[11px] leading-[16px] text-dim">
              <TokenCard fill={fill} explorer={explorer} slug={slug} />
              <TraderCard fill={fill} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
});

/**
 * The tape holds the last four hundred fills. With three hundred wallets on it that is
 * about half an hour, while the window above says a day, so the end of the screen is not
 * the end of the window: this asks for the page before the oldest row and puts it under.
 *
 * Mounted with the window and the filters as its key, so a change to any of them brings a
 * fresh one rather than a button still reporting the end of a tape nobody is reading now.
 */
function Older({ window: window_, stocks, dust }: { window: Window; stocks: boolean; dust: boolean }) {
  const [state, setState] = useState<"idle" | "loading" | "end">("idle");

  const load = async () => {
    const { ids, byId, older } = useTape.getState();
    const oldest = byId[ids[ids.length - 1] ?? ""];
    if (!oldest) return;
    setState("loading");
    try {
      const page = await getTape(window_, stocks, dust, { ts: oldest.ts, id: oldest.id });
      older(page);
      setState(page.length === 0 ? "end" : "idle");
    } catch {
      setState("idle");
    }
  };

  return (
    <tr>
      <td colSpan={11} className="px-2 py-3 text-center text-[11px] text-dim">
        {state === "end" ? (
          "that is the whole window"
        ) : (
          <button type="button" className="hover:text-fg" disabled={state === "loading"} onClick={load}>
            {state === "loading" ? "loading…" : "older"}
          </button>
        )}
      </td>
    </tr>
  );
}

export function Tape({ explorer, slug }: Links) {
  const filter = useUi((state) => state.filter.trim().toLowerCase());
  const page = useUi(useShallow((state) => ({ window: state.window, stocks: state.stocks, dust: state.dust })));
  const ids = useTape(
    useShallow((state) => {
      if (!filter) return state.ids;
      // A filter that names a token exactly means that token: "AI" is the token, not
      // every trader with those two letters somewhere in their handle, which is most of
      // them. Anything else stays a loose match on either.
      const token = state.ids.some((id) => state.byId[id]?.symbol?.toLowerCase() === filter);
      return state.ids.filter((id) => {
        const fill = state.byId[id];
        if (!fill) return false;
        const symbol = (fill.symbol ?? "").toLowerCase();
        return token ? symbol === filter : fill.handle.toLowerCase().includes(filter) || symbol.includes(filter);
      });
    }),
  );

  return (
    <table className="w-full border-collapse text-[11px] sm:text-[12px]">
      <thead>
        <tr>
          <th className={head} title="when the fill landed, on your clock">
            time
          </th>
          <th className={`${head} ${roomy}`} title="what the tracked wallet did with the token: bought it, or sold it">
            side
          </th>
          <th
            className={`${head} text-right`}
            title="what the trade settled for. A ~ means the size was priced from the feed because the transaction carried no cash leg of its own"
          >
            usd
          </th>
          <th className={`${head} ${mid} text-right`} title="what one token cost in this trade">
            price
          </th>
          {/* The one column a reader mistakes for the token's own move: it is the trade's. */}
          <th
            className={`${head} ${mid} text-right`}
            title="this trade measured against the token's price now — a buy is green when the token has risen since, a sell when it has fallen. Not the token's own move: that is 1h / 24h on its card"
          >
            vs now
          </th>
          <th className={head} title="hover a token for its card: mark, market cap, volume, liquidity, pool age">
            token
          </th>
          <th className={`${head} w-full`} title="hover a trader for their card: rank, pnl, what they did here">
            trader
          </th>
          <th className={`${head} ${wide} text-right`} title="the trader's followers on fomo">
            flw
          </th>
          <th className={`${head} ${wide} text-right`} title="how many tokens changed hands">
            qty
          </th>
          <th className={`${head} ${mid}`} title="the transaction, on the explorer">
            tx
          </th>
          <th
            className={`${head} ${wide} min-w-[230px]`}
            title="the size of the trade on a log scale, so a $500 fill and a $50k one are both visible"
          >
            size
          </th>
        </tr>
      </thead>
      <tbody>
        {ids.map((id) => (
          <Row key={id} id={id} explorer={explorer} slug={slug} />
        ))}
      </tbody>
      {/* Outside the filter: it narrows what is on the screen, and older pages give it more
          to narrow. A filter that matches nothing loaded yet is exactly when this is wanted. */}
      <tfoot>
        <Older key={`${page.window}|${page.stocks}|${page.dust}`} {...page} />
      </tfoot>
    </table>
  );
}
