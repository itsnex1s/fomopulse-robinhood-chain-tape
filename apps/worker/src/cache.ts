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

export const tooMany = (): Response =>
  new Response(JSON.stringify({ error: "too many requests" }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "60" },
  });
