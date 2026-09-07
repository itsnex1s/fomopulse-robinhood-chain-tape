/**
 * Read side of the fomo API: PnL, volume, holdings and avatars are fomo's own numbers,
 * stored and served, never recomputed. The session they go out under is in ./privy.ts.
 */
import { fomoConfig } from "./config.ts";
import type { HoldingRow, IncomingTrader } from "./db.ts";
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

/** `pnl24h`, `pnl7d`, `pnl30d`, `pnlAllTime` — whichever the window returned. */
const pnlOf = (entry: Entry): number | null => {
  const hit = Object.entries(entry).find(([key]) => key.toLowerCase().startsWith("pnl"));
  return typeof hit?.[1] === "number" ? hit[1] : null;
};

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

/** One leaderboard row as fomo publishes it: the card, and the positions shown on it. */
export type LeaderboardEntry = IncomingTrader & { holdings_list: HoldingRow[] };

export async function leaderboard(window: LeaderboardWindow): Promise<LeaderboardEntry[]> {
  const body = await get<{ leaderboard?: Entry[] } | Entry[]>(`/v2/leaderboard${window}`);
  const list = Array.isArray(body) ? body : (body.leaderboard ?? []);
  return list
    .filter((entry) => entry.userHandle)
    .map((entry, index) => ({
      handle: entry.userHandle!,
      rank: index + 1,
      id: entry.id,
      display_name: entry.displayName ?? null,
      avatar_url: entry.profilePictureLink ?? null,
      clan: entry.clan?.name ?? null,
      verified: entry.verified ? 1 : 0,
      followers: entry.followers ?? null,
      volume: entry.totalVolume ?? null,
      trades: entry.numTrades ?? null,
      holdings: entry.totalHoldings ?? null,
      top_value: entry.topHoldings?.reduce((sum, h) => sum + (h.value ?? 0), 0) ?? null,
      pnl: pnlOf(entry),
      holdings_list: (entry.topHoldings ?? [])
        .filter((h) => h.tokenAddress && h.value)
        .map((h) => ({
          token: h.tokenAddress!.toLowerCase(),
          network: h.networkId ?? 0,
          image_url: h.imageUrl ?? null,
          amount: h.humanAmount ?? 0,
          price: h.price ?? null,
          value: h.value ?? 0,
          pnl: h.pnl ?? null,
        })),
    }));
}
