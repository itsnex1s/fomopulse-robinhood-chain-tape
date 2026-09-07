# fomopulse — repo map

A live trade tape: every buy and sell by tracked fomo.family wallets on Robinhood Chain (id 4663),
priced about a second after it lands. Bun and viem read the chain; one Cloudflare Durable Object
holds the tape in production. Read-only — no keys, no signing.

This file is the index. It names every module, what it owns, and what it exports, so the first file
opened is the right one. Read it, then open the two or three files the question actually touches.

## Working rules

Reuse what is here before adding anything: `db.ts` is the whole storage surface, `api/types.ts` the
whole wire contract, `format.ts` and `table.tsx` the whole presentation vocabulary. A helper longer
than five lines almost always already exists under one of those names.

The same TypeScript runs in two places, so a change to `apps/server/src` lands on the self-hosted
Bun process and on the Worker at once. Check both paths before calling a change done.

Comment only what the code cannot say: an external constraint, a unit, an invariant, a rule that
looks wrong until you know why. Three lines is the ceiling. Anything longer is a commit message —
put it in the commit, where git keeps it and no one pays to read it again. Never write history into
a source file: what the code used to do, what was measured on which date, why the previous approach
was dropped. `git log` and `git blame` already hold all of it.

Ship a verifiable check with non-trivial logic: a `bun test` case, a `--once` run, a query. `bun run
check` is lint, typecheck, test and build in one.

## Layout

Three packages and a scripts folder. Dependencies run one way:

    apps/web  →  apps/server/src/api/types.ts        (types only, no runtime import)
    apps/worker  →  apps/server/src                  (the Worker imports the server wholesale)
    scripts  →  apps/server/src
    apps/server  →  config/*.json

`apps/server` never imports from `apps/worker` or `apps/web`. `config/*.json` is data, imported
directly with JSON import attributes and validated at `config.ts` and `limits.ts`.

Runtime dependencies are four: `viem` and `hono` on the server, `react`, `react-dom`,
`@tanstack/react-query` and `zustand` on the web. `bun:sqlite` is the database on Bun; the Worker
aliases that specifier to `apps/worker/src/sqlite.ts`, a shim over Durable Object SQL storage, so
the same queries run unchanged in both.

    apps/
      server/src/        the tape: config, ingestion, storage, pricing, fomo, API
        api/             Hono routes and the wire types
        db/              one file per table group, behind the db.ts barrel
        ingest/          chain → receipts → fills
        prices/          DexScreener quotes and the price feed
      server/test/       bun tests and their fixtures
      web/src/           the SPA
      worker/src/        the Cloudflare edge and the Durable Object
    config/              wallets, chain, fomo, stock tokens, operational limits
    scripts/             one-off and operational tools

## Runtime shape

**Ingestion.** ERC-20 `Transfer` logs are subscribed to over a raw WebSocket with two filters, one
for tracked wallets as sender and one as recipient. Each transaction is fetched whole, stored as
receipt plus transfer rows, and reconstructed into fills: a token leg matched with the USDG or WETH
cash leg in the same transaction. No cash leg means the price feed estimates it, marked `~`. A
monotonic cursor survives restarts; a sweep re-reads the recent past for logs the socket dropped.

**Two runtimes.** `apps/server/src/index.ts` is the Bun process: `Bun.serve`, timers for prices,
bags, traders, the books and pruning, and `live.ts` for the socket. `apps/worker/src/tape.ts` is the Durable
Object: one alarm every fifteen seconds is its pulse, and it prices, catches up, sweeps and asks
fomo on clocks kept in its own storage. `apps/worker/src/index.ts` is the edge in front of it,
serving the built SPA, forwarding `/ws`, and answering `/api/*` out of the colo cache.

**Addresses.** Each screen is a path — `/`, `/traders`, `/bags`, `/discover` — and the two things
worth sending somebody are the query: `?window=` and `?q=`. `apps/web/src/url.ts` is the whole
vocabulary and `useUrl.ts` keeps it in step with the store; the address wins on arrival and on back
and forward, and storage only fills in what it does not say. Both runtimes answer a screen's own
path with the app shell and everything else with a 404, from the one list in `api/views.ts`.

**API.** `/api/tape`, `/api/status`, `/api/overview`, `/api/traders`, `/api/bags`, `/api/discover`, `/api/limits`,
`/api/alive`,
plus `/ws` for the live push. All take `window` and most take `limit`; the tape also takes
`stocks`, `dust` and a `before`/`beforeId` cursor. `api/types.ts` is the single definition of every
response, re-exported type-only by the web app, so a renamed field fails the typecheck on both sides.

**What the readers cost.** Two caches and a ceiling stand between a burst of them and the bill.
The object memoises each answer for its window's lifetime; the colo in front of it holds the
answer for as long as the `x-ttl` header asks, keyed on a canonical query — only the parameters
the API reads, only the values it allows, a row count rounded up to the next step — so the cache
cannot be walked past one row at a time. What a month is on course to walk is measured off the
storage's own count of rows and stretches both lifetimes in proportion once it passes the plan's
allowance, and the platform's rate limiter caps what one address can make the object do, which
is the one thing a cache cannot bound: every value of a cursor is a different, valid page.

**Tables.** `receipts` holds what the chain said, its ERC-20 transfers packed into one value on
the row rather than a row apiece — nothing queries them, and a row apiece was seven eighths of
everything this tape writes; `fills` is the tape; `tokens`,
`addresses` and `prices` are lookups; `trader_stats` is the books, walked from the fills, and
`bag_hours` the hourly snapshot the bag deltas are read against; `traders` holds the cards fomo
shows; `meta` is the key-value store the resume cursor and the fomo session live in.
There are no migrations: `db/schema.ts` is the whole story, and a database that does not match it is
deleted and re-synced from the chain.

**Outbound.** JSON-RPC to the chain over three clients — batched HTTP, unbatched keyed HTTP for
logs, and an unbatched fallback endpoint. DexScreener for quotes and token names. fomo.family for
the leaderboard cards — handle, avatar, clan — behind a Privy bearer that renews itself against
`auth.privy.io`. Nothing on the screens is a number fomo supplied. Every one of those is paced deliberately; read the comment before changing a batch
size or an interval.

## Files

One row per module: `id · path · exports · what it owns`. Types and constants are listed among the
exports. A module with no exports listed is an entry point that runs on import.

### apps/server/src — core

    0  limits.ts        limits ms WINDOWS Limits Ladder validateLimits
                        Every operational number in one place, validated on the way in: retention,
                        the job clocks, the sweep range, what the feed is asked for, how long an
                        answer is held at either cache, what one address may ask of the object,
                        what a month may spend. Served at /api/limits. The
                        constants that decide what a fill IS are not here — they live beside the
                        rule they belong to.
    1  config.ts        chain chainConfig configure wallets fomoConfig QUOTE_TOKENS WALLET_LIST
                        WALLET_SET WALLET_TOPICS Wallet QuoteToken Secrets
                        Validated chain, fomo and wallet config; env settings; the three RPC clients.
                        The most depended-on module in the repo.
    2  db.ts            (barrel)
                        Re-exports the whole storage surface. Import storage from here, not from db/*.
    3  log.ts           log describe
                        stderr logger; first line of an error.
    4  sleep.ts         sleep
                        Portable sleep, used by every pacing loop.
    5  window.ts        since pnlWindow WINDOW_SECONDS
                        Window name → unix start second; maps a window to the books' window.
    6  stocks.ts        isStock stockOf Stock
                        Tokenised-stock registry, keyed by contract address.
    7  fomo.ts          leaderboard WINDOWS LeaderboardEntry LeaderboardWindow FomoError
                        Read side of the fomo API: the leaderboard cards, and nothing numeric.
    8  privy.ts         bearer renewed hasSession sessionState
                        The fomo bearer session: load, expiry, deduplicated renewal, persistence.
    9  traders.ts       maintain refresh reload ranking bookOf ranked traderOf bagList
                        startTraders traderInterval retryInterval leaderboardState quoteBags
                        The leaderboard pass, the standing every screen ranks by, and the two
                        lists — who moved the tape, and what those wallets are still long.
    9b discover.ts      discoverList
                        The discover page: the young pools the tracked wallets are buying into,
                        with the books' rank of everyone in each of them.
    10 pnl.ts           rebuildStats startBooks
                        The books: one sequential walk over every fill, average cost per wallet
                        and token, rewriting trader_stats. Read this before touching a p/l.
    11 live.ts          follow resume poll Emit
                        Bun live mode: subscribe, reconnect with backoff, the sweep timer.
    12 index.ts         (entry)
                        Bun entry point: CLI flags, catch-up, Bun.serve, the background timers.

### apps/server/src/ingest — chain to fills

    13 parse.ts         parse transfers TRANSFER_TOPIC Kind Transfer ParsedReceipt RawReceipt
                        ReceiptInput
                        Receipt shapes; pulls the ERC-20 Transfer logs out of a receipt.
    14 reconstruct.ts   reconstruct participants tokensToResolve StoredFill ReconstructContext
                        Dust DUST_USD DUSTED HANDOUT TRADE
                        Net flows per wallet, trade legs, cash-leg pricing, the dust verdict.
                        The heart of the project; read this before touching anything about a fill.
    15 resolve.ts       resolveTokens resolveKinds readTokens decimals kinds timestampOf
                        Chain lookups: contract kind, token metadata by multicall, block timestamps.
    16 receipt.ts       onLogs processTx IngestLog
                        Per-transaction pipeline: fetch, resolve, store, reconstruct, emit.
    17 cursor.ts        cursor
                        The resume block: monotonic, never advanced past in-flight work.
    18 subscribe.ts     watch catchUp head scanChunk openSocketWith
                        eth_getLogs catch-up with adaptive chunking, and the raw socket subscription
                        with its heartbeat.
    19 sweep.ts         sweeper SWEEP_BLOCKS SWEEP_MARGIN
                        The block range each sweep re-reads, resuming from where the last one ended.
    20 rebuild.ts       rebuildFills repairFills RULES RebuildResult
                        Replays stored receipts through the current rules. RULES is the version
                        stamp: bump it and the object repairs its own fills on the next pass.
    21 lag.ts           sample latencyMs latencySummary
                        Rolling block-to-database latency samples for the status line.

### apps/server/src/db — storage

    22 connection.ts    db
                        Opens the single Database, applies the pragmas and the schema.
    23 schema.ts        SCHEMA
                        The entire DDL. No migrations; a mismatched database is deleted.
    24 meta.ts          getMeta setMeta
                        Key-value rows that survive a restart: the cursor, the source, the session.
    24b logs.ts         packTransfers unpackTransfers carryTransfersOntoReceipts legacyTransfers
                        migrating
                        How a receipt's transfers are packed onto it, and how a database from
                        before that carries its rows across, a bounded slice at a time, before
                        the old table is dropped. A receipt the carry has not reached is read
                        where its transfers still are.
    25 receipts.ts      saveReceipt getReceipt allReceipts transfersOf dateReceipt saveToken
                        saveKind loadDecimals loadKinds namelessTokens receiptCounts StoredReceipt
                        Receipts, transfers, token decimals and names, address kinds.
    26 fills.ts         insertFills tape tapeOfTx tapeStats overview counts deleteFill stampSupply
                        TapeRow TapeCursor OverviewRow
                        The tape table: inserts, the dust pardon, the tape and overview reads.
    26b positions.ts     rebuildPositions refreshPositions refreshHeld positionsReady positionsCount
                        Net position per wallet and token, held as a table instead of derived on
                        every read. Written from the fills: per wallet when a fill lands, per
                        token when a pardon or a price reaches all of it, in full after a prune
                        or a replay. Read this before touching a bag.
    27 prices.ts        savePrice loadPrices tokensToPrice unpricedFills setEstimate dropThinPrices
                        StoredQuote
                        Feed quotes per token, and the repricing of fills that arrived unpriced.
    28 traders.ts       saveTraders allTraders TraderRow IncomingTrader
                        fomo trader cards: identity only, no figures.
    29 bags.ts          tapeBags tapeHolders tapeTokens unnamedBags recordBagHistory RESIDUE
                        PER_QUERY BagRow Holder
                        Bag aggregates off the fills, the holders of a whole page in one query,
                        and the hourly snapshot the window deltas are read against.
    29b discover.ts     discoverTokens discoverBuyers MAX_POOL_AGE MIN_POOL_USD MAX_CHURN
                        DiscoverRow Buyer
                        Young pools with what this tape saw happen in them, and who bought a
                        whole page of them. The cuts that decide what is a discovery live here.
    30 stats.ts         allStats saveStats statsVersion fillsAfter lastPriceOf STAT_WINDOWS
                        StatRow StatFill StatWindow
                        The books table: paged fill reads for the walk, and the version a reader
                        holding a copy checks against.
    31 prune.ts         prune pruneOnce startPrune FILL_DAYS RECEIPT_DAYS
                        Retention horizons and the pruning loop.

### apps/server/src/prices

    32 dexscreener.ts   fetchQuotes fetchNames BATCH MIN_LIQUIDITY SLUGS Quote
                        The DexScreener calls, their batching, and the chain slugs.
    33 feed.ts          refreshPrices startPrices prices
                        The quote pass: quote the stalest tokens, reprice the fills waiting on them.
    34 eth.ts           ethUsd noteEthUsd FLOATING
                        The USD price of the floating quote token, cached.
    35 bags.ts          quoteBags nameBags startBagQuotes
                        Quotes and names for the tokens the tracked wallets are still long.

### apps/server/src/api

    36 types.ts         Fill Trader Bag Discover Status Overview Window Side Priced
                        The entire wire contract. No imports, by design.
    36b views.ts        VIEW_PATHS isViewPath
                        The addresses the app draws itself, which both runtimes answer with the
                        shell. Kept in step with url.ts on the web side and with the Worker's
                        run_worker_first, which a test holds it to.
    37 fills.ts         toFill handleOf
                        A stored tape row becomes the wire Fill; wallet to handle.
    37b budget.ts       spend walked meterRows projected pressure stretch budget BUDGET
                        MAX_STRETCH resetBudget
                        What the month is on course to walk — the storage's own count of rows
                        where the platform keeps one, the answers' own word for it where it does
                        not — and how much longer to hold them for it. The stretch reaches the
                        edge cache through the `x-ttl` header routes.ts sets.
    38 routes.ts        api COUNTED MARKED ttlBy
                        The Hono app: the eight GET routes, the in-process memo in front of them,
                        and the `x-ttl` every answer carries for the edge. All the lifetimes come
                        from config/limits.json.
    39 ws.ts            websocket broadcast
                        Bun's pub/sub socket handlers.
    40 static.ts        site
                        Bun-only static and SPA serving in front of the API.

### apps/worker/src — the Cloudflare runtime

    41 index.ts         (entry)
                        The edge: assets, the /ws forward, and the colo cache for /api/*, keyed on
                        the canonical query and held for as long as the object asks.
    41b cache.ts        canonical throttled tooMany RateLimiter Verdict
                        What the edge decides before the object is reached: the canonical query an
                        answer is filed under, and whether this address has had its minute of it.
    42 tape.ts          Tape
                        The Durable Object: the alarm pulse, the pass budget, the deduplication slot,
                        the beat that /api/alive reports, and the hibernating reader sockets.
    43 app.ts           boot follow resume sweep prices quotes traders repair carry prune session
                        wallet_count
                        The ingestion glue for the object, and the re-export of the Hono app.
    44 socket.ts        upgrade
                        A client WebSocket over fetch upgrade, which the Worker has and Bun does not.
    45 sqlite.ts        Database use bytesUsed rowsRead
                        The bun:sqlite shim over Durable Object SQL storage, and the storage's own
                        count of every row walked, which is what the bill is made of.
    46 env.ts           Env Secrets
                        The binding and secret types.

### apps/web/src

    47 main.tsx         (entry)          React root and the QueryClient defaults.
    48 App.tsx          (component)      Layout, the status and tape queries, the scroll hold.
    49 store.ts         useTape useUi Row View VIEWS WINDOWS MAX_ROWS
                                         The tape store and the persisted UI store.
    50 useFeed.ts       useFeed Feed     One WebSocket for the app, writing straight into the store.
    51 useHotkeys.ts    useHotkeys chorded
                                         Global keys for window, view and filter.
    51b url.ts          readPlace placeUrl viewOf titleOf pushes VIEWS WINDOWS HOME
                        DEFAULT_WINDOW View Place
                                         Where the reader is, spelled as an address.
    51c useUrl.ts       useUrl           The address bar and the store, kept in step.
    52 api.ts           getTape getStatus getTraders getBags getOverview chainName bagUrl
                        tokenUrl txUrl blockUrl tokenExplorerUrl traderUrl fomoTokenUrl
                        TRACKED_CHAIN
                                         The fetch wrappers and every outbound URL the UI builds.
    53 types.ts         (re-export)      The server's api/types.ts, type-only.
    54 format.ts        usd usdCompact compact amount price pct signed short ago clock span
                                         Every number and time the UI prints.
    55 table.tsx        head cell mid wide roomy denseCell num tone sorted useSort SortHeader
                                         The shared table vocabulary: classes, sorting, headers.
    56 Tape.tsx         Tape             The tape table, its memoized row, the filter and the pager.
    57 Traders.tsx      Traders          The traders table: the books, per window.
    58 Bags.tsx         Bags             The bags table shell and footer.
    59 bags-row.tsx     BagRow           One bag row, its delta badge and holder strip.
    60 bags-math.ts     ret retLabel net cost barWidth holderTitle name BY SortKey
                                         Bag arithmetic and the strings derived from it.
    60a Discover.tsx    Discover         The new-token table, its cuts and its footer.
    60b discover-row.tsx DiscoverRow     One young pool: its flow, its multiple, who bought it.
    60c discover-math.ts growth growthLabel churn net keep name CUTS Cuts BY SortKey
                                         What the page measures, and the cuts the reader keeps.
    61 cards.tsx        TokenCard TraderCard Links poolAge vsNowPct NEW_POOL_S THIN_LIQUIDITY
                                         The hover card bodies.
    62 StatusBar.tsx    StatusBar        The header: feed state, controls, the overview numbers.
    63 Avatar.tsx       Avatar           An image with an identicon fallback derived from the address.
    64 Hover.tsx        Hover Rows       The popover and its key-value grid.

### scripts

    65 roster.ts        Rebuilds config/wallets.json by resolving traders' on-chain addresses.
    66 rebuild.ts       Replays stored receipts through the current reconstruction rules.
    67 enrich.ts        One-off leaderboard refresh against a local database.
    68 verify-tape.ts   Diffs our fills against the original site's published tape.
    69 assets.ts        Renders the OG image and the icons through headless Chrome.
    70 load.ts          Synthetic reader load against a deployment.

## Invariants

Addresses and transaction hashes are stored and compared lowercase. `config.ts` refuses to start on
a wallet listed twice.

Amounts from the chain are read as wei-scale integers and only divided by the token's decimals at
the edge of the system. A fill's `usd` is null when nothing could price it; `priced` says which tier
answered — the cash leg, a feed estimate, or nothing.

Fills are keyed on `(tx, log_index)`, so replaying a transaction is idempotent and the sweep can
re-read a block it has already seen for free.

`window` is one of a closed set and anything else means the whole history. `limit` is capped
server-side.

The dust rule keeps handouts and sprays off the tape without hiding a real trade: a fill is only
dusted on value and history, never on size alone.

## Commands

    bun run check       lint, typecheck, test, build — the gate CI runs
    bun test            the suite; run it from the repo root, where bunfig.toml points it at :memory:
    bun run ingest      the Bun process; --once, --tail N, --poll N, --from BLOCK
    bun run web         the SPA against a local server
    bun run cf:dev      build the SPA and run the Worker locally
    bun run cf:deploy   build and deploy the Worker
    bun run rebuild     replay stored receipts through the current rules
    bun run roster      rebuild the tracked wallet list
    bun run verify      diff our tape against the original site
