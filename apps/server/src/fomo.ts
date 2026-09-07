/**
 * Read side of the fomo API: the card and nothing else — handle, display name, avatar,
 * clan, tick. Every number on the screens is walked from this tape's own fills, so a
 * refused session costs the pages their faces and none of their figures. Session: ./privy.ts.
 */
import { fomoConfig } from "./config.ts";
import type { IncomingTrader } from "./db.ts";
import { bearer, renewed } from "./privy.ts";

/**
 * Where the service is and who the tape says it is, from `config/fomo.json`. fomo answers
 * 430 to a request that arrives with no user agent, with curl's, or with a browser's, and a
 * Worker sends none of its own.
 */
const { api: BASE, userAgent: AGENT } = fomoConfig;

export const WINDOWS = ["", "/24h", "/7d", "/30d"] as const;
export type LeaderboardWindow = (typeof WINDOWS)[number];

interface Entry {
  id: string;
  userHandle?: string;
  displayName?: string;
  profilePictureLink?: string | null;
  verified?: boolean;
  followers?: number;
  totalVolume?: number;
  numTrades?: number;
  totalHoldings?: number;
  topHoldings?: {
    tokenAddress?: string;
    networkId?: number;
    imageUrl?: string | null;
    humanAmount?: number;
    price?: number;
    value?: number;
    pnl?: number;
  }[];
  clan?: { name?: string } | null;
  [key: string]: unknown;
}

/**
 * A refusal that carries its status. 401 is a session that ran out and renewal fixes it;
 * 403 is fomo declining this caller with a token it accepted, which nothing here fixes.
 */
export class FomoError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "FomoError";
  }
}

const ask = (path: string, key: string) =>
  fetch(BASE + path, {
    headers: { Authorization: `Bearer ${key}`, "user-agent": AGENT },
    // Bounded for the same reason the price feed is: this runs inside the tick.
    signal: AbortSignal.timeout(10_000),
  });

async function get<T>(path: string): Promise<T> {
  let response = await ask(path, await bearer());
  // A 401 the clock did not see coming is worth one renewal and one retry; `renewed` is
  // what decides it is not too soon to ask again.
  if (response.status === 401) {
    const fresh = await renewed();
    if (fresh) response = await ask(path, fresh);
  }
  // The body is part of the reason: an expired session and a refused caller both answer 401.
  if (!response.ok)
    throw new FomoError(`fomo ${path} → ${response.status} ${(await response.text()).slice(0, 160)}`, response.status);
  const body = (await response.json()) as { responseObject?: unknown };
  return (body.responseObject ?? body) as T;
}

/**
 * One leaderboard row, reduced to the card. fomo publishes PnL, volume, trade counts and
 * three positions beside it; none of that is read any more, because the same numbers are
 * measured here from the chain and an account-wide figure covering four other chains
 * cannot be checked against anything.
 */
export type LeaderboardEntry = IncomingTrader;

export async function leaderboard(window: LeaderboardWindow): Promise<LeaderboardEntry[]> {
  const body = await get<{ leaderboard?: Entry[] } | Entry[]>(`/v2/leaderboard${window}`);
  const list = Array.isArray(body) ? body : (body.leaderboard ?? []);
  return list
    .filter((entry) => entry.userHandle)
    .map((entry) => ({
      handle: entry.userHandle!,
      id: entry.id,
      display_name: entry.displayName ?? null,
      avatar_url: entry.profilePictureLink ?? null,
      clan: entry.clan?.name ?? null,
      verified: entry.verified ? 1 : 0,
      followers: entry.followers ?? null,
    }));
}
