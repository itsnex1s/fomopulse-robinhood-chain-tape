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

test("Ethereum carries what was read off Ethereum", () => {
  const ethereum = CHAINS.ethereum;
  expect(ethereum.id).toBe(1);
  expect(ethereum.multicall3.toLowerCase()).toBe("0xca11bde05977b3631167028862be2a173976ca11");
  expect(ethereum.rpcWs.startsWith("wss://")).toBe(true);
  // The scan asks for logs by topic with no contract address, which the endpoint and the
  // fallback both have to take; a second one is what makes a wide sweep survive a refusal.
  expect(ethereum.rpcFallbackHttp).not.toBe("");
  expect(ethereum.rpcFallbackHttp).not.toBe(ethereum.rpcHttp);
  expect(ethereum.explorer).toBe("https://etherscan.io");
  // Three stablecoins at a dollar and one floating token, WETH, priced through the feed.
  const quotes = Object.entries<ChainFile["quoteTokens"][string]>(ethereum.quoteTokens);
  expect(quotes.map(([, q]) => q.symbol).sort()).toEqual(["DAI", "USDC", "USDT", "WETH"]);
  expect(quotes.filter(([, q]) => q.usd === undefined).map(([, q]) => q.symbol)).toEqual(["WETH"]);
  for (const [address] of quotes) expect(address).toBe(address.toLowerCase());
  expect(ethereum.quoteTokens["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"]).toEqual({ symbol: "WETH", decimals: 18 });
});

test("Base carries what was read off Base", () => {
  const base = CHAINS.base;
  expect(base.id).toBe(8453);
  expect(base.multicall3.toLowerCase()).toBe("0xca11bde05977b3631167028862be2a173976ca11");
  expect(base.rpcWs.startsWith("wss://")).toBe(true);
  expect(base.rpcFallbackHttp).not.toBe("");
  expect(base.rpcFallbackHttp).not.toBe(base.rpcHttp);
  expect(base.explorer).toBe("https://basescan.org");
  // What the chain's own endpoint states: "maximum 10 calls in 1 batch". Twenty, the default, is
  // answered with one error and no id, and a busy transaction's lookups never land.
  expect(base.rpcBatch).toBe(10);
  const quotes = Object.entries<ChainFile["quoteTokens"][string]>(base.quoteTokens);
  expect(quotes.map(([, q]) => q.symbol).sort()).toEqual(["DAI", "USDC", "USDbC", "WETH"]);
  expect(quotes.filter(([, q]) => q.usd === undefined).map(([, q]) => q.symbol)).toEqual(["WETH"]);
  for (const [address] of quotes) expect(address).toBe(address.toLowerCase());
  // The OP-stack predeploy: the same WETH address on every chain built on it.
  expect(base.quoteTokens["0x4200000000000000000000000000000000000006"]).toEqual({ symbol: "WETH", decimals: 18 });
});

test("BNB Chain carries what was read off BNB Chain", () => {
  const bsc = CHAINS.bsc;
  expect(bsc.id).toBe(56);
  expect(bsc.multicall3.toLowerCase()).toBe("0xca11bde05977b3631167028862be2a173976ca11");
  expect(bsc.rpcWs.startsWith("wss://")).toBe(true);
  expect(bsc.rpcFallbackHttp).not.toBe("");
  expect(bsc.rpcFallbackHttp).not.toBe(bsc.rpcHttp);
  expect(bsc.explorer).toBe("https://bscscan.com");
  const quotes = Object.entries<ChainFile["quoteTokens"][string]>(bsc.quoteTokens);
  expect(quotes.map(([, q]) => q.symbol).sort()).toEqual(["BUSD", "USDC", "USDT", "WBNB"]);
  expect(quotes.filter(([, q]) => q.usd === undefined).map(([, q]) => q.symbol)).toEqual(["WBNB"]);
  for (const [address] of quotes) expect(address).toBe(address.toLowerCase());
  // The stablecoins on this chain answer 18 to decimals, not the 6 their namesakes do elsewhere;
  // a fill sized with 6 here would be a trillion times too large.
  for (const [, q] of quotes) expect(q.decimals).toBe(18);
});

test("a chain with one provider and no explorer is a chain, not a config mistake", () => {
  expect(() => validateChain({ ...sound, rpcFallbackHttp: "", explorer: "" })).not.toThrow();
  // Present but nonsense is still refused: empty says there is none, a typo says nothing.
  expect(() => validateChain({ ...sound, rpcFallbackHttp: "rpc.example" })).toThrow(/rpcFallbackHttp/);
  expect(() => validateChain({ ...sound, explorer: "explorer.example" })).toThrow(/explorer/);
});

test("a batch cap is a positive integer or absent", () => {
  expect(() => validateChain({ ...sound, rpcBatch: 10 })).not.toThrow();
  expect(() => validateChain({ ...sound, rpcBatch: 0 })).toThrow(/rpcBatch/);
  expect(() => validateChain({ ...sound, rpcBatch: 2.5 })).toThrow(/rpcBatch/);
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
