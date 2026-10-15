/**
 * Position of a fan-out child: a `runsOnAll` host execution (one per matching
 * roster host) or a matrix combination. Hosts sort by `agentId`, matrix
 * combinations by variant label, so `first` is reproducible across re-runs.
 */
export interface FanoutPosition {
  /** 0-based. */
  index: number;
  total: number;
  first: boolean;
  last: boolean;
}
