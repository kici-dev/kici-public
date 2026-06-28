import { describe, it, expect, vi } from 'vitest';
import { readStepLogLines, toAgentStepLogs } from './step-log-reader.js';
import { agentStepLogsSchema } from '@kici-dev/engine';
import { createMockDb } from '../__test-helpers__/mock-db.js';

function makeLogStorage(data: string) {
  return {
    append: vi.fn(),
    read: vi.fn().mockResolvedValue({ data, cursor: data.length, complete: true }),
    exists: vi.fn(),
    list: vi.fn(),
  };
}

describe('toAgentStepLogs', () => {
  it('wraps every line untrusted and is schema-valid', () => {
    const out = toAgentStepLogs('r1', 'j1', 0, {
      lines: ['a', 'b'],
      totalLines: 2,
      nextCursor: null,
    });
    expect(agentStepLogsSchema.safeParse(out).success).toBe(true);
    expect(out.lines).toEqual([
      { untrusted: true, value: 'a' },
      { untrusted: true, value: 'b' },
    ]);
  });
});

describe('readStepLogLines', () => {
  it('returns an empty page when the step has no log path', async () => {
    const { db } = createMockDb({ selectFirstRow: { log_path: null } });
    const out = await readStepLogLines(
      { db: db as never, logStorage: makeLogStorage('') },
      { runId: 'r1', jobId: 'j1', stepIndex: 0 },
    );
    expect(out).toEqual({ lines: [], totalLines: 0, nextCursor: null });
  });

  it('returns an empty page when the step row is absent', async () => {
    const { db } = createMockDb({ selectFirstRow: undefined });
    const out = await readStepLogLines(
      { db: db as never, logStorage: makeLogStorage('x') },
      { runId: 'r1', jobId: 'j1', stepIndex: 0 },
    );
    expect(out.totalLines).toBe(0);
  });

  it('paginates lines with a next cursor', async () => {
    const { db } = createMockDb({ selectFirstRow: { log_path: 'p' } });
    const data = 'l0\nl1\nl2\nl3\n';
    const page1 = await readStepLogLines(
      { db: db as never, logStorage: makeLogStorage(data) },
      { runId: 'r1', jobId: 'j1', stepIndex: 0, limit: 2 },
    );
    expect(page1.lines).toEqual(['l0', 'l1']);
    expect(page1.totalLines).toBe(4);
    expect(page1.nextCursor).toBe('2');

    const page2 = await readStepLogLines(
      { db: db as never, logStorage: makeLogStorage(data) },
      { runId: 'r1', jobId: 'j1', stepIndex: 0, limit: 2, cursor: '2' },
    );
    expect(page2.lines).toEqual(['l2', 'l3']);
    expect(page2.nextCursor).toBeNull();
  });
});
