import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LogWriter } from './log-writer.js';
import type { LogStorage } from './log-storage.js';

// ── Mock LogStorage ──────────────────────────────────────────────

function createMockLogStorage() {
  const appended: Array<{ path: string; data: string }> = [];

  const storage: LogStorage = {
    append: vi.fn(async (path: string, data: string) => {
      appended.push({ path, data });
    }),
    read: vi.fn(async () => ({ data: '', cursor: 0, complete: true })),
    exists: vi.fn(async () => false),
    list: vi.fn(async () => []),
  };

  return { storage, appended };
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

      expect(mockStorage.storage.append).not.toHaveBeenCalled();
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
      (mockStorage.storage.append as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('disk full'),
      );

      // Should not throw
      await expect(
        writer.appendChunk('run-1', 'test', 0, ['line'], Date.now()),
      ).resolves.not.toThrow();
    });
  });
});
