/**
 * The head each screen is served. One file is the app, so without this every address carries
 * the home page's title and the home page's canonical — which is a search engine being told
 * the other three screens are copies and asked not to keep them.
 *
 * Read against the real apps/web/index.html rather than a fixture: what is being tested is
 * that the rewriter and that file still name the same tags.
 */
import { expect, test } from "bun:test";
import { later, traderDocument } from "../src/api/profile.ts";
import { dress, SOURCE } from "../src/api/shell.ts";
import { sitemap } from "../src/api/sitemap.ts";
import { HANDLE_LIST, PAGES, SITE, traderOf, traderPath, VIEW_PATHS } from "../src/api/views.ts";

const source = await Bun.file(new URL("../../web/index.html", import.meta.url)).text();
const served = (path: string, rows?: unknown[]): Promise<string> =>
  dress(new Response(source, { headers: { "content-type": "text/html; charset=utf-8" } }), path, rows).text();

test("every screen is a page of its own: its name, its sentence, its address", async () => {
  for (const path of VIEW_PATHS) {
    const page = PAGES[path];
    expect({ path, named: page !== undefined }).toEqual({ path, named: true });
    const html = await served(path);
    const here = `${SITE}${path}`;
    expect(html).toContain(`<title>${page!.title}</title>`);
    expect(html).toContain(`<meta name="description" content="${page!.description}"`);
    expect(html).toContain(`<link rel="canonical" href="${here}"`);
    expect(html).toContain(`<meta property="og:url" content="${here}"`);
    expect(html).toContain(`<meta property="og:title" content="${page!.title}"`);
    expect(html).toContain(`<meta name="twitter:title" content="${page!.title}"`);
    expect(html).toContain(`<meta property="og:description" content="${page!.description}"`);
    expect(html).toContain(`<meta name="twitter:description" content="${page!.description}"`);
  }
});

test("no two screens answer to the same name", () => {
  const titles = VIEW_PATHS.map((path) => PAGES[path]!.title);
  expect(new Set(titles).size).toBe(titles.length);
  const said = VIEW_PATHS.map((path) => PAGES[path]!.description);
  expect(new Set(said).size).toBe(said.length);
});

test("a trailing slash is the same page and not a second one", async () => {
  expect(await served("/bags/")).toContain(`<link rel="canonical" href="${SITE}/bags"`);
});

test("a path no screen answers to is served whatever it was, untouched", async () => {
  expect(await served("/nowhere")).toBe(source);
});

test("a screen without JavaScript is the screen, not an empty div", async () => {
  const html = await served("/traders", [
    { rank: 1, handle: "unipcs", fills: 12, tape_volume: 40_500, total: -1_250 },
    { rank: 2, handle: "frankdegods", fills: 3, tape_volume: 900, total: null },
  ]);
  expect(html).toContain("<h1>");
  // Each handle is a link to that trader's page: the only path to them a crawler that does
  // not run the app has, and the sitemap is the other.
  expect(html).toContain(`<td><a href="${traderPath("unipcs")}">unipcs</a></td>`);
  expect(html).toContain("<td>$40,500</td>");
  // A loss says so rather than carrying a minus into a cell nothing explains.
  expect(html).toContain("<td>$1,250 loss</td>");
  // Nothing to say is a dash, and never the word null.
  expect(html).toContain("<td>—</td>");
  expect(html).not.toContain("null");
});

test("the traders screen links every tracked wallet, not only the ones on it", async () => {
  // Search Console reported all but two of these as discovered and not indexed for as long as
  // the sitemap was the only thing that named them. A page reached by a link is a different
  // class of page to one reached by a list.
  const html = await served("/traders", [{ rank: 1, handle: HANDLE_LIST[0]!, fills: 1, tape_volume: 1, total: 1 }]);
  for (const handle of HANDLE_LIST) expect(html).toContain(`href="${traderPath(handle)}"`);
  expect(new Set(HANDLE_LIST).size).toBe(HANDLE_LIST.length);
});

test("the roster is there on a traders screen whose rows never arrived", async () => {
  const html = await served("/traders", []);
  expect(html).toContain(`href="${traderPath(HANDLE_LIST[0]!)}"`);
  // Still no table, because there were no rows to put in one.
  expect(html).not.toContain("<table>");
});

test("no other screen carries the roster", async () => {
  for (const path of VIEW_PATHS.filter((p) => p !== "/traders"))
    expect({ path, listed: (await served(path, [])).includes("roster") }).toEqual({ path, listed: false });
});

test("what a token calls itself cannot close a tag", async () => {
  const html = await served("/bags", [
    { token: "0xdead", symbol: '</td><script>alert("x")</script>', holders: 1, value: 1, pnl: null, first_buyer: null },
  ]);
  expect(html).not.toContain("<script>alert");
  expect(html).toContain("&lt;/td&gt;&lt;script&gt;");
});

test("a screen with nothing to show is still a page that says what it is", async () => {
  const html = await served("/discover", []);
  expect(html).toContain(`<title>${PAGES["/discover"]!.title}</title>`);
  expect(html).not.toContain("<table>");
});

test("every screen draws its rows from an address the app itself asks for", () => {
  for (const path of VIEW_PATHS) {
    const source_ = SOURCE[path];
    expect({ path, has: source_ !== undefined }).toEqual({ path, has: true });
    expect(source_!.startsWith("/api/")).toBe(true);
  }
});

test("the sitemap names every screen, the documents beside them, and the traders it was given", async () => {
  const [first, second] = [HANDLE_LIST[0]!, HANDLE_LIST[1]!];
  const xml = sitemap([first, second]);
  const listed = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => loc!);
  for (const path of VIEW_PATHS) expect(listed).toContain(`${SITE}${path}`);
  expect(listed).toContain(`${SITE}${traderPath(first)}`);
  expect(listed).toContain(`${SITE}${traderPath(second)}`);
  // A trader it was not given is not a page it claims exists.
  expect(listed).not.toContain(`${SITE}${traderPath(HANDLE_LIST[2]!)}`);
  expect(new Set(listed).size).toBe(listed.length);
  // Every address that is not a screen or a trader is a document the assets hold by that name.
  const known = new Set([...VIEW_PATHS, traderPath(first), traderPath(second)].map((path) => `${SITE}${path}`));
  for (const loc of listed.filter((l) => !known.has(l))) {
    const file = Bun.file(new URL(`../../web/public${loc.slice(SITE.length)}.html`, import.meta.url));
    expect({ loc, exists: await file.exists() }).toEqual({ loc, exists: true });
  }
});

test("a trader's page exists for the roster and for nobody else", () => {
  const handle = HANDLE_LIST[0]!;
  expect(traderOf(traderPath(handle))).toBe(handle);
  // However it is spelled in the address, the page is the one the roster names.
  expect(traderOf(`/trader/${handle.toUpperCase()}`)).toBe(handle);
  expect(traderOf(`/trader/${handle}/`)).toBe(handle);
  for (const path of ["/trader/", "/trader/nobody", "/trader/a/b", "/traders", "/trader/%E0%A4%A"])
    expect({ path, found: traderOf(path) }).toEqual({ path, found: undefined });
});

test("a trader's page says who it is about, everywhere a page can", () => {
  const handle = HANDLE_LIST[0]!;
  const html = traderDocument(
    {
      handle,
      trader: null,
      fills: [{ ts: 1_700_000_000, side: "buy", usd: 1234.5, symbol: "<b>X", token: "0xabc", price: 2, mcap_at: null }],
    } as never,
    "7d",
  );
  expect(html).toContain(`<h1>${handle}</h1>`);
  expect(html).toContain(`<link rel="canonical" href="${SITE}${traderPath(handle)}">`);
  expect(html).toContain("<td>$1,235</td>");
  expect(html).toContain("&lt;b&gt;X");
  expect(html).not.toContain("<b>X");
  // The books have never been walked for this one, and the page says nothing rather than zero.
  expect(html).not.toContain("<dl>");
});

test("a trader with nothing in the window is a page about a quiet trader", () => {
  const handle = HANDLE_LIST[1]!;
  const html = traderDocument({ handle, trader: null, fills: [] }, "7d");
  expect(html).toContain("No fills in this window");
  expect(html).not.toContain("<table>");
});

test("a trader whose figures could not be read is a page to come back for, not an empty one", async () => {
  // 287 of these and a crawler walks them faster than one address may reach the object. A 200
  // saying this trader has never traded is what a search engine would keep about a real person.
  for (const [got, want] of [
    [429, 429],
    [500, 503],
    [503, 503],
    [404, 404],
  ] as const) {
    const res = later(got);
    expect({ got, status: res.status }).toEqual({ got, status: want });
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.text()).not.toContain("<h1>");
  }
});
