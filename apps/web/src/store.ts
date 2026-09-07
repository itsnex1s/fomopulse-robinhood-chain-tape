import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Fill, Window } from "./types.ts";
import { DEFAULT_WINDOW, HOME, type Place, readPlace, VIEWS, type View, WINDOWS } from "./url.ts";

/** Capped like the original: 400 rows, oldest dropped, until a reader loads older ones. */
export const MAX_ROWS = 400;

const keyOf = (fill: Fill) => `${fill.tx}:${fill.id}`;

/** `tick` marks fills that arrived over the socket, so the first screen does not blink. */
export type Row = Fill & { key: string; tick: boolean };

interface TapeState {
  ids: string[];
  byId: Record<string, Row>;
  /** New fills wait here while the reader is scrolled away from the top. */
  pending: Fill[];
  /** Newest fill the socket has delivered, held rows included: the status bar's own clock. */
  lastTs: number;
  hold: boolean;
  /** How many rows the tape keeps: 400, plus every page of older ones asked for since. */
  cap: number;
  reset: (fills: Fill[]) => void;
  /** A page from before the oldest row on the screen, appended under it. */
  older: (fills: Fill[]) => void;
  push: (fills: Fill[]) => void;
  setHold: (hold: boolean) => void;
  flush: () => void;
}

type Merged = Pick<TapeState, "ids" | "byId" | "cap">;

function merge(state: Merged, fills: Fill[]): Merged {
  if (fills.length === 0) return state;
  const byId = { ...state.byId };
  let ids = state.ids;
  // The bottom of what is on screen. The server reprices fills up to an hour old and sends
  // the whole transaction again, so one that has already aged off arrives as a fill this
  // store has never seen — and it is not new.
  const oldest = ids.length > 0 ? (byId[ids[ids.length - 1]!]?.ts ?? 0) : 0;
  for (const fill of fills) {
    const key = keyOf(fill);
    const known = byId[key];
    if (!known && fill.ts < oldest) {
      // Below the last row the screen holds: it belongs under them, or nowhere.
      if (ids.length >= state.cap) continue;
      byId[key] = { ...fill, key, tick: false };
      ids = [...ids, key];
      continue;
    }
    // A repriced fill comes back with the same key: replace it in place, do not blink.
    byId[key] = { ...fill, key, tick: known ? known.tick : true };
    if (!known) ids = [key, ...ids];
  }
  for (const key of ids.slice(state.cap)) delete byId[key];
  return { ids: ids.slice(0, state.cap), byId, cap: state.cap };
}

const newest = (fills: Fill[], since = 0) => fills.reduce((max, f) => (f.ts > max ? f.ts : max), since);

export const useTape = create<TapeState>((set) => ({
  ids: [],
  byId: {},
  pending: [],
  lastTs: 0,
  hold: false,
  cap: MAX_ROWS,
  reset: (fills) => {
    const byId: Record<string, Row> = {};
    const ids: string[] = [];
    for (const fill of fills.slice(0, MAX_ROWS)) {
      const key = keyOf(fill);
      if (byId[key]) continue;
      byId[key] = { ...fill, key, tick: false };
      ids.push(key);
    }
    set({ ids, byId, pending: [], lastTs: newest(fills), cap: MAX_ROWS });
  },
  older: (fills) =>
    set((state) => {
      const byId = { ...state.byId };
      const ids = [...state.ids];
      for (const fill of fills) {
        const key = keyOf(fill);
        if (byId[key]) continue;
        // Never a tick: an older page is not an arrival, and a row that flashes on the
        // way in reads as a fill that just landed.
        byId[key] = { ...fill, key, tick: false };
        ids.push(key);
      }
      // The cap follows what the reader loaded, or the next fill off the socket would
      // drop the page they just asked for off the bottom.
      return { ids, byId, cap: ids.length > state.cap ? ids.length : state.cap };
    }),
  push: (fills) => {
    // The socket pushes every fill; what the reader has hidden never enters the store,
    // or four hundred rows of dusting would carry the tape off the screen.
    const { stocks, dust } = useUi.getState();
    // Before the filter: the tape went quiet or it did not, whatever the reader has hidden.
    set((state) => ({ lastTs: newest(fills, state.lastTs) }));
    const wanted = fills.filter((f) => (stocks || f.is_stock === 0) && (dust || f.is_dust === 0));
    if (wanted.length === 0) return;
    set((state) => {
      if (!state.hold) return merge(state, wanted);
      // A row already on the screen came back repriced: a correction, not an arrival, so it
      // updates in place rather than waiting behind the "new" button and counting as a fill.
      const known = wanted.filter((f) => state.byId[keyOf(f)]);
      const queued = new Map(state.pending.map((f) => [keyOf(f), f]));
      for (const fill of wanted) if (!state.byId[keyOf(fill)]) queued.set(keyOf(fill), fill);
      return { ...merge(state, known), pending: [...queued.values()].slice(-MAX_ROWS) };
    });
  },
  setHold: (hold) => set({ hold }),
  flush: () => set((state) => ({ ...merge(state, state.pending), pending: [] })),
}));

/** The screens and the windows are the address bar's vocabulary; they are defined with it. */
export { VIEWS, type View, WINDOWS };

/** Where the address says to start. A path no screen answers to never reaches the app —
 *  both runtimes 404 it — so the fallback is only for a store built without a document. */
const start: Place = readPlace(typeof location === "undefined" ? "/" : location.href) ?? {
  view: HOME,
  window: DEFAULT_WINDOW,
  filter: "",
};

interface UiState {
  window: Window;
  stocks: boolean;
  dust: boolean;
  filter: string;
  view: View;
  set: (patch: Partial<Pick<UiState, "window" | "stocks" | "dust" | "filter" | "view">>) => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      window: start.window,
      stocks: true,
      dust: false,
      filter: start.filter,
      view: start.view,
      set: (patch) => set(patch),
    }),
    {
      name: "fomopulse.ui",
      // The screen is the address now, so storing it would only give a shared link something
      // to argue with. What is left is preference: the toggles, and the window to open a bare
      // address in.
      partialize: ({ window, stocks, dust }) => ({ window, stocks, dust }),
      // Storage supplies what the address does not say, never the other way round: rehydration
      // runs after the state above is built and would otherwise undo the link that was opened.
      merge: (persisted, current) => {
        const stored = { ...current, ...(persisted as Partial<UiState>) };
        return { ...stored, ...(readPlace(typeof location === "undefined" ? "/" : location.href, stored) ?? {}) };
      },
    },
  ),
);
