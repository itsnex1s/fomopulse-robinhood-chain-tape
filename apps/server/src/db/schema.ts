/** The whole schema; there are no migrations, and a database that does not match is deleted and re-synced.
 *  Receipts keep only what the reconstruction reads — the ERC-20 transfers, addresses and amounts as bytes —
 *  so a rebuild replays every fill without touching the chain again. */
export const SCHEMA = `
  /** One row per transaction; ts is the block timestamp, NULL until it is known. */
  CREATE TABLE IF NOT EXISTS receipts (id INTEGER PRIMARY KEY, tx BLOB NOT NULL UNIQUE, block INTEGER NOT NULL, ts INTEGER);
  CREATE INDEX IF NOT EXISTS receipts_block ON receipts (block);
  /** The ERC-20 transfers of a receipt: 20-byte addresses, the amount as a big-endian integer. */
  CREATE TABLE IF NOT EXISTS transfers (
    receipt_id INTEGER NOT NULL, log_index INTEGER NOT NULL,
    token BLOB NOT NULL, sender BLOB NOT NULL, recipient BLOB NOT NULL, value BLOB NOT NULL,
    PRIMARY KEY (receipt_id, log_index)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS tokens (address TEXT PRIMARY KEY, decimals INTEGER NOT NULL, symbol TEXT, name TEXT);
  CREATE TABLE IF NOT EXISTS addresses (address TEXT PRIMARY KEY, kind TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS fills (
    tx TEXT NOT NULL, log_index INTEGER NOT NULL, block INTEGER NOT NULL, ts INTEGER NOT NULL,
    wallet TEXT NOT NULL, token TEXT NOT NULL, side TEXT NOT NULL,
    amount REAL NOT NULL, usd REAL, price REAL, priced TEXT NOT NULL,
    /**
     * The token's whole supply as the feed implied it when this fill landed, stamped once
     * and never touched again: the fill's own price over it is the market cap it was
     * bought at. Everything else on a row can be worked out later from a receipt or asked
     * of a feed that answers for the token now — this cannot. A token that burns supply
     * after a trade leaves nothing behind that says what the supply used to be, and the
     * market cap taken over today's would read lower than the one that was paid.
     * NULL on a row older than the column, which falls back to the feed's supply now.
     */
    supply REAL,
    /** Dusting, decided when the fill is reconstructed and cleared if the token turns out real. */
    dust INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tx, log_index)
  );
  CREATE INDEX IF NOT EXISTS fills_ts ON fills (ts);
  CREATE INDEX IF NOT EXISTS fills_wallet_token_ts ON fills (wallet, token, ts);
  CREATE INDEX IF NOT EXISTS fills_token_ts ON fills (token, ts);
  CREATE TABLE IF NOT EXISTS prices (
    token TEXT PRIMARY KEY, price_usd REAL NOT NULL, liquidity_usd REAL, change24 REAL,
    pair_created_at INTEGER, pair_address TEXT, updated_at INTEGER NOT NULL,
    /** The rest of the feed's card, read in the same call: the token's hour, its market-wide day, its size, its picture. */
    change1h REAL, change5m REAL, volume24 REAL, buys24 INTEGER, sells24 INTEGER, market_cap REAL, fdv REAL,
    dex TEXT, image_url TEXT
  );
  /**
   * Who a tracked trader is, as fomo shows them. Only the identity is kept: the numbers on
   * both screens are walked from this tape's own fills, and a figure that cannot be checked
   * against the chain has no business sitting next to one that can.
   */
  CREATE TABLE IF NOT EXISTS traders (
    handle TEXT PRIMARY KEY, id TEXT, display_name TEXT, avatar_url TEXT, clan TEXT,
    verified INTEGER NOT NULL DEFAULT 0, followers INTEGER, updated_at INTEGER NOT NULL
  );
  /**
   * What each bag looked like on the hour — how many wallets were long it and what that
   * was worth — so the screen can say whether the tracked traders are piling in or leaving
   * over the selected window. Measured off the fills, like the bag itself.
   *
   * Named for the hour rather than for history because the old bag_history table counted
   * something else: the three positions fomo published per trader. A row of that kind
   * inside a window would be diffed against a wallet count it has nothing to do with, so
   * the new measure gets a new table and the old one is dropped below.
   */
  /**
   * What each wallet holds of each token, read off the fills and kept: net amount, and the
   * cost of the buys that were priced. Every screen that says anything about a position —
   * the bags, their holders, the tokens worth quoting, the ones still without a name —
   * starts from this, and deriving it on each of those reads was a grouped pass over the
   * whole tape a few times a second at busy moments.
   *
   * Keyed by token before wallet, which is the order every reader wants: each of them groups
   * by token or asks for a handful by name, and against the other order that is a sort of the
   * whole table on every read.
   *
   * Not a source of truth: the fills are, and this is rebuilt from them, per token as they
   * land and in full after anything wholesale. A row whose amount is at or below zero is a
   * position that was closed, kept because the token's first buy and last fill are read
   * from here too.
   */
  CREATE TABLE IF NOT EXISTS positions (
    wallet TEXT NOT NULL, token TEXT NOT NULL,
    amount REAL NOT NULL, gross REAL NOT NULL, bought_usd REAL NOT NULL, bought_amount REAL NOT NULL,
    last_ts INTEGER NOT NULL, first_buy_ts INTEGER,
    PRIMARY KEY (token, wallet)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS bag_hours (
    token TEXT NOT NULL, network INTEGER NOT NULL, ts INTEGER NOT NULL,
    holders INTEGER NOT NULL, value REAL NOT NULL, pnl REAL,
    PRIMARY KEY (token, network, ts)
  ) WITHOUT ROWID;
  /**
   * The average-cost books, walked over every fill and written by a job: the walk has to be
   * sequential, since a sell is priced against the cost of the buys before it. A trip counts
   * in the window it closed in; what is open has no window and is marked now; free is what
   * selling never-paid-for inventory brought in, which is not profit on anything.
   */
  CREATE TABLE IF NOT EXISTS trader_stats (
    wallet TEXT PRIMARY KEY,
    realized_24h REAL NOT NULL, realized_7d REAL NOT NULL, realized_30d REAL NOT NULL, realized_all REAL NOT NULL,
    trips_24h INTEGER NOT NULL, trips_7d INTEGER NOT NULL, trips_30d INTEGER NOT NULL, trips_all INTEGER NOT NULL,
    wins_24h INTEGER NOT NULL, wins_7d INTEGER NOT NULL, wins_30d INTEGER NOT NULL, wins_all INTEGER NOT NULL,
    unrealized REAL NOT NULL, open_value REAL NOT NULL, open_tokens INTEGER NOT NULL, free REAL NOT NULL,
    buys INTEGER NOT NULL, sells INTEGER NOT NULL, volume REAL NOT NULL, tokens INTEGER NOT NULL,
    first_ts INTEGER, last_ts INTEGER, computed_at INTEGER NOT NULL
  );
  /** Small named values that survive a restart: the resume cursor, the feed's source. */
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  /**
   * And what fomo used to fill in, now that every number on both screens is walked from
   * the fills: the positions it published per trader, the cards it priced them with, and
   * the hourly counts taken off them. Not migrations — nothing is carried across, and a
   * database that is thrown away never sees these lines. They are here so a database that
   * is not thrown away stops paying for tables no code reads.
   */
  DROP TABLE IF EXISTS holdings;
  DROP TABLE IF EXISTS bag_tokens;
  DROP TABLE IF EXISTS bag_history;
`;
