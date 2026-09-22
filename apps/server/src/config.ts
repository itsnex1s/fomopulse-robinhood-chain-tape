import { type Address, createPublicClient, defineChain, type Hex, http, pad } from "viem";
import arcJson from "../../../config/chains/arc.json" with { type: "json" };
import baseJson from "../../../config/chains/base.json" with { type: "json" };
import bscJson from "../../../config/chains/bsc.json" with { type: "json" };
import ethereumJson from "../../../config/chains/ethereum.json" with { type: "json" };
import robinhoodJson from "../../../config/chains/robinhood.json" with { type: "json" };
import fomoJson from "../../../config/fomo.json" with { type: "json" };
import walletsJson from "../../../config/wallets.json" with { type: "json" };

export interface QuoteToken {
  symbol: string;
  decimals: number;
  /** Fixed USD value for stablecoins. Absent means the price has to come from elsewhere. */
  usd?: number;
}

export interface Wallet {
  handle: string;
  address: Address;
  display_name?: string;
  followers?: number;
  profile_url?: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** What a file under config/chains has to say. `rpcFallbackHttp` and `explorer` may be the
 *  empty string; see validateChain for what empty means and what it costs. */
export interface ChainFile {
  id: number;
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcHttp: string;
  rpcWs: string;
  rpcFallbackHttp: string;
  /** The most calls `rpcHttp` takes in one JSON-RPC batch, when it states a cap; absent means the default. */
  rpcBatch?: number;
  explorer: string;
  multicall3: string;
  dexscreenerSlug: string;
  quoteTokens: Record<string, { symbol: string; decimals: number; usd?: number }>;
}

/** A config mistake should stop the process on the first line, not surface as an empty tape an hour later. */
export function invalid(message: string): never {
  throw new Error(`config: ${message}`);
}

export function validateChain(chain: ChainFile): void {
  if (!Number.isInteger(chain.id) || chain.id <= 0) invalid(`chain id ${chain.id} is not a positive integer`);
  if (!/^https?:\/\//.test(chain.rpcHttp)) invalid(`rpcHttp ${chain.rpcHttp} is not an http(s) URL`);
  if (!/^wss?:\/\//.test(chain.rpcWs)) invalid(`rpcWs ${chain.rpcWs} is not a ws(s) URL`);
  // Empty is allowed and means there is only one endpoint: a chain a week old has one
  // provider, and refusing to start is worse than reading wide logs off the same node.
  if (chain.rpcFallbackHttp !== "" && !/^https?:\/\//.test(chain.rpcFallbackHttp))
    invalid(`rpcFallbackHttp ${chain.rpcFallbackHttp} is not an http(s) URL`);
  // Same for the explorer: empty means there is no public one, and every link built from
  // it already resolves to undefined rather than to a path on this origin.
  if (chain.explorer !== "" && !/^https?:\/\//.test(chain.explorer))
    invalid(`explorer ${chain.explorer} is not an http(s) URL`);
  if (chain.rpcBatch !== undefined && (!Number.isInteger(chain.rpcBatch) || chain.rpcBatch < 1))
    invalid(`rpcBatch ${chain.rpcBatch} is not a positive integer`);
  if (!ADDRESS.test(chain.multicall3)) invalid(`multicall3 ${chain.multicall3} is not an address`);
  if (!chain.dexscreenerSlug) invalid("dexscreenerSlug is missing");
  for (const [address, token] of Object.entries(chain.quoteTokens)) {
    if (!ADDRESS.test(address)) invalid(`quote token ${address} is not an address`);
    if (!Number.isInteger(token.decimals)) invalid(`quote token ${token.symbol} has no integer decimals`);
  }
}

function validateWallets(list: Wallet[]): void {
  const addresses = new Set<string>();
  const handles = new Set<string>();
  for (const w of list) {
    if (!w.handle) invalid(`wallet ${w.address} has no handle`);
    if (!ADDRESS.test(w.address)) invalid(`wallet ${w.handle}: ${w.address} is not an address`);
    const address = w.address.toLowerCase();
    const handle = w.handle.toLowerCase();
    if (addresses.has(address)) invalid(`wallet ${w.handle}: ${address} is listed twice`);
    if (handles.has(handle)) invalid(`handle ${w.handle} is listed twice`);
    addresses.add(address);
    handles.add(handle);
  }
}

/** The service the trader numbers come from, and the two public Privy identifiers a renewal has to name. */
function validateFomo(fomo: typeof fomoJson): void {
  for (const [name, url] of [
    ["api", fomo.api],
    ["site", fomo.site],
    ["privy.sessions", fomo.privy.sessions],
  ] as const)
    if (!/^https:\/\//.test(url)) invalid(`fomo ${name} ${url} is not an https URL`);
  if (!fomo.userAgent) invalid("fomo userAgent is empty; the API refuses a request that does not say who it is");
  if (!fomo.privy.appId || !fomo.privy.clientId) invalid("fomo privy appId and clientId are both required");
}

/**
 * Every chain this tape knows how to follow, by the name of its file. One of them is the
 * chain a given process follows, named by CHAIN; the rest are here so a typo or a truncated
 * file fails the typecheck and the suite rather than the deploy that switches over.
 */
export const CHAINS = {
  robinhood: robinhoodJson,
  arc: arcJson,
  ethereum: ethereumJson,
  base: baseJson,
  bsc: bscJson,
} as const;
export type ChainName = keyof typeof CHAINS;

/** Which of them this process follows. Read once, at module scope, because the clients, the
 *  quote tokens and the stock registry are all built from it before anything is served. */
function chosen(): ChainName {
  const asked = (typeof process === "undefined" ? "" : (process.env.CHAIN ?? "")).trim();
  if (asked === "") return "robinhood";
  if (!(asked in CHAINS)) invalid(`CHAIN ${asked} is not one of ${Object.keys(CHAINS).join(", ")}`);
  return asked as ChainName;
}

const chainJson: ChainFile = CHAINS[chosen()];

for (const file of Object.values(CHAINS)) validateChain(file);
validateFomo(fomoJson);
validateWallets(walletsJson as Wallet[]);

export const chainConfig = chainJson;
export const fomoConfig = fomoJson;

export const chain = defineChain({
  id: chainJson.id,
  name: chainJson.name,
  nativeCurrency: chainJson.nativeCurrency,
  rpcUrls: { default: { http: [chainJson.rpcHttp] } },
  ...(chainJson.explorer === "" ? {} : { blockExplorers: { default: { name: "Explorer", url: chainJson.explorer } } }),
  contracts: { multicall3: { address: chainJson.multicall3 as Address } },
});

/** The endpoint wide `eth_getLogs` goes to. A chain with no second provider answers it from
 *  the only one it has, which is slower under a rate limit but is not a reason not to run. */
const wideUrl = chainJson.rpcFallbackHttp || chainJson.rpcHttp;

export const QUOTE_TOKENS = new Map<Address, QuoteToken>(
  Object.entries(chainJson.quoteTokens).map(([a, q]) => [a.toLowerCase() as Address, q as QuoteToken]),
);

export const wallets: Wallet[] = (walletsJson as Wallet[]).map((w) => ({
  ...w,
  address: w.address.toLowerCase() as Address,
}));

export const WALLET_SET = new Set<Address>(wallets.map((w) => w.address));
export const WALLET_LIST = wallets.map((w) => w.address);
/** The wallets as 32-byte topics, the form `eth_subscribe` takes. */
export const WALLET_TOPICS: Hex[] = WALLET_LIST.map((a) => pad(a, { size: 32 }));

export interface Secrets {
  RPC_HTTP_URL?: string;
  RPC_WS_URL?: string;
  FOMO_ACCESS_TOKEN?: string;
  FOMO_PRIVY_PAT?: string;
  FOMO_REFRESH_TOKEN?: string;
  FOMOPULSE_DB?: string;
}

/** A process reads its environment; a Worker is handed one. Both end up here. */
const ofProcess = (): Secrets => (typeof process === "undefined" ? {} : (process.env as Secrets));

/** `bun test` sets this. A Worker has no process at all, so it is never under test here. */
const underTest = typeof process !== "undefined" && process.env.NODE_ENV === "test";

interface Settings {
  wsUrl: string | undefined;
  httpUrl: string;
  /** The public endpoint answers a few requests in a row and then 429s; a provider key lifts the pacing. */
  publicRpc: boolean;
  fomoToken: string | undefined;
  /** The pair that renews `fomoToken`; without both it is a one-hour session and no more. */
  fomoPat: string | undefined;
  fomoRefresh: string | undefined;
  dbPath: string;
}

const settings = (from: Secrets): Settings => {
  const httpUrl = from.RPC_HTTP_URL?.trim() || chainJson.rpcHttp;
  return {
    // Live logs come free over PublicNode's socket; a provider key in RPC_WS_URL takes over.
    wsUrl: from.RPC_WS_URL?.trim() || chainJson.rpcWs,
    httpUrl,
    publicRpc: httpUrl === chainJson.rpcHttp,
    fomoToken: from.FOMO_ACCESS_TOKEN?.trim() || undefined,
    fomoPat: from.FOMO_PRIVY_PAT?.trim() || undefined,
    fomoRefresh: from.FOMO_REFRESH_TOKEN?.trim() || undefined,
    // Under `bun test` the default is memory, never the file beside the checkout. bunfig's
    // preload only applies when the run starts at the repo root, and a run started from a
    // package directory — or from an editor's run-this-test — otherwise opens the real
    // database and writes its fixtures into it. An explicit FOMOPULSE_DB still wins.
    dbPath: from.FOMOPULSE_DB?.trim() || (underTest ? ":memory:" : "fomopulse.db"),
  };
};

export let env = settings(ofProcess());

/** How many calls leave in one batch. Twenty unless the chain file says its endpoint takes fewer:
 *  a node that caps a batch answers a longer one with a single error and no `id`, which reads as
 *  every call in it failing, and a transaction with that many participants is never stored. */
const BATCH_SIZE = chainJson.rpcBatch ?? 20;

/** One client for every HTTP call: concurrent calls leave as one JSON-RPC batch, which is one request
 *  against the public endpoint's limiter instead of many. viem backs off exponentially from `retryDelay`,
 *  so the retry count is what bounds a refused call — four attempts is fifteen seconds, the Worker's budget. */
const clientFor = (
  url: string,
  batch: false | { batchSize: number; wait: number } = { batchSize: BATCH_SIZE, wait: 16 },
) =>
  createPublicClient({
    chain,
    transport: http(url, { batch, retryCount: 4, retryDelay: 1_000 }),
  });

export let rpc = clientFor(env.httpUrl);

/** The keyed endpoint for `eth_getLogs`, unbatched for the reason `wideRpc` is. A batched
 *  refusal costs more than the round trip it saves: the cap the provider states — ten
 *  blocks on Alchemy's free tier — is what lets the scan go on using the key at all. */
export let logRpc = clientFor(env.httpUrl, false);

/** The endpoint for wide-range `eth_getLogs`, which the keyed one refuses outright; used whether or not a key
 *  is configured, and the chain's own endpoint is not a substitute — it caps the log count as well as the rate.
 *  Unbatched: a limiter answers a whole batch with one object and no `id`, which viem reads by position. */
export let wideRpc = clientFor(wideUrl, false);

/** Takes the settings from somewhere other than the process; the exported bindings are live, so a module
 *  that imported `rpc` a moment ago sees the client this builds. */
export function configure(secrets: Secrets): void {
  env = settings(secrets);
  rpc = clientFor(env.httpUrl);
  logRpc = clientFor(env.httpUrl, false);
  wideRpc = clientFor(wideUrl, false);
}
