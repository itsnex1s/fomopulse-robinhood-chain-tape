import { chainConfig, wallets } from "../config.ts";
import { type TapeRow, tape } from "../db.ts";
import { limits } from "../limits.ts";
import { stockOf } from "../stocks.ts";
import { bookOf, traderOf } from "../traders.ts";
import type { Fill } from "./types.ts";

const traders = new Map(wallets.map((w) => [w.address, w]));

/** A stored row's wallet, for the rows that name one: the handle, or the address prefix. */
export const handleOf = (wallet: string): string => traders.get(wallet as `0x${string}`)?.handle ?? wallet.slice(0, 10);

/** Under this a tokenised stock is not a line of the tape: a stock settles off fomo's own account
 *  with no cash leg on chain, so nothing in the shape of a $5 fractional buy tells it from a credit,
 *  and either way half a tape of them carries a third of a percent of what it moved. */
export const STOCK_MIN_USD = 25;

/** Whether a fill is worth a line. Read by the page and by the socket alike, so the two agree. */
export const onTape = (fill: Fill): boolean => fill.is_stock === 0 || (fill.usd ?? 0) >= STOCK_MIN_USD;

/**
 * What a socket is given the moment it connects: the fills that landed while the page it is
 * about to draw was sitting in the edge cache. Four times that cache's lifetime, because a
 * page can be served at the end of its window and the socket opens after the page arrives.
 */
const TAIL_SECONDS = Math.max(60, (limits.cache.edge.tape ?? 15) * 4);
/** The most it will ever send. A quiet chain sends a handful; a burst must not send a page. */
const TAIL_ROWS = 200;

/** The tape since `TAIL_SECONDS` ago, in the shape the socket pushes. */
export const tail = (): Fill[] =>
  tape(Math.floor(Date.now() / 1000) - TAIL_SECONDS, TAIL_ROWS)
    .map(toFill)
    .filter(onTape);

/** The shape robinhoodtrenches.com serves, so a client written against it works here. */
export function toFill(row: TapeRow): Fill {
  const trader = traders.get(row.wallet as `0x${string}`);
  const fomo = trader ? traderOf(trader.handle) : undefined;
  const book = bookOf(row.wallet);
  const stock = stockOf(row.token);
  return {
    id: row.id,
    ts: row.ts,
    tx: row.tx,
    side: row.side,
    usd: row.usd,
    amount: row.amount,
    price: row.price,
    priced: row.priced,
    block: row.block,
    // The wallet's first buy of this token on this tape — the original's FIRST BUY, read off our own history.
    new_position: row.new_position,
    // Other tracked wallets that bought the same token in the hour before: the crowd, from the tape itself.
    others: row.others,
    is_stock: stock ? 1 : 0,
    // A token nobody paid for, pushed to the whole tracker at once; hidden unless asked for.
    is_dust: row.dust ? 1 : 0,
    wallet: row.wallet,
    handle: trader?.handle ?? row.wallet.slice(0, 10),
    display_name: trader?.display_name ?? null,
    followers: fomo?.followers ?? trader?.followers ?? 0,
    avatar_url: fomo?.avatar_url ?? null,
    profile_url: trader?.profile_url ?? null,
    // This tape's standing for the trader card: where the wallet sits among the tracked
    // ones by the day's books, and what those books say it made.
    rank: book.rank,
    pnl_24h: book.pnl,
    verified: fomo?.verified ?? 0,
    clan: fomo?.clan ?? null,
    token: row.token,
    symbol: row.symbol,
    // A tokenised stock is named after its company, not "… • Robinhood Token".
    name: stock?.name ?? row.name,
    // The token's card from the feed, as of its last quote: what it is worth now next to
    // what the fill paid, how deep and how old its pool is, how the whole market traded it.
    mark: row.mark,
    liquidity: row.liquidity,
    pair_url: row.pair_address ? `https://dexscreener.com/${chainConfig.dexscreenerSlug}/${row.pair_address}` : null,
    pair_created_at: row.pair_created_at,
    change24: row.change24,
    change1h: row.change1h,
    volume24: row.volume24,
    buys24: row.buys24,
    sells24: row.sells24,
    market_cap: row.market_cap,
    mcap_at: row.mcap_at,
    dex: row.dex,
    image_url: row.image_url ?? stock?.logo ?? null,
    // The original carries this and its own client ignores it; here for a drop-in client.
    flags: [],
  };
}
