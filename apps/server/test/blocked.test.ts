/**
 * The addresses the site does not answer. This is the one door with no appeal behind it, so
 * what is tested is both halves: that the listed address is stopped, and that nobody else is.
 * A blocklist that quietly matches more than it was given is worse than none.
 */
import { expect, test } from "bun:test";
import { barred, barredResponse } from "../../worker/src/cache.ts";
import { limits, validateLimits } from "../src/limits.ts";

const from = (ip: string | null): Request =>
  new Request("https://fomopulse.app/", { headers: ip === null ? {} : { "cf-connecting-ip": ip } });

const sound = JSON.parse(JSON.stringify(limits)) as typeof limits;

test("the address the list names is the one that is stopped", () => {
  // The list itself is config; what this holds is that whatever is in it is applied.
  for (const entry of limits.cache.blocked) {
    const address = entry.split("/")[0]!;
    expect({ entry, barred: barred(from(address)) }).toEqual({ entry, barred: true });
  }
});

test("an address the list does not name is answered", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "45.113.64.205", "45.113.65.204", "145.113.64.204"])
    expect({ ip, barred: barred(from(ip)) }).toEqual({ ip, barred: false });
});

test("a request with no address at all is answered rather than guessed at", () => {
  // Every request through the edge carries cf-connecting-ip; one that does not is a test or
  // a health check, and refusing those would be a blocklist nobody put anything on.
  expect(barred(from(null))).toBe(false);
});

test("what it answers with says nothing about why", () => {
  const res = barredResponse();
  expect(res.status).toBe(403);
  expect(res.headers.get("content-type")).toContain("json");
});

test("an entry that is not an address is refused rather than silently matching nothing", () => {
  for (const bad of ["not-an-address", "45.113.64", "45.113.64.204/nope", ""]) {
    const given = { ...sound, cache: { ...sound.cache, blocked: [bad] } };
    expect({
      bad,
      threw: (() => {
        try {
          validateLimits(given as never);
          return false;
        } catch {
          return true;
        }
      })(),
    }).toEqual({ bad, threw: true });
  }
});

test("a range is allowed, and an address is a range of one", () => {
  for (const good of ["45.113.64.0/24", "10.0.0.0/8", "203.0.113.7", "2a01:cb1e::1"])
    expect(() => validateLimits({ ...sound, cache: { ...sound.cache, blocked: [good] } } as never)).not.toThrow();
});
