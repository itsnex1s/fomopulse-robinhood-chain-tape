/**
 * The whole schema, and the whole story: there are no migrations. A database that does
 * not match is deleted and re-synced from the chain, which is what the receipts are for.
 *
 * Receipts are kept because the pricing rules keep changing: a rebuild replays every
 * fill from the database without touching the chain again. What is kept is what the
 * reconstruction reads — the ERC-20 transfers, one row each, addresses and amounts as
 * bytes — not the node's JSON, which is fifty times larger and mostly other events.
 */
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
  /** fomo's own numbers about a trader: PnL, volume, holdings, avatar. Refreshed, never computed. */
  CREATE TABLE IF NOT EXISTS traders (
    handle TEXT PRIMARY KEY, id TEXT, display_name TEXT, avatar_url TEXT, clan TEXT,
    verified INTEGER NOT NULL DEFAULT 0, followers INTEGER, volume REAL, trades INTEGER,
    holdings INTEGER, top_value REAL,
    pnl_all REAL, pnl_24h REAL, pnl_7d REAL, pnl_30d REAL,
    rank_all INTEGER, rank_24h INTEGER, rank_7d INTEGER, rank_30d INTEGER, updated_at INTEGER NOT NULL
  );
  /** The positions fomo publishes per trader — three each, replaced on every refresh. */
  CREATE TABLE IF NOT EXISTS holdings (
    handle TEXT NOT NULL, token TEXT NOT NULL, network INTEGER NOT NULL, image_url TEXT,
    amount REAL NOT NULL, price REAL, value REAL NOT NULL, pnl REAL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (handle, token, network)
  );
  CREATE INDEX IF NOT EXISTS holdings_token ON holdings (token);
  /**
   * What a held token is called on a chain this tape does not follow. Separate from
   * tokens, which is keyed by address alone: the same address is a different token on
   * BSC and on Base, and these names are read from a feed rather than from the chain.
   */
  CREATE TABLE IF NOT EXISTS bag_tokens (
    token TEXT NOT NULL, network INTEGER NOT NULL, symbol TEXT, name TEXT, updated_at INTEGER NOT NULL,
    /** The feed's quote for a bag off the tracked chain; on it, the quote lives in prices. */
    price REAL, liquidity REAL, change24 REAL, pair_created_at INTEGER, pair_address TEXT, quoted_at INTEGER,
    PRIMARY KEY (token, network)
  );
  /**
   * What each bag looked like at every refresh — holders and value — so the screen can
   * say whether the tracked traders are piling in or leaving over the selected window.
   */
  CREATE TABLE IF NOT EXISTS bag_history (
    token TEXT NOT NULL, network INTEGER NOT NULL, ts INTEGER NOT NULL,
    holders INTEGER NOT NULL, value REAL NOT NULL, pnl REAL,
    PRIMARY KEY (token, network, ts)
  ) WITHOUT ROWID;
  /** Small named values that survive a restart: the resume cursor, the feed's source. */
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
