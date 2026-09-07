/**
 * The edge in front of the tape: the built web app, `/ws` handed straight to the object,
 * and `/api/*` answered from the cache of the colo it arrived in, which is what keeps a
 * thousand polling readers down to one request per colo per cache window.
 */

import { isViewPath } from "../../server/src/api/views.ts";
import { limits } from "../../server/src/limits.ts";
import { canonical, throttled, tooMany } from "./cache.ts";
import type { Env } from "./env.ts";

export { Tape } from "./tape.ts";

/**
 * How long an answer may be reused at the edge, in seconds, from config/limits.json. Set just
 * under the interval the client polls at, so the object is asked once per colo per window
 * however many readers there are. The object may ask for longer in the answer's own `x-ttl`,
 * which is how a month spending past its budget reaches this cache: see api/budget.ts.
 */
const TTL: [prefix: string, seconds: number][] = Object.entries(limits.cache.edge).map(([name, seconds]) => [
  `/api/${name}`,
  seconds,
]);

/**
 * One object, named. The hint pins it to eastern North America, next to the RPC provider
 * and the price feed, so a fill reaches the tape in one hop.
 */
const tape = (env: Env) => env.TAPE.get(env.TAPE.idFromName("tape"), { locationHint: "enam" });

/** One `/api` request: from the edge cache when it can be, from the object otherwise. */
async function answer(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const asked = canonical(url);
  const direct = async () => {
    const verdict = await throttled(env.OBJECT_LIMIT, request);
    if (verdict === "over") return tooMany();
    const from = await tape(env).fetch(new Request(asked.toString(), request));
    // Copied because a subrequest's headers are immutable and the caller adds to them.
    const response = new Response(from.body, from);
    response.headers.set("x-limit", verdict);
    return response;
  };
  if (request.method !== "GET") return direct();

  const configured = TTL.find(([prefix]) => url.pathname.startsWith(prefix))?.[1] ?? 0;
  if (configured === 0) return direct();

  const cache = caches.default;
  const key = new Request(asked.toString(), { method: "GET" });
  const hit = await cache.match(key);
  if (hit) {
    const cached = new Response(hit.body, hit);
    cached.headers.set("x-cache", "hit");
    return cached;
  }

  const response = await direct();
  // A refusal and an error are this request's, not the colo's: caching either would serve one
  // reader's throttling to everybody behind the same cache.
  if (!response.ok) return response;
  // What the object asked for, which already carries whatever the month is spending; the
  // configured lifetime is the floor under it and the answer when it says nothing.
  const asks = Number(response.headers.get("x-ttl"));
  const seconds = Number.isFinite(asks) && asks > configured ? Math.round(asks) : configured;
  response.headers.set("cache-control", `public, max-age=${seconds}, s-maxage=${seconds}`);
  response.headers.set("x-cache", "miss");
  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // The socket is an object request like any other, and one nothing caches.
    if (url.pathname === "/ws")
      return (await throttled(env.OBJECT_LIMIT, request)) === "over" ? tooMany() : tape(env).fetch(request);
    if (!url.pathname.startsWith("/api/")) {
      // The app draws four screens and the assets hold one page, so a screen's own address
      // is answered with that page. Everything else the assets do not have stays a 404.
      const shell = isViewPath(url.pathname) ? new Request(new URL("/", url).toString(), request) : request;
      return env.ASSETS.fetch(shell);
    }

    const response = await answer(request, env, ctx, url);
    // robots.txt lets a crawler read the two endpoints the first paint needs; this keeps
    // the JSON they return out of the index.
    response.headers.set("x-robots-tag", "noindex");
    return response;
  },

  /**
   * The object keeps itself awake with an alarm, and an alarm can be lost with the object
   * that set it; this is the second key to the door.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(tape(env).fetch(new Request("https://tape.internal/api/alive")));
  },
};
