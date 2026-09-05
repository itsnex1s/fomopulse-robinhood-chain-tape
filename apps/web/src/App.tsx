import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { getStatus, getTape } from "./api.ts";
import { Bags } from "./Bags.tsx";
import { StatusBar } from "./StatusBar.tsx";
import { useTape, useUi } from "./store.ts";
import { Tape } from "./Tape.tsx";
import { Traders } from "./Traders.tsx";
import { useFeed } from "./useFeed.ts";
import { useHotkeys } from "./useHotkeys.ts";

export default function App() {
  const filterRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const window = useUi((state) => state.window);
  const stocks = useUi((state) => state.stocks);
  const dust = useUi((state) => state.dust);
  const pending = useTape((state) => state.pending.length);
  const view = useUi((state) => state.view);
  const feed = useFeed();
  useHotkeys(filterRef);

  // One poll for the whole bar, at the pace the numbers in it actually move: the fills
  // arrive over the socket, and what is left — the lag, the block, the window's line —
  // is a readout, not the tape. The socket keeps the tape itself current, so the tape is
  // fetched on a window change and not again when the tab regains focus: a refetch would
  // reset 400 rows for nothing.
  const status = useQuery({
    queryKey: ["status", window],
    queryFn: () => getStatus(window),
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
  });
  const tape = useQuery({
    queryKey: ["tape", window, stocks, dust],
    queryFn: () => getTape(window, stocks, dust),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (tape.data) useTape.getState().reset(tape.data);
  }, [tape.data]);

  // Rows that arrive while the reader is scrolled down would push the row under the
  // cursor away, so they wait in the store until the tape is back at the top.
  const onScroll = () => useTape.getState().setHold((scrollRef.current?.scrollTop ?? 0) > 8);

  const toTop = () => {
    scrollRef.current?.scrollTo({ top: 0 });
    useTape.getState().setHold(false);
    useTape.getState().flush();
  };

  return (
    <div className="flex h-full flex-col">
      <h1 className="sr-only">fomopulse — open source live tape of the top fomo.family traders on Robinhood Chain</h1>
      <StatusBar status={status.data} feed={feed} filterRef={filterRef} />
      <div ref={scrollRef} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-auto">
        {view === "tape" && (
          <Tape explorer={status.data?.explorer ?? ""} slug={status.data?.dexscreener_slug ?? "robinhood"} />
        )}
        {view === "traders" && <Traders />}
        {view === "bags" && <Bags />}
        {view === "tape" && pending > 0 && (
          <button
            type="button"
            onClick={toTop}
            className="sticky bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-line bg-panel px-3 py-1 text-[11px] text-accent shadow-lg"
          >
            ↑ {pending} new
          </button>
        )}
      </div>
    </div>
  );
}
