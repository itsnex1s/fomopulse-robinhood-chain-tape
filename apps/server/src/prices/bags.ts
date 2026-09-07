import type { Address } from "viem";
import { chainConfig } from "../config.ts";
import { namelessTokens, recordBagHistory, savePrice, tapeTokens, unnamedBags } from "../db.ts";
import { readTokens } from "../ingest/resolve.ts";
import { log } from "../log.ts";
import { BATCH, fetchQuotes } from "./dexscreener.ts";

/**
 * Names and quotes for the tokens the tracked traders hold, from the chain that minted them
 * and the price feed — the same two sources the tape itself reads.
 */

/** A quote for the stalest held tokens: the feed takes thirty addresses a call and the
 *  wallets are long several hundred, so a pass covers a slice, oldest first. */
export async function quoteBags(): Promise<void> {
  const held = tapeTokens();
  if (held.length === 0) return;
  const tokens = held
    .sort((a, b) => (a.quoted_at ?? 0) - (b.quoted_at ?? 0))
    .slice(0, BATCH)
    .map((row) => row.token);
  const at = Math.floor(Date.now() / 1000);
  for (const [address, quote] of await fetchQuotes(tokens)) savePrice(address, quote, at);
  // The bags as they stand once the quotes are in; the screen diffs against the hour the
  // window opened in. Stamped on the hour, so running this every three minutes is one row.
  recordBagHistory(at, chainConfig.id);
}

/** A held token is named from the chain, the same source the tape reads. The same multicall
 *  repairs tokens that kept their decimals and lost a symbol to a rate-limited RPC. */
export async function nameBags(): Promise<void> {
  const wanted = [...new Set([...unnamedBags(200), ...namelessTokens(40)])].slice(0, 40) as Address[];
  if (wanted.length === 0) return;
  await readTokens(wanted).catch((error) => log.error("tokens", error));
}

/** Quotes move faster than anything else on the page: every three minutes, one request. */
export function startBagQuotes(minutes = 3): void {
  const tick = async () => {
    await quoteBags().catch((error) => log.error("bag quotes", error));
    setTimeout(tick, minutes * 60_000);
  };
  void tick();
}
