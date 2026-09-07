import type { Window } from "./types.ts";

/**
 * Where the reader is, spelled the way the address bar spells it. The screen is the path, and
 * the two things worth sending somebody — the window counted in and what the table is filtered
 * to — are the query. Everything else is a preference and stays in the browser.
 */

export type View = "tape" | "traders" | "bags" | "discover";
/** The order the keys walk them in: 1–5 for the windows, [ and ] for the views. */
export const VIEWS: View[] = ["tape", "traders", "bags", "discover"];
export const WINDOWS: Window[] = ["1h", "24h", "7d", "30d", "all"];

/** Kept in step with VIEW_PATHS in apps/server/src/api/views.ts, which decides what the two
 *  runtimes answer with the app shell; a screen missing there is a 404 before the app loads. */
const PATH: Record<View, string> = { tape: "/", traders: "/traders", bags: "/bags", discover: "/discover" };

/** What a bare address means: the tape, over the day. */
export const HOME: View = "tape";
export const DEFAULT_WINDOW: Window = "24h";

export interface Place {
  view: View;
  window: Window;
  filter: string;
}

/** `/bags/` is `/bags`; nothing else about a path is forgiven. */
const trimmed = (pathname: string) => (pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname);

export const viewOf = (pathname: string): View | undefined => VIEWS.find((view) => PATH[view] === trimmed(pathname));

/**
 * The place an address names. What it does not say is taken from `fallback` — the window a
 * reader picked last time, which a link to a bare screen should not throw away — and only
 * then from the defaults. Undefined for a path no screen answers to.
 */
export function readPlace(href: string, fallback: Partial<Place> = {}): Place | undefined {
  const url = new URL(href, "http://fomopulse.invalid");
  const view = viewOf(url.pathname);
  if (view === undefined) return undefined;
  const asked = url.searchParams.get("window");
  return {
    view,
    window: WINDOWS.find((w) => w === asked) ?? fallback.window ?? DEFAULT_WINDOW,
    filter: url.searchParams.get("q") ?? fallback.filter ?? "",
  };
}

/** The address for a place. The default window and an empty filter are left unsaid, so the
 *  ordinary case is a clean path and a shared link carries only what was chosen. */
export function placeUrl(place: Place): string {
  const query = new URLSearchParams();
  if (place.window !== DEFAULT_WINDOW) query.set("window", place.window);
  const filter = place.filter.trim();
  if (filter) query.set("q", filter);
  const search = query.toString();
  return `${PATH[place.view]}${search ? `?${search}` : ""}`;
}

/**
 * Whether moving between two places is somewhere to come back to. A screen and a window are;
 * a filter is being typed, and one entry per letter would bury the page the reader came from
 * under a search they are still spelling.
 */
export const pushes = (from: Place, to: Place): boolean => from.view !== to.view || from.window !== to.window;

const NAMED: Record<View, string> = {
  tape: "the live tape",
  traders: "traders",
  bags: "bags",
  discover: "new tokens",
};

/** What a tab, a bookmark and a history entry call this place. */
export const titleOf = (place: Place): string =>
  `fomopulse — ${NAMED[place.view]}${place.filter.trim() ? ` · ${place.filter.trim()}` : ""}`;
