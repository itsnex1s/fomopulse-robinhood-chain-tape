import type { Address } from "viem";
import { chainConfig } from "../config.ts";
import { heldTokens, namelessTokens, saveBagQuote, saveBagToken, savePrice, tapeTokens, unnamedBags } from "../db.ts";
import { readTokens } from "../ingest/resolve.ts";
import { log } from "../log.ts";
import { BATCH, fetchNames, fetchQuotes, SLUGS } from "./dexscreener.ts";

/**
 * Names and quotes for the tokens the tracked traders hold. fomo publishes a position
 * as an address and a value; what the token is called and what it is worth now come
 * from the chain and from the price feed, and two thirds of the bags sit on chains this
 * tape does not follow, where the feed is the only source there is.
 */

/**
 * A live quote for every held token, whichever chain it sits on. fomo's price is a
 * snapshot from the leaderboard read; the feed's is minutes old at most and comes with
 * liquidity, the day's change and the pool's age, which is what tells a bag that is
 * still tradable from one that is a number on a card. On the tracked chain the quote
 * joins the same prices table the tape uses; elsewhere it sits beside the bag's name.
 * One request per chain, the stalest quotes first: the feed takes thirty addresses a
 * call and the tracked chain alone holds two hundred bags, so the same thirty largest
 * every pass left the rest on fomo's snapshot for good.
 */
export async function quoteBags(): Promise<void> {
  const byNetwork = new Map<number, Map<string, number>>();
  const take = (network: number, token: string, quotedAt: number | null) => {
    if (!SLUGS[network]) return;
    const list = byNetwork.get(network) ?? new Map<string, number>();
    list.set(token, Math.min(list.get(token) ?? Infinity, quotedAt ?? 0));
    byNetwork.set(network, list);
  };
  for (const bag of heldTokens(chainConfig.id)) take(bag.network, bag.token, bag.quoted_at);
  // Without a session there are no holdings; what the tape sees held still wants a mark.
  for (const row of tapeTokens()) take(chainConfig.id, row.token, row.quoted_at);
  const at = Math.floor(Date.now() / 1000);
  for (const [network, list] of byNetwork) {
    const tokens = [...list]
      .sort(([, a], [, b]) => a - b)
      .slice(0, BATCH)
      .map(([token]) => token);
    const quotes = await fetchQuotes(tokens, SLUGS[network]);
    for (const [address, quote] of quotes) {
      if (network === chainConfig.id) savePrice(address, quote, at);
      else saveBagQuote(address, network, quote, at);
    }
  }
}

/**
 * A bag on a chain this tape does not follow has no contract to ask, so it is named
 * from the price feed, which covers every chain fomo reports a bag on: one call per
 * chain, and only while a name is still missing.
 */
async function nameForeignBags(): Promise<void> {
  const missing = unnamedBags(chainConfig.id, 200).filter((bag) => bag.network !== chainConfig.id);
  const byNetwork = new Map<number, string[]>();
  for (const bag of missing) {
    const slug = SLUGS[bag.network];
    if (slug) byNetwork.set(bag.network, [...(byNetwork.get(bag.network) ?? []), bag.token]);
  }
  const at = Math.floor(Date.now() / 1000);
  for (const [network, tokens] of byNetwork) {
    const names = await fetchNames(SLUGS[network]!, tokens.slice(0, BATCH));
    for (const [address, { symbol, name }] of names) saveBagToken(address, network, symbol, name, at);
  }
}

/**
 * A bag on the tracked chain is named from the chain itself, which is the same source
 * the tape reads and so always agrees with it. The same pass repairs the tape's own
 * tokens: one first seen while the RPC was rate-limiting kept its decimals and lost its
 * symbol or its name, and the original's tape carries both. One multicall for all of
 * them, the way the ingester reads a token it has not seen — three calls per token went
 * out one by one before, a hundred and twenty requests for forty names.
 */
async function nameHeldTokens(): Promise<void> {
  const held = unnamedBags(chainConfig.id, 200)
    .filter((bag) => bag.network === chainConfig.id)
    .map((bag) => bag.token);
  await readTokens([...new Set([...held, ...namelessTokens(40)])].slice(0, 40) as Address[]);
}

/** Both naming passes, each failing on its own: the chain and the feed are different outages. */
export async function nameBags(): Promise<void> {
  await nameHeldTokens().catch((error) => log.error("tokens", error));
  await nameForeignBags().catch((error) => log.error("bags", error));
}

/** Quotes move faster than the leaderboard: every three minutes, a request per chain. */
export function startBagQuotes(minutes = 3): void {
  const tick = async () => {
    await quoteBags().catch((error) => log.error("bag quotes", error));
    setTimeout(tick, minutes * 60_000);
  };
  void tick();
}
