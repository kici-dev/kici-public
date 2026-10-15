/**
 * Chunking for the reconnect `state.replay` payload.
 *
 * The wire schema caps `runs` at `STATE_REPLAY_MAX_RUNS` (500) and the
 * Platform's WS limiter caps a single message at 4 MB with a 2 MB burst
 * refilling at 500 KB/s, so a replay must be split on BOTH axes: a frame that
 * breaches either one is dropped by the Platform, which closes the connection
 * with 4003. Reconnecting does not reduce the run count, so an oversized frame
 * is not transient: the orchestrator would rebuild and resend it forever.
 *
 * Pure and I/O-free so tests can shrink the bounds instead of building 500 runs.
 */

/**
 * Runs per frame. Deliberately below the schema's hard cap of 500 so growth in
 * a run's `jobs` array cannot silently re-break the link.
 */
export const REPLAY_CHUNK_MAX_RUNS = 200;

/** Serialized bytes per frame. A quarter of the limiter's 2 MB burst. */
export const REPLAY_CHUNK_MAX_BYTES = 256 * 1024;

/** Mirrors the Platform limiter's byte refill rate; the pacing divisor. */
export const REPLAY_BYTE_REFILL_BYTES_PER_SEC = 500 * 1024;

export interface ChunkBounds {
  maxRuns: number;
  maxBytes: number;
}

const DEFAULT_BOUNDS: ChunkBounds = {
  maxRuns: REPLAY_CHUNK_MAX_RUNS,
  maxBytes: REPLAY_CHUNK_MAX_BYTES,
};

/**
 * Splits `runs` into frames obeying both bounds, preserving order.
 *
 * A run larger than `maxBytes` is emitted alone. The byte test is guarded on a
 * non-empty current chunk; without the guard an oversized run would loop
 * forever or emit an empty chunk.
 */
export function chunkReplayRuns<T>(
  runs: readonly T[],
  bounds: ChunkBounds = DEFAULT_BOUNDS,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;

  for (const run of runs) {
    const size = Buffer.byteLength(JSON.stringify(run), 'utf8');
    const exceedsCount = current.length + 1 > bounds.maxRuns;
    const exceedsBytes = current.length > 0 && currentBytes + size > bounds.maxBytes;

    if (current.length > 0 && (exceedsCount || exceedsBytes)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }

    current.push(run);
    currentBytes += size;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}
