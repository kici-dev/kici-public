import { describe, it, expect, vi } from 'vitest';
import { pruneExpiredLogs } from './log-retention.js';
import type { LogStorage } from './log-storage.js';

function fakeStorage(
  objs: Array<{ path: string; lastModified: Date }>,
): LogStorage & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    append: vi.fn(),
    appendStreaming: vi.fn(),
    finalize: vi.fn(),
    read: vi.fn(),
    exists: vi.fn(),
    list: vi.fn(),
    listWithMetadata: vi.fn(async () => objs),
    deleteMany: vi.fn(async (ps: string[]) => {
      deleted.push(...ps);
      return ps.length;
    }),
    deleted,
  } as unknown as LogStorage & { deleted: string[] };
}

const now = new Date('2026-07-10T00:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

describe('pruneExpiredLogs', () => {
  it('bulk-deletes only objects older than ttlDays', async () => {
    const s = fakeStorage([
      { path: 'executions/r1/job-a/step-0.log/seg-000000', lastModified: daysAgo(100) },
      { path: 'executions/r2/job-a/step-0.log', lastModified: daysAgo(5) },
    ]);
    const n = await pruneExpiredLogs(s, 90, now);
    expect(n).toBe(1);
    expect(s.deleted).toEqual(['executions/r1/job-a/step-0.log/seg-000000']);
  });

  it('keeps in-window objects (a recent/active run never loses its logs)', async () => {
    const s = fakeStorage([
      { path: 'executions/recent/job-a/step-0.log', lastModified: daysAgo(89) },
      { path: 'executions/recent/job-a/step-1.log', lastModified: now },
    ]);
    const n = await pruneExpiredLogs(s, 90, now);
    expect(n).toBe(0);
    expect(s.deleted).toEqual([]);
  });

  it('is a no-op when ttlDays <= 0', async () => {
    const s = fakeStorage([{ path: 'executions/r1/job-a/step-0.log', lastModified: daysAgo(999) }]);
    expect(await pruneExpiredLogs(s, 0, now)).toBe(0);
    expect(await pruneExpiredLogs(s, -1, now)).toBe(0);
    expect(s.deleted).toEqual([]);
  });

  it('does not call deleteMany when nothing is expired', async () => {
    const s = fakeStorage([{ path: 'executions/r1/job-a/step-0.log', lastModified: daysAgo(1) }]);
    const n = await pruneExpiredLogs(s, 90, now);
    expect(n).toBe(0);
    expect(s.deleteMany).not.toHaveBeenCalled();
  });

  it('logs and returns 0 when the bulk delete throws (tick not aborted)', async () => {
    const s = fakeStorage([{ path: 'executions/r1/job-a/step-0.log', lastModified: daysAgo(100) }]);
    (s.deleteMany as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    expect(await pruneExpiredLogs(s, 90, now)).toBe(0);
  });
});
