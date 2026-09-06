/**
 * Read side of the fomo API. Everything shown about a trader — PnL, volume, holdings,
 * avatar — is theirs; we store it and serve it, we do not recompute it. The session the
 * reads go out under, and its renewal, are in ./privy.ts.
 */
import { fomoConfig } from "./config.ts";
import type { HoldingRow, IncomingTrader } from "./db.ts";
import { bearer, renewed } from "./privy.ts";

/**
 * Where the service is and who the tape says it is, from `config/fomo.json`. The user
 * agent is not decoration: fomo answers 430 to a request that arrives with no user agent,
 * with curl's, or with a browser's — a Worker sends none of its own, so the tape says who
 * it is or gets nothing.
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
 * A refusal that carries its status. 401 is a session that ran out and is fixed by
 * renewing it; 403 is fomo declining this caller with a token it accepted — nothing on
 * our side fixes that, and asking again every ten minutes is just noise at their door.
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
  // A 401 the clock did not see coming is worth one renewal and one retry. A second is
  // fomo's answer, and `renewed` is the one that decides it is not too soon to ask.
  if (response.status === 401) {
    const fresh = await renewed();
    if (fresh) response = await ask(path, fresh);
  }
  // The body is part of the reason: a 401 from an expired session and a 401 from a
  // request fomo would not take from this caller read the same without it.
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
