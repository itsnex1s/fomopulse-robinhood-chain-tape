import fomoConfig from "../../../config/fomo.json" with { type: "json" };
import type { Bag, Fill, Overview, Status, Trader, Window } from "./types.ts";

/** The service the trader numbers come from, named once for the whole app in config/fomo.json. */
const FOMO = fomoConfig.site;

const json = async <T>(url: string): Promise<T> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → ${response.status}`);
  return response.json() as Promise<T>;
};

export const getStatus = (window: Window) => json<Status>(`/api/status?window=${window}`);

/** A page of the tape; `before` continues from the oldest row the screen already holds. */
export const getTape = (window: Window, stocks: boolean, dust: boolean, before?: { ts: number; id: number }) =>
  json<Fill[]>(
    `/api/tape?limit=400&window=${window}&stocks=${stocks}&dust=${dust}` +
      (before ? `&before=${before.ts}&beforeId=${before.id}` : ""),
  );

export const getTraders = (window: Window) => json<Trader[]>(`/api/traders?window=${window}&limit=300`);

export const getOverview = (window: Window) => json<Overview>(`/api/overview?window=${window}`);

/** Sorting happens on the client, so it asks for the whole list rather than the top of one ordering. */
export const getBags = (window: Window) => json<Bag[]>(`/api/bags?window=${window}&limit=200`);

/** The chain this tape follows; the server configures the same id. */
export const TRACKED_CHAIN = 4663;

/** DexScreener names the chains fomo reports holdings on. */
const SLUGS: Record<number, string> = {
  4663: "robinhood",
  56: "bsc",
  1399811149: "solana",
  1: "ethereum",
  8453: "base",
};
/** fomo's own slugs differ in one place: BNB Chain is `bnb` there. */
const FOMO_SLUGS: Record<number, string> = { ...SLUGS, 56: "bnb" };
export const chainName = (id: number) =>
  ({ 4663: "", 56: "BSC", 1399811149: "SOL", 1: "ETH", 8453: "BASE" })[id] ?? `#${id}`;
/**
 * What to call a chain where it has to be named outright. `chainName` is for the tag on a
 * row, and leaves the tape's own chain blank there — a filter that offers "this chain"
 * says nothing about which chain that is, and a bag list holds five of them.
 */
export const chainLabel = (id: number) => SLUGS[id] ?? `chain #${id}`;
/** The pool the quote came from when there is one, else the token's page. */
export const bagUrl = (bag: { network: number; token: string; pair_address?: string | null }) =>
  SLUGS[bag.network] ? `https://dexscreener.com/${SLUGS[bag.network]}/${bag.pair_address ?? bag.token}` : undefined;
export const fomoTokenUrl = (bag: { network: number; token: string }) =>
  FOMO_SLUGS[bag.network] ? `${FOMO}/tokens/${FOMO_SLUGS[bag.network]}/${bag.token}` : undefined;

export const txUrl = (explorer: string, tx: string) => `${explorer}/tx/${tx}`;
export const tokenExplorerUrl = (explorer: string, token: string) => `${explorer}/token/${token}`;
export const blockUrl = (explorer: string, block: number) => `${explorer}/block/${block}`;
export const tokenUrl = (slug: string, token: string) => `https://dexscreener.com/${slug}/${token}`;
export const traderUrl = (fill: { handle: string; profile_url?: string | null }) =>
  fill.profile_url ?? `${FOMO}/profile/${fill.handle}`;
