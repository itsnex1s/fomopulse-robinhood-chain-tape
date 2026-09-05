/**
 * Build config/wallets.json from fomo's own leaderboard.
 *
 * fomo publishes an `evmAddress` for every trader, but that is the Privy embedded
 * wallet, not the address that trades: on Robinhood Chain the tokens land on a
 * separate EIP-7702 delegated address that the API never names. What the API does
 * give is the swap — token, amount and time — and the amount matches the on-chain
 * transfer exactly, so the wallet is recovered by finding that transfer and taking
 * its final recipient.
 *
 *   FOMO_ACCESS_TOKEN=... bun run scripts/roster.ts            # write config/wallets.json
 *   FOMO_ACCESS_TOKEN=... bun run scripts/roster.ts --verify   # only report, change nothing
 *   bun run scripts/roster.ts --input dump.json                # resolve from a pre-dumped list
 *
 * The access token is `privy:token` in fomo.family's local storage. It lasts about
 * an hour, which is longer than this script needs; nothing is written to disk but
 * the roster itself.
 */
import { type Address, createPublicClient, erc20Abi, http, parseAbiItem } from "viem";
import { chain, chainConfig, env, fomoConfig } from "../apps/server/src/config.ts";

const { api: API, site: SITE } = fomoConfig;
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const LEADERBOARD_WINDOWS = ["", "/24h", "/7d", "/30d"];
/**
 * How far around the estimated block to look. Scaling this with the age of the swap
 * sounds right and is worse in practice: the wider range is refused outright by the
 * public RPC more often than it finds an older swap.
 */
const SEARCH_RADIUS = 12_000n;
const ROBINHOOD = 4663;
/**
 * Routing contracts that hold a token mid-route. They can end up looking terminal
 * when the rest of the route falls outside the searched range, and none of them is
 * ever a trader.
 */
const INFRASTRUCTURE = new Set<string>([
  "0x8366a39cc670b4001a1121b8f6a443a643e40951", // Uniswap v4 PoolManager
  "0x8876789976decbfcbbbe364623c63652db8c0904", // Universal Router
  "0xca11bde05977b3631167028862be2a173976ca11", // Multicall3
  "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be", // RelayApprovalProxyV3
]);

// The public RPC answers 429 after a few requests in a row, and this script is a
// one-off, so it waits rather than racing: a swallowed 429 would look exactly like
// a wallet that could not be found.
const rpc = createPublicClient({
  chain,
  transport: http(env.httpUrl, { retryCount: 10, retryDelay: 1_000 }),
});
/**
 * The wide `Transfer` scan is the one call a keyed provider may refuse: Alchemy's free
 * tier caps `eth_getLogs` at ten blocks and this search needs twenty-four thousand. The
 * chain's own endpoint has no cap, only the rate limit the pacing already respects, so
 * the scan moves there the first time the keyed one refuses and stays there. It is asked
 * for by name rather than through the server's `wideRpc`, which is the fallback provider
 * the Worker uses: that one caps the range too, and the Worker only reaches for it because
 * the chain's own endpoint answers 429 to Cloudflare's egress. From a laptop it answers.
 */
const wide = createPublicClient({
  chain,
  transport: http(chainConfig.rpcHttp, { retryCount: 10, retryDelay: 1_000 }),
});
let scan = rpc;

async function transfersOf(token: Address, fromBlock: bigint, toBlock: bigint) {
  try {
    return await scan.getLogs({ address: token, event: TRANSFER, fromBlock, toBlock });
  } catch (error) {
    if (scan === wide) throw error;
    // The refusal does not always name the range: Alchemy answers a scan this wide with
    // "Invalid parameters were provided to the RPC method", which reads like a bug in the
    // call rather than a cap. Any refusal of the first wide scan moves the search to the
    // chain's own endpoint, which has no cap and only the rate limit the pacing respects.
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.error(`the keyed RPC refused eth_getLogs (${message}); scanning on the chain's own endpoint`);
    scan = wide;
    return transfersOf(token, fromBlock, toBlock);
  }
}

const PACE_MS = 350;
const pace = () => Bun.sleep(PACE_MS);

interface Trader {
  handle: string;
  id: string;
  displayName?: string;
  followers?: number;
  swaps: { token: Address; amount: number; at: string }[];
  /** Only set in --input mode, to score the resolver against a list we already have. */
  expect?: string;
}

async function fomo<T>(path: string): Promise<T> {
  const token = process.env.FOMO_ACCESS_TOKEN?.trim();
  if (!token) throw new Error("FOMO_ACCESS_TOKEN is not set; see the header of this file");
  const res = await fetch(`${API}${path}`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "x-supported-chains": "56,143,4663,8453,1399811149",
      origin: SITE,
      referer: `${SITE}/`,
    },
  });
  if (!res.ok) throw new Error(`fomo ${path} -> HTTP ${res.status}`);
  const body = (await res.json()) as { responseObject: T };
  return body.responseObject;
}

async function collectTraders(): Promise<Trader[]> {
  const byId = new Map<string, { userHandle: string; displayName?: string; followers?: number }>();
  for (const window of LEADERBOARD_WINDOWS) {
    const page = await fomo<{
      leaderboard: { id: string; userHandle: string; displayName?: string; followers?: number }[];
    }>(`/v2/leaderboard${window}`);
    for (const u of page.leaderboard) if (u.userHandle) byId.set(u.id, u);
  }
  console.error(`leaderboard: ${byId.size} traders`);

  const traders: Trader[] = [];
  for (const [id, u] of byId) {
    const page = await fomo<{
      swaps: { outNetworkId: number; outTokenAddress: string; outHumanAmount: number; createdAt: string }[];
    }>(`/v2/users/${id}/swaps?limit=20`);
    const swaps = page.swaps
      .filter((s) => s.outNetworkId === ROBINHOOD && s.outHumanAmount > 0)
      .slice(0, 3)
      .map((s) => ({ token: s.outTokenAddress.toLowerCase() as Address, amount: s.outHumanAmount, at: s.createdAt }));
    traders.push({ handle: u.userHandle, id, displayName: u.displayName, followers: u.followers, swaps });
  }
  return traders;
}

/** Block time drifts, so anchor on two real blocks instead of assuming a constant. */
async function blockEstimator() {
  const head = await rpc.getBlock({ blockNumber: await rpc.getBlockNumber(), includeTransactions: false });
  await pace();
  const past = await rpc.getBlock({ blockNumber: head.number - 500_000n, includeTransactions: false });
  const msPerBlock = (Number(head.timestamp - past.timestamp) * 1000) / 500_000;
  /** The searched range, already clamped: a `toBlock` past the head is rejected outright. */
  return (at: string): { from: bigint; to: bigint } => {
    const behind = (Number(head.timestamp) * 1000 - Date.parse(at)) / msPerBlock;
    const centre = head.number - BigInt(Math.round(behind));
    const from = centre - SEARCH_RADIUS;
    const to = centre + SEARCH_RADIUS;
    return { from: from < 0n ? 0n : from, to: to > head.number ? head.number : to };
  };
}

const decimalsCache = new Map<Address, number>();
async function decimalsOf(token: Address): Promise<number> {
  const known = decimalsCache.get(token);
  if (known !== undefined) return known;
  await pace();
  const d = await rpc.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }).catch(() => 18);
  decimalsCache.set(token, d);
  return d;
}

/**
 * The transfer route ends at the trader: relay hands the token through its own
 * addresses with the same value, so the last transfer of that value in the
 * transaction is the one that credits the wallet.
 */
async function resolveWallet(
  swaps: Trader["swaps"],
  estimate: (at: string) => { from: bigint; to: bigint },
): Promise<Address | undefined> {
  for (const swap of swaps) {
    const range = estimate(swap.at);
    const decimals = await decimalsOf(swap.token);
    await pace();
    const logs = await transfersOf(swap.token, range.from, range.to);

    const matches = logs.filter((l) => {
      const value = Number(l.args.value ?? 0n) / 10 ** decimals;
      return Math.abs(value - swap.amount) / swap.amount < 1e-4;
    });
    if (matches.length === 0) continue;

    // The route is a chain of transfers of the same value: pool, relayer, relayer,
    // trader. Only the trader never sends it on, so the address that appears as a
    // recipient and never as a sender is the end of the route.
    const senders = new Set(matches.map((l) => l.args.from?.toLowerCase()));
    const terminal = matches.filter((l) => {
      const to = l.args.to?.toLowerCase();
      return to !== undefined && !senders.has(to) && !INFRASTRUCTURE.has(to);
    });
    const pick = terminal.at(-1);
    if (pick?.args.to) return pick.args.to.toLowerCase() as Address;
  }
  return undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inputFlag = args.indexOf("--input");
  const traders: Trader[] =
    inputFlag >= 0 ? JSON.parse(await Bun.file(args[inputFlag + 1]!).text()) : await collectTraders();

  const merge = args.includes("--merge");
  const known = new Map<string, { handle: string; address: Address; display_name?: string; followers?: number }>();
  if (merge) {
    const existing = JSON.parse(await Bun.file("config/wallets.json").text()) as {
      handle: string;
      address: Address;
      display_name?: string;
      followers?: number;
    }[];
    for (const w of existing) known.set(w.handle.toLowerCase(), w);
  }

  const estimate = await blockEstimator();
  const resolved: { handle: string; address: Address; display_name?: string; followers?: number }[] = [];
  let scored = 0;
  let correct = 0;
  let failed = 0;

  for (const t of traders) {
    // An address we already have needs no RPC; only its fomo metadata is refreshed.
    const already = known.get(t.handle.toLowerCase());
    if (already) {
      resolved.push({
        ...already,
        handle: t.handle,
        display_name: t.displayName ?? already.display_name,
        followers: t.followers ?? already.followers,
      });
      continue;
    }
    let address: Address | undefined;
    try {
      address = t.swaps.length > 0 ? await resolveWallet(t.swaps, estimate) : undefined;
    } catch (e) {
      console.error(`  ${t.handle}: RPC failed — ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      failed++;
      continue;
    }
    if (t.expect) {
      scored++;
      if (address === t.expect.toLowerCase()) correct++;
      else console.error(`  ${t.handle}: expected ${t.expect}, got ${address ?? "nothing"}`);
    }
    if (address) resolved.push({ handle: t.handle, address, display_name: t.displayName, followers: t.followers });
  }

  console.error(
    `resolved ${resolved.length} of ${traders.length} traders${failed > 0 ? `, ${failed} failed on RPC` : ""}`,
  );
  if (scored > 0) console.error(`scored against the known list: ${correct}/${scored}`);

  if (args.includes("--verify")) return;

  // Merging keeps wallets an earlier run resolved: a trader whose recent swaps fall
  // outside what this RPC will serve would otherwise be dropped from the roster.
  const merged = new Map<string, { handle: string; address: Address; display_name?: string; followers?: number }>();
  if (merge) for (const w of known.values()) merged.set(w.address.toLowerCase(), w);
  for (const w of resolved) merged.set(w.address, { ...merged.get(w.address), ...w });

  const out = [...merged.values()].sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0));
  await Bun.write("config/wallets.json", `${JSON.stringify(out, null, 2)}\n`);
  console.error(`wrote config/wallets.json with ${out.length} wallets`);
}

await main();
