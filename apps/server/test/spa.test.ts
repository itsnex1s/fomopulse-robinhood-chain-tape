/** What the process serves beside the API: a built file, a screen's own address, or a 404. */
import { expect, test } from "bun:test";
import { HANDLE_LIST, isViewPath, NOT_FOUND, traderPath, VIEW_PATHS } from "../src/api/views.ts";
import { api } from "./support/api.ts";

test("every screen's address is one the app is served at", () => {
  for (const path of VIEW_PATHS) expect(isViewPath(path)).toBe(true);
  // A trailing slash is the same address; nothing else is.
  expect(isViewPath("/bags/")).toBe(true);
  expect(isViewPath("/bags/1")).toBe(false);
  expect(isViewPath("/nowhere")).toBe(false);
  expect(isViewPath("/api/tape")).toBe(false);
});

test("an address no screen answers to is a 404, not the app pretending it exists", async () => {
  // The shell is only served where the app has a screen; the built file may or may not be
  // there in a test run, so what is asserted is that these never come back as a page.
  for (const path of ["/nowhere", "/missing.png", "/api/nothing-here", NOT_FOUND, `${NOT_FOUND}.html`]) {
    const res = await api.request(path);
    expect({ path, status: res.status }).toEqual({ path, status: 404 });
  }
});

test("the object's runtime is asked for every screen the assets cannot answer", async () => {
  // On Cloudflare the assets are served before the Worker unless the path says otherwise,
  // and they hold one page. A screen missing from that list is a 404 in production and a
  // working page here, which is the one difference between the two runtimes worth a test.
  const config = await Bun.file(new URL("../../worker/wrangler.jsonc", import.meta.url)).text();
  const first = config.match(/"run_worker_first"\s*:\s*\[([^\]]*)\]/)?.[1] ?? "";
  for (const path of VIEW_PATHS) {
    // A pattern is matched exactly, so the trailing slash isViewPath forgives is listed too.
    // The home page is the one the assets hold under its own name, and it is listed all the
    // same: served straight off them it would never reach the Worker, and never be dressed.
    for (const form of path === "/" ? ["/"] : [path, `${path}/`])
      expect({ form, listed: first.includes(`"${form}"`) }).toEqual({ form, listed: true });
  }
  // The not-found page is a document the assets hold, so only the Worker can say it is a 404.
  expect(first.includes(`"${NOT_FOUND}"`)).toBe(true);
});

test("the API still answers first, whatever the fallback would do with the path", async () => {
  // The one route with no memo in front of it. Every other answer is held for its window,
  // and the whole run shares those: asking for one here hands the next file an answer worked
  // out before its own fills landed.
  const res = await api.request("/api/alive");
  expect(res.status).toBe(200);
});

test("a tracked trader has a page of their own, and a name nobody tracks does not", async () => {
  const handle = HANDLE_LIST[0]!;
  const res = await api.request(traderPath(handle));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(await res.text()).toContain(`<h1>${handle}</h1>`);
  // A page per guessed name is the shape of a soft 404; there is one per tracked wallet.
  expect((await api.request("/trader/nobody-at-all")).status).toBe(404);
});

test("the sitemap is written, not stored, and answers under the name robots.txt gives", async () => {
  const res = await api.request("/sitemap.xml");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("xml");
  const xml = await res.text();
  for (const path of VIEW_PATHS) expect(xml).toContain(`<loc>https://fomopulse.app${path}</loc>`);
});
