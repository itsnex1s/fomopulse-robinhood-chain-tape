/**
 * A socket can drop a single log without dropping the connection, and the cursor moves on with the
 * logs that did arrive, so nothing would look at that block again. The recent past is re-read on a
 * timer: a stored receipt costs no call and a written fill is dropped by its primary key.
 */
import { limits } from "../limits.ts";

/** How far back a sweep reaches when there is no earlier sweep to start from, and how much it
 *  overlaps the last one for a receipt still in flight at its tip. Blocks, from the limits. */
export const SWEEP_BLOCKS = BigInt(limits.sweep.blocks);
export const SWEEP_MARGIN = BigInt(limits.sweep.marginBlocks);

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

/**
 * How many of these fills sit past everything the socket has accounted for. Below the mark is a
 * log dropped in passing, which is what the sweep is for; above it is a subscription that has
 * stopped without going down.
 */
export const unaccounted = (fills: readonly { block: number }[], delivered: bigint): number =>
  fills.reduce((n, fill) => (BigInt(fill.block) > delivered ? n + 1 : n), 0);
