import { expect, test } from "bun:test";
import registry from "../../../config/stock-tokens.json" with { type: "json" };
import { isStock, validateStocks } from "../src/stocks.ts";

test("a registry that has been truncated or reshaped is named, not thrown past", () => {
  // It is read at module scope, so an unchecked file took the whole tape down with
  // "Cannot read properties of undefined (reading 'flatMap')" and nothing to go on.
  expect(() => validateStocks({})).toThrow(/stock-tokens\.json has no assets array/);
  expect(() => validateStocks({ assets: "half a file" })).toThrow(/no assets array/);
  expect(() => validateStocks({ assets: [{ tokenSymbol: "COST" }] })).toThrow(/tokenSymbol and tokenName/);
  expect(() => validateStocks({ assets: [{ tokenSymbol: "COST", tokenName: "Costco" }] })).toThrow(
    /COST has no deployments array/,
  );
  expect(() =>
    validateStocks({ assets: [{ tokenSymbol: "COST", tokenName: "Costco", deployments: [{ chainId: 4663 }] }] }),
  ).toThrow(/COST has a deployment without an address/);
});

test("the registry the repo ships passes, and its tokens are known", () => {
  expect(() => validateStocks(registry)).not.toThrow();
  const first = (registry as { assets: { deployments: { contractAddress: string; chainId: number }[] }[] }).assets
    .flatMap((a) => a.deployments)
    .find((d) => d.chainId === 4663);
  if (first) expect(isStock(first.contractAddress)).toBe(true);
});
