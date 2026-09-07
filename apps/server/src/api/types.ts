/**
 * What the API serves, shared by the server that builds these rows and the web app that
 * renders them, so a renamed field fails to compile on both sides. The names follow the
 * responses of robinhoodtrenches.com. No imports on purpose: the web app compiles this file
 * without the server's toolchain.
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
  /** The wallet's standing in this tape's books; null until the walk has run. */
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
  /**
   * What the whole token was worth when this fill landed, over the supply stamped on the fill
   * at the time, so a token that burns supply later does not look cheaper at entry than it
   * was. `market_cap` is the feed's, as of its last quote.
   */
  mcap_at: number | null;
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
  /** The fomo side: when the cards last arrived, and why they stopped if they have. */
  leaderboard: { updated_at: number | null; refused: string | null; asking_again_in: number | null };
  /**
   * What the month is on course to walk against what the plan includes, and how much longer
   * answers are being held because of it — `holding` is 1 while there is room. Read off what
   * each answer says it walked, not metered by the platform.
   */
  budget: { rows_walked: number; rows_projected: number; budget: number; holding: number };
}

/** `GET /api/traders`: what a wallet did on this tape in the window, and what its books made. */
export interface Trader {
  handle: string;
  address: string;
  /** Identity, which is all fomo is asked for: the avatar, the clan, the tick. */
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
  /**
   * The books, measured on this chain from this tape's fills. `realized`, `trips` and
   * `wins` are the window's — a round trip counts in the window it closed in — while
   * `unrealized` and the open position are as of now, because a position has no window.
   * `rank` is by `total` across every tracked wallet.
   */
  pnl_window: string;
  realized: number | null;
  unrealized: number | null;
  total: number | null;
  trips: number | null;
  wins: number | null;
  open_value: number | null;
  open_tokens: number | null;
  /** Proceeds from selling what arrived at no cost, which is not profit on anything. */
  free: number | null;
  tokens: number | null;
  first_ts: number | null;
  stats_at: number | null;
  rank: number | null;
}

/** `GET /api/bags`: one token the tracked traders are sitting in, as this tape measures it. */
export interface Bag {
  token: string;
  network: number;
  image_url: string | null;
  symbol: string | null;
  name: string | null;
  is_stock: number;
  /** Wallets on this tape still holding the token, counted off their own fills. */
  holders: number;
  /** What the positions are worth together; null until a price marks them. */
  value: number | null;
  pnl: number | null;
  /** The largest single position, for how concentrated the bag is; null until a price marks it. */
  top_value: number | null;
  /** Tokens held across the positions, so the bag can be re-marked at the feed's price. */
  amount: number;
  /** The feed's price for the token; null until it has quoted one. */
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

/**
 * `GET /api/discover`: a young pool a tracked wallet has bought into. The feed says how deep
 * and how old it is; everything about who is in it is measured on this tape. Pools too
 * shallow to be a market, and ones whose day's volume dwarfs their own depth, never reach here.
 */
export interface Discover {
  token: string;
  symbol: string | null;
  name: string | null;
  image_url: string | null;
  is_stock: number;
  /** The feed's card for the pool. `pair_created_at` is milliseconds, as DexScreener reports it. */
  price: number | null;
  quoted_at: number | null;
  liquidity: number | null;
  change24: number | null;
  volume24: number | null;
  buys24: number | null;
  sells24: number | null;
  market_cap: number | null;
  dex: string | null;
  pair_created_at: number | null;
  pair_address: string | null;
  /** Tracked wallets that bought it, ever and inside the window, against the ones that sold. */
  buyers: number;
  buyers_recent: number;
  sellers: number;
  fills: number;
  bought_usd: number;
  sold_usd: number;
  last_fill_ts: number | null;
  /** Wallets still long it, and how many were when the window opened. */
  holders: number;
  holders_then: number | null;
  /** The first tracked wallet in, by handle, and how long after the pool opened it bought. */
  first_buyer: string | null;
  first_buy_ts: number | null;
  first_lag: number | null;
  /** What the whole token was worth at that first buy, against what the feed says now. */
  mcap_at: number | null;
  /** Fills of it the dust rule kept off the tape: a token that was sprayed as well as sold. */
  dusted: number;
  /** Buys and sells by one wallet that cancelled within five minutes at the same size. */
  wash: number;
  /** The best books rank among the wallets that bought it; null where none of them is ranked. */
  best_rank: number | null;
  buyers_list: { handle: string; ts: number; usd: number | null; rank: number | null; avatar_url: string | null }[];
}
