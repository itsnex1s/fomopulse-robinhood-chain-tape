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
