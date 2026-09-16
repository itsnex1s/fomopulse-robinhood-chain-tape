/**
 * The chains this tape knows how to follow. Which one a process follows is a variable now
 * rather than an import, so what these hold is the two things that go wrong with that: a
 * file nobody registered, and a registered file nobody checked.
 *
 * Importing config.ts already validates every one of them — it does that at module scope.
 * These say which file failed and why, instead of a stack trace naming neither.
 */

import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { CHAINS, type ChainFile, chainConfig, validateChain } from "../src/config.ts";

const sound: ChainFile = {
  id: 1,
  name: "Test",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcHttp: "https://rpc.example",
  rpcWs: "wss://rpc.example",
  rpcFallbackHttp: "https://fallback.example",
  explorer: "https://explorer.example",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  dexscreenerSlug: "test",
  quoteTokens: { "0x5fc5360d0400a0fd4f2af552add042d716f1d168": { symbol: "USDG", decimals: 6, usd: 1 } },
};

test("every file under config/chains is one the registry knows", () => {
  const files = readdirSync(new URL("../../../config/chains/", import.meta.url))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length));
  // A file added and never registered is followed by nothing and noticed by nobody.
  expect(files.sort()).toEqual(Object.keys(CHAINS).sort());
});

test("a chain names itself the same way twice", () => {
  for (const [name, file] of Object.entries(CHAINS)) {
    expect({ name, slug: file.dexscreenerSlug }).toEqual({ name, slug: name });
    expect({ name, id: Number.isInteger(file.id) && file.id > 0 }).toEqual({ name, id: true });
  }
});

test("the chain followed by default is the one the tape is deployed against", () => {
  // Nothing sets CHAIN in the suite, so this is the fallback the deploy relies on.
  expect(chainConfig.id).toBe(4663);
});

test("Arc carries what was read off Arc", () => {
  const arc = CHAINS.arc;
  expect(arc.id).toBe(5042);
  expect(arc.multicall3.toLowerCase()).toBe("0xca11bde05977b3631167028862be2a173976ca11");
  expect(arc.rpcWs.startsWith("wss://")).toBe(true);
  // USDC is the gas token and the quote token both, and the ERC-20 answers 6 to decimals.
  const [address, quote] = Object.entries(arc.quoteTokens)[0]!;
  expect(address).toBe("0x3600000000000000000000000000000000000000");
  expect(quote).toEqual({ symbol: "USDC", decimals: 6, usd: 1 });
});

test("a chain with one provider and no explorer is a chain, not a config mistake", () => {
  expect(() => validateChain({ ...sound, rpcFallbackHttp: "", explorer: "" })).not.toThrow();
  // Present but nonsense is still refused: empty says there is none, a typo says nothing.
  expect(() => validateChain({ ...sound, rpcFallbackHttp: "rpc.example" })).toThrow(/rpcFallbackHttp/);
  expect(() => validateChain({ ...sound, explorer: "explorer.example" })).toThrow(/explorer/);
});

test("what a chain cannot be missing", () => {
  expect(() => validateChain({ ...sound, id: 0 })).toThrow(/chain id/);
  expect(() => validateChain({ ...sound, rpcHttp: "" })).toThrow(/rpcHttp/);
  expect(() => validateChain({ ...sound, rpcWs: "" })).toThrow(/rpcWs/);
  expect(() => validateChain({ ...sound, multicall3: "0xnope" })).toThrow(/multicall3/);
  expect(() => validateChain({ ...sound, dexscreenerSlug: "" })).toThrow(/dexscreenerSlug/);
  expect(() => validateChain({ ...sound, quoteTokens: { "0xnope": { symbol: "X", decimals: 6 } } })).toThrow(
    /quote token/,
  );
});
