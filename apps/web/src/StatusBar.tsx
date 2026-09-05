import { type RefObject, useEffect, useReducer } from "react";
import { useShallow } from "zustand/shallow";
import { blockUrl } from "./api.ts";
import { ago, usdCompact } from "./format.ts";
import { useTape, useUi, VIEWS, WINDOWS } from "./store.ts";
import type { Status } from "./types.ts";
import type { Feed } from "./useFeed.ts";

/**
 * A clock of the bar's own. Everything else here is answered by a poll, but the quiet
 * counter counts, and without this it only moved when the poll came back: the tape
 * scrolled fills past a number that stood still.
 */
function useSecond(): void {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, []);
}

/** Five blocks for the pace of the last five minutes: one per fill a minute, all five from five up. */
function Pace({ perMinute }: { perMinute: number }) {
  const lit = Math.min(5, Math.round(perMinute));
  return (
    <span
      className="inline-flex items-center gap-1.5 font-mono text-dimmer"
      title="trades per minute over the last five minutes on this tape"
    >
      <span className="inline-flex gap-px">
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className={`inline-block h-[9px] w-[4px] ${i < lit ? "bg-accent/70" : "bg-line"}`} />
        ))}
      </span>
      {perMinute.toFixed(1)} trades/min
    </span>
  );
}

export function StatusBar({
  status,
  feed,
  filterRef,
}: {
  status: Status | undefined;
  feed: Feed;
  filterRef: RefObject<HTMLInputElement | null>;
}) {
  const { window, stocks, dust, filter, view, set } = useUi(
    useShallow((state) => ({
      window: state.window,
      stocks: state.stocks,
      dust: state.dust,
      filter: state.filter,
      view: state.view,
      set: state.set,
    })),
  );
  // The window as a whole, from the server: the rows on screen are only the last four
  // hundred of it. It rides on the status poll rather than a second one of its own.
  const o = status?.overview;
  const buyShare = o && o.buys + o.sells > 0 ? Math.round((o.buys / (o.buys + o.sells)) * 100) : null;
  const live = feed === "live";
  useSecond();
  // The socket knows the tape is busy a poll before `/api/status` says so, so the newer
  // of the two wins: a fill landing on screen has to reset the counter under it.
  const lastFill = useTape((state) => state.lastTs);
  const quietSince = Math.max(status?.last_ts ?? 0, lastFill);

  return (
    // A phone gets the same bar over two lines: what the tape is, then what it is filtered to.
    <header className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-panel px-3 py-1.5 text-[12px] text-dim sm:py-0 sm:text-[11px] lg:flex-nowrap">
      <span className="font-medium tracking-wide text-accent">fomopulse</span>
      <a
        className="text-dimmer hover:text-fg"
        href="https://github.com/itsnex1s/fomopulse-robinhood-chain-tape"
        target="_blank"
        rel="noreferrer"
        title="the source of this tape on GitHub — open source (MIT), run your own"
        aria-label="source on GitHub"
      >
        <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden="true">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
        </svg>
        <span className="sr-only">source on GitHub</span>
      </a>

      <span className="flex items-center gap-1.5" title={status?.source ?? ""}>
        <span className={`inline-block size-1.5 rounded-full ${live ? "bg-up" : "bg-down"}`} />
        <span className={live ? "text-fg" : "text-down"}>
          {live && status?.source === "polling" ? "polling" : feed}
        </span>
      </span>

      <span className="text-dimmer">·</span>
      {VIEWS.map((option) => (
        <button
          key={option}
          type="button"
          title="keys [ and ]"
          className={`px-1 py-1 text-[13px] sm:p-0 sm:text-[11px] ${option === view ? "text-fg" : "hover:text-fg"}`}
          onClick={() => set({ view: option })}
        >
          {option}
        </button>
      ))}
      <span className="hidden text-dimmer sm:inline">·</span>
      {status && (
        <a
          className="hidden font-mono text-dim hover:text-accent md:inline"
          href={blockUrl(status.explorer, status.last_block)}
          target="_blank"
          rel="noreferrer"
          title={`block on ${new URL(status.explorer).host}`}
        >
          #{status.last_block}
        </a>
      )}
      <span
        className="hidden font-mono sm:inline"
        title="block timestamp → row on screen, median of the recent fills: the socket, the receipt and the price are all inside it"
      >
        {status?.latency_ms == null ? "–" : `${(status.latency_ms / 1000).toFixed(1)}s`}
      </span>
      <span
        className="hidden font-mono text-dimmer lg:inline"
        title="since the last tracked trade — a quiet tape, not a delay"
      >
        {quietSince === 0 ? "" : `quiet ${ago(quietSince)}`}
      </span>

      <span className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto sm:flex-nowrap">
        {WINDOWS.map((option, index) => (
          <button
            key={option}
            type="button"
            title={`key ${index + 1}`}
            className={`px-0.5 py-1 sm:p-0 ${option === window ? "text-accent" : "hover:text-fg"}`}
            onClick={() => set({ window: option })}
          >
            {option}
          </button>
        ))}
        <span className="text-dimmer">·</span>
        {/* Struck through is off: a filter has to say which way it is set without being
            asked, and "stk" alone said neither what it filtered nor that it was a switch. */}
        <button
          type="button"
          title={`${stocks ? "hide" : "show"} tokenised stocks — key t`}
          className={`px-0.5 py-1 sm:p-0 ${stocks ? "text-fg" : "text-dimmer line-through"}`}
          onClick={() => set({ stocks: !stocks })}
        >
          stocks
        </button>
        <button
          type="button"
          title={`${dust ? "hide" : "show"} dust — tokens nobody paid for, pushed to every tracked wallet — key d`}
          className={`px-0.5 py-1 sm:p-0 ${dust ? "text-fg" : "text-dimmer line-through"}`}
          onClick={() => set({ dust: !dust })}
        >
          dust
        </button>
        <input
          ref={filterRef}
          value={filter}
          onChange={(event) => set({ filter: event.target.value })}
          placeholder="/ trader or token"
          className="min-w-0 flex-1 basis-full bg-transparent py-1 text-fg outline-none placeholder:text-dimmer sm:w-36 sm:flex-none sm:basis-auto sm:py-0"
        />
        {o && (
          <>
            <span className="hidden text-dimmer sm:inline">·</span>
            {/* Each number carries the word for what it is. Unlabelled they read as a row
                of figures a reader has to hover to tell apart, and nobody hovers a tape. */}
            <span
              className="hidden font-mono sm:inline"
              title={`what the tracked wallets traded in the ${window} window · ${o.fills} fills${
                o.biggest_buy
                  ? ` · biggest buy ${usdCompact(o.biggest_buy.usd)} ${o.biggest_buy.symbol ?? ""} by ${o.biggest_buy.handle}`
                  : ""
              }`}
            >
              <span className="text-dimmer">vol </span>
              {usdCompact(o.volume)}
            </span>
            {buyShare !== null && (
              <span
                className="hidden font-mono sm:inline"
                title={`${o.buys} buys against ${o.sells} sells in the ${window} window`}
              >
                <span className="text-dimmer">buys </span>
                <span className="text-up">{buyShare}</span>
                <span className="text-dimmer">/</span>
                <span className="text-down">{100 - buyShare}</span>
              </span>
            )}
            <span
              className="hidden font-mono text-dimmer xl:inline"
              title={`${o.wallets} of the tracked wallets traded ${o.tokens} different tokens in the ${window} window`}
            >
              {o.wallets} wallets · {o.tokens} tokens
            </span>
            {/* The words these two spell out need a screen wider than the breakpoint the
                rest of the bar uses; at lg they pushed the filter off the end. */}
            <span className="hidden xl:inline">
              <Pace perMinute={o.per_minute} />
            </span>
          </>
        )}
      </span>
    </header>
  );
}
