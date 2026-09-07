/**
 * The edge in front of the tape. Three kinds of request and nothing else: the built web
 * app, which the platform serves from the colo the reader is in; `/ws`, which is handed
 * straight to the object holding the tape; and `/api/*`, which is answered from the
 * cache of the colo it arrived in and only reaches the object when that cache is cold.
 *
 * That last part is what a thousand readers rest on. They poll a handful of endpoints
 * every few seconds; with a second or two of cache each colo asks the object once per
 * window however many readers it has, and a fill still arrives over the socket the
 * moment it lands.
 */
import type { Env } from "./env.ts";

export { Tape } from "./tape.ts";

/**
 * How long an answer may be reused. Set just under the interval the client polls at, so
 * the object is asked once per window however many readers there are: the requests it
 * serves are then bounded by the clock rather than by how many people have the tape open,
 * which is the whole difference between one tab's traffic and a thousand's.
 */
const TTL: [prefix: string, seconds: number][] = [
  // Fetched on a window change, not on a timer, and the socket carries the rest.
  ["/api/tape", 1],
  // Polled every 15 s, and it carries the overview line as well.
  ["/api/status", 12],
  ["/api/overview", 12],
  // fomo is asked every ten minutes and the bag quotes every two; polled every two minutes.
  ["/api/traders", 90],
  ["/api/bags", 90],
];

/**
 * One object, named. The hint keeps it in eastern North America, next to the RPC
 * provider and the price feed — a fill reaches the tape in one hop and the readers are
 * served from their own colo anyway.
 */
const tape = (env: Env) => env.TAPE.get(env.TAPE.idFromName("tape"), { locationHint: "enam" });

/** One `/api` request: from the edge cache when it can be, from the object otherwise. */
async function answer(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const direct = async () => {
    const from = await tape(env).fetch(request);
    // Copied because a subrequest's headers are immutable and the caller adds to them.
    return new Response(from.body, from);
  };
  if (request.method !== "GET") return direct();

  const seconds = TTL.find(([prefix]) => url.pathname.startsWith(prefix))?.[1] ?? 0;
  if (seconds === 0) return direct();

  const cache = caches.default;
  const key = new Request(url.toString(), { method: "GET" });
  const hit = await cache.match(key);
  if (hit) {
    // Says which of the two paths answered, so a deployment can be checked from outside.
    const cached = new Response(hit.body, hit);
    cached.headers.set("x-cache", "hit");
    return cached;
  }

  const response = await direct();
  response.headers.set("cache-control", `public, max-age=${seconds}, s-maxage=${seconds}`);
  response.headers.set("x-cache", "miss");
  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") return tape(env).fetch(request);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    const response = await answer(request, env, ctx, url);
    // A crawler has to fetch these to see anything at all — the page is a tape and the
    // tape arrives over the API — but the JSON is not a page and must never be a result
    // of its own. robots.txt lets the two endpoints the first paint needs be read; this
    // keeps what comes back out of the index.
    response.headers.set("x-robots-tag", "noindex");
    return response;
  },

  /**
   * The object keeps itself awake with an alarm; this is the second key to the door,
   * for the case where the alarm was lost with the object that set it.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(tape(env).fetch(new Request("https://tape.internal/api/alive")));
  },
};
