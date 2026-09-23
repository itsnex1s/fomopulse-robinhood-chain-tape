import { escaped, LINKS, named, table, usd, when } from "./html.ts";
import type { Bag, Discover, Fill, Trader } from "./types.ts";
import { HANDLE_LIST, pageOf, SITE, traderPath, trimmed } from "./views.ts";

/**
 * The app is one file and every screen is served that file, so the head a crawler reads is
 * the home page's, four times over — including its canonical, which says the other three
 * are copies of it and asks for them not to be kept. This puts each screen's own name,
 * sentence and address on the copy it is served, and the screen's own first rows in the
 * page, streamed through the response rather than held in memory.
 */

/**
 * The answer each screen draws itself from. A reader with JavaScript fetches the same thing a
 * moment later and React replaces what is here with it; a reader without — a crawler that does
 * not run scripts, a text browser, a reader mode — gets the rows instead of an empty div.
 * Written as an API path so the edge serves it out of the cache the page's own polling fills.
 */
export const SOURCE: Record<string, string> = {
  "/": "/api/tape?limit=400&window=24h&stocks=true&dust=false",
  "/traders": "/api/traders?window=24h&limit=300",
  "/bags": "/api/bags?window=24h&limit=200",
  "/discover": "/api/discover?window=24h&limit=200",
};

/**
 * What a trader's own page is written from. A week rather than the app's day: the page is for
 * somebody arriving at a name they have never seen, and a trader quiet since yesterday is
 * still a trader. Thirty fills is a page of them and not an archive.
 */
export const TRADER_WINDOW = "7d";
export const TRADER_FILLS = 30;

/** Rows written into the page. Enough to say what the screen is about and no more: the reader
 *  who can run the app gets all of them a moment later, and the one who cannot is reading. */
const SHOWN = 20;

/** One screen's rows as text. Unknown shapes render nothing rather than guessing at them. */
function rendered(pathname: string, all: unknown[]): string {
  const rows = all.slice(0, SHOWN);
  if (pathname === "/")
    return table(
      ["time (UTC)", "trader", "side", "size", "token"],
      (rows as Fill[]).map((f) => [when(f.ts), f.handle, f.side, usd(f.usd), named(f.symbol, f.token)]),
    );
  if (pathname === "/traders")
    return table(
      ["#", "trader", "fills", "volume", "profit and loss"],
      (rows as Trader[]).map((t, n) => [
        String(t.rank ?? n + 1),
        // The only path a crawler that does not run the app has to the trader pages.
        { text: t.handle, href: traderPath(t.handle) },
        String(t.fills),
        usd(t.tape_volume),
        usd(t.total),
      ]),
    );
  if (pathname === "/bags")
    return table(
      ["token", "holders", "value", "profit and loss", "first in"],
      (rows as Bag[]).map((b) => [
        named(b.symbol, b.token),
        String(b.holders),
        usd(b.value),
        usd(b.pnl),
        b.first_buyer ?? "—",
      ]),
    );
  if (pathname === "/discover")
    return table(
      ["token", "buyers", "pool", "market cap", "first in", "opened (UTC)"],
      (rows as Discover[]).map((d) => [
        named(d.symbol, d.token),
        String(d.buyers),
        usd(d.liquidity),
        usd(d.market_cap),
        d.first_buyer ?? "—",
        when(d.pair_created_at === null ? null : Math.floor(d.pair_created_at / 1_000)),
      ]),
    );
  return "";
}

/**
 * The roster, linked. The table above it is the twenty that moved the tape; this is every
 * tracked wallet, so a trader's page is reachable by following links and not only by being
 * read off the sitemap - which is the difference between a page a crawler queues and one it
 * files under discovered and never fetches. Written from the roster rather than from the
 * answer, so the list is whole on a screen whose rows did not arrive.
 */
const roster = (): string =>
  `<nav class="roster"><h2>Every tracked trader</h2>${HANDLE_LIST.map(
    (handle) => `<a href="${escaped(traderPath(handle))}">${escaped(handle)}</a>`,
  ).join(" ")}</nav>`;

/**
 * The head, and the rows where the app will draw them. `rows` is what SOURCE returned; without
 * it the head is still put right, because a page that says who it is matters more than a page
 * that has a table on it and no name.
 */
export function dress(html: Response, pathname: string, rows?: unknown[]): Response {
  const page = pageOf(pathname);
  if (page === undefined) return html;
  const path = trimmed(pathname);
  const here = `${SITE}${path}`;
  const set = (attribute: string, value: string) => ({
    element(el: { setAttribute(name: string, value: string): void }) {
      el.setAttribute(attribute, value);
    },
  });
  const drawn = rows === undefined || rows.length === 0 ? "" : rendered(path, rows);
  const listed = path === "/traders" ? roster() : "";
  const body =
    drawn === "" && listed === ""
      ? ""
      : `<h1>${escaped(page.title)}</h1><p>${escaped(page.description)}</p>${drawn}${listed}${LINKS}`;
  const rewriter = new HTMLRewriter()
    .on("title", {
      element(el: { setInnerContent(text: string): void }) {
        el.setInnerContent(page.title);
      },
    })
    .on('meta[name="description"]', set("content", page.description))
    .on('meta[property="og:description"]', set("content", page.description))
    .on('meta[name="twitter:description"]', set("content", page.description))
    .on('meta[property="og:title"]', set("content", page.title))
    .on('meta[name="twitter:title"]', set("content", page.title))
    .on('link[rel="canonical"]', set("href", here))
    .on('meta[property="og:url"]', set("content", here));
  if (body === "") return rewriter.transform(html);
  return rewriter
    .on("#root", {
      element(el: { append(content: string, options: { html: boolean }): void }) {
        el.append(body, { html: true });
      },
    })
    .transform(html);
}
