import type { RateLimiter } from "./cache.ts";
import type { Tape } from "./tape.ts";

/** What the deployment hands the object: two endpoints, one optional session, one namespace. */
export interface Secrets {
  RPC_HTTP_URL?: string;
  RPC_WS_URL?: string;
  FOMO_ACCESS_TOKEN?: string;
  FOMO_PRIVY_PAT?: string;
  FOMO_REFRESH_TOKEN?: string;
}

export interface Env extends Secrets {
  TAPE: DurableObjectNamespace<Tape>;
  ASSETS: Fetcher;
  /** Optional so a deployment without the binding degrades to no ceiling rather than no site. */
  OBJECT_LIMIT?: RateLimiter;
}
