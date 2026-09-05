import type { Window } from "./api/types.ts";

/** Seconds in each window the API serves; `all` has no start. */
export const WINDOW_SECONDS: Record<Exclude<Window, "all">, number> = {
  "1h": 3_600,
  "24h": 86_400,
  "7d": 604_800,
  "30d": 2_592_000,
};

/** Where the window starts, as a unix timestamp; `all`, or anything unknown, starts at zero. */
export function since(window: string | undefined): number {
  const seconds = WINDOW_SECONDS[window as keyof typeof WINDOW_SECONDS];
  return seconds === undefined ? 0 : Math.floor(Date.now() / 1000) - seconds;
}

/** fomo publishes PnL by day, week, month and all-time; the hour window reads the day's. */
export const pnlWindow = (window: string): "24h" | "7d" | "30d" | "all" =>
  window === "7d" || window === "30d" || window === "all" ? window : "24h";
