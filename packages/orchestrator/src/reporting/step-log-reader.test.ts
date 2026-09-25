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
      recorded: true,
    });
    expect(agentStepLogsSchema.safeParse(out).success).toBe(true);
    expect(out.recorded).toBe(true);
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
    expect(out).toEqual({ lines: [], totalLines: 0, nextCursor: null, recorded: false });
  });

  it('returns an empty page when the step row is absent', async () => {
    const { db } = createMockDb({ selectFirstRow: undefined });
    const out = await readStepLogLines(
      { db: db as never, logStorage: makeLogStorage('x') },
      { runId: 'r1', jobId: 'j1', stepIndex: 0 },
    );
    expect(out.totalLines).toBe(0);
    expect(out.recorded).toBe(false);
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
    expect(page1.recorded).toBe(true);

    const page2 = await readStepLogLines(
      { db: db as never, logStorage: makeLogStorage(data) },
      { runId: 'r1', jobId: 'j1', stepIndex: 0, limit: 2, cursor: '2' },
    );
    expect(page2.lines).toEqual(['l2', 'l3']);
    expect(page2.nextCursor).toBeNull();
  });
});

/**
 * A fake database that serves rows per table and applies the equality
 * predicates the reader issues, so a dropped `where` changes the result.
 */
function makeTableDb(tables: Record<string, Array<Record<string, unknown>>>) {
  const reads: string[] = [];
  const db = {
    selectFrom(table: string) {
      reads.push(table);
      const predicates: Array<[string, unknown]> = [];
      const chain = {
        select: () => chain,
        where: (column: string, _op: string, value: unknown) => {
          predicates.push([column, value]);
          return chain;
        },
        executeTakeFirst: async () =>
          (tables[table] ?? []).find((row) => predicates.every(([c, v]) => row[c] === v)),
      };
      return chain;
    },
  };
  return { db, reads };
}

function makeFileStorage(files: Record<string, string>) {
  return {
    append: vi.fn(),
    appendStreaming: vi.fn(),
    finalize: vi.fn(),
    exists: vi.fn(async (p: string) => p in files),
    read: vi.fn(async (p: string) => ({ data: files[p]!, cursor: 0, complete: true })),
    list: vi.fn(),
    listWithMetadata: vi.fn(),
    deleteMany: vi.fn(),
  };
}

describe('readStepLogLines — the workflow-level log (step -1)', () => {
  const SETUP_LOG = 'executions/r1/job-build/step--1.log';

  it('reads step -1 from the job-name path, which no step row names', async () => {
    const { db } = makeTableDb({
      execution_steps: [],
      execution_jobs: [
        { run_id: 'r2', job_id: 'j1', job_name: 'other-run' },
        { run_id: 'r1', job_id: 'j1', job_name: 'build' },
      ],
    });
    const storage = makeFileStorage({
      [SETUP_LOG]: '[host-checkout] Clone complete\n[host-install] Dependencies installed\n',
    });

    const out = await readStepLogLines(
      { db: db as never, logStorage: storage },
      { runId: 'r1', jobId: 'j1', stepIndex: -1 },
    );

    // fails-when: the reader keys only on an execution_steps row, which the
    // workflow-level log never has (step.status carries non-negative indexes),
    // so every step -1 read returns an empty page.
    expect(out.lines).toEqual([
      '[host-checkout] Clone complete',
      '[host-install] Dependencies installed',
    ]);
    expect(storage.read).toHaveBeenCalledWith(SETUP_LOG);
  });

  it('falls back to the queued job name when the job has no execution_jobs row', async () => {
    const { db } = makeTableDb({
      execution_jobs: [],
      dispatch_queue: [{ id: 'j1', job_name: 'build' }],
    });
    const storage = makeFileStorage({ [SETUP_LOG]: 'line\n' });

    const out = await readStepLogLines(
      { db: db as never, logStorage: storage },
      { runId: 'r1', jobId: 'j1', stepIndex: -1 },
    );

    expect(out.lines).toEqual(['line']);
  });

  it('returns an empty page when the job wrote no step -1 log', async () => {
    const { db } = makeTableDb({ execution_jobs: [{ run_id: 'r1', job_id: 'j1', job_name: 'b' }] });
    const storage = makeFileStorage({});

    const out = await readStepLogLines(
      { db: db as never, logStorage: storage },
      { runId: 'r1', jobId: 'j1', stepIndex: -1 },
    );

    // fails-when: a job that wrote no setup log reads like one whose log is empty
    expect(out).toEqual({ lines: [], totalLines: 0, nextCursor: null, recorded: false });
    expect(storage.read).not.toHaveBeenCalled();
  });

  it('reports a stored setup log that holds no lines as recorded', async () => {
    const { db } = makeTableDb({ execution_jobs: [{ run_id: 'r1', job_id: 'j1', job_name: 'b' }] });
    const storage = makeFileStorage({ 'executions/r1/job-b/step--1.log': '' });

    const out = await readStepLogLines(
      { db: db as never, logStorage: storage },
      { runId: 'r1', jobId: 'j1', stepIndex: -1 },
    );

    // breaks-if-wrong: an empty stored log must still read as recorded, so the
    // reader can say "empty" rather than "never written"
    expect(out).toEqual({ lines: [], totalLines: 0, nextCursor: null, recorded: true });
  });

  it('a regular step still reads the path its row names, never a derived one', async () => {
    // breaks-if-wrong: a non-negative step must keep resolving through its
    // execution_steps row.
    const { db, reads } = makeTableDb({
      execution_steps: [
        { run_id: 'r1', job_id: 'j1', step_index: 0, log_path: 'executions/r1/job-x/step-0.log' },
      ],
    });
    const storage = makeFileStorage({ 'executions/r1/job-x/step-0.log': 'step zero\n' });

    const out = await readStepLogLines(
      { db: db as never, logStorage: storage },
      { runId: 'r1', jobId: 'j1', stepIndex: 0 },
    );

    expect(out.lines).toEqual(['step zero']);
    expect(reads).toEqual(['execution_steps']);
  });
});
