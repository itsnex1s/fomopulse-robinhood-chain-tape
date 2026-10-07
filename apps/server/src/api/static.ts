/**
 * The built web app, served by the process that indexes. Bun-only: on Cloudflare the same
 * `apps/web/dist` is uploaded as static assets and answered at the edge.
 */
import { fileURLToPath } from "node:url";
import { type Context, Hono } from "hono";
import { later, traderDocument } from "./profile.ts";
import { api } from "./routes.ts";
import { dress, SOURCE, TRADER_FILLS, TRADER_WINDOW } from "./shell.ts";
import type { Profile } from "./types.ts";
import { isViewPath, NOT_FOUND, traderOf, trimmed } from "./views.ts";

/** `fileURLToPath`, not `.pathname`: on Windows the latter is `/D:/…`, which no file API opens. */
const dist = fileURLToPath(new URL("../../../web/dist/", import.meta.url));
const asset = (path: string) => Bun.file(dist + path.replace(/^\/+/, ""));

/** The screen's own first rows, asked of this process's own API. A page that cannot get them
 *  is still a page: the head is what a search engine keeps, the rows are what it reads. */
async function drawn(path: string): Promise<unknown[] | undefined> {
  const source = SOURCE[trimmed(path)];
  if (source === undefined) return undefined;
  try {
    const response = await api.request(source);
    return response.ok ? ((await response.json()) as unknown[]) : undefined;
  } catch {
    return undefined;
  }
}

/** A tracked trader's own page. The handle is checked against the roster before anything is
 *  read, so there is a page per tracked wallet and not one per name somebody guessed. */
async function trader(handle: string): Promise<Response> {
  const asked = `/api/trader/${encodeURIComponent(handle)}?window=${TRADER_WINDOW}&limit=${TRADER_FILLS}`;
  const response = await api.request(asked);
  if (!response.ok) return later(response.status);
  const profile = (await response.json()) as Profile;
  return new Response(traderDocument(profile, TRADER_WINDOW), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function spa(c: Context): Promise<Response> {
  // Parsed, so `..` is resolved away before it reaches a file API; what is left encoded
  // stays encoded, and no directory is named twice.
  const path = new URL(c.req.url).pathname;
  if (trimmed(path) === NOT_FOUND || path === `${NOT_FOUND}.html`) {
    const page = asset(`${NOT_FOUND}.html`);
    return (await page.exists())
      ? new Response(page, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } })
      : c.text("not found", 404);
  }
  const file = asset(path);
  if (await file.exists()) return new Response(file);
  // A document is linked without its extension and Cloudflare serves it that way from the
  // assets; this is the same rule, so one address works under both runtimes.
  if (path.length > 1 && !path.includes(".")) {
    const document = asset(`${path}.html`);
    if (await document.exists())
      return new Response(document, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  const handle = traderOf(path);
  if (handle !== undefined) return trader(handle);
  // Only the app's own screens fall back to the shell. Anything else — an icon we do not
  // have, an /api path nothing answers — is a 404 rather than a page that lied about
  // existing, which is a crawler's word for a soft 404.
  if (!isViewPath(path)) return c.text("not found", 404);
  const index = asset("index.html");
  if (await index.exists())
    return dress(
      new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } }),
      path,
      await drawn(path),
    );
  return c.text("web app is not built yet — run `bun run build`", 503);
}

/** The API first, then everything else: a built file where there is one, a screen's own
 *  address answered with the shell, and a 404 for the rest. */
export const site = new Hono()
  .get("/favicon.ico", () => new Response(null, { status: 204 }))
  .route("/", api)
  .get("*", spa);
