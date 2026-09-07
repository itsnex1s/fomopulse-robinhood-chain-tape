/**
 * The built web app, served by the process that indexes. Bun-only: on Cloudflare the same
 * `apps/web/dist` is uploaded as static assets and answered at the edge.
 */
import { fileURLToPath } from "node:url";
import { type Context, Hono } from "hono";
import { api } from "./routes.ts";
import { isViewPath } from "./views.ts";

/** `fileURLToPath`, not `.pathname`: on Windows the latter is `/D:/…`, which no file API opens. */
const dist = fileURLToPath(new URL("../../../web/dist/", import.meta.url));
const asset = (path: string) => Bun.file(dist + path.replace(/^\/+/, ""));

async function spa(c: Context): Promise<Response> {
  // Parsed, so `..` is resolved away before it reaches a file API; what is left encoded
  // stays encoded, and no directory is named twice.
  const path = new URL(c.req.url).pathname;
  const file = asset(path);
  if (await file.exists()) return new Response(file);
  // Only the app's own screens fall back to the shell. Anything else — an icon we do not
  // have, an /api path nothing answers — is a 404 rather than a page that lied about
  // existing, which is a crawler's word for a soft 404.
  if (!isViewPath(path)) return c.text("not found", 404);
  const index = asset("index.html");
  if (await index.exists()) return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
  return c.text("web app is not built yet — run `bun run build`", 503);
}

/** The API first, then everything else: a built file where there is one, a screen's own
 *  address answered with the shell, and a 404 for the rest. */
export const site = new Hono()
  .get("/favicon.ico", () => new Response(null, { status: 204 }))
  .route("/", api)
  .get("*", spa);
