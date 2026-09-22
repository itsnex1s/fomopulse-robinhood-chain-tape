/**
 * The edge in front of the tape: the built web app, `/ws` handed straight to the object,
 * and `/api/*` answered from the cache of the colo it arrived in, which is what keeps a
 * thousand polling readers down to one request per colo per cache window.
 */

import { later, traderDocument } from "../../server/src/api/profile.ts";
import { dress, SOURCE, TRADER_FILLS, TRADER_WINDOW } from "../../server/src/api/shell.ts";
import type { Profile } from "../../server/src/api/types.ts";
import { isViewPath, traderOf, trimmed } from "../../server/src/api/views.ts";
import { limits } from "../../server/src/limits.ts";
import {
  barred,
  barredResponse,
  canonical,
  impersonating,
  named,
  nameless,
  pretending,
  throttled,
  tooMany,
} from "./cache.ts";
import type { Env } from "./env.ts";

export { Tape } from "./tape.ts";

/**
 * How long an answer may be reused at the edge, in seconds, from config/limits.json, keyed by
 * the route's own name — the segment after /api/, and not a prefix of the path, or /api/traders
 * would be answered by whichever of it and /api/trader was written down first. Set just under
 * the interval the client polls at, so the object is asked once per colo per window however
 * many readers there are. The object may ask for longer in the answer's own `x-ttl`, which is
 * how a month spending past its budget reaches this cache: see api/budget.ts.
 */
const TTL: Record<string, number> = limits.cache.edge;
const routeOf = (pathname: string): string => pathname.split("/")[2] ?? "";

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

  const configured = TTL[routeOf(url.pathname)] ?? 0;
  if (configured === 0) return direct();

  const cache = caches.default;
  const key = new Request(asked.toString(), { method: "GET" });
  const hit = await cache.match(key);
  if (hit) {
    const cached = new Response(hit.body, hit);
    cached.headers.set("x-cache", "hit");
    // The verdict on the stored answer was whoever missed and reached the object; this reader
    // spent none of their minute, and saying otherwise would read as a ceiling nobody is near.
    cached.headers.set("x-limit", "cached");
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

/**
 * The screen's own first rows, out of the same cache the page's own polling fills — the source
 * is the address the app asks for, so the two share a key and a colo that has served the page
 * once answers this for nothing. A miss spends one of the reader's minute like any other, and
 * a refusal or an error is simply a page without a table on it.
 */
async function drawn(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<unknown[] | undefined> {
  const source = SOURCE[trimmed(url.pathname)];
  if (source === undefined) return undefined;
  const at = new URL(source, url);
  try {
    const response = await answer(new Request(at.toString(), { headers: request.headers }), env, ctx, at);
    return response.ok ? ((await response.json()) as unknown[]) : undefined;
  } catch {
    return undefined;
  }
}

/** One tracked trader's own page, written here out of the object's answer for them. A handle
 *  the roster does not know never gets this far, so there is a page per tracked wallet.
 *  There are 287 of these and a crawler goes through them faster than one address may reach
 *  the object, so the refused one has to be refused rather than written empty: see `later`. */
async function profile(handle: string, request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const at = new URL(`/api/trader/${encodeURIComponent(handle)}?window=${TRADER_WINDOW}&limit=${TRADER_FILLS}`, url);
  const asked = await answer(new Request(at.toString(), { headers: request.headers }), env, ctx, at).catch(
    () => undefined,
  );
  if (asked === undefined) return later(503);
  if (!asked.ok) return later(asked.status);
  return new Response(traderDocument((await asked.json()) as Profile, TRADER_WINDOW), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Before the page, before the assets, before routing: an address on the list is answered
    // with nothing at all. A client that has stopped behaving like a reader is not one, and
    // a page it never loads is a script it never runs. See cache.blocked in config/limits.json.
    if (barred(request)) return barredResponse();

    // Everything past this line can reach the object, and the object is what the bill is made
    // of. The page and its assets are served to anyone at all; this is only the door to the
    // object, and what it asks for is a name: see `named` and `impersonating`.
    if (url.pathname === "/ws" || url.pathname.startsWith("/api/")) {
      if (!named(request)) return nameless();
      if (impersonating(request, url.host)) return pretending();
    }
    // The socket is an object request like any other, and one nothing caches.
    if (url.pathname === "/ws")
      return (await throttled(env.OBJECT_LIMIT, request)) === "over" ? tooMany() : tape(env).fetch(request);
    // The sitemap is written by the object — it names every trader the tape has seen trade —
    // and robots.txt asks for it under this name rather than under /api.
    if (url.pathname === "/sitemap.xml") {
      const at = new URL("/api/sitemap", url);
      return answer(new Request(at.toString(), { headers: request.headers }), env, ctx, at);
    }
    if (!url.pathname.startsWith("/api/")) {
      const handle = traderOf(url.pathname);
      if (handle !== undefined) return profile(handle, request, env, ctx, url);
      // The app draws four screens and the assets hold one page, so a screen's own address
      // is answered with that page, wearing that screen's own head. Everything else the
      // assets do not have stays a 404.
      if (!isViewPath(url.pathname)) return env.ASSETS.fetch(request);
      const shell = await env.ASSETS.fetch(new Request(new URL("/", url).toString(), request));
      return dress(shell, url.pathname, await drawn(request, env, ctx, url));
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
