/**
 * How many people used the site on one UTC day, with the crawlers taken out. Every address and
 * user-agent the zone saw is profiled off Cloudflare's own analytics, its network is looked up at
 * Team Cymru, and a profile counts only if it ran the page, came from no data centre and named
 * itself as nothing automated.
 *
 *   bun run humans                 yesterday
 *   bun run humans 2026-10-04      that day; the free plan keeps about a week of it
 *
 * Reads CLOUDFLARE_API_TOKEN (Analytics: Read on the zone), else the token `wrangler login` holds.
 */
import { fileURLToPath } from "node:url";

const day = process.argv[2] ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`not a day: ${day}`);
const from = `${day}T00:00:00Z`;
const to = new Date(Date.parse(from) + 86_400_000).toISOString().replace(/\.\d+Z$/, "Z");

const worker = fileURLToPath(new URL("../apps/worker/", import.meta.url));
const token =
  process.env.CLOUDFLARE_API_TOKEN ??
  Bun.spawnSync(["bunx", "wrangler", "auth", "token"], { cwd: worker, stderr: "ignore" })
    .stdout.toString()
    .trim()
    .split("\n")
    .at(-1);
if (!token) throw new Error("no token: set CLOUDFLARE_API_TOKEN or run `wrangler login`");

// The domain is named once, in wrangler.jsonc, and read from there rather than written again.
const host = (await Bun.file(`${worker}wrangler.jsonc`).text()).match(/"pattern":\s*"([^"/]+)/)?.[1];
if (!host) throw new Error("no custom domain in apps/worker/wrangler.jsonc");

async function cf<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  const body = (await response.json()) as { errors?: unknown[]; result?: T; data?: T };
  if (body.errors?.length) throw new Error(JSON.stringify(body.errors));
  return (body.result ?? body.data) as T;
}

const [zone] = await cf<{ id: string }[]>(`zones?name=${host}`);
if (!zone) throw new Error(`no zone ${host} on this token`);

type Group = { count: number; dimensions: Record<string, string> };
// The adaptive dataset answers at most this many groups; a day that fills it is undercounted.
const GROUPS = 10_000;

async function groups(filter: string, dimensions: string): Promise<Group[]> {
  const query = `{viewer{zones(filter:{zoneTag:"${zone!.id}"}){httpRequestsAdaptiveGroups(limit:${GROUPS},filter:{datetime_geq:"${from}",datetime_lt:"${to}",requestSource:"eyeball"${filter}},orderBy:[count_DESC]){count dimensions{${dimensions}}}}}}`;
  const data = await cf<{ viewer: { zones: { httpRequestsAdaptiveGroups: Group[] }[] } }>("graphql", {
    method: "POST",
    body: JSON.stringify({ query }),
  });
  const rows = data.viewer.zones[0]?.httpRequestsAdaptiveGroups ?? [];
  if (rows.length === GROUPS) console.warn(`warning: ${dimensions} hit ${GROUPS} groups, the day is cut short`);
  return rows;
}

/** One address under one user-agent, and what it did all day. */
type Profile = {
  ip: string;
  ua: string;
  ran: boolean;
  live: number;
  pages: Set<string>;
  hours: Set<string>;
  verified: string;
  asn: string;
};
const profiles = new Map<string, Profile>();
function profile(d: Record<string, string>): Profile {
  const key = `${d.clientIP}\t${d.userAgent}`;
  let found = profiles.get(key);
  if (!found) {
    found = {
      ip: d.clientIP ?? "",
      ua: d.userAgent ?? "",
      ran: false,
      live: 0,
      pages: new Set(),
      hours: new Set(),
      verified: "",
      asn: "",
    };
    profiles.set(key, found);
  }
  found.verified ||= d.verifiedBotCategory ?? "";
  if (d.datetimeHour) found.hours.add(d.datetimeHour);
  return found;
}

// The screens and the written pages; everything else a browser fetches is a part of one of them.
const PAGE = /^\/($|traders\/?$|bags\/?$|discover\/?$|trader\/|about)/;
const [beacons, scripts, live, pages] = await Promise.all([
  groups(`,clientRequestPath:"/cdn-cgi/rum"`, "clientIP userAgent verifiedBotCategory"),
  groups(`,clientRequestPath_like:"/assets/%.js"`, "clientIP userAgent"),
  groups(
    `,clientRequestPath_in:["/api/status","/api/tape","/ws"],edgeResponseStatus_in:[200,101]`,
    "clientIP userAgent datetimeHour",
  ),
  groups(
    `,edgeResponseStatus:200,clientRequestHTTPMethodName:"GET"`,
    "clientIP userAgent clientRequestPath verifiedBotCategory datetimeHour",
  ),
]);
for (const { dimensions } of [...beacons, ...scripts]) profile(dimensions).ran = true;
for (const { count, dimensions } of live) profile(dimensions).live += count;
for (const { dimensions } of pages) {
  if (PAGE.test(dimensions.clientRequestPath ?? "")) profile(dimensions).pages.add(dimensions.clientRequestPath ?? "");
}

// Team Cymru's bulk whois: one connection, the whole list between begin and end, closed by them.
const ips = [...new Set([...profiles.values()].map((p) => p.ip))];
const names = new Map<string, string>();
let whois = "";
await new Promise<void>((resolve, reject) => {
  Bun.connect({
    hostname: "whois.cymru.com",
    port: 43,
    socket: {
      open: (socket) => void socket.write(`begin\nverbose\n${ips.join("\n")}\nend\n`),
      data: (_, chunk) => {
        whois += chunk.toString();
      },
      close: () => resolve(),
      error: (_, error) => reject(error),
    },
  }).catch(reject);
});
for (const line of whois.split("\n")) {
  const [asn, ip, , , , , name] = line.split("|").map((cell) => cell.trim());
  if (asn && ip && /^\d+$/.test(asn)) names.set(ip, `AS${asn} ${name ?? ""}`);
}
for (const p of profiles.values()) p.asn = names.get(p.ip) ?? "unknown";

const AUTOMATED =
  /bot|crawl|spider|slurp|headless|lighthouse|preview|python|curl|node|go-http|axios|wget|scrapy|playwright|puppeteer|java\/|okhttp|httpclient|facebookexternalhit|whatsapp|telegram|discord|slack|embedly/i;
// Hosting, and the proxy networks a crawler rents to look residential. Cloudflare is not on it:
// AS13335 is WARP as well, and its visitors here held the tape open like anybody else.
const HOSTED =
  /amazon|aws|google|microsoft|azure|digitalocean|hetzner|ovh|linode|akamai|vultr|choopa|oracle|alibaba|tencent|huawei|contabo|m247|datacamp|leaseweb|scaleway|hostinger|fastly|zscaler|colocrossing|psychz|quadranet|servers|hosting|datacenter|cdn77|g-core|gcore|ionos|hostwinds|kamatera|netcup|ipxo|equinix|clouvider|stark|tzulo|limestone|bytedance|facebook|gtt-backbone|bite-us|net3-ai|hostroyale|latitude|lonconnect|server-mania|b2 net|web2objects/i;
// A reader opens one trader's page from a link; a crawler walks the roster.
const WALK = 8;
// A tab left open from the day before polls hundreds of times without loading a page today, and
// a returning reader's cached script fetches nothing; a client that rotates its address every
// call makes one or two requests from each and never loads a page at all.
const HELD_OPEN = 10;
const POLLED = "polled without a page";

function verdict(p: Profile): string | undefined {
  if (p.verified) return "known bot";
  if (!p.ua || AUTOMATED.test(p.ua)) return "automated user-agent";
  if (!p.ran && !p.live) return "ran no script";
  if (!p.ran && !p.pages.size && p.live < HELD_OPEN) return POLLED;
  if (HOSTED.test(p.asn)) return "data centre or proxy";
  if (p.pages.size >= WALK) return "walked the pages";
  return undefined;
}

const dropped = new Map<string, number>();
const people: Profile[] = [];
// The same cut also takes a reader whose page came over one address and whose polls over another,
// so what it took from home networks rather than from WARP is reported as unsure, not as nobody.
const unsure: Profile[] = [];
for (const p of profiles.values()) {
  const why = verdict(p);
  if (why) dropped.set(why, (dropped.get(why) ?? 0) + 1);
  else people.push(p);
  if (why === POLLED && !HOSTED.test(p.asn) && !p.asn.startsWith("AS13335 ")) unsure.push(p);
}
const addresses = (list: Profile[]) => new Set(list.map((p) => p.ip)).size;

console.log(`${host} · ${day} UTC · ${profiles.size} address+agent pairs from ${ips.length} addresses\n`);
console.log("dropped");
for (const [why, n] of [...dropped].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${why}`);
console.log(`\npeople (distinct addresses; one person can hold several)`);
const line = (n: number, what: string) => console.log(`  ${String(n).padStart(6)}  ${what}`);
line(addresses(people), "left after the cuts");
line(addresses(unsure), "unsure: polled from a home network without loading a page");
line(addresses(people.filter((p) => p.live > 0)), "opened the live app");
line(addresses(people.filter((p) => p.live >= 10)), "stayed: ten or more live requests");
line(addresses(people.filter((p) => p.hours.size >= 2)), "seen in two or more hours");
line(addresses(people.filter((p) => /Mobile|Android|iPhone/.test(p.ua))), "on a phone");

const networks = new Map<string, Set<string>>();
for (const p of people) {
  const set = networks.get(p.asn) ?? new Set();
  networks.set(p.asn, set.add(p.ip));
}
console.log("\ntheir networks");
for (const [asn, set] of [...networks].sort((a, b) => b[1].size - a[1].size).slice(0, 10)) {
  console.log(`  ${String(set.size).padStart(6)}  ${asn.slice(0, 70)}`);
}
