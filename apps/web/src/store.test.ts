import { beforeEach, expect, test } from "bun:test";
import { useTape } from "./store.ts";

const fill = (id: number, tx: string, usd: number | null, extra: Record<string, unknown> = {}) =>
  ({
    id,
    tx,
    usd,
    ts: 1_000 + id,
    priced: usd === null ? "unpriced" : "estimate",
    is_stock: 1,
    is_dust: 0,
    ...extra,
  }) as never;

beforeEach(() => {
  useTape.getState().reset([]);
  useTape.getState().setHold(false);
});

test("a fill that arrives while the reader is scrolled away waits behind the button", () => {
  useTape.getState().setHold(true);
  useTape.getState().push([fill(1, "0xa", null)]);

  expect(useTape.getState().ids).toEqual([]);
  expect(useTape.getState().pending).toHaveLength(1);
});

test("a repriced row updates in place while held, and is not counted as new", () => {
  useTape.getState().reset([fill(1, "0xa", null)]);
  useTape.getState().setHold(true);
  useTape.getState().push([fill(1, "0xa", 12.5)]);

  expect(useTape.getState().byId["0xa:1"]?.usd).toBe(12.5);
  expect(useTape.getState().pending).toEqual([]);
});

test("a queued fill repriced before it lands is replaced where it stands, not queued twice", () => {
  useTape.getState().setHold(true);
  useTape.getState().push([fill(1, "0xa", null), fill(2, "0xb", null)]);
  useTape.getState().push([fill(1, "0xa", 7)]);

  expect(useTape.getState().pending.map((f) => f.id)).toEqual([1, 2]);
  useTape.getState().flush();
  expect(useTape.getState().byId["0xa:1"]?.usd).toBe(7);
});

test("a fill the reader has hidden still says the tape is not quiet", () => {
  useTape.getState().push([fill(9, "0xc", 1, { is_dust: 1 })]);

  expect(useTape.getState().ids).toEqual([]);
  expect(useTape.getState().lastTs).toBe(1_009);
});

test("an older page lands under the tape and survives the next fill off the socket", () => {
  const { reset, older, push } = useTape.getState();
  reset([fill(9, "0xnew", 1), fill(8, "0xmid", 1)]);
  older([fill(7, "0xold", 1), fill(6, "0xolder", 1)]);

  expect(useTape.getState().ids).toEqual(["0xnew:9", "0xmid:8", "0xold:7", "0xolder:6"]);
  // Not a tick: an older page is a page, not an arrival, and must not flash.
  expect(useTape.getState().byId["0xold:7"]?.tick).toBe(false);

  push([fill(10, "0xnext", 1)]);
  const { ids } = useTape.getState();
  expect(ids[0]).toBe("0xnext:10");
  expect(ids).toContain("0xolder:6");
});

test("a page already on the screen is not appended twice", () => {
  const { reset, older } = useTape.getState();
  reset([fill(9, "0xnew", 1)]);
  older([fill(9, "0xnew", 1), fill(8, "0xmid", 1)]);
  expect(useTape.getState().ids).toEqual(["0xnew:9", "0xmid:8"]);
});

test("a reprice of a fill that has aged off the screen does not come back at the top", () => {
  // The server reprices fills up to an hour old and broadcasts the whole transaction, so
  // one already dropped from the buffer arrives as a fill the store has never seen. Put at
  // the top it read as a fresh trade, flashing above rows twenty minutes newer.
  useTape.getState().reset([fill(50, "0xnew", 10), fill(40, "0xmid", 10)]);
  const before = useTape.getState().ids;

  useTape.getState().push([fill(1, "0xold", 25)]);

  expect(useTape.getState().ids[0]).toBe(before[0]); // the newest row is still the newest
  expect(useTape.getState().ids).toEqual([...before, "0xold:1"]); // it lands under them
  expect(useTape.getState().byId["0xold:1"]!.tick).toBe(false); // and does not blink

  // Once the tape is full, a row that belongs below the bottom is simply not carried.
  useTape.setState({ cap: 3 });
  useTape.getState().push([fill(0, "0xolder", 5)]);
  expect(useTape.getState().ids).not.toContain("0xolder:0");
});
