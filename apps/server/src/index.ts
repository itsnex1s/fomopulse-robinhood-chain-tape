/**
 * One process: the indexer, the price feed, the REST API and the websocket.
 *
 *   bun run ingest                    catch up, then follow the chain and serve
 *   bun run ingest --once --tail N    read the last N blocks and exit
 *   bun run ingest --from B           start from block B instead of the stored cursor
 *   bun run ingest --poll S           re-read the chain every S seconds (default 12) instead of subscribing
 */
import { toFill } from "./api/fills.ts";
import { site } from "./api/static.ts";
import { broadcast, websocket } from "./api/ws.ts";
import { env, wallets } from "./config.ts";
import { setMeta, startPrune, tapeOfTx } from "./db.ts";
import { cursor } from "./ingest/cursor.ts";
import type { StoredFill } from "./ingest/reconstruct.ts";
import { catchUp, head } from "./ingest/subscribe.ts";
import { type Emit, follow, poll } from "./live.ts";
import { log } from "./log.ts";
import { startBagQuotes } from "./prices/bags.ts";
import { startPrices } from "./prices/feed.ts";
import { startTraders } from "./traders.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const once = args.includes("--once");
const tail = BigInt(flag("tail") ?? 10_000);
const pollSecs = args.includes("--poll") ? (flag("poll") ?? "12") : undefined;

const handles = new Map(wallets.map((w) => [w.address, w.handle]));

/** The tape on stdout, one line per fill. */
function print(fills: StoredFill[]): void {
  for (const f of fills) {
    const time = new Date(f.ts * 1000).toISOString().slice(11, 19);
    const usd = f.usd === null ? f.priced : `${f.priced === "estimate" ? "~" : ""}$${f.usd.toFixed(2)}`;
    console.log(
      `${time} ${f.side.toUpperCase().padEnd(4)} ${usd.padStart(12)}  ${f.token.slice(0, 10)}  ${handles.get(f.wallet) ?? f.wallet}`,
    );
  }
}

async function startBlock(): Promise<bigint> {
  const explicit = flag("from");
  if (explicit) return BigInt(explicit);
  if (cursor.last > 0) return BigInt(cursor.last) + 1n;
  return (await head()) - tail;
}

function serve() {
  const port = Number(process.env.PORT ?? 8080);
  const server = Bun.serve({
    port,
    websocket,
    fetch(request, server) {
      if (new URL(request.url).pathname === "/ws") {
        return server.upgrade(request, { data: undefined })
          ? undefined
          : new Response("expected a websocket", { status: 426 });
      }
      return site.fetch(request, undefined);
    },
  });
  log.info(`serving http://localhost:${port} (/api/status, /api/tape, /ws)`);
  return server;
}

async function main(): Promise<void> {
  const server = once ? undefined : serve();
  // Rows are read back from the database so the socket and the REST tape agree field for field.
  const push = (txs: string[]) => {
    if (!server) return;
    const rows = [...new Set(txs)].flatMap(tapeOfTx).map(toFill);
    if (rows.length > 0) broadcast(server, rows);
  };
  const emit: Emit = (fills) => {
    print(fills);
    push(fills.map((f) => f.tx));
  };

  const from = await startBlock();
  const to = await head();
  log.info(`catching up ${from} → ${to} (${to - from} blocks, ${wallets.length} wallets)`);
  await catchUp(from, to, emit);
  if (once) return;

  setMeta("source", pollSecs === undefined && env.wsUrl ? "websocket" : "polling");
  // Fills without a cash leg wait here at most one tick before they get a price.
  startPrices(push);
  // The bags are quoted from the same feed, on a clock of their own.
  startBagQuotes();
  startPrune();
  // PnL, avatars and holdings come from fomo's own leaderboard; we only store them.
  startTraders();

  if (pollSecs !== undefined) await poll(emit, Number(pollSecs) || 12);
  else if (env.wsUrl) follow(env.wsUrl, emit);
  else await poll(emit, 12);
}

await main();
