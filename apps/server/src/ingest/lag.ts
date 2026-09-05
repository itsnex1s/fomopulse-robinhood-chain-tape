/**
 * How long a fill takes from its block to this database — the number a trader means
 * by "delay". It is not the gap since the last trade: on a quiet tape that gap grows
 * by a second every second while the pipeline sits idle at full speed.
 */
const SAMPLES = 20;
/** A catch-up replays blocks that are minutes or hours old; they say nothing about the socket. */
const MAX_AGE_MS = 60_000;

const STALE_MS = 600_000;

const recent: number[] = [];
let last = 0;

export function sample(blockTs: number): void {
  const age = Date.now() - blockTs * 1_000;
  if (age < 0 || age > MAX_AGE_MS) return;
  recent.push(age);
  last = Date.now();
  if (recent.length > SAMPLES) recent.shift();
}

/** Median of the recent samples; null before the first live fill and after a long silence. */
export function latencyMs(): number | null {
  const sorted = fresh();
  return sorted ? Math.round(sorted[sorted.length >> 1]!) : null;
}

/** The same samples in seconds, the shape the original publishes. */
export function latencySummary(): { n: number; median: number; p90: number } | null {
  const sorted = fresh();
  if (!sorted) return null;
  const at = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]! / 10) / 100;
  return { n: sorted.length, median: at(0.5), p90: at(0.9) };
}

function fresh(): number[] | undefined {
  if (recent.length === 0 || Date.now() - last > STALE_MS) return undefined;
  return [...recent].sort((a, b) => a - b);
}
