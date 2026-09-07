/**
 * The addresses the web app draws itself, which both runtimes answer with the app shell.
 * Kept in step with PATH in apps/web/src/url.ts: the web app cannot be imported from here —
 * the dependency runs the other way — so a screen added there is added here too, and one
 * that is not is a 404 before the app ever loads, which is what an unknown address should be.
 */
export const VIEW_PATHS: string[] = ["/", "/traders", "/bags", "/discover"];

/** `/bags/` is `/bags`; nothing else about a path is forgiven. */
export const isViewPath = (pathname: string): boolean =>
  VIEW_PATHS.includes(pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname);
