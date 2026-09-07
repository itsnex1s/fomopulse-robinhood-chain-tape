/** What the process serves beside the API: a built file, a screen's own address, or a 404. */
import { expect, test } from "bun:test";
import { isViewPath, VIEW_PATHS } from "../src/api/views.ts";
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
  for (const path of ["/nowhere", "/missing.png", "/api/nothing-here"]) {
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
    // The home page is the one the assets already hold.
    if (path === "/") continue;
    // A pattern is matched exactly, so the trailing slash isViewPath forgives is listed too.
    for (const form of [path, `${path}/`])
      expect({ form, listed: first.includes(`"${form}"`) }).toEqual({ form, listed: true });
  }
});

test("the API still answers first, whatever the fallback would do with the path", async () => {
  // The one route with no memo in front of it. Every other answer is held for its window,
  // and the whole run shares those: asking for one here hands the next file an answer worked
  // out before its own fills landed.
  const res = await api.request("/api/alive");
  expect(res.status).toBe(200);
});
