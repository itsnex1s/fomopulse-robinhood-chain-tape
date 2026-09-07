import type { Address } from "viem";
import registry from "../../../config/stock-tokens.json" with { type: "json" };
import { chainConfig, invalid } from "./config.ts";

interface Asset {
  tokenSymbol: string;
  tokenName: string;
  logoUrl?: string;
  deployments: { contractAddress: string; chainId: number }[];
}

export interface Stock {
  symbol: string;
  /** The company, without the registry's "• Robinhood Token" suffix. */
  name: string;
  logo: string | null;
}

/** "Costco • Robinhood Token" is the token; "Costco" is what a reader wants next to COST. */
const plainName = (name: string) => name.replace(/\s*[•·–-]\s*Robinhood Token\s*$/i, "").trim();

/** Robinhood's own registry of tokenised stocks (`GET https://api.robinhood.com/rhj/assets`), shipped as a
 *  file because the list changes on corporate-action timescales. Refresh it by saving that response over it. */
/** Checked like the other config files: this is read at module scope, so a file that has been
 *  truncated or reshaped takes the whole tape down with an error naming neither. An empty
 *  registry is not a safe fallback either — without it every tokenised stock reads as a
 *  handout and drops off the tape, which is worse than refusing to start. */
export function validateStocks(file: unknown): asserts file is { assets: Asset[] } {
  const assets = (file as { assets?: unknown })?.assets;
  if (!Array.isArray(assets)) invalid("stock-tokens.json has no assets array");
  for (const asset of assets as Asset[]) {
    if (typeof asset?.tokenSymbol !== "string" || typeof asset?.tokenName !== "string")
      invalid(`stock-tokens.json: an asset has no tokenSymbol and tokenName (${JSON.stringify(asset).slice(0, 80)})`);
    if (!Array.isArray(asset.deployments)) invalid(`stock-tokens.json: ${asset.tokenSymbol} has no deployments array`);
    for (const d of asset.deployments)
      if (typeof d?.contractAddress !== "string" || !Number.isInteger(d?.chainId))
        invalid(`stock-tokens.json: ${asset.tokenSymbol} has a deployment without an address and a chain id`);
  }
}

validateStocks(registry);

const STOCKS = new Map<Address, Stock>(
  registry.assets.flatMap((asset) =>
    asset.deployments
      .filter((d) => d.chainId === chainConfig.id)
      .map(
        (d) =>
          [
            d.contractAddress.toLowerCase() as Address,
            { symbol: asset.tokenSymbol, name: plainName(asset.tokenName), logo: asset.logoUrl ?? null },
          ] as const,
      ),
  ),
);

export const stockOf = (token: string): Stock | undefined => STOCKS.get(token.toLowerCase() as Address);
export const isStock = (token: string): boolean => STOCKS.has(token.toLowerCase() as Address);
