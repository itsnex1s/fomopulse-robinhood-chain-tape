/**
 * The one POST that tells every engine but Google which addresses changed. What is worth
 * holding is the shape of the submission and the two ways it is refused whole: a key nobody
 * can read at the address the body names, and an address on somebody else's host.
 */
import { expect, test } from "bun:test";
import { announce, INDEXNOW_KEY } from "../src/api/indexnow.ts";
import { addresses, sitemap } from "../src/api/sitemap.ts";
import { HANDLE_LIST, SITE, traderPath } from "../src/api/views.ts";

type Sent = { url: string; body: Record<string, unknown> };

/** Replaces fetch for one call and hands back what was sent. */
async function sent(urls: string[], status = 200): Promise<Sent | null> {
  const real = globalThis.fetch;
  let caught: Sent | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    caught = { url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> };
    return new Response("", { status });
  }) as typeof fetch;
  try {
    await announce(urls);
  } finally {
    globalThis.fetch = real;
  }
  return caught;
}

test("the key is readable at the address the submission says it is", async () => {
  // The whole of IndexNow's proof that the caller controls the host: a file at this path
  // whose contents are the key. Written into the assets, so it ships with the page.
  const file = Bun.file(new URL(`../../web/public/${INDEXNOW_KEY}.txt`, import.meta.url));
  expect(await file.exists()).toBe(true);
  expect((await file.text()).trim()).toBe(INDEXNOW_KEY);
  expect(INDEXNOW_KEY).toMatch(/^[a-f0-9]{8,128}$/);
});

test("the submission names this host, this key, and nothing but our own addresses", async () => {
  const mine = `${SITE}${traderPath(HANDLE_LIST[0]!)}`;
  const caught = await sent([`${SITE}/`, mine, "https://example.com/somebody-else"]);
  expect(caught).not.toBeNull();
  expect(caught!.url).toContain("indexnow");
  expect(caught!.body).toMatchObject({
    host: new URL(SITE).host,
    key: INDEXNOW_KEY,
    keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`,
  });
  // A submission carrying one foreign address is refused whole, so it never carries one.
  expect(caught!.body.urlList).toEqual([`${SITE}/`, mine]);
});

test("nothing of ours to say is nothing sent", async () => {
  expect(await sent(["https://example.com/"])).toBeNull();
  expect(await sent([])).toBeNull();
});

test("an engine that will not listen is not an error a pass dies of", async () => {
  // 429 and 403 both happen, and neither is worth a retry inside a pass that has a tape to run.
  expect(await sent([`${SITE}/`], 429)).not.toBeNull();
  const real = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("dns"))) as unknown as typeof fetch;
  try {
    expect(await announce([`${SITE}/`])).toBeNull();
  } finally {
    globalThis.fetch = real;
  }
});

test("what is told and what is written are the same list", () => {
  const handles = [HANDLE_LIST[0]!, HANDLE_LIST[1]!];
  const told = addresses(handles);
  const written = [...sitemap(handles).matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => loc!);
  expect(told).toEqual(written);
});
