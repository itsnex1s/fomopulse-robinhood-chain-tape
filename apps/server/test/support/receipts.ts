/**
 * What the reconstruction tests are built from: the two real receipts the numbers are
 * pinned against, the context a reconstruction needs around one, and the synthetic
 * transfers used where a real receipt would say too much at once.
 */
import type { Address, Hex } from "viem";
import { QUOTE_TOKENS, type QuoteToken } from "../../src/config.ts";
import {
  type Kind,
  participants,
  type RawReceipt,
  type ReconstructContext,
  TRANSFER_TOPIC,
} from "../../src/ingest/reconstruct.ts";
import buyReceipt from "../fixtures/buy-bbl.json" with { type: "json" };
import sellReceipt from "../fixtures/sell-butthole.json" with { type: "json" };

/**
 * Both receipts are real, and the expected numbers are what robinhoodtrenches.com
 * published for the same transactions, so this pins the reconstruction against the
 * site we are cloning rather than against itself.
 */
export const buy = {
  name: "buy routed through relay: cash never touches the wallet",
  receipt: (buyReceipt as { result: RawReceipt }).result,
  wallet: "0x662053fd75f1f7da7e524d884b96552a13d2800b" as Address,
  token: "0xdf2e15395bc8a2078187eecee8eb024aa57e0265" as Address,
  side: "buy",
  amount: 9520976.503865257,
  usd: 845.042526,
  price: 0.00008875586717989858,
} as const;

export const sell = {
  name: "sell split across pool hops: the aggregate leg is the size",
  receipt: (sellReceipt as { result: RawReceipt }).result,
  wallet: "0x80f3b0b712a82172a67e454e313ba6e2b0e7ae64" as Address,
  token: "0xdd0b80c2a4b341676c5316f0107f6939ae021e18" as Address,
  side: "sell",
  amount: 5741192.335860492,
  usd: 5508.52027,
  price: 0.0009594732152749558,
} as const;

/** The traders are accounts; everything else with a balance change in these receipts is a pool or a fee sink. */
export function kindsFor(
  receipt: RawReceipt,
  traders: Address[],
  quote: ReadonlyMap<Address, QuoteToken> = QUOTE_TOKENS,
): Map<string, Kind> {
  const kinds = new Map<string, Kind>();
  for (const address of participants(receipt, quote))
    kinds.set(address, traders.includes(address) ? "eoa" : "contract");
  return kinds;
}

export function context(
  receipt: RawReceipt,
  traders: Address[],
  overrides: Partial<ReconstructContext> = {},
): ReconstructContext {
  const quote = overrides.quote ?? QUOTE_TOKENS;
  return {
    wallets: new Set<Address>(traders),
    quote,
    decimals: new Map([
      [buy.token, 18],
      [sell.token, 18],
    ]),
    kinds: kindsFor(receipt, traders, quote),
    ts: 1788536209,
    ...overrides,
  };
}

export const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
export const topic = (address: string) => `0x000000000000000000000000${address.slice(2)}` as Hex;
export const transferLog = (logIndex: number, token: Address, from: string, to: string, value: bigint) => ({
  address: token,
  topics: [TRANSFER_TOPIC, topic(from), topic(to)] as Hex[],
  data: `0x${value.toString(16)}` as Hex,
  logIndex: `0x${logIndex.toString(16)}` as Hex,
});
export const pool = "0x1111111111111111111111111111111111111111";
export const alice = "0x2222222222222222222222222222222222222222" as Address;
export const bob = "0x3333333333333333333333333333333333333333" as Address;
export const red = "0x4444444444444444444444444444444444444444" as Address;
export const blue = "0x5555555555555555555555555555555555555555" as Address;

/** Two tracked wallets buying from one pool, and a feed that knows both tokens. */
export const twoBuyers: ReconstructContext = {
  wallets: new Set([alice, bob]),
  quote: QUOTE_TOKENS,
  decimals: new Map([
    [red, 18],
    [blue, 18],
  ]),
  kinds: new Map([[pool, "contract"]]),
  prices: new Map([
    [red, 100],
    [blue, 200],
  ]),
  ts: 0,
};
