/** The canonical query the edge files an answer under. Every value a reader can vary that this
 *  does not fold down is a cache miss they can ask for as often as they like. */
import { expect, test } from "bun:test";
import { admitted, canonical, named, nameless, ownPage, throttled, tooMany } from "../../worker/src/cache.ts";

const key = (query: string) => canonical(new URL(`https://tape.test/api/tape${query}`)).toString();

test("a row count is rounded up to a step, so the cache cannot be walked past one row at a time", () => {
  // Every count between two steps is one answer, and the one the app asks for is untouched.
  expect(key("?limit=399")).toBe(key("?limit=400"));
  expect(key("?limit=301")).toBe(key("?limit=400"));
  expect(key("?limit=1")).toBe(key("?limit=50"));
  expect(new Set([351, 370, 399, 400].map((n) => key(`?limit=${n}`))).size).toBe(1);
  // And a count past the widest step is that step, not a read of everything.
  expect(key("?limit=99999")).toBe(key("?limit=1000"));
});

test("anything the API does not read is dropped, and an unknown value falls back to the default", () => {
  expect(key("?cachebust=17")).toBe(key(""));
  expect(key("?window=zzz")).toBe(key(""));
  expect(key("?dust=maybe")).toBe(key(""));
  expect(key("?window=24h&cachebust=17")).toBe(key("?window=24h"));
});

test("the same question in another order is the same key", () => {
  expect(key("?window=24h&stocks=false&limit=400")).toBe(key("?limit=400&stocks=false&window=24h"));
});

test("a cursor is kept only as a pair, since half of one is the first page again", () => {
  expect(key("?before=100&beforeId=7")).toContain("before=100");
  expect(key("?before=100")).toBe(key(""));
  expect(key("?beforeId=7")).toBe(key(""));
  expect(key("?before=0&beforeId=7")).toBe(key(""));
});

test("what the app itself asks for survives untouched", () => {
  const asked = canonical(new URL("https://tape.test/api/tape?limit=400&window=24h&stocks=true&dust=false"));
  expect(asked.searchParams.get("limit")).toBe("400");
  expect(asked.searchParams.get("window")).toBe("24h");
  expect(asked.searchParams.get("stocks")).toBe("true");
  expect(asked.searchParams.get("dust")).toBe("false");
  expect(asked.pathname).toBe("/api/tape");
});

/** A limiter that refuses everything past `allow`, the way the platform's does per colo. */
const limiter = (allow: number) => {
  let seen = 0;
  return { limit: () => Promise.resolve({ success: ++seen <= allow }) };
};
test("a seat past its minute's worth of the object is refused, and told for how long", async () => {
  const limit = limiter(2);
  expect(await throttled(limit, "ip:1.2.3.4")).toBe("ok");
  expect(await throttled(limit, "ip:1.2.3.4")).toBe("ok");
  expect(await throttled(limit, "ip:1.2.3.4")).toBe("over");
  const refusal = tooMany();
  expect(refusal.status).toBe(429);
  expect(refusal.headers.get("retry-after")).toBe("60");
});

test("no limiter and no address are both no ceiling, not a refused reader", async () => {
  expect(await throttled(undefined, "ip:1.2.3.4")).toBe("off");
  expect(await throttled(limiter(0), "ip:anon")).toBe("off");
});

test("a client with a key is counted against its own name, not against its address", async () => {
  // Two clients behind one address, which is an office or a cloud region, are two minutes.
  const limit = limiter(1);
  expect(await throttled(limit, "key:research")).toBe("ok");
  expect(await throttled(limit, "key:tape-bot")).toBe("over");
});

test("a caller that will not say what it is does not reach the object", () => {
  const ask = (headers?: Record<string, string>) => new Request("https://tape.test/api/tape", { headers });
  expect(named(ask({ "user-agent": "Mozilla/5.0" }))).toBe(true);
  expect(named(ask({ "user-agent": "python-requests/2.31.0" }))).toBe(true);
  // No header at all, and a header that is only spaces, are the same refusal.
  expect(named(ask())).toBe(false);
  expect(named(ask({ "user-agent": "" }))).toBe(false);
  expect(named(ask({ "user-agent": "   " }))).toBe(false);
  expect(nameless().status).toBe(403);
});

/** The door to the object. A deployment that has issued no keys has none, which is what a
 *  clone of this repository should be; the tests below give it some and then ask who gets in. */
const ask = (headers: Record<string, string> = {}, url = "https://tape.test/api/tape") =>
  new Request(url, { headers: { "cf-connecting-ip": "1.2.3.4", ...headers } });
const KEYS = { API_KEYS: "research:sk_aaaaaaaaaaaa,tape-bot:sk_bbbbbbbbbbbb" };
const seat = (headers?: Record<string, string>, env: { API_KEYS?: string } = KEYS) =>
  admitted(ask(headers), env, "tape.test");

test("with no key issued the tape answers anyone, and counts them by address", () => {
  expect(seat({}, {})).toBe("ip:1.2.3.4");
  expect(seat({ authorization: "Bearer sk_aaaaaaaaaaaa" }, {})).toBeInstanceOf(Response);
});

test("a bearer token names the client, and a wrong one is refused however close it is", () => {
  expect(seat({ authorization: "Bearer sk_aaaaaaaaaaaa" })).toBe("key:research");
  expect(seat({ authorization: "bearer sk_bbbbbbbbbbbb" })).toBe("key:tape-bot");
  for (const wrong of ["Bearer sk_aaaaaaaaaaab", "Bearer sk_aaaaaaaaaaa", "Bearer ", "Bearer x"]) {
    const answer = seat({ authorization: wrong });
    expect({ wrong, status: answer instanceof Response ? answer.status : 200 }).toEqual({ wrong, status: 401 });
  }
});

test("the refusal says which scheme would have worked, as RFC 9110 asks", () => {
  const answer = seat({});
  expect(answer).toBeInstanceOf(Response);
  if (answer instanceof Response) {
    expect(answer.status).toBe(401);
    expect(answer.headers.get("www-authenticate")).toContain("Bearer");
  }
});

test("the app's own page needs no key, because it has nowhere to keep one", () => {
  // Fetch Metadata, which the browser sets and the page cannot: W3C, and every browser since
  // Safari 16.4. The two below it are the same claim from a browser older than that.
  expect(seat({ "sec-fetch-site": "same-origin" })).toBe("ip:1.2.3.4");
  expect(seat({ origin: "https://tape.test" })).toBe("ip:1.2.3.4");
  expect(seat({ referer: "https://tape.test/traders?window=24h" })).toBe("ip:1.2.3.4");
  // Another site's page is not ours, and neither is a referer that will not parse.
  expect(seat({ origin: "https://not-tape.test" })).toBeInstanceOf(Response);
  expect(seat({ referer: "not a url" })).toBeInstanceOf(Response);
  expect(seat({ "sec-fetch-site": "cross-site" })).toBeInstanceOf(Response);
  expect(ownPage(ask({ "sec-fetch-site": "same-origin" }), "tape.test")).toBe(true);
});

test("a person who typed the address is not a program on a schedule", () => {
  // sec-fetch-site: none is the browser saying nobody's page started this. A script that
  // simply does not send the header is not the same thing and is still asked for a key.
  expect(seat({ "sec-fetch-site": "none" })).toBe("ip:1.2.3.4");
  expect(seat({})).toBeInstanceOf(Response);
  // And a header that says cross-site is believed over a referer that disagrees with it.
  expect(seat({ "sec-fetch-site": "cross-site", referer: "https://tape.test/" })).toBeInstanceOf(Response);
});
