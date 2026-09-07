import type { Address } from "viem";
import type { QuoteToken } from "../config.ts";
import { type Kind, parse, type ReceiptInput, type Transfer } from "./parse.ts";

export type { Kind, ParsedReceipt, RawReceipt, ReceiptInput, Transfer } from "./parse.ts";
export { parse, TRANSFER_TOPIC, transfers } from "./parse.ts";

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Why a fill is off the tape. A trade is `0`. `1` is dusting by value — nobody paid for it and
 * it is worth cents — and one real trade in the token pardons its whole dusty history. `2` is a
 * handout by shape, which nothing pardons: one transaction is not changed by what others were.
 */
export const TRADE = 0;
export const DUSTED = 1;
export const HANDOUT = 2;
export type Dust = typeof TRADE | typeof DUSTED | typeof HANDOUT;

/** One fill as stored: the wallet's movement, its size in dollars, and how that number was obtained. */
export interface StoredFill {
  tx: string;
  logIndex: number;
  block: number;
  ts: number;
  wallet: Address;
  token: Address;
  side: "buy" | "sell";
  amount: number;
  usd: number | null;
  price: number | null;
  /** How `usd` was obtained: exactly from the cash leg, from the price feed, or not at all. */
  priced: "cash_leg" | "estimate" | "unpriced";
  /** Whether this is a trade at all, and if not, which rule says so. */
  dust: Dust;
}

export interface ReconstructContext {
  wallets: ReadonlySet<Address>;
  quote: ReadonlyMap<Address, QuoteToken>;
  decimals: ReadonlyMap<string, number>;
  /** Code kind of every address `participants()` names. One missing here sends the transaction to the feed. */
  kinds: ReadonlyMap<string, Kind>;
  /** Block timestamp in seconds. */
  ts: number;
  /** Needed only to price a WETH cash leg. */
  ethUsd?: number;
  /** USD per whole token from the price feed, for legs no cash leg can pay for. */
  prices?: ReadonlyMap<string, number>;
  /** Tokenised stocks are settled out of fomo's own account and are never dusting. */
  isStock?: (token: Address) => boolean;
}

/** One trader's movement of one token in one direction, its transfers merged. */
interface Leg {
  trader: Address;
  token: Address;
  side: "buy" | "sell";
  value: bigint;
  /** Who handed the token over, or took it: a pool, a router, or somebody's account. */
  counterparty: Address;
  /** First and last log index of the merged transfers. */
  first: number;
  last: number;
}

const scale = (value: bigint, decimals: number) => Number(value) / 10 ** decimals;

/**
 * Below this share of a token's largest transfer in the transaction, a balance change is a fee,
 * not a trade: launchpad hooks pay a fraction of a percent of every swap to a collector wallet.
 */
const FEE_RATIO = 5n; // percent

/**
 * Net movement of every non-quote token per address, fee-sized changes dropped — except for the
 * tracked wallets, whose every change is a fill however small. Relay hands a token through its
 * own addresses, which nets to zero and disappears.
 */
function netFlows(
  all: Transfer[],
  quote: ReadonlyMap<Address, QuoteToken>,
  exempt: ReadonlySet<Address>,
): Map<Address, Map<Address, bigint>> {
  const flows = new Map<Address, Map<Address, bigint>>();
  const largest = new Map<Address, bigint>();
  const add = (address: Address, token: Address, delta: bigint) => {
    if (address === ZERO) return;
    const byToken = flows.get(address) ?? new Map<Address, bigint>();
    byToken.set(token, (byToken.get(token) ?? 0n) + delta);
    flows.set(address, byToken);
  };
  for (const t of all) {
    if (quote.has(t.token)) continue;
    add(t.from, t.token, -t.value);
    add(t.to, t.token, t.value);
    if (t.value > (largest.get(t.token) ?? 0n)) largest.set(t.token, t.value);
  }
  for (const [address, byToken] of flows) {
    for (const [token, net] of byToken) {
      const magnitude = net < 0n ? -net : net;
      if (magnitude === 0n) byToken.delete(token);
      else if (!exempt.has(address) && magnitude * 100n < (largest.get(token) ?? 0n) * FEE_RATIO) byToken.delete(token);
    }
    if (byToken.size === 0) flows.delete(address);
  }
  return flows;
}

const NOBODY: ReadonlySet<Address> = new Set();

/**
 * Addresses whose balance of a non-quote token changed by more than a fee: the traders, and the
 * pools they traded against. Their code kind tells the two apart, so the caller looks it up first.
 */
export function participants(receipt: ReceiptInput, quote: ReadonlyMap<Address, QuoteToken>): Address[] {
  return [...netFlows(parse(receipt).transfers, quote, NOBODY).keys()];
}

/** Non-quote tokens a tracked wallet moved; the decimals of these have to be known before reconstructing. */
export function tokensToResolve(
  receipt: ReceiptInput,
  wallets: ReadonlySet<Address>,
  quote: ReadonlyMap<Address, QuoteToken>,
): Address[] {
  const tokens = new Set<Address>();
  for (const t of parse(receipt).transfers) {
    if (!quote.has(t.token) && (wallets.has(t.from) || wallets.has(t.to))) tokens.add(t.token);
  }
  return [...tokens];
}

/**
 * The trade legs of every trader in the transaction, in log order. A trader is an externally
 * owned account whose balance of the token changed; a transfer between two traders is an
 * inventory move, between two contracts a hop. `unknown` is set when a participant's kind is missing.
 */
function tradeLegs(all: Transfer[], ctx: ReconstructContext): { legs: Leg[]; unknown: boolean } {
  const flows = netFlows(all, ctx.quote, ctx.wallets);
  let unknown = false;
  const isTrader = (address: Address, token: Address): boolean => {
    if (flows.get(address)?.get(token) === undefined) return false;
    if (ctx.wallets.has(address)) return true;
    const kind = ctx.kinds.get(address);
    if (kind === undefined) unknown = true;
    return kind === "eoa";
  };

  const merged = new Map<string, Leg>();
  for (const t of all) {
    if (ctx.quote.has(t.token) || t.from === ZERO) continue;
    const buyer = isTrader(t.to, t.token);
    const seller = isTrader(t.from, t.token);
    // A tracked wallet on exactly one side is that wallet's fill whatever stands on the other:
    // fomo settles a tokenised stock out of its own account, which looks like a transfer between
    // two accounts and is the trader's buy all the same. Only wallet to wallet is inventory.
    const takes = buyer && ctx.wallets.has(t.to);
    const gives = seller && ctx.wallets.has(t.from);
    let side: "buy" | "sell";
    if (takes !== gives) side = takes ? "buy" : "sell";
    else if (buyer !== seller) side = buyer ? "buy" : "sell";
    else continue;
    const trader = side === "buy" ? t.to : t.from;
    const counterparty = side === "buy" ? t.from : t.to;
    const key = `${trader}:${t.token}:${side}`;
    const leg = merged.get(key);
    if (leg) {
      leg.value += t.value;
      leg.last = t.logIndex;
    } else {
      merged.set(key, {
        trader,
        token: t.token,
        side,
        value: t.value,
        counterparty,
        first: t.logIndex,
        last: t.logIndex,
      });
    }
  }
  return { legs: [...merged.values()].sort((a, b) => a.first - b.first), unknown };
}

/**
 * The log range holding a leg's cash. A buy is paid before the token arrives, so it owns the logs
 * since the previous trader's leg; a sell is paid after, so it owns the logs up to the next one.
 * A sell followed by another trader's buy puts both their cash in one gap, and falls back to the feed.
 */
function segment(i: number, legs: Leg[]): [number, number] | undefined {
  const leg = legs[i]!;
  if (leg.side === "buy") {
    const prev = legs[i - 1];
    if (prev && prev.side === "sell" && prev.trader !== leg.trader) return undefined;
    return [prev ? prev.last + 1 : 0, leg.last];
  }
  const next = legs[i + 1];
  if (next && next.side === "buy" && next.trader !== leg.trader) return undefined;
  return [leg.first, next ? next.first - 1 : Number.MAX_SAFE_INTEGER];
}

/**
 * Turn one receipt into the fills it contains. The trade is invisible in the wallet's own balance
 * changes — fomo routes through relay.link, so the cash never touches the trader's address — but a
 * route settles one amount of quote token, so the largest quote transfer in its log range is its size.
 */
export function reconstruct(receipt: ReceiptInput, ctx: ReconstructContext): StoredFill[] {
  const { tx, block, transfers: all } = parse(receipt);
  const { legs, unknown } = tradeLegs(all, ctx);
  // No quote token moved anywhere in this transaction, so nobody paid for anything in it.
  const paidFor = all.some((t) => ctx.quote.has(t.token));

  const fills: StoredFill[] = [];
  legs.forEach((leg, i) => {
    if (!ctx.wallets.has(leg.trader)) return;
    const amount = scale(leg.value, ctx.decimals.get(leg.token) ?? 18);
    // A leg whose range holds no cash — an airdrop, a token-for-token route, the one batch
    // layout that cannot be split — is estimated from the price feed, which the tape marks `~`.
    const range = unknown ? undefined : segment(i, legs);
    const cash = range ? cashUsd(all, ctx, range) : undefined;
    const feed = ctx.prices?.get(leg.token);

    let usd: number | null = null;
    let price: number | null = null;
    let priced: StoredFill["priced"] = "unpriced";
    if (cash !== undefined) {
      usd = cash;
      price = amount > 0 ? cash / amount : null;
      priced = "cash_leg";
    } else if (feed !== undefined) {
      usd = feed * amount;
      price = feed;
      priced = "estimate";
    }

    fills.push({
      tx,
      logIndex: leg.first,
      block,
      ts: ctx.ts,
      wallet: leg.trader,
      token: leg.token,
      side: leg.side,
      amount,
      usd,
      price,
      priced,
      dust: isDusting(leg, usd, paidFor, all, ctx),
    });
  });
  return fills;
}

/** Under this, a fill nobody paid for is not worth a line of the tape. */
export const DUST_USD = 5;
/** Wallets credited the same amount by one sender in one transaction, past which it is a handout. */
const HANDED_TO = 5;

/**
 * A tracker is worth spamming: a script pushes a worthless token to every wallet on the list to
 * get onto the tape. What separates that from a trade is the shape of the whole transaction — no
 * quote token moved, the counterparty took nothing back, and the token is not one fomo settles.
 */
function isDusting(leg: Leg, usd: number | null, paidFor: boolean, all: Transfer[], ctx: ReconstructContext): Dust {
  if (paidFor || ctx.isStock?.(leg.token)) return TRADE;
  if (all.some((t) => t.to === leg.counterparty && t.token !== leg.token)) return TRADE;
  // The shape first: a handout of a token that trades for real is still a handout.
  if (pushed(leg, all) || handedOut(leg, all)) return HANDOUT;
  return usd === null || usd < DUST_USD ? DUSTED : TRADE;
}

/**
 * A spray need not fit in one transaction: the same script sends the same amount to one wallet at
 * a time, seconds apart, so counting recipients within a receipt does not see it. Such a receipt is
 * one token leaving one sender — as is a tokenised stock, which is why its check runs before this.
 */
function pushed(leg: Leg, all: Transfer[]): boolean {
  const sender = leg.side === "buy" ? leg.counterparty : leg.trader;
  return all.every((t) => t.token === leg.token && t.from === sender);
}

/**
 * The other half of the verdict, for a token whose pool gives the handout a price. Value cannot
 * tell a spray from a trade there, but shape can: nobody buys the identical quantity as seventy
 * other people in the same transaction.
 */
function handedOut(leg: Leg, all: Transfer[]): boolean {
  const wallets = new Set<string>();
  for (const t of all)
    if (t.token === leg.token && t.from === leg.counterparty && t.value === leg.value) wallets.add(t.to);
  return wallets.size >= HANDED_TO;
}

/** The largest single quote-token transfer within the log range, in USD. */
function cashUsd(all: Transfer[], ctx: ReconstructContext, [lo, hi]: [number, number]): number | undefined {
  let best: number | undefined;
  for (const t of all) {
    if (t.logIndex < lo || t.logIndex > hi) continue;
    const q = ctx.quote.get(t.token);
    if (!q) continue;
    const rate = q.usd ?? ctx.ethUsd;
    if (rate === undefined) continue;
    const usd = scale(t.value, q.decimals) * rate;
    if (best === undefined || usd > best) best = usd;
  }
  return best;
}
