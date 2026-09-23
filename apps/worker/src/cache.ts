/**
 * The key a cached answer is filed under, which is the whole of what the edge cache is worth.
 */
import { limits, WINDOWS } from "../../server/src/limits.ts";

/** The platform's rate limiter, as the unsafe binding hands it over: one call per request,
 *  counted per key in the colo the request landed in. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

const window = new Set<string>(WINDOWS);
const STEPS = limits.cache.limitSteps;
const CAP = STEPS[STEPS.length - 1]!;

/**
 * The query a cached answer is keyed on: only the parameters the API reads, only the values it
 * allows, in one order. A row count is rounded up to the next step it is allowed to take.
 *
 * Without this the cache is trivial to walk past — `?limit=399`, `?limit=398`, and every one of
 * them is a miss and a read of the object — and a lifetime is only worth what the number of
 * distinct keys behind it makes it. The object is asked with the same canonical URL the cache
 * is keyed on, so the two can never answer different questions.
 */
export function canonical(url: URL): URL {
  const asked = url.searchParams;
  const out = new URL(url.origin + url.pathname);
  const set = out.searchParams;
  const window_ = asked.get("window");
  // An unknown window is left off rather than corrected: the route's own default is the answer.
  if (window_ !== null && window.has(window_)) set.set("window", window_);
  for (const flag of ["stocks", "dust"]) {
    const value = asked.get(flag);
    if (value === "true" || value === "false") set.set(flag, value);
  }
  const limit = Number(asked.get("limit"));
  if (Number.isFinite(limit) && limit > 0) set.set("limit", String(STEPS.find((step) => step >= limit) ?? CAP));
  // Both halves or neither: without the pair there is no cursor and the read is the first page.
  const before = Number(asked.get("before"));
  const beforeId = Number(asked.get("beforeId"));
  if (Number.isInteger(before) && before > 0 && Number.isInteger(beforeId) && beforeId > 0) {
    set.set("before", String(before));
    set.set("beforeId", String(beforeId));
  }
  set.sort();
  return out;
}

/**
 * Whether this address has had its minute's worth of the object. Counted only where the cache
 * could not answer, so a reader whose page is being served from the colo spends none of it;
 * what it bounds is the one thing the cache cannot, a cursor whose every value is a different
 * and entirely valid page. See cache.objectRequestsPerMinute in config/limits.json.
 */
export async function throttled(limiter: RateLimiter | undefined, request: Request): Promise<Verdict> {
  const ip = request.headers.get("cf-connecting-ip");
  if (ip === null || limiter === undefined) return "off";
  return (await limiter.limit({ key: ip })).success ? "ok" : "over";
}

/** Said in `x-limit` on every answer that reached the object: whether the ceiling is in force
 *  at all, and whether this address is inside it. A limiter that quietly does nothing looks
 *  exactly like one nobody has reached, which is the one thing worth telling apart. */
export type Verdict = "off" | "ok" | "over";

/**
 * The addresses the site does not answer, from config/limits.json. Parsed once: a prefix is
 * kept as the bytes it fixes, so a match is a comparison and not a string the request has to
 * be formatted into. IPv6 is compared as text, which only matches a whole address — the list
 * has never needed a v6 range and guessing at one silently matching too much is worse.
 */
const RANGES = limits.cache.blocked.map((entry) => {
  const [address = "", bits] = entry.split("/");
  const octets = address.split(".").map(Number);
  const v4 = octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  if (!v4) return { text: address.toLowerCase() };
  const width = bits === undefined ? 32 : Math.min(32, Number(bits));
  const value = octets.reduce((acc, n) => acc * 256 + n, 0);
  const mask = width === 0 ? 0 : (0xffff_ffff << (32 - width)) >>> 0;
  return { value: (value & mask) >>> 0, mask };
});

/** Whether this address is one of them. Nothing it sends is read first, so a blocked client
 *  cannot spend anything at all: not the object, not the cache, not a line of routing. */
export function barred(request: Request): boolean {
  const ip = request.headers.get("cf-connecting-ip");
  if (ip === null || RANGES.length === 0) return false;
  const octets = ip.split(".").map(Number);
  const value =
    octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
      ? octets.reduce((acc, n) => acc * 256 + n, 0)
      : undefined;
  const text = ip.toLowerCase();
  return RANGES.some((range) =>
    range.mask === undefined ? range.text === text : value !== undefined && (value & range.mask) >>> 0 === range.value,
  );
}

export const barredResponse = (): Response =>
  new Response(JSON.stringify({ error: "blocked" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });

/**
 * Whether the caller says what it is. A browser always does, and so does every library with a
 * default; a request that arrives nameless on the way to the object is a scraper that turned
 * its own name off. The assets are served to anyone — this is only the door to the object.
 */
export const named = (request: Request): boolean => (request.headers.get("user-agent") ?? "").trim() !== "";

export const nameless = (): Response =>
  new Response(JSON.stringify({ error: "send a user-agent" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });

/**
 * There is deliberately no rule here that reads a user-agent and decides what the caller is.
 * The header is a string the caller writes, so every such rule is a classifier guessing at an
 * unauthenticated claim: one that refuses `Mozilla/5.0` refuses `Mozilla/5.0 (compatible;
 * Name/1.0)` with it, which is the shape a bot names itself in and Googlebot's own.
 *
 * The mechanisms that answer this properly answer it with proof, not with a string:
 *   a request from our own page  ->  Fetch Metadata, which the browser sets and a page cannot
 *   a bot that is who it says    ->  Web Bot Auth: RFC 9421 signatures under Signature-Agent
 *   a crawler nobody wants       ->  the zone's managed list, which Cloudflare keeps current
 *   a client allowed to automate ->  a credential
 * and what an anonymous caller may cost is answered by the two caches and `throttled`, which
 * need to know nothing about anyone. Adding a fifth guess here would only look like an answer.
 */

export const tooMany = (): Response =>
  new Response(JSON.stringify({ error: "too many requests" }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "60" },
  });
