import { expect, test } from "bun:test";
import { chorded } from "./useHotkeys.ts";

const key = (over: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

test("a shortcut with a modifier held belongs to the browser", () => {
  // Cmd+D bookmarks, Cmd+T opens a tab, Cmd+1..5 switch tabs; all of them also toggled the
  // tape's own filters underneath the reader.
  expect(chorded(key({ metaKey: true }))).toBe(true);
  expect(chorded(key({ ctrlKey: true }))).toBe(true);
  expect(chorded(key({ altKey: true }))).toBe(true);
  // Shift is ours: `/` is a shifted key on a good few layouts.
  expect(chorded(key({ shiftKey: true }))).toBe(false);
  expect(chorded(key())).toBe(false);
});
