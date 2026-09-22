import { chainConfig } from "../config.ts";
import { count, escaped, LINKS, named, STYLE, table, usd, when } from "./html.ts";
import type { Profile } from "./types.ts";
import { SITE, traderPath } from "./views.ts";

/**
 * One tracked trader's own page, written by the runtime rather than drawn by the app. It is a
 * document and not a fifth screen: what it is for is to be a page — one address per tracked
 * wallet, with that wallet's name on it and its own numbers under it, which is the thing a
 * live tape behind one address cannot be.
 */

/** The head of a trader's page: their name, and a sentence that is about them and nobody else. */
export const traderPage = (handle: string): { title: string; description: string } => ({
  title: `${handle} — fomo.family trades and profit and loss on ${chainConfig.name} · fomopulse`,
  description:
    `Every buy and sell ${handle} has made on ${chainConfig.name}, read off the chain's own transfer logs: ` +
    `size, price, token and transaction, with realised and open profit walked from those fills.`,
});

/**
 * A trader's page is the figures on it. When the answer behind it could not be got — the
 * address has had its minute of the object, or the read failed — the page to serve is one
 * saying come back, never a 200 saying this trader has never traded: a crawler keeps what
 * it was handed, and what it was handed would be a lie about somebody with a name.
 */
export const later = (status: number): Response =>
  new Response("could not read this trader just now", {
    status: status === 404 || status === 429 ? status : 503,
    headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "60" },
  });

const rows = (profile: Profile): string =>
  table(
    ["time (UTC)", "side", "size", "token", "price", "market cap then"],
    profile.fills.map((f) => [
      when(f.ts),
      f.side,
      usd(f.usd),
      named(f.symbol, f.token),
      f.price === null ? "—" : `$${f.price < 0.01 ? f.price.toPrecision(3) : f.price.toFixed(4)}`,
      usd(f.mcap_at),
    ]),
  );

const books = (profile: Profile): string => {
  const t = profile.trader;
  if (t === null) return "";
  const pairs: [string, string][] = [
    ["Profit and loss", usd(t.total)],
    ["Realised", usd(t.realized)],
    ["Open", usd(t.unrealized)],
    ["Open position", usd(t.open_value)],
    ["Round trips", count(t.trips)],
    ["Of those, up", count(t.wins)],
    ["Fills seen", count(t.fills)],
    ["Volume", usd(t.tape_volume)],
    ["Tokens traded", count(t.tokens)],
    ["Rank", t.rank === null ? "—" : `#${t.rank}`],
    ["First seen", when(t.first_ts)],
    ["Last seen", when(t.last_ts)],
  ];
  return `<dl>${pairs.map(([name, value]) => `<dt>${escaped(name)}</dt><dd>${escaped(value)}</dd>`).join("")}</dl>`;
};

/** Who fomo says this is. Identity only — every figure above it was measured here. */
const who = (profile: Profile): string => {
  const t = profile.trader;
  const said = [
    t?.display_name,
    t?.clan ? `clan ${t.clan}` : null,
    t?.followers ? `${count(t.followers)} followers` : null,
  ]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .map(escaped)
    .join(" · ");
  const link = t?.profile_url
    ? ` <a href="${escaped(t.profile_url)}" rel="nofollow noreferrer">profile on fomo.family</a>`
    : "";
  return said === "" && link === "" ? "" : `<p class="lede">${said}${link}</p>`;
};

/**
 * The whole document. `window` is only said, never trusted into markup beyond escaping, and a
 * trader the books have not reached yet is a page with their fills on it and no figures —
 * which is the truth about them rather than a row of zeroes.
 */
export function traderDocument(profile: Profile, window: string): string {
  const page = traderPage(profile.handle);
  const here = `${SITE}${traderPath(profile.handle)}`;
  const empty = profile.fills.length === 0;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0a0d10">
<title>${escaped(page.title)}</title>
<meta name="description" content="${escaped(page.description)}">
<link rel="canonical" href="${escaped(here)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="profile">
<meta property="og:site_name" content="fomopulse">
<meta property="og:title" content="${escaped(page.title)}">
<meta property="og:description" content="${escaped(page.description)}">
<meta property="og:url" content="${escaped(here)}">
<meta property="og:image" content="${SITE}/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escaped(page.title)}">
<meta name="twitter:description" content="${escaped(page.description)}">
<meta name="twitter:image" content="${SITE}/og.png">
<style>${STYLE}</style>
</head>
<body>
<p class="crumb"><a href="/">fomopulse</a> / <a href="/traders">traders</a> / ${escaped(profile.handle)}</p>
<h1>${escaped(profile.handle)}</h1>
${who(profile)}
<p>What this tape saw ${escaped(profile.handle)} do on ${escaped(chainConfig.name)} over the last ${escaped(window)}, reconstructed
from the chain's own transfer logs. Every figure below was walked from those fills; fomo.family is asked only for the
name. <a href="/about">How the tape is built</a>.</p>
${books(profile)}
<h2>${empty ? "No fills in this window" : `Last ${profile.fills.length} fills`}</h2>
${empty ? `<p class="lede">Nothing from ${escaped(profile.handle)} reached the tape over the last ${escaped(window)}.</p>` : rows(profile)}
<p><a href="/?q=${encodeURIComponent(profile.handle)}">Follow ${escaped(profile.handle)} on the live tape</a></p>
${LINKS}
<footer>Read-only and open source: no keys, no signing, nothing to connect.
<a href="https://github.com/itsnex1s/fomopulse-robinhood-chain-tape">Source on GitHub</a>. Not affiliated with
fomo.family or Robinhood Markets, and not advice.</footer>
</body>
</html>`;
}
