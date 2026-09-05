import { type Address, erc20Abi } from "viem";
import { rpc, WALLET_SET } from "../config.ts";
import { loadDecimals, loadKinds, saveKind, saveToken } from "../db.ts";
import type { Kind } from "./parse.ts";

/**
 * What the chain says about the addresses and tokens a receipt names: the code kind
 * of every participant, the decimals (and names, for the screen) of every traded
 * token, and the timestamp of every block. Read once, kept in memory and in the
 * database, so a restart re-learns nothing it already knew.
 */
export const decimals = loadDecimals();
export const kinds = loadKinds();
// A tracked wallet is a trader by definition; no need to ask the chain.
for (const wallet of WALLET_SET) kinds.set(wallet, "eoa");

const blockTs = new Map<number, number>();

/** Code kind of every participant not seen before; a delegated EOA (EIP-7702) reads as `0xef0100…`. */
export async function resolveKinds(addresses: Address[]): Promise<void> {
  const missing = addresses.filter((a) => !kinds.has(a));
  if (missing.length === 0) return;
  const codes = await Promise.all(missing.map((address) => rpc.getCode({ address })));
  missing.forEach((address, i) => {
    const code = codes[i];
    const kind: Kind = !code || code === "0x" || code.toLowerCase().startsWith("0xef0100") ? "eoa" : "contract";
    kinds.set(address, kind);
    saveKind(address, kind);
  });
}

/** Decimals are needed to size a fill, symbol and name only to render it; all three come from one multicall. */
export async function resolveTokens(tokens: Address[]): Promise<void> {
  await readTokens(tokens.filter((t) => !decimals.has(t)));
}

/** Decimals, symbol and name of every token given, in one multicall, kept in memory and stored. */
export async function readTokens(tokens: Address[]): Promise<void> {
  if (tokens.length === 0) return;
  const functions = ["decimals", "symbol", "name"] as const;
  const results = await rpc.multicall({
    allowFailure: true,
    contracts: tokens.flatMap((address) => functions.map((functionName) => ({ address, abi: erc20Abi, functionName }))),
  });
  tokens.forEach((address, i) => {
    const [d, symbol, name] = results.slice(i * 3, i * 3 + 3);
    // A call that failed leaves what was known; a token first seen now defaults to 18.
    const dec = d?.status === "success" ? Number(d.result) : (decimals.get(address) ?? 18);
    decimals.set(address, dec);
    saveToken(
      address,
      dec,
      symbol?.status === "success" ? String(symbol.result) : undefined,
      name?.status === "success" ? String(name.result) : undefined,
    );
  });
}

export async function timestampOf(block: bigint): Promise<number> {
  const key = Number(block);
  const known = blockTs.get(key);
  if (known !== undefined) return known;
  const { timestamp } = await rpc.getBlock({ blockNumber: block, includeTransactions: false });
  const ts = Number(timestamp);
  // Blocks are 0.1 s apart, so the map would grow fast; only the recent ones are ever asked for again.
  if (blockTs.size > 5_000) blockTs.clear();
  blockTs.set(key, ts);
  return ts;
}
