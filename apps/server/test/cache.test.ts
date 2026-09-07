/** The canonical query the edge files an answer under. Every value a reader can vary that this
 *  does not fold down is a cache miss they can ask for as often as they like. */
import { expect, test } from "bun:test";
import { canonical } from "../../worker/src/cache.ts";

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
