import { expect, test } from "bun:test";
import { ago, compact, pct, price, short, signed, span, usd, usdCompact } from "./format.ts";

test("dollars keep cents, large ones go compact", () => {
  expect(usd(12.345)).toBe("$12.35");
  expect(usdCompact(62_000_000)).toBe("$62M");
  expect(price(0.00041234)).toBe("$0.0004123");
  expect(compact(1500)).toBe("1.5K");
});

test("a sign is information: profit and loss read differently", () => {
  expect(signed(1500)).toBe("+$1.5K");
  expect(signed(-1500)).toBe("−$1.5K");
  expect(pct(12.34)).toBe("+12.3%");
  expect(pct(-4)).toBe("−4.0%");
  expect(pct(250)).toBe("+250%");
});

test("ages read from seconds to months", () => {
  const now = Math.floor(Date.now() / 1000);
  expect(ago(now - 30)).toBe("30s");
  expect(ago(now - 300)).toBe("5m");
  expect(ago(now - 7200)).toBe("2h");
  expect(span(300)).toBe("5m");
  expect(span(90000)).toBe("25h");
  expect(span(10 * 86400)).toBe("10d");
  expect(span(400 * 86400)).toBe("13mo");
});

test("an address is ten characters and an ellipsis", () => {
  expect(short("0x4444444444444444444444444444444444444444")).toBe("0x44444444…");
});
