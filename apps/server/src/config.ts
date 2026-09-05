import { type Address, createPublicClient, defineChain, type Hex, http, pad } from "viem";
import chainJson from "../../../config/chains/robinhood.json" with { type: "json" };
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

/** A config mistake should stop the process on the first line, not surface as an empty tape an hour later. */
function invalid(message: string): never {
  throw new Error(`config: ${message}`);
}

function validateChain(chain: typeof chainJson): void {
  if (!Number.isInteger(chain.id) || chain.id <= 0) invalid(`chain id ${chain.id} is not a positive integer`);
  if (!/^https?:\/\//.test(chain.rpcHttp)) invalid(`rpcHttp ${chain.rpcHttp} is not an http(s) URL`);
  if (!/^wss?:\/\//.test(chain.rpcWs)) invalid(`rpcWs ${chain.rpcWs} is not a ws(s) URL`);
  if (!/^https?:\/\//.test(chain.rpcFallbackHttp))
    invalid(`rpcFallbackHttp ${chain.rpcFallbackHttp} is not an http(s) URL`);
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

/**
 * The service the trader numbers come from, and the two public identifiers of its Privy
 * app that a renewal has to name. They are read from a file rather than written into the
 * code for the reason the chain is: the tape is one service's tape by configuration, not
 * by construction, and pointing it at another should not be a patch to a source file.
 */
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

validateChain(chainJson);
validateFomo(fomoJson);
validateWallets(walletsJson as Wallet[]);

export const chainConfig = chainJson;
export const fomoConfig = fomoJson;

export const chain = defineChain({
  id: chainJson.id,
  name: chainJson.name,
  nativeCurrency: chainJson.nativeCurrency,
  rpcUrls: { default: { http: [chainJson.rpcHttp] } },
  blockExplorers: { default: { name: "Blockscout", url: chainJson.explorer } },
  contracts: { multicall3: { address: chainJson.multicall3 as Address } },
});

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
    dbPath: from.FOMOPULSE_DB?.trim() || "fomopulse.db",
  };
};

export let env = settings(ofProcess());

/**
 * One client for every HTTP call. Calls made concurrently — the two log filters of a
 * chunk, the receipts of a batch, the code of a transaction's participants — leave as
 * one JSON-RPC batch: fewer round trips on a provider, and one request instead of
 * many against the public endpoint's limiter. The retry is for that limiter too, but
 * bounded: viem backs off exponentially from `retryDelay`, so the ten attempts this
 * used to make were seventeen minutes on a single call. Measured on 2026-09-05, that
 * is what a catch-up against a refusing endpoint did — the Worker's pass sat in it
 * until the platform killed the whole invocation at fifteen minutes
 * (`exceededWallTime`), and the leaderboard behind it never ran. Four attempts spend
 * fifteen seconds of backoff, which is what a rate limiter needs and no more.
 */
const clientFor = (url: string, batch: false | { batchSize: number; wait: number } = { batchSize: 20, wait: 16 }) =>
  createPublicClient({
    chain,
    transport: http(url, { batch, retryCount: 4, retryDelay: 1_000 }),
  });

export let rpc = clientFor(env.httpUrl);

/** The keyed endpoint for `eth_getLogs`, unbatched for the reason `wideRpc` is. A batched
 *  refusal costs more than the round trip it saves: the cap the provider states — ten
 *  blocks on Alchemy's free tier — is what lets the scan go on using the key at all. */
export let logRpc = clientFor(env.httpUrl, false);

/**
 * The second endpoint for the one call the first may refuse outright: `eth_getLogs`
 * over a wide range (Alchemy's free tier allows ten blocks, which turns a catch-up
 * into hundreds of requests). OrdoFi whether or not a key is configured — the key
 * changes nothing about what this endpoint is for, and the chain's own endpoint is
 * the wrong one to fall back to. Measured 2026-09-05, eight 2 000-block chunks back
 * to back with no pacing at all:
 *
 *     OrdoFi       350-1 400 ms each, all eight served, and 46 824 logs on one
 *                  unfiltered 2 000-block scan
 *     the chain's  ~300 ms each until the seventh, then 429, and 429 on the same
 *                  unfiltered scan — it caps the log count as well as the rate
 *
 * Its calls go one per request, alone among ours. A refusing endpoint answers a
 * refused batch with a single object and no `id` — measured 2026-09-05:
 *
 *     [{"jsonrpc":"2.0","id":1,"error":{…}}, …]      a normal refusal, one entry per call
 *     {"jsonrpc":"2.0","error":{"code":429,…}}       the rate limiter, for the whole batch
 *
 * viem reads a batch's answer by position, so the second shape leaves it dereferencing
 * `undefined` and the rate limit surfaces as "Cannot read properties of undefined
 * (reading 'error')" — an error nothing can retry on, which took the catch-up with it
 * every time the limiter spoke. Unbatched, a 429 comes back as the rate limit it is and
 * the backoff above answers it. The cost is two requests a chunk instead of one, which
 * is what the pacing between chunks is there for.
 */
export let wideRpc = clientFor(chainJson.rpcFallbackHttp, false);

/**
 * Take the settings from somewhere other than the process. Exported bindings are live,
 * so a module that imported `rpc` a moment ago sees the client this builds.
 */
export function configure(secrets: Secrets): void {
  env = settings(secrets);
  rpc = clientFor(env.httpUrl);
  logRpc = clientFor(env.httpUrl, false);
  wideRpc = clientFor(chainJson.rpcFallbackHttp, false);
}
