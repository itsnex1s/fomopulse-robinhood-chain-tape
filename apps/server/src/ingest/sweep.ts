/**
 * A socket can drop a single log without dropping the connection, and the cursor moves
 * on with the logs that did arrive, so nothing would ever look at that block again. The
 * recent past is re-read on a timer through the same path as a cold start: a receipt
 * already stored costs no call and a fill already written is dropped by its primary key.
 *
 * Each sweep starts a little before the last one ended rather than a fixed ten minutes
 * back. The same blocks were read five times over that way, on an endpoint that paces
 * us: measured 2026-09-05 with the fallback endpoint at 2.2 s per 500 blocks, the fixed
 * six-thousand-block reach was twelve chunks and half a minute every two minutes, of
 * which eleven chunks were blocks the sweep before had already read.
 */

/** How far back a sweep reaches when there is no earlier sweep to start from: about 10 minutes. */
export const SWEEP_BLOCKS = 6_000n;
/** Overlap with the last sweep, for a receipt that was still in flight at its tip: about a minute. */
export const SWEEP_MARGIN = 600n;

export function sweeper(window = SWEEP_BLOCKS, margin = SWEEP_MARGIN) {
  let sweptTo: bigint | undefined;
  return {
    /** The range the next sweep reads: never more than `span` blocks below the tip. */
    range(tip: bigint, span = window): [from: bigint, to: bigint] {
      const floor = tip > span ? tip - span : 0n;
      const resume = sweptTo === undefined ? floor : sweptTo > margin ? sweptTo - margin : 0n;
      return [resume > floor ? resume : floor, tip];
    },
    /** Called once the sweep up to `tip` has been stored. */
    done(tip: bigint): void {
      sweptTo = tip;
    },
  };
}
