import { chainConfig, wallets } from "../config.ts";

/**
 * The addresses the web app draws itself, which both runtimes answer with the app shell.
 * Kept in step with PATH in apps/web/src/url.ts: the web app cannot be imported from here —
 * the dependency runs the other way — so a screen added there is added here too, and one
 * that is not is a 404 before the app ever loads, which is what an unknown address should be.
 */
export const VIEW_PATHS: string[] = ["/", "/traders", "/bags", "/discover"];

/** `/bags/` is `/bags`; nothing else about a path is forgiven. */
export const trimmed = (pathname: string): string => (pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname);

export const isViewPath = (pathname: string): boolean => VIEW_PATHS.includes(trimmed(pathname));

/**
 * The one origin every absolute address on the page names. The same string is written into
 * public/robots.txt and public/sitemap.xml, which are files a crawler reads before any of
 * this runs and so cannot be given it.
 */
export const SITE = "https://fomopulse.app";

/** What a screen calls itself where the reader never looks: the tab, the search result, the card. */
export interface Page {
  title: string;
  description: string;
}

/**
 * One page per screen. The shell is one file, so without this every address serves the home
 * page's title and, worse, its canonical — which tells a search engine the other three are
 * the same page and asks it not to keep them.
 */
export const PAGES: Record<string, Page> = {
  "/": {
    title: `fomopulse — live tape of the top fomo.family traders on ${chainConfig.name}`,
    description: `Every buy and sell of the top fomo.family traders on ${chainConfig.name}, on one live tape: size, price, token, trader, transaction. Open source, read-only, no keys, no trading.`,
  },
  "/traders": {
    title: `Traders — who is making money on ${chainConfig.name} · fomopulse`,
    description:
      "Every tracked fomo.family trader ranked by realised and open profit over the last hour, day, week or month, walked from this tape's own fills rather than reported by anyone.",
  },
  "/bags": {
    title: "Bags — what the fomo.family traders are still holding · fomopulse",
    description: `What the tracked fomo.family wallets are long on ${chainConfig.name} right now: size, cost, return, and how many of them entered or left over the window.`,
  },
  "/discover": {
    title: `Discover — new ${chainConfig.name} tokens the fomo.family traders are buying · fomopulse`,
    description:
      "Pools opened in the last three days that tracked fomo.family wallets have bought into: who was first in, at what market cap, and what the pool has done since.",
  },
};

/** The page at an address, if the app draws one there. */
export const pageOf = (pathname: string): Page | undefined => PAGES[trimmed(pathname)];

/** The roster by the lowercase handle, which is the most an address can promise to carry. */
const HANDLES = new Map(wallets.map((w) => [w.handle.toLowerCase(), w.handle]));

/** Where a tracked trader's own page lives. Not a screen: the app does not draw one, the
 *  runtime writes it, so it is a document like /about rather than a fifth view. */
export const TRADER_PREFIX = "/trader/";

/**
 * The handle an address names, spelled as the roster spells it. Anyone the tape does not
 * track is undefined and gets a 404 — a page per guessed name is the shape of a soft 404,
 * and there are only ever as many trader pages as there are tracked wallets.
 */
export function traderOf(pathname: string): string | undefined {
  const path = trimmed(pathname);
  if (!path.startsWith(TRADER_PREFIX)) return undefined;
  const asked = path.slice(TRADER_PREFIX.length);
  if (asked === "" || asked.includes("/")) return undefined;
  try {
    return HANDLES.get(decodeURIComponent(asked).toLowerCase());
  } catch {
    return undefined;
  }
}

/** The address that page is kept at, whatever case it was asked for. */
export const traderPath = (handle: string): string => `${TRADER_PREFIX}${encodeURIComponent(handle)}`;

/** Every tracked handle, for the sitemap and for anything else that needs the whole roster. */
export const HANDLE_LIST: string[] = wallets.map((w) => w.handle);
