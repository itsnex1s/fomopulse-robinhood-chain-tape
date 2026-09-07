/**
 * The API's shapes come from the server, so a renamed field fails the typecheck on both sides.
 * The import is type-only and erased at build time; nothing of the server ships in the bundle.
 */
export type * from "../../server/src/api/types.ts";
