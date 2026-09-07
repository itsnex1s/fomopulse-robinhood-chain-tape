import { expect, test } from "bun:test";
import { DEFAULT_WINDOW, type Place, placeUrl, pushes, readPlace, titleOf, VIEWS, viewOf } from "./url.ts";

test("every screen has an address, and every address a screen", () => {
  for (const view of VIEWS) expect(viewOf(placeUrl({ view, window: DEFAULT_WINDOW, filter: "" }))).toBe(view);
  expect(viewOf("/bags/")).toBe("bags");
  expect(viewOf("/nowhere")).toBeUndefined();
  expect(viewOf("/api/tape")).toBeUndefined();
});

test("an address carries what was chosen and stays quiet about the rest", () => {
  expect(placeUrl({ view: "tape", window: DEFAULT_WINDOW, filter: "" })).toBe("/");
  expect(placeUrl({ view: "discover", window: DEFAULT_WINDOW, filter: "" })).toBe("/discover");
  expect(placeUrl({ view: "traders", window: "7d", filter: "" })).toBe("/traders?window=7d");
  expect(placeUrl({ view: "bags", window: "all", filter: "MARS" })).toBe("/bags?window=all&q=MARS");
  // Whitespace is not a filter, and typing one is not a place worth linking to.
  expect(placeUrl({ view: "tape", window: DEFAULT_WINDOW, filter: "   " })).toBe("/");
});

test("what the address does not say is what the reader last picked, then the default", () => {
  expect(readPlace("/traders?window=7d&q=alice")).toEqual({ view: "traders", window: "7d", filter: "alice" });
  // A bare screen keeps the window the reader was already counting in.
  expect(readPlace("/bags", { window: "30d", filter: "MARS" })).toEqual({
    view: "bags",
    window: "30d",
    filter: "MARS",
  });
  expect(readPlace("/")).toEqual({ view: "tape", window: DEFAULT_WINDOW, filter: "" });
  // A window nothing serves is not one, and neither is a path no screen answers to.
  expect(readPlace("/traders?window=99y")?.window).toBe(DEFAULT_WINDOW);
  expect(readPlace("/nowhere")).toBeUndefined();
});

test("a place round-trips through its own address", () => {
  const place = { view: "discover", window: "7d", filter: "NEWCO" } as const;
  expect(readPlace(placeUrl(place))).toEqual(place);
});

test("the tab says which screen it is on, and what it is filtered to", () => {
  expect(titleOf({ view: "discover", window: "24h", filter: "" })).toBe("fomopulse — new tokens");
  expect(titleOf({ view: "tape", window: "24h", filter: "MARS" })).toBe("fomopulse — the live tape · MARS");
});

test("a screen and a window are somewhere to go back to; a filter is being typed", () => {
  const at = (over: Partial<Place>): Place => ({ view: "tape", window: "24h", filter: "", ...over });
  expect(pushes(at({}), at({ view: "bags" }))).toBe(true);
  expect(pushes(at({}), at({ window: "7d" }))).toBe(true);
  expect(pushes(at({}), at({ filter: "MAR" }))).toBe(false);
  expect(pushes(at({ filter: "MAR" }), at({ filter: "MARS" }))).toBe(false);
});
