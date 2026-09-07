import { expect, test } from "bun:test";
import { blockUrl, tokenExplorerUrl, txUrl } from "./api.ts";

const tx = "0xabc";

test("an explorer link is absent until the explorer is known", () => {
  // /api/status carries the explorer's address, and the tape renders before that resolves.
  // Built on an empty string these were `/tx/0xabc`, a path on the app's own origin, so the
  // link took the reader back to the page they were already on.
  expect(txUrl("", tx)).toBeUndefined();
  expect(tokenExplorerUrl("", "0xdef")).toBeUndefined();
  expect(blockUrl("", 12)).toBeUndefined();
});

test("with an explorer it is the explorer's own path", () => {
  expect(txUrl("https://scan.example", tx)).toBe("https://scan.example/tx/0xabc");
  expect(tokenExplorerUrl("https://scan.example", "0xdef")).toBe("https://scan.example/token/0xdef");
  expect(blockUrl("https://scan.example", 12)).toBe("https://scan.example/block/12");
});
