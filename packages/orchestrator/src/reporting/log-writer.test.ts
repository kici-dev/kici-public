import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LogStream } from '@kici-dev/engine';
import { LogWriter } from './log-writer.js';
import type { LogStorage } from './log-storage.js';

// ── Mock LogStorage ──────────────────────────────────────────────

function createMockLogStorage() {
  const appended: Array<{ path: string; data: string }> = [];
  const finalized: string[] = [];

  const storage: LogStorage = {
    append: vi.fn(async () => {}),
    appendStreaming: vi.fn(async (path: string, data: string) => {
      appended.push({ path, data });
    }),
    finalize: vi.fn(async (path: string) => {
      finalized.push(path);
    }),
    read: vi.fn(async () => ({ data: '', cursor: 0, complete: true })),
    exists: vi.fn(async () => false),
    list: vi.fn(async () => []),
  };

  return { storage, appended, finalized };
}

// ── Tests ────────────────────────────────────────────────────────

describe('LogWriter', () => {
  let mockStorage: ReturnType<typeof createMockLogStorage>;
  let writer: LogWriter;

  beforeEach(() => {
    mockStorage = createMockLogStorage();
    writer = new LogWriter({ logStorage: mockStorage.storage });
  });

  describe('appendChunk', () => {
    it('formats lines as JSONL', async () => {
      const timestamp = new Date('2026-01-15T10:30:00Z').getTime();

      await writer.appendChunk('run-1', 'test', 0, ['hello world', 'line 2'], timestamp);

      expect(mockStorage.appended).toHaveLength(1);
      const data = mockStorage.appended[0].data;

      const lines = data.trim().split('\n');
      expect(lines).toHaveLength(2);

      const parsed1 = JSON.parse(lines[0]);
      expect(parsed1).toEqual({
        ts: '2026-01-15T10:30:00.000Z',
        level: 'stdout',
        msg: 'hello world',
        meta: {},
      });

      const parsed2 = JSON.parse(lines[1]);
      expect(parsed2).toEqual({
        ts: '2026-01-15T10:30:00.000Z',
        level: 'stdout',
        msg: 'line 2',
        meta: {},
      });
    });

    it('constructs correct path', async () => {
      await writer.appendChunk('run-abc', 'my-build', 2, ['output'], Date.now());

      expect(mockStorage.appended[0].path).toBe('executions/run-abc/job-my-build/step-2.log');
    });

    it('JSONL contains ts, level, msg fields', async () => {
      const ts = Date.now();
      await writer.appendChunk('run-1', 'test', 0, ['line'], ts);

      const parsed = JSON.parse(mockStorage.appended[0].data.trim());
      expect(parsed).toHaveProperty('ts');
      expect(parsed).toHaveProperty('level');
      expect(parsed).toHaveProperty('msg');
      expect(parsed).toHaveProperty('meta');
    });

    it('skips empty lines array', async () => {
      await writer.appendChunk('run-1', 'test', 0, [], Date.now());

      expect(mockStorage.storage.appendStreaming).not.toHaveBeenCalled();
    });

    it('handles special characters in log lines', async () => {
      const ts = Date.now();
      await writer.appendChunk('run-1', 'test', 0, ['{"nested":"json"}', 'line\twith\ttabs'], ts);

      const data = mockStorage.appended[0].data;
      const lines = data.trim().split('\n');

      // Should be valid JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }

      // Nested JSON should be escaped in msg field
      const parsed = JSON.parse(lines[0]);
      expect(parsed.msg).toBe('{"nested":"json"}');
    });

    it('each JSONL line ends with newline', async () => {
      await writer.appendChunk('run-1', 'test', 0, ['a', 'b', 'c'], Date.now());

      const data = mockStorage.appended[0].data;
      // The combined data should end with a newline
      expect(data.endsWith('\n')).toBe(true);

      // Each line (when split) should have been terminated
      const parts = data.split('\n').filter(Boolean);
      expect(parts).toHaveLength(3);
    });

    it('does not throw when storage fails', async () => {
      (mockStorage.storage.appendStreaming as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('disk full'),
      );

      // Should not throw
      await expect(
        writer.appendChunk('run-1', 'test', 0, ['line'], Date.now()),
      ).resolves.not.toThrow();
    });
  });

  describe('drain', () => {
    it('awaits an in-flight append before resolving', async () => {
      // A slow append that resolves only when we release it. `appendChunk` is
      // called fire-and-forget (not awaited) — the way the agent WS handler
      // calls it — so its storage write is still pending when drain() runs.
      let releaseAppend: (() => void) | undefined;
      let appendCompleted = false;
      (mockStorage.storage.appendStreaming as ReturnType<typeof vi.fn>).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseAppend = () => {
              appendCompleted = true;
              resolve();
            };
          }),
      );

      // Fire-and-forget, mirroring onLogChunk: do NOT await the chunk.
      void writer.appendChunk('run-1', 'test', 0, ['marker:OK'], Date.now());
      // Let the synchronous portion of appendChunk register the pending append.
      await Promise.resolve();

      let drained = false;
      const drainPromise = writer.drain('run-1').then(() => {
        drained = true;
      });

      // drain() must still be pending: the append has not been released.
      await Promise.resolve();
      expect(drained).toBe(false);
      expect(appendCompleted).toBe(false);

      releaseAppend?.();
      await drainPromise;
      expect(drained).toBe(true);
      expect(appendCompleted).toBe(true);
    });

    it('resolves immediately when there are no pending appends for the run', async () => {
      await expect(writer.drain('unknown-run')).resolves.toBeUndefined();
    });

    it('forgets a run once its appends have settled', async () => {
      await writer.appendChunk('run-1', 'test', 0, ['line'], Date.now());
      // The append already settled (appendChunk awaited it), so the pending set
      // for run-1 is cleaned up and a later drain is a no-op.
      await expect(writer.drain('run-1')).resolves.toBeUndefined();
    });

    it('still drains when an append rejected (ordering, not error propagation)', async () => {
      (mockStorage.storage.appendStreaming as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('disk full'),
      );
      void writer.appendChunk('run-1', 'test', 0, ['line'], Date.now());
      await Promise.resolve();
      await expect(writer.drain('run-1')).resolves.toBeUndefined();
    });

    it('awaits pending appends then finalizes every path written in the run', async () => {
      const order: string[] = [];
      (mockStorage.storage.appendStreaming as ReturnType<typeof vi.fn>).mockImplementation(
        async (p: string) => {
          order.push(`append:${p}`);
        },
      );
      (mockStorage.storage.finalize as ReturnType<typeof vi.fn>).mockImplementation(
        async (p: string) => {
          order.push(`finalize:${p}`);
        },
      );

      await writer.appendChunk('run-1', 'job-a', 0, ['l1'], Date.now());
      await writer.appendChunk('run-1', 'job-a', 1, ['l2'], Date.now());
      await writer.drain('run-1');

      const step0 = 'executions/run-1/job-job-a/step-0.log';
      const step1 = 'executions/run-1/job-job-a/step-1.log';
      expect(mockStorage.storage.appendStreaming).toHaveBeenCalledWith(step0, expect.any(String));
      expect(mockStorage.storage.finalize).toHaveBeenCalledWith(step0);
      expect(mockStorage.storage.finalize).toHaveBeenCalledWith(step1);

      // Every append precedes every finalize (await-pending-then-finalize).
      const firstFinalize = order.findIndex((o) => o.startsWith('finalize:'));
      expect(firstFinalize).toBeGreaterThan(-1);
      expect(order.slice(0, firstFinalize).every((o) => o.startsWith('append:'))).toBe(true);
    });

    it('forgets a run path set after drain (no double finalize on re-drain)', async () => {
      await writer.appendChunk('run-1', 'job-a', 0, ['l1'], Date.now());
      await writer.drain('run-1');
      const callsAfterFirst = (mockStorage.storage.finalize as ReturnType<typeof vi.fn>).mock.calls
        .length;
      await writer.drain('run-1');
      // A second drain finds no tracked paths → no further finalize calls.
      expect((mockStorage.storage.finalize as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
        callsAfterFirst,
      );
    });
  });
});

describe('LogWriter stream level', () => {
  let mockStorage: ReturnType<typeof createMockLogStorage>;
  let writer: LogWriter;

  beforeEach(() => {
    mockStorage = createMockLogStorage();
    writer = new LogWriter({ logStorage: mockStorage.storage });
  });

  function levelsOf(data: string): string[] {
    return data
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).level);
  }

  it('stamps the record level from the chunk stream', async () => {
    await writer.appendChunk(
      'run-1',
      'test',
      0,
      ['nft: Could not process rule'],
      Date.now(),
      'job-1',
      undefined,
      LogStream.enum.stderr,
    );

    expect(levelsOf(mockStorage.appended[0].data)).toEqual([LogStream.enum.stderr]);
  });

  it('defaults the record level to stdout when the chunk carries no stream', async () => {
    await writer.appendChunk('run-1', 'test', 0, ['ordinary progress'], Date.now());

    expect(levelsOf(mockStorage.appended[0].data)).toEqual([LogStream.enum.stdout]);
  });
});
