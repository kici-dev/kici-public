/**
 * Deterministic position of a fan-out child within its fan-out.
 *
 * A fan-out child is one of:
 * - a `runsOnAll` host execution (one pinned execution per matching roster host), or
 * - a matrix combination (one execution per expanded combination).
 *
 * The order is deterministic: host fan-out is sorted by `agentId`, matrix fan-out by
 * its variant label, so `first` is always reproducible across re-runs.
 */
export interface FanoutPosition {
  /** 0-based position in the deterministically-ordered fan-out. */
  index: number;
  /** Number of children in this fan-out. */
  total: number;
  /** Whether this is the first child (`index === 0`). */
  first: boolean;
  /** Whether this is the last child (`index === total - 1`). */
  last: boolean;
}
