import type { Address } from "viem";
import registry from "../../../config/stock-tokens.json" with { type: "json" };
import { chainConfig } from "./config.ts";

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

/**
 * Robinhood's own registry of tokenised stocks (`GET https://api.robinhood.com/rhj/assets`),
 * shipped as a file because the list changes on corporate-action timescales and the tape
 * needs the flag on every row. Refresh it by saving that response over the file.
 */
const STOCKS = new Map<Address, Stock>(
  (registry as unknown as { assets: Asset[] }).assets.flatMap((asset) =>
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
