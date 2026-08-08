import { describe, expect, it } from 'vitest';
import { STATE_REPLAY_MAX_RUNS } from '@kici-dev/engine';
import {
  chunkReplayRuns,
  REPLAY_CHUNK_MAX_BYTES,
  REPLAY_CHUNK_MAX_RUNS,
  type ChunkBounds,
} from './replay-chunker.js';

/** Small bounds keep the tests readable; production bounds are asserted separately. */
const BOUNDS: ChunkBounds = { maxRuns: 3, maxBytes: 1024 };

/** A run whose serialized size is approximately `bytes`. */
function runOfSize(id: string, bytes: number): { runId: string; pad: string } {
  return { runId: id, pad: 'x'.repeat(Math.max(0, bytes - 40)) };
}

describe('chunkReplayRuns', () => {
  it('returns no chunks for an empty list', () => {
    expect(chunkReplayRuns([], BOUNDS)).toEqual([]);
  });

  it('returns a single chunk for a single run', () => {
    const runs = [{ runId: 'a' }];
    expect(chunkReplayRuns(runs, BOUNDS)).toEqual([[{ runId: 'a' }]]);
  });

  it('keeps exactly maxRuns in one chunk', () => {
    const runs = [{ runId: 'a' }, { runId: 'b' }, { runId: 'c' }];
    const chunks = chunkReplayRuns(runs, BOUNDS);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(3);
  });

  it('splits at maxRuns + 1', () => {
    const runs = [{ runId: 'a' }, { runId: 'b' }, { runId: 'c' }, { runId: 'd' }];
    const chunks = chunkReplayRuns(runs, BOUNDS);
    expect(chunks.map((c) => c.length)).toEqual([3, 1]);
  });

  it('splits on the byte bound before the count bound', () => {
    // Two 600-byte runs exceed the 1024-byte bound, though 2 < maxRuns of 3.
    const runs = [runOfSize('a', 600), runOfSize('b', 600)];
    const chunks = chunkReplayRuns(runs, BOUNDS);
    expect(chunks.map((c) => c.length)).toEqual([1, 1]);
  });

  it('gives an oversized single run its own chunk rather than looping or emitting an empty chunk', () => {
    const runs = [runOfSize('big', 5000), { runId: 'small' }];
    const chunks = chunkReplayRuns(runs, BOUNDS);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(1);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
  });

  it('preserves input order across chunks', () => {
    const runs = ['a', 'b', 'c', 'd', 'e'].map((runId) => ({ runId }));
    const flat = chunkReplayRuns(runs, BOUNDS).flat();
    expect(flat.map((r) => r.runId)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('defaults to the production bounds', () => {
    expect(REPLAY_CHUNK_MAX_RUNS).toBe(200);
    expect(REPLAY_CHUNK_MAX_BYTES).toBe(256 * 1024);
    const runs = Array.from({ length: 201 }, (_, i) => ({ runId: `r${i}` }));
    expect(chunkReplayRuns(runs)).toHaveLength(2);
  });

  it('keeps the run bound at or under the wire cap', () => {
    // The load-bearing relation, asserted directly rather than by restating 500:
    // a chunk bound above STATE_REPLAY_MAX_RUNS would rebuild exactly the
    // unsendable frame this module exists to prevent. Raising the bound past the
    // schema cap must fail here rather than in production.
    expect(REPLAY_CHUNK_MAX_RUNS).toBeLessThanOrEqual(STATE_REPLAY_MAX_RUNS);
  });

  it('never emits a chunk breaching the wire cap, for the payload that broke staging', () => {
    // 827 runs is the exact count that wedged the staging orchestrator: the
    // Platform rejects any frame above STATE_REPLAY_MAX_RUNS (500) with a 4003
    // close, and the orchestrator reconnects and resends the identical frame.
    const runs = Array.from({ length: 827 }, (_, i) => ({ runId: `r${i}` }));
    const chunks = chunkReplayRuns(runs);
    expect(chunks.every((c) => c.length <= 500)).toBe(true);
    expect(chunks.flat()).toHaveLength(827);
  });
});
