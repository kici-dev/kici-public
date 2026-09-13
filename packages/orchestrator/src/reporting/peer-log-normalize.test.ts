import { describe, it, expect } from 'vitest';
import { LogStream, type PeerLogChunk } from '@kici-dev/engine';
import { normalizePeerLogChunk } from './peer-log-normalize.js';

function chunkOf(lines: PeerLogChunk['lines']): PeerLogChunk {
  return { type: 'peer.log.chunk', runId: 'run-1', jobId: 'job-1', stepIndex: 0, lines };
}

describe('normalizePeerLogChunk', () => {
  it('emits one group when every line agrees on timestamp and stream', () => {
    const out = normalizePeerLogChunk(
      chunkOf([
        { text: 'a', timestamp: 100, stream: LogStream.enum.stdout },
        { text: 'b', timestamp: 100, stream: LogStream.enum.stdout },
      ]),
    );

    expect(out).toEqual([
      {
        runId: 'run-1',
        jobId: 'job-1',
        stepIndex: 0,
        lines: ['a', 'b'],
        timestamp: 100,
        stream: LogStream.enum.stdout,
      },
    ]);
  });

  it('splits on a stream change, preserving order', () => {
    const out = normalizePeerLogChunk(
      chunkOf([
        { text: 'a', timestamp: 100, stream: LogStream.enum.stdout },
        { text: 'b', timestamp: 100, stream: LogStream.enum.stderr },
        { text: 'c', timestamp: 100, stream: LogStream.enum.stdout },
      ]),
    );

    expect(out.map((g) => [g.lines, g.stream])).toEqual([
      [['a'], LogStream.enum.stdout],
      [['b'], LogStream.enum.stderr],
      [['c'], LogStream.enum.stdout],
    ]);
  });

  it('splits on a timestamp change', () => {
    const out = normalizePeerLogChunk(
      chunkOf([
        { text: 'a', timestamp: 100 },
        { text: 'b', timestamp: 200 },
      ]),
    );

    expect(out.map((g) => [g.lines, g.timestamp])).toEqual([
      [['a'], 100],
      [['b'], 200],
    ]);
  });

  it('keeps an absent stream absent rather than defaulting it', () => {
    const out = normalizePeerLogChunk(chunkOf([{ text: 'a', timestamp: 100 }]));

    expect(out).toHaveLength(1);
    expect(out[0].stream).toBeUndefined();
    expect('stream' in out[0]).toBe(false);
  });

  it('treats an absent stream and stdout as different groups', () => {
    const out = normalizePeerLogChunk(
      chunkOf([
        { text: 'a', timestamp: 100 },
        { text: 'b', timestamp: 100, stream: LogStream.enum.stdout },
      ]),
    );

    expect(out).toHaveLength(2);
  });

  it('returns no groups for an empty chunk', () => {
    expect(normalizePeerLogChunk(chunkOf([]))).toEqual([]);
  });
});
