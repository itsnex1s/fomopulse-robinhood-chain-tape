import { chainConfig, wallets } from "../config.ts";
import type { TapeRow } from "../db.ts";
import { stockOf } from "../stocks.ts";
import { traderOf } from "../traders.ts";
import type { Fill } from "./types.ts";

const traders = new Map(wallets.map((w) => [w.address, w]));

/** A stored row's wallet, for the rows that name one: the handle, or the address prefix. */
export const handleOf = (wallet: string): string => traders.get(wallet as `0x${string}`)?.handle ?? wallet.slice(0, 10);

/** The shape robinhoodtrenches.com serves, so a client written against it works here. */
export function toFill(row: TapeRow): Fill {
  const trader = traders.get(row.wallet as `0x${string}`);
  const fomo = trader ? traderOf(trader.handle) : undefined;
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
    // fomo's standing, for the trader card; null until `enrich` has run.
    rank: fomo?.rank_24h ?? null,
    pnl_24h: fomo?.pnl_24h ?? null,
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
