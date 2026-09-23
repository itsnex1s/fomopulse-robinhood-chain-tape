import { limits, ms } from "../limits.ts";
import { log } from "../log.ts";
import { SITE } from "./views.ts";

/**
 * IndexNow: one POST telling every engine that speaks it which addresses changed. Bing,
 * Yandex, Seznam and Naver share one endpoint and pass the submission between themselves,
 * so this is the whole of "tell the engines" for everybody except Google, which does not
 * take it and is told by the sitemap instead.
 *
 * The key is not a secret. Its only job is to say the caller controls the host, which it
 * does by being readable at https://<host>/<key>.txt — see apps/web/public.
 */
export const INDEXNOW_KEY = "5d3397b72e8f1757b6ee0cc8fe42818bf9bacc89a639c9b4";
const ENDPOINT = "https://api.indexnow.org/IndexNow";

/** What one submission may carry. The protocol allows ten thousand; the roster is three
 *  hundred, so this is a ceiling against a bug and not a page size. */
const MOST = 1_000;

/**
 * Tells the engines. `urls` are absolute and on this site, because a submission naming
 * another host is refused whole rather than in part. Returns what the endpoint said, and
 * throws nothing: an engine that will not listen today is not a reason to fail a pass.
 */
export async function announce(urls: string[]): Promise<number | null> {
  const here = urls.filter((url) => url.startsWith(`${SITE}/`)).slice(0, MOST);
  if (here.length === 0) return null;
  const host = new URL(SITE).host;
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host, key: INDEXNOW_KEY, keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`, urlList: here }),
    });
    // 200 is taken, 202 is taken and the key is still being checked. Everything else is a
    // refusal worth seeing in the log, and none of it is worth retrying inside the pass.
    if (response.status !== 200 && response.status !== 202)
      log.warn(`indexnow refused ${here.length} addresses with ${response.status}`);
    return response.status;
  } catch (error) {
    log.warn(`indexnow could not be reached: ${String(error)}`);
    return null;
  }
}

/** The same job on a timer, for the Bun process. The object runs it off its alarm instead;
 *  see apps/worker/src/tape.ts. */
export function startAnnouncing(urls: () => string[], seconds = limits.pace.indexNowSeconds): void {
  const tick = () => {
    announce(urls())
      .then((said) => said !== null && log.info(`told indexnow about the day's addresses, which answered ${said}`))
      .catch((error) => log.error("indexnow", error));
    setTimeout(tick, ms(seconds));
  };
  setTimeout(tick, ms(seconds));
}
