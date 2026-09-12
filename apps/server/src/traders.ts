import { measure } from "./api/budget.ts";
import type { Bag, Trader } from "./api/types.ts";
import { chainConfig, wallets } from "./config.ts";
import {
  allStats,
  allTraders,
  getMeta,
  STAT_WINDOWS,
  type StatRow,
  type StatWindow,
  saveTraders,
  setMeta,
  statsVersion,
  type TraderRow,
  tapeBags,
  tapeHolders,
  tapeStats,
} from "./db.ts";
import { FomoError, leaderboard, WINDOWS } from "./fomo.ts";
import { limits, ms } from "./limits.ts";
import { log } from "./log.ts";
import { nameBags, quoteBags } from "./prices/bags.ts";
import { hasSession } from "./privy.ts";
import { sleep } from "./sleep.ts";
import { isStock } from "./stocks.ts";
import { pnlWindow } from "./window.ts";

/** Re-exported for the worker, which alarms quotes and trader maintenance separately. */
export { quoteBags };

/** The cards fomo shows for the tracked handles, by handle; every read here goes through
 *  this map. The two lists built below are measured on the tape, not read from fomo. */
let byHandle = new Map<string, TraderRow>();

export function reload(): void {
  byHandle = new Map(allTraders().map((row) => [row.handle, row]));
}
reload();

export const traderOf = (handle: string): TraderRow | undefined => byHandle.get(handle);

/** What a wallet made in a window: the trips it closed there plus what it is still holding. */
const totalIn = (row: StatRow, window: StatWindow): number => row[`realized_${window}`] + row.unrealized;

/**
 * Everyone's standing: the books by wallet and, per window, the place each takes among
 * them. Ranked here over every wallet with books, so a wallet is #7 on the tape, on the
 * traders page and at any page size. Held until the walk writes new books.
 */
interface Standing {
  books: Map<string, StatRow>;
  rank: Map<StatWindow, Map<string, number>>;
}
let bookCache: { version: number; standing: Standing } | undefined;

function standing(): Standing {
  if (bookCache && bookCache.version === statsVersion()) return bookCache.standing;
  const rows = allStats();
  const rank = new Map<StatWindow, Map<string, number>>();
  for (const window of STAT_WINDOWS) {
    const place = new Map<string, number>();
    let n = 0;
    for (const row of [...rows].sort((a, b) => totalIn(b, window) - totalIn(a, window))) place.set(row.wallet, ++n);
    rank.set(window, place);
  }
  const fresh: Standing = { books: new Map(rows.map((row) => [row.wallet, row])), rank };
  bookCache = { version: statsVersion(), standing: fresh };
  return fresh;
}

/** The day's books for one wallet, for the trader card on a tape row. */
export function bookOf(wallet: string): { rank: number | null; pnl: number | null } {
  const { books, rank } = standing();
  const row = books.get(wallet);
  return { rank: rank.get("24h")?.get(wallet) ?? null, pnl: row === undefined ? null : totalIn(row, "24h") };
}

/** Whether fomo has ever answered for this database. Nothing stored means no ranks, no
 *  PnL and no avatars on screen, which is not a state worth holding for ten minutes. */
export function ranked(): boolean {
  for (const row of byHandle.values()) if (row.updated_at !== null) return true;
  return false;
}

/** Failed leaderboard reads in a row; cleared by the next one that answers. */
let failures = 0;
/**
 * How long to leave fomo alone after it refuses us outright. A 403 arrives on a token fomo
 * itself accepted — the session is fine and the caller is not welcome — so nothing we do
 * between now and then changes the answer.
 */
const REFUSED_MS = ms(limits.pace.tradersRefusedSeconds);
/**
 * When it is worth asking again, and what was said last time. Kept in the database as well as
 * in memory: a deploy or an eviction replaces the object, and a stand-down that starts over
 * every restart is not a stand-down at all.
 */
const REFUSED_KEY = "fomo:refused";
let refusedUntil = 0;
let refusal: string | null = null;
let readRefusal = false;

/** The stored refusal, read once per process and kept in step with it afterwards. */
function refused(): { until: number; why: string | null } {
  if (!readRefusal) {
    readRefusal = true;
    try {
      const raw = getMeta(REFUSED_KEY);
      if (raw) {
        const held = JSON.parse(raw) as { until: number; why: string };
        refusedUntil = held.until;
        refusal = held.why;
      }
    } catch {
      // no database yet, or a row this version cannot read: nothing to stand down for
    }
  }
  return { until: refusedUntil, why: refusal };
}

function stand(until: number, why: string | null): void {
  refusedUntil = until;
  refusal = why;
  readRefusal = true;
  setMeta(REFUSED_KEY, why === null ? "" : JSON.stringify({ until, why }));
}

/**
 * How long to wait before asking fomo again: the regular interval once the table has answers,
 * the cold one while it has none, doubling after every failed read so a dead token is asked a
 * few times an hour rather than four times a minute.
 */
export const retryInterval = (
  regularMs: number,
  coldMs: number,
  answered: boolean,
  failed: number,
  refusedForMs = 0,
): number => {
  // A refusal outranks both clocks: the cold interval exists to fill an empty table fast,
  // which is the last thing to do at a door that answered 403.
  if (refusedForMs > 0) return Math.max(refusedForMs, regularMs);
  return answered ? regularMs : Math.min(regularMs, coldMs * 2 ** failed);
};
export const traderInterval = (
  regularMs = ms(limits.pace.tradersSeconds),
  coldMs = ms(limits.pace.tradersColdSeconds),
): number => retryInterval(regularMs, coldMs, ranked(), failures, Math.max(0, refused().until - Date.now()));

/**
 * Pull the leaderboard for the avatars on it. All four windows, because each lists a
 * different top and between them they cover more of the tracked wallets than any one
 * does; nothing but the card is kept from any of them.
 */
export async function refresh(): Promise<number> {
  const at = Math.floor(Date.now() / 1000);
  let seen = 0;
  for (const window of WINDOWS) {
    const rows = await leaderboard(window);
    saveTraders(
      rows.map(({ handle, id, display_name, avatar_url, clan, verified, followers }) => ({
        handle,
        id,
        display_name,
        avatar_url,
        clan,
        verified,
        followers,
      })),
      at,
    );
    seen = Math.max(seen, rows.length);
    await sleep(300);
  }
  reload();
  return seen;
}

/**
 * One round of everything fomo and the feed have to say about a trader: the leaderboard, then
 * the names of the tokens they hold. A failure is expected and not fatal — the stored numbers
 * stay and the UI shows how old they are.
 */
export async function maintain(): Promise<void> {
  const failure = hasSession()
    ? await refresh().then(
        (n) => {
          log.info(`traders: ${n} from the leaderboard`);
          failures = 0;
          if (refused().why !== null) stand(0, null);
          return null;
        },
        (error: unknown) => {
          failures++;
          if (error instanceof FomoError && error.status === 403) stand(Date.now() + REFUSED_MS, error.message);
          return error;
        },
      )
    : null;
  // Symbols and names come from the chain and the price feed, so an expired fomo session
  // does not stop them.
  await nameBags();
  // Raised only once the naming has run: swallowed here, an expired token would show as a
  // tape with no ranks and nothing anywhere to say why.
  if (failure) throw failure;
}

/**
 * The leaderboard on a timer; the bags are named right after each read, so a position that
 * arrived just now is not a hex string for ten minutes. Logged, never thrown: a rejection out
 * of the tick would end the loop with it.
 */
export function startTraders(): void {
  if (!hasSession()) log.warn("no fomo session is deployed; trader PnL and avatars stay as last stored");
  const tick = async () => {
    await maintain().catch((error) => log.error("traders", error));
    setTimeout(tick, traderInterval());
  };
  void tick();
}

/**
 * What the fomo side of the screen is doing, for a reader looking at numbers that have not
 * moved: without it a stand-down reads exactly like a quiet leaderboard.
 */
export const leaderboardState = () => {
  let updatedAt: number | null = null;
  for (const row of byHandle.values())
    if (row.updated_at !== null && (updatedAt === null || row.updated_at > updatedAt)) updatedAt = row.updated_at;
  const { until, why } = refused();
  return {
    updated_at: updatedAt,
    /** Set while fomo is refusing this caller; the reason as fomo gave it. */
    refused: why,
    /** Seconds until the next attempt, when there is a reason to wait. */
    asking_again_in: until > Date.now() ? Math.round((until - Date.now()) / 1000) : null,
  };
};

const walletOf = new Map(wallets.map((w) => [w.address, w]));

/**
 * Who moved the tape in this window and what they made doing it, all of it measured here.
 * The books cover the page's window; what is still open is marked now, because a position
 * has no window, and `total` is the two together.
 */
export function ranking(sinceTs: number, window: string, limit: number): Trader[] {
  const label = pnlWindow(window);
  const stats = new Map(measure("traders:tape", () => tapeStats(sinceTs)).map((row) => [row.wallet, row]));
  const { books, rank } = measure("traders:books", standing);
  const place = rank.get(label);
  // Every tracked wallet is a row, traded or not: an empty `here` says a name is between
  // trades better than an absent row does.
  const rows = [...new Set([...wallets.map((w) => w.address as string), ...stats.keys()])].map((address) => {
    const row = stats.get(address);
    const book = books.get(address);
    const wallet = walletOf.get(address as `0x${string}`);
    const handle = wallet?.handle ?? address.slice(0, 10);
    const fomo = byHandle.get(handle);
    const realized = book ? book[`realized_${label}`] : null;
    return {
      handle,
      address,
      display_name: fomo?.display_name ?? wallet?.display_name ?? null,
      avatar_url: fomo?.avatar_url ?? null,
      clan: fomo?.clan ?? null,
      verified: fomo?.verified ?? 0,
      followers: fomo?.followers ?? wallet?.followers ?? null,
      profile_url: wallet?.profile_url ?? null,
      fills: row?.fills ?? 0,
      tape_volume: row?.volume ?? 0,
      last_ts: row?.last_ts ?? null,
      pnl_window: label,
      realized,
      unrealized: book?.unrealized ?? null,
      total: book === undefined ? null : totalIn(book, label),
      trips: book ? book[`trips_${label}`] : null,
      wins: book ? book[`wins_${label}`] : null,
      open_value: book?.open_value ?? null,
      open_tokens: book?.open_tokens ?? null,
      free: book?.free ?? null,
      tokens: book?.tokens ?? null,
      first_ts: book?.first_ts ?? null,
      stats_at: book?.computed_at ?? null,
      rank: place?.get(address) ?? null,
    };
  });

  // Loudest on this tape first, then the strongest books among the ones that sat still.
  return rows
    .sort((a, b) => b.tape_volume - a.tape_volume || (b.total ?? -Infinity) - (a.total ?? -Infinity) || 0)
    .slice(0, limit);
}

/** What the tracked traders are sitting in, by token: net positions off the fills, marked
 *  at the feed's price, with the token's flow inside the window beside them. */
export function bagList(sinceTs: number, limit: number): Bag[] {
  const bags = measure("bags:page", () => tapeBags(sinceTs, limit));
  const holders = measure("bags:holders", () => tapeHolders(bags.map((bag) => bag.token)));
  return bags.map((bag): Bag => {
    const firstBuyer = bag.first_buyer ? walletOf.get(bag.first_buyer as `0x${string}`) : undefined;
    const topHolder = bag.top_holder ? walletOf.get(bag.top_holder as `0x${string}`) : undefined;
    return {
      ...bag,
      network: chainConfig.id,
      is_stock: isStock(bag.token) ? 1 : 0,
      first_buyer: firstBuyer?.handle ?? bag.first_buyer,
      top_holder: topHolder?.handle ?? bag.top_holder,
      holders_list: (holders.get(bag.token) ?? []).flatMap((h) => {
        // Unmarked positions have no dollars to show; the count in `holders` keeps them.
        if (h.value === null) return [];
        const wallet = walletOf.get(h.wallet as `0x${string}`);
        return [
          {
            handle: wallet?.handle ?? h.wallet.slice(0, 10),
            value: h.value,
            pnl: null,
            avatar_url: wallet ? (byHandle.get(wallet.handle)?.avatar_url ?? null) : null,
          },
        ];
      }),
    };
  });
}
