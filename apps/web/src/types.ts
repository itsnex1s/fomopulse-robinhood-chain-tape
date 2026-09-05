/**
 * The API's shapes come from the server, which annotates its handlers with them, so the
 * two sides cannot drift: a renamed field fails the typecheck on both. The import is
 * type-only and erased at build time; nothing of the server ships in the bundle.
 */
export type * from "../../server/src/api/types.ts";
