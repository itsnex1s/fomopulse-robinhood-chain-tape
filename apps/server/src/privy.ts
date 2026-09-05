/**
 * The session behind every read of the fomo API, and how it renews itself.
 *
 * `FOMO_ACCESS_TOKEN` is a Privy access token from a logged-in browser and it dies in an
 * hour; `FOMO_REFRESH_TOKEN` is what buys the next one, and `FOMO_PRIVY_PAT` is the second
 * access token Privy wants to hear that request from. The three are a bootstrap: from there
 * the tape carries its own session, keeps the renewed one in the database, and only needs
 * the browser again if it is down long enough for Privy to end the session behind the
 * refresh token. Without any of it the app runs on the tape alone, and none of the three
 * ever leaves .env.
 */
import { env, fomoConfig } from "./config.ts";
import { getMeta, setMeta } from "./db.ts";
import { log } from "./log.ts";

/**
 * The two public identifiers of the service's Privy app that a renewal has to name,
 * alongside the origin of the site they belong to, from `config/fomo.json`.
 *
 * What a renewal needs was measured on 2026-09-05, against a logged-in browser and then
 * from a shell: `authorization` — Privy's own access token, not the one fomo takes —
 * `privy-app-id`, `privy-client-id` and an `origin` of the site the app belongs to are
 * each required, and together they are all that is. A request without the last is refused
 * with "Must specify origin" before it is read at all. No cookies, no client analytics
 * id, nothing else tied to a browser, which is what makes this a call a server can make.
 */
const { site: PRIVY_ORIGIN } = fomoConfig;
const { sessions: PRIVY_SESSIONS, appId: PRIVY_APP_ID, clientId: PRIVY_CLIENT_ID } = fomoConfig.privy;

/** Renewed this long before the hour is up, so a leaderboard pass never spends a dead token. */
const RENEW_SKEW_MS = 5 * 60_000;
/**
 * How long any renewal answers for, whether it changed anything or not. Privy tells a
 * session it still considers current to keep what it has, and the tick comes back every
 * fifteen seconds: without a floor the five minutes before an expiry would be twenty
 * renewals, and a 401 right after one would ask for a twenty-first.
 */
const RENEW_FLOOR_MS = 60_000;
/** Where the renewed session is kept, so a restart does not fall back to the deployed one. */
const SESSION_KEY = "fomo:session";

interface Session {
  /** What fomo takes: a Privy access token for its app, good for an hour. */
  bearer: string;
  /** What Privy takes to renew: its own access token, good for the same hour. */
  pat: string;
  /**
   * What authorises the renewal. Measured 2026-09-05: the same value comes back from every
   * renewal, so this is the one worth keeping and the two above are cache. It outlives them
   * by as long as Privy keeps the session, which is the ceiling on running unattended.
   */
  refresh: string;
}

/** The session in use, once the secrets and the database have been read. */
let live: Session | undefined;
/** One renewal at a time: a pass asks for four leaderboards at once and they share a token. */
let renewing: Promise<void> | undefined;
let renewedAt = 0;
/** Every attempt, not only the ones that changed something: what the floor is measured from. */
let triedAt = 0;
let renewError: string | null = null;

/** A stored session is this deployment's only if it grew out of the refresh token deployed
 *  now: a new secret starts a new session, and an old row would shadow it forever. */
function stored(seed: Session): Session | undefined {
  try {
    const raw = getMeta(SESSION_KEY);
    if (!raw) return undefined;
    const held = JSON.parse(raw) as Session & { from?: string };
    return held.bearer && held.from === seed.refresh ? held : undefined;
  } catch {
    // No database yet, or a row this version cannot read: the deployed session still works.
    return undefined;
  }
}

/**
 * The session in hand: the renewed one if the database holds it, the deployed one if not.
 * A deployment may carry the renewable pair without an access token at all — an empty
 * bearer reads as expired, so the first call buys one before it asks fomo anything.
 */
function current(): Session | undefined {
  if (live) return live;
  const bearer = env.fomoToken ?? "";
  const pat = env.fomoPat ?? "";
  const refresh = env.fomoRefresh ?? "";
  if (!bearer && !(pat && refresh)) return undefined;
  const seed: Session = { bearer, pat, refresh };
  live = stored(seed) ?? seed;
  return live;
}

/** When a JWT says it dies, in ms. Zero for one this cannot read, which renews it at once. */
function expiresAt(jwt: string): number {
  const payload = jwt.split(".")[1];
  if (!payload) return 0;
  try {
    const base64 = payload
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const { exp } = JSON.parse(atob(base64)) as { exp?: number };
    return typeof exp === "number" ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/**
 * Trades the refresh token for a fresh hour. Privy answers a session it still considers
 * current with `session_update_action: "ignore"` and a null token — nothing to adopt, and
 * what we hold is what it would have issued — so every field falls back to the one it
 * replaces rather than being overwritten with nothing.
 */
async function renew(session: Session): Promise<void> {
  triedAt = Date.now();
  const response = await fetch(PRIVY_SESSIONS, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${session.pat}`,
      "privy-app-id": PRIVY_APP_ID,
      "privy-client-id": PRIVY_CLIENT_ID,
      origin: PRIVY_ORIGIN,
    },
    body: JSON.stringify({ refresh_token: session.refresh }),
    // Bounded like every other call in the tick: a fetch that never settles holds the pass.
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`privy sessions → ${response.status} ${(await response.text()).slice(0, 160)}`);
  const body = (await response.json()) as {
    token?: string | null;
    privy_access_token?: string | null;
    refresh_token?: string | null;
  };
  const next: Session = {
    bearer: body.token || session.bearer,
    pat: body.privy_access_token || session.pat,
    refresh: body.refresh_token || session.refresh,
  };
  live = next;
  renewedAt = Date.now();
  renewError = null;
  // Stamped with the deployed token rather than the returned one, so the row still answers
  // to the secret it came from on the day Privy starts rotating these.
  setMeta(SESSION_KEY, JSON.stringify({ ...next, from: env.fomoRefresh ?? "" }));
}

/** Deduplicated, and never thrown from: a renewal that fails leaves the current token in
 *  place, and the 401 it earns says more about why than this could. */
function renewOnce(session: Session): Promise<void> {
  renewing ??= renew(session)
    .catch((error) => {
      renewError = error instanceof Error ? error.message : String(error);
      log.warn(`fomo session renewal failed: ${renewError}`);
    })
    .finally(() => {
      renewing = undefined;
    });
  return renewing;
}

/** The token to send now, renewed first if its hour is nearly up and there is a way to. */
export async function bearer(): Promise<string> {
  const session = current();
  if (!session) throw new Error("no fomo session: set FOMO_ACCESS_TOKEN, or the renewable pair");
  const now = Date.now();
  if (
    session.refresh &&
    session.pat &&
    now > expiresAt(session.bearer) - RENEW_SKEW_MS &&
    now - triedAt > RENEW_FLOOR_MS
  )
    await renewOnce(session);
  return (live ?? session).bearer;
}

/** Whether there is a session at all, for a caller deciding whether to bother asking. */
export const hasSession = (): boolean => current() !== undefined;

/** What the pulse reports: a session that renews itself and one that is running out read
 *  the same from outside until the hour is up. */
export const sessionState = () => {
  const session = current();
  return {
    token: Boolean(session),
    renews: Boolean(session?.refresh && session.pat),
    expires: session ? new Date(expiresAt(session.bearer)).toISOString() : null,
    renewed: renewedAt === 0 ? null : new Date(renewedAt).toISOString(),
    error: renewError,
  };
};

/**
 * A renewal asked for out of turn, after a 401 the clock did not see coming — a session
 * ended elsewhere, a token renewed by another reader. Answers with the token to try again
 * with, or nothing when it is too soon to ask again or there is no way to ask at all.
 */
export async function renewed(): Promise<string | undefined> {
  const session = current();
  if (!session?.refresh || !session.pat || Date.now() - triedAt <= RENEW_FLOOR_MS) return undefined;
  await renewOnce(session);
  return (live ?? session).bearer;
}
