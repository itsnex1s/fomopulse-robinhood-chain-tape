# Contributing

fomopulse is a read-only tape of what tracked wallets buy and sell on-chain. Everything it
shows is public blockchain data; it holds no keys and never sends a transaction. Most useful
contributions are a wallet, a chain, a real receipt that the reconstruction gets wrong, or a
screen the original site has and we do not yet.

## Setup

```bash
bun install                 # Bun 1.2.9 or newer; CI runs 1.3.2
cp .env.example .env        # optional: RPC endpoints; the public one works for --once
bun run check               # lint, typecheck, tests, web build — what CI runs
bun run ingest --once --tail 3000   # five minutes of real fills, no account needed
```

`bun run web` starts Vite on 5173 and proxies `/api` and `/ws` to the ingester on 8080.

## Where things live

| Path | What |
|---|---|
| `config/wallets.json` | tracked wallets: `handle`, `address`, `followers`, `profile_url` |
| `config/chains/*.json` | one file per chain: RPC, explorer, quote tokens, Multicall3, DexScreener slug |
| `config/fomo.json` (the fomo API and site, and the public identifiers of its Privy app the
  session renewal names), `config/stock-tokens.json` | Robinhood's registry of tokenised stocks, for the `STK` flag |
| `apps/server/src/ingest/` | subscription, receipts, reconstruction of fills, resume cursor |
| `apps/server/src/prices/` | DexScreener feed for fills no cash leg can price |
| `apps/server/src/api/` | REST routes, the websocket, the built web app |
| `apps/web/src/` | the terminal: React 19, Zustand for the tape, TanStack Query for the rest |
| `apps/server/test/` | tests; `fixtures/` holds real receipts |
| `scripts/` | roster from fomo, verify against the original site, rebuild fills, render assets |

## Adding a wallet

Append an object to `config/wallets.json` and open a pull request:

```json
{ "handle": "trader", "address": "0x…", "followers": 1234, "profile_url": "https://fomo.family/profile/trader" }
```

`address` is the wallet the tokens land on, which on Robinhood Chain is the trader's
EIP-7702 delegated address, not the `evmAddress` fomo shows. `scripts/roster.ts` resolves it
from a swap, and its header comment explains how. Addresses are lowercased on load and
must be unique.

## Adding a chain

Copy `config/chains/robinhood.json`, fill in the chain id, RPC, explorer, Multicall3 and the
DexScreener slug, and list the quote tokens: stablecoins with `"usd": 1`, the wrapped native
coin without a fixed value (it is priced through the feed). The reconstruction only assumes
that trades settle in one of those quote tokens; it does not depend on the DEX.

## Fixing the reconstruction

Every fill is rebuilt from a stored receipt, so a wrong number is a test waiting to be written:

1. Fetch the receipt: `eth_getTransactionReceipt` from any RPC, save the whole JSON response
   under `apps/server/test/fixtures/<what-it-shows>.json`.
2. Add a case to `apps/server/test/reconstruct.test.ts` with the numbers the original site
   published for that transaction, or the on-chain truth.
3. Change `reconstruct.ts` until it passes without breaking the others.
4. `bun run rebuild` replays every stored receipt through the new rule with no chain calls.

The pricing rules live in `apps/server/src/ingest/reconstruct.ts`, each with the comment
that says why; keep those comments true when you change the code.

## Style

- `bun run format` before committing; Biome is the only formatter and linter.
- Comments explain why, not what. Names are full words.
- Commit messages describe the change and the reason in plain prose, no trailers.
- `stdout` is the tape; everything a human reads goes to `stderr` through `log.ts`.
- Keep the API shape of robinhoodtrenches.com for the endpoints it has, so clients written
  against that site keep working.

## Pull requests

`bun run check` green, one topic per pull request, and a sentence on how you verified it
(a fixture, a `bun run verify` window, a screenshot for the web).

## Data and manners

Wallet lists are public data and the tape is read-only. `scripts/roster.ts` reads fomo's
leaderboard through your own logged-in session and is a maintainer's tool, not something the
service runs; keep it that way.
