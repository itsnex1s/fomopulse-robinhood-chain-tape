/**
 * The built web app, served by the process that indexes. Only this platform has files:
 * on Cloudflare the same `apps/web/dist` is uploaded as static assets and answered at
 * the edge, so the routes live here rather than beside the API.
 */
import { fileURLToPath } from "node:url";
import { type Context, Hono } from "hono";
import { api } from "./routes.ts";

/**
 * `fileURLToPath`, not `.pathname`: on Windows the latter is `/D:/…`, which no file API opens.
 */
const dist = fileURLToPath(new URL("../../../web/dist/", import.meta.url));
const asset = (path: string) => Bun.file(dist + path.replace(/^\/+/, ""));

async function spa(c: Context): Promise<Response> {
  const path = new URL(c.req.url).pathname;
  const file = asset(path);
  if (await file.exists()) return new Response(file);
  // A missing file is a 404; only routes fall back to the app shell, so a crawler
  // asking for an icon we do not have is told so instead of being handed HTML.
  if (/\.[a-z0-9]+$/i.test(path)) return c.text("not found", 404);
  const index = asset("index.html");
  if (await index.exists()) return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
  return c.text("web app is not built yet — run `bun run build`", 503);
}

/** The API first, then the files it is served alongside. */
export const site = new Hono()
  .get("/favicon.ico", () => new Response(null, { status: 204 }))
  .route("/", api)
  .get("/", spa)
  .get("/assets/*", spa)
  // Everything else with a dot in it is a file Vite copied from public/: icons, og.png,
  // the manifest, robots.txt, sitemap.xml.
  .get("/:file{[^/]+\\.[a-z0-9]+}", spa);
