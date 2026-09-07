/**
 * The session behind every read of the fomo API. `FOMO_ACCESS_TOKEN` is a Privy access token
 * from a logged-in browser and dies in an hour; `FOMO_REFRESH_TOKEN` buys the next one, and
 * `FOMO_PRIVY_PAT` is the second access token Privy wants that request to carry.
 */
import { env, fomoConfig } from "./config.ts";
import { getMeta, setMeta } from "./db.ts";
import { log } from "./log.ts";

/**
 * What a renewal has to name, from `config/fomo.json`: `authorization` — Privy's own access
 * token, not the one fomo takes — `privy-app-id`, `privy-client-id` and `origin` are each
 * required and together all that is; without the last Privy answers "Must specify origin".
 */
const { site: PRIVY_ORIGIN } = fomoConfig;
const { sessions: PRIVY_SESSIONS, appId: PRIVY_APP_ID, clientId: PRIVY_CLIENT_ID } = fomoConfig.privy;

/** Renewed this long before the hour is up, so a leaderboard pass never spends a dead token. */
const RENEW_SKEW_MS = 5 * 60_000;
/**
 * How long any renewal answers for, whether it changed anything or not. Privy tells a session
 * it still considers current to keep what it has, so without a floor the minutes before an
 * expiry would be one renewal per tick.
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
   * What authorises the renewal: the same value comes back from every one, so this is the
   * field worth keeping and the two above are cache. It lasts as long as Privy keeps the
   * session, which is the ceiling on running unattended.
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

/** Runs long enough to be a token, masked: an upstream body can echo the credential it refused. */
export const redact = (text: string): string => text.replace(/[A-Za-z0-9_-]{20,}/g, "…");

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
 * The session in hand: the renewed one if the database holds it, the deployed one if not. A
 * deployment may carry the renewable pair with no access token — an empty bearer reads as
 * expired, so the first call buys one before it asks fomo anything.
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
 * current with `session_update_action: "ignore"` and a null token, so every field falls back
 * to the one it replaces rather than being overwritten with nothing.
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
  if (!response.ok) {
    // The body goes to the log and no further. An auth service can quote back the credential
    // it just refused, and this error is what /api/alive serves to anyone who asks.
    log.warn(`privy sessions → ${response.status}: ${redact((await response.text()).slice(0, 160))}`);
    throw new Error(`privy sessions → ${response.status}`);
  }
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

/** What the pulse reports about the session: whether it exists, renews, and when it dies. */
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
 * A renewal asked for out of turn, after a 401 the clock did not see coming. Answers with the
 * token to try again with, or nothing when it is too soon to ask or there is no way to.
 */
export async function renewed(): Promise<string | undefined> {
  const session = current();
  if (!session?.refresh || !session.pat || Date.now() - triedAt <= RENEW_FLOOR_MS) return undefined;
  await renewOnce(session);
  return (live ?? session).bearer;
}
