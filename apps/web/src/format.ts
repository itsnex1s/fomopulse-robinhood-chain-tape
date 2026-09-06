/** Instances are expensive to build and this runs per row, so they are made once. */
const usdFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const compactFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const priceFormat = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 });
const smallFormat = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 });
/** The original stamps every row in New York time, whoever is watching. */
const clockFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/**
 * A fill under half a cent is still a fill: rounded to cents it reads "$0", which says the
 * trade was for nothing rather than for a fraction of a cent. Measured 2026-09-06, a
 * settlement batch left a wallet with 0.0000018 MSFT — nine hundredths of a cent — and the
 * tape showed it as "~$0" beside a four-figure price.
 */
export const usd = (value: number) => (value > 0 && value < 0.005 ? "<$0.01" : `$${usdFormat.format(value)}`);
export const usdCompact = (value: number) => `$${compactFormat.format(value)}`;
/** PnL always carries its sign; a plus is information, not decoration. */
export const signed = (value: number) => `${value < 0 ? "−" : "+"}$${compactFormat.format(Math.abs(value))}`;
export const ago = (ts: number) => {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
};
/** A duration, for ages that run from minutes to years: pool age, time since a first buy. */
export const span = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 2 * 86400) return `${Math.round(s / 3600)}h`;
  if (s < 60 * 86400) return `${Math.round(s / 86400)}d`;
  return `${Math.round(s / (30 * 86400))}mo`;
};
/** A day's change: one decimal below a hundred percent, whole numbers above. */
export const pct = (value: number) =>
  `${value < 0 ? "−" : "+"}${Math.abs(value) >= 100 ? Math.round(Math.abs(value)) : Math.abs(value).toFixed(1)}%`;
export const compact = (value: number) => compactFormat.format(value);
/**
 * A quantity, which on this tape runs from four million tokens down to a millionth of a
 * share: compact above one, significant digits below it. `compact` rounds everything under
 * 0.05 to "0", and a tokenised stock is bought by the dollar rather than by the share —
 * measured 2026-09-06, 276 of the window's thousand rows were stock fills and every one of
 * them was a fraction of a share, so every one of them read "0".
 */
export const amount = (value: number) => (value >= 1 ? compactFormat.format(value) : smallFormat.format(value));
export const price = (value: number) => `$${priceFormat.format(value)}`;
export const clock = (ts: number) => clockFormat.format(new Date(ts * 1000));
export const short = (hash: string) => `${hash.slice(0, 10)}…`;
