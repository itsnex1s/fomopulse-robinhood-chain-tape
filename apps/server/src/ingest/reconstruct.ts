import type { Address } from "viem";
import type { QuoteToken } from "../config.ts";
import { type Kind, parse, type ReceiptInput, type Transfer } from "./parse.ts";

export type { Kind, ParsedReceipt, RawReceipt, ReceiptInput, Transfer } from "./parse.ts";
export { parse, TRANSFER_TOPIC, transfers } from "./parse.ts";

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Why a fill is off the tape, kept on the fill itself. A trade is `0`. `1` is dusting by
 * value — nobody paid for it and it is worth cents — and one real trade in the token
 * pardons the token's whole dusty history. `2` is a handout by shape, which nothing
 * pardons: what one transaction was is not changed by what other transactions were.
 * Measured 2026-09-06: fomocat is a real token with a real pool, and fifteen paid buys in
 * it brought back two hundred and sixty-one rows of a spray to seventy-three wallets.
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
 * Below this share of a token's largest transfer in the transaction, an account's
 * balance change is a fee, not a trade: launchpad hooks pay a fraction of a percent of
 * every swap to a collector wallet, which would otherwise look like a trader.
 */
const FEE_RATIO = 5n; // percent

/**
 * Net movement of every non-quote token per address, fee-sized changes dropped —
 * except for the tracked wallets, whose every change is a fill, however small an
 * airdrop it is. Relay hands a token through its own addresses, which nets to zero
 * and disappears.
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
 * Addresses whose balance of a non-quote token changed by more than a fee: the
 * traders, and the pools they traded against. Their code kind tells the two apart, so
 * this is what the caller has to look up before `reconstruct` can price anything.
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
 * The trade legs of every trader in the transaction, in log order. A trader is an
 * externally owned account whose balance of the token changed; a transfer between two
 * traders is an inventory move, not a trade, and a transfer between two contracts is
 * a hop. `unknown` is set when some participant's kind is not in `kinds`.
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
    // A tracked wallet on exactly one side is that wallet's fill whatever stands on the
    // other: fomo settles a tokenised stock out of its own account, which looks like a
    // transfer between two accounts and is the trader's buy all the same. Only a move
    // between two tracked wallets is inventory.
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
 * The log range holding a leg's cash. A buy is paid before the token arrives, so it
 * owns the logs since the previous trader's leg; a sell is paid after the token
 * leaves, so it owns the logs up to the next one. One case cannot be split without
 * guessing: a sell followed by another trader's buy, where both traders' cash sits
 * in the same gap. That leg falls back to the price feed.
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
 * Turn one receipt into the fills it contains.
 *
 * The trade is invisible in the wallet's own balance changes: fomo routes through
 * relay.link, so the cash never touches the trader's address.
 * What is reliable is that a route settles one amount of quote token, split across
 * pool hops and re-sent by each relayer, so the largest single quote transfer inside
 * the trade's own log range is the size of the trade. A relayer can pack several
 * traders' swaps into one transaction; their legs split the log range between them.
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
    // A leg whose range holds no cash — an airdrop, a token-for-token route, the one
    // batch layout that cannot be split — is estimated from the price feed, which is
    // what the original marks `~`.
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
/**
 * Wallets credited with the same amount, by one sender, in one transaction, before the
 * transfer is a handout rather than a trade. Measured 2026-09-06: fomodoge was pushed to
 * seventy-three wallets at a time, 81 817 459.405 each, in transactions that called the
 * token itself — 359 fills and $3.39M of "buys" against a pool that traded $11k all day.
 */
const HANDED_TO = 5;

/**
 * A tracker is worth spamming: a script pushes a worthless token to every wallet on the
 * list to get itself onto the tape. What separates that from a trade is the shape of the
 * whole transaction — no quote token moved in it, so nobody paid for anything; the
 * counterparty took nothing but the same token back, so it handed the token out rather
 * than traded it (a pool always receives the other side of the swap, while a dusting
 * script is fed the token it sprays and sprays it on); and the token is not a tokenised
 * stock, which fomo settles out of an account of its own. Past those, two things end it:
 * the shape of the transfer itself — one token, one sender, nothing coming back — or, for
 * a receipt that at least looks like a trade, a fill worth cents. The
 * verdict needs no history, which is the point: the first fill of a token minted a
 * second ago is already off the tape, and one real trade in it clears the flag from its
 * whole history (`clearDust`).
 */
function isDusting(leg: Leg, usd: number | null, paidFor: boolean, all: Transfer[], ctx: ReconstructContext): Dust {
  if (paidFor || ctx.isStock?.(leg.token)) return TRADE;
  if (all.some((t) => t.to === leg.counterparty && t.token !== leg.token)) return TRADE;
  // The shape first: a handout of a token that trades for real is still a handout, and
  // saying so with the same flag as "worth cents" is what let one paid buy undo it.
  if (pushed(leg, all) || handedOut(leg, all)) return HANDOUT;
  return usd === null || usd < DUST_USD ? DUSTED : TRADE;
}

/**
 * A spray does not need to fit in one transaction. The same script sends the same amount to
 * one wallet at a time, a few seconds apart, and each transaction on its own is a wallet
 * whose balance went up — which is why counting recipients within a receipt does not see it.
 * What such a transaction never has is a second side: the whole receipt is one token leaving
 * one sender, and the caller has already established that nothing came back for it. A trade
 * moves two things; this moves one. Measured 2026-09-06: 6 300 BREW pushed to 75 wallets in
 * 87 transactions, six seconds apart, priced at $392.55 each by a pool that had traded
 * nineteen cents all day — $34k of "buys" nobody paid for.
 *
 * A tokenised stock arrives in exactly this shape and is a real fill, which is why the
 * stock check runs before this one: four in five of the archive's clean fills come from
 * receipts in which no quote token moved at all.
 */
function pushed(leg: Leg, all: Transfer[]): boolean {
  const sender = leg.side === "buy" ? leg.counterparty : leg.trader;
  return all.every((t) => t.token === leg.token && t.from === sender);
}

/**
 * The other half of the same verdict, for a token whose pool gives the handout a price.
 * Value cannot tell a spray from a trade — an airdrop of a token with a live pool is worth
 * whatever the pool says — but the shape can: one sender, one amount, many wallets at once.
 * Nobody buys the identical quantity as seventy other people in the same transaction.
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
