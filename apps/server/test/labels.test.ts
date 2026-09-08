/**
 * What a token is allowed to call itself. The symbol and the name come off the contract and
 * are whatever it returns: one on this chain returns nine thousand characters, and rendered
 * whole it decides the width of every column beside it.
 */
import { expect, test } from "bun:test";
import "./support/memory.ts";
import { db, saveToken, trimLabels } from "../src/db.ts";

const labelOf = (address: string) =>
  db
    .query<{ symbol: string | null; name: string | null }, [string]>(
      "SELECT symbol, name FROM tokens WHERE address = ?",
    )
    .get(address)!;

test("a symbol longer than a ticker is cut where it is stored", () => {
  const address = `0x${"ab".repeat(20)}`;
  saveToken(address, 18, "BTC".repeat(3_000), "Everything".repeat(100));
  const row = labelOf(address);
  expect(row.symbol).toHaveLength(24);
  expect(row.name).toHaveLength(48);
  expect(row.symbol).toBe("BTCBTCBTCBTCBTCBTCBTCBTC");
});

test("an ordinary ticker and name are left exactly as they came", () => {
  const address = `0x${"ac".repeat(20)}`;
  saveToken(address, 18, "SILVERBACK", "Silverback Gorilla");
  expect(labelOf(address)).toEqual({ symbol: "SILVERBACK", name: "Silverback Gorilla" });
});

test("a row stored before the cut is cut too, and the pass is a no-op after that", () => {
  const address = `0x${"ad".repeat(20)}`;
  db.query<unknown, [string, string, string]>(
    "INSERT INTO tokens (address, decimals, symbol, name) VALUES (?, 18, ?, ?)",
  ).run(address, "X".repeat(9_575), "Y".repeat(400));
  trimLabels();
  expect(labelOf(address)).toEqual({ symbol: "X".repeat(24), name: "Y".repeat(48) });
  trimLabels();
  expect(labelOf(address)).toEqual({ symbol: "X".repeat(24), name: "Y".repeat(48) });
});
