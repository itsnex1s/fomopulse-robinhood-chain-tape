/**
 * What the API serves, shared by the server that builds these rows and the web app
 * that renders them. The server annotates its handlers with these types, so a field
 * cannot be renamed on one side without the other failing to compile. The names follow
 * the responses of robinhoodtrenches.com, so a client written against it works here.
 *
 * No imports on purpose: the web app compiles this file without the server's toolchain.
 */

export type Window = "1h" | "24h" | "7d" | "30d" | "all";
export type Side = "buy" | "sell";
/** How a fill's dollar amount was obtained: exactly from the cash leg, from the price feed, or not at all. */
export type Priced = "cash_leg" | "estimate" | "unpriced";

/** One row of `GET /api/tape`; the websocket carries the same rows. */
export interface Fill {
  id: number;
  ts: number;
  tx: string;
  side: Side;
  usd: number | null;
  amount: number;
  price: number | null;
  priced: Priced;
  block: number;
  /** 1 when this is the wallet's first buy of the token on this tape. */
  new_position: number;
  /** Other tracked wallets that bought the same token in the hour before this fill. */
  others: number;
  is_stock: number;
  /** A token nobody paid for, delivered to the whole tracker at once; hidden unless asked for. */
  is_dust: number;
  wallet: string;
  handle: string;
  display_name: string | null;
  followers: number;
  avatar_url: string | null;
  profile_url: string | null;
  /** fomo's standing; null until the server has read the leaderboard. */
  rank: number | null;
  pnl_24h: number | null;
  verified: number;
  clan: string | null;
  token: string;
  symbol: string | null;
  /** The token's name; a tokenised stock carries its company's. */
  name: string | null;
  /** The token's card from the feed. `mark` is what it is worth now; the fill's own price sits in `price`. */
  mark: number | null;
  liquidity: number | null;
  pair_url: string | null;
  /** Milliseconds, as DexScreener reports it. */
  pair_created_at: number | null;
  change24: number | null;
  change1h: number | null;
  volume24: number | null;
  buys24: number | null;
  sells24: number | null;
  market_cap: number | null;
  dex: string | null;
  image_url: string | null;
  /** The original carries this and its own client ignores it; here for a drop-in client. */
  flags: string[];
}

/** `GET /api/overview`: the window in a line, what the original's readout shows above its tape. */
export interface Overview {
  window: string;
  fills: number;
  volume: number;
  buys: number;
  sells: number;
  wallets: number;
  tokens: number;
  fills_5m: number;
  volume_5m: number;
  per_minute: number;
  biggest_buy: { usd: number; ts: number; token: string; symbol: string | null; handle: string } | null;
}

/** `GET /api/status`: what the client builds its header and its links from. */
export interface Status {
  /** The window's own line, carried here so a tab polls one endpoint instead of two. */
  overview: Overview;
  chain_id: number;
  wallets: number;
  trades: number;
  first_ts: number | null;
  last_block: number;
  /** Transactions read from the chain and not yet stored. */
  pending: number;
  source: string;
  /** Block timestamp → stored row, median of the recent fills. */
  latency_ms: number | null;
  latency: { n: number; median: number; p90: number } | null;
  /** Seconds since the last stored fill — how quiet the tape is, not how slow it is. */
  lag_seconds: number | null;
  last_ts: number | null;
  server_ts: number;
  uptime: number;
  explorer: string;
  dexscreener_slug: string;
  /** The fomo side: when its numbers last arrived, and why they stopped if they have. */
  leaderboard: { updated_at: number | null; refused: string | null; asking_again_in: number | null };
}

/** `GET /api/traders`: our tape stats for the window, plus fomo's own numbers about the trader. */
export interface Trader {
  handle: string;
  address: string;
  display_name: string | null;
  avatar_url: string | null;
  clan: string | null;
  verified: number;
  followers: number | null;
  profile_url: string | null;
  /** What this tape saw of the trader inside the window. */
  fills: number;
  tape_volume: number;
  last_ts: number | null;
  /** fomo's PnL for `pnl_window`, which is the day when the tape shows an hour. */
  pnl: number | null;
  rank: number | null;
  pnl_window: string;
  pnl_all: number | null;
  volume: number | null;
  trades: number | null;
  holdings: number | null;
  top_value: number | null;
  updated_at: number | null;
}

/** `GET /api/bags`: one token the tracked traders are sitting in, as fomo publishes it — or as this tape measures it. */
export interface Bag {
  token: string;
  network: number;
  image_url: string | null;
  symbol: string | null;
  name: string | null;
  is_stock: number;
  /** Whose numbers the position columns are: fomo's, as published, or this tape's, measured off its fills. */
  source: "fomo" | "tape";
  /** fomo's numbers over the three positions it publishes per trader — or the net-long wallets on this tape. */
  holders: number;
  /** What the positions are worth together; null until a price marks them. */
  value: number | null;
  pnl: number | null;
  /** The largest single position, for how concentrated the bag is; null until a price marks it. */
  top_value: number | null;
  /** Tokens held across the positions, so the bag can be re-marked at the feed's price. */
  amount: number;
  /** Live from the feed when `quoted_at` is set, otherwise fomo's price from the last leaderboard read. */
  price: number | null;
  quoted_at: number | null;
  liquidity: number | null;
  change24: number | null;
  /** Milliseconds, as DexScreener reports it. */
  pair_created_at: number | null;
  pair_address: string | null;
  updated_at: number;
  top_holder: string | null;
  /** What the token did on our own tape inside the window; all zero off the tracked chain. */
  fills: number;
  buys: number;
  bought_usd: number;
  sold_usd: number;
  traders_in: number;
  last_fill_ts: number | null;
  /** The tracked trader who bought it first on this tape, by handle, and when. */
  first_buyer: string | null;
  first_buy_ts: number | null;
  /** The bag when the window opened; null until a snapshot that old exists. */
  holders_then: number | null;
  value_then: number | null;
  holders_list: { handle: string; value: number; pnl: number | null; avatar_url: string | null }[];
}
