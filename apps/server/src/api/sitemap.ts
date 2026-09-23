import { escaped } from "./html.ts";
import { SITE, traderPath, VIEW_PATHS } from "./views.ts";

/**
 * The list of addresses worth fetching, written rather than stored: a screen added to the app
 * is a line here without anybody remembering, and so is a trader the tape has actually seen
 * trade. Traders with nothing on them are left out on purpose — a page per name the tape has
 * never seen do anything is the shape a search engine files under crawled and not indexed.
 */

/** Documents the assets hold under their own name, which no list in the code already covers. */
const DOCUMENTS = ["/about"];

const entry = (path: string, changes: string, priority: string): string =>
  `  <url>\n    <loc>${escaped(SITE + path)}</loc>\n    <changefreq>${changes}</changefreq>\n    <priority>${priority}</priority>\n  </url>`;

/** The same addresses, as addresses. What is told to IndexNow and what is written in the
 *  sitemap are one list, so the two can say different things only by being given different
 *  traders - which is the point: the sitemap gets every one, the ping gets the ones that moved. */
export const addresses = (handles: string[]): string[] => [
  ...VIEW_PATHS.map((path) => SITE + path),
  ...DOCUMENTS.map((path) => SITE + path),
  ...handles.map((handle) => SITE + traderPath(handle)),
];

export function sitemap(handles: string[]): string {
  const lines = [
    ...VIEW_PATHS.map((path) => entry(path, "hourly", path === "/" ? "1.0" : "0.8")),
    ...DOCUMENTS.map((path) => entry(path, "monthly", "0.6")),
    ...handles.map((handle) => entry(traderPath(handle), "daily", "0.5")),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${lines.join("\n")}\n</urlset>\n`;
}
