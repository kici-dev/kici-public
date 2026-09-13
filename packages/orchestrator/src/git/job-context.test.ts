import { describe, it, expect, vi } from 'vitest';
import { createJobCredentialContextReader } from './job-context.js';

type RunRow = {
  customer_id: string;
  repo_identifier: string;
  ref: string;
  trigger_event: string | null;
  trust_tier: string | null;
};
type JobRow = { git_credentials: Record<string, Record<string, string>> | null };
type DispatchRow = { job_config: string };

/** A dispatch-queue id is a uuid column, so the fixture uses a real one. */
const JOB_ID = '3f9b6c02-3a1f-4c19-9a2f-6b0d1e7c4a55';

/**
 * A db that answers by table name, so a reader that adds, drops or reorders a
 * query keeps getting the row it asked for rather than the next one in a list.
 */
function fakeDb(rows: {
  execution_runs?: RunRow | undefined;
  execution_jobs?: JobRow | undefined;
  dispatch_queue?: DispatchRow | undefined;
}) {
  const selectFrom = vi.fn((table: keyof typeof rows) => {
    const chain = {
      select: () => chain,
      where: () => chain,
      executeTakeFirst: vi.fn(async () => rows[table]),
    };
    return chain;
  });
  return { selectFrom } as never;
}

const RUN: RunRow = {
  customer_id: 'org-1',
  repo_identifier: 'cmaster11/main',
  ref: 'main',
  trigger_event: 'push',
  trust_tier: null,
};

const DECLARED = { forge: { kind: 'token', tokenSecret: 'ci:TOKEN' } };

/** A dispatch record carrying the lock's declaration, as `buildJobConfig` writes it. */
function dispatchRow(gitCredentials: unknown): DispatchRow {
  return { job_config: JSON.stringify({ jobName: 'build', gitCredentials }) };
}

describe('createJobCredentialContextReader', () => {
  it('reads every fact from server truth, not from params', async () => {
    const read = createJobCredentialContextReader(
      fakeDb({
        execution_runs: { ...RUN, trust_tier: 'trusted' },
        execution_jobs: { git_credentials: { forge: { kind: 'token' } } },
      }),
    );
    await expect(read('run-1', JOB_ID)).resolves.toEqual({
      orgId: 'org-1',
      sourceRepo: 'cmaster11/main',
      declaredCredentials: { forge: { kind: 'token' } },
      trustTier: 'trusted',
      branch: 'main',
      triggerType: 'push',
    });
  });

  it('returns null for an unknown run rather than a default org', async () => {
    const read = createJobCredentialContextReader(fakeDb({}));
    await expect(read('nope', JOB_ID)).resolves.toBeNull();
  });

  it('reads the declaration from the dispatch record when the job row has not landed', async () => {
    // The dispatch is sent before `addJobsToRun` writes the tracked row, so an
    // agent asking straight away finds no job row. Reading that as "declared
    // nothing" refused a credential the workflow correctly declared.
    const read = createJobCredentialContextReader(
      fakeDb({ execution_runs: RUN, dispatch_queue: dispatchRow(DECLARED) }),
    );
    await expect(read('run-1', JOB_ID)).resolves.toMatchObject({
      declaredCredentials: DECLARED,
    });
  });

  it('reads the declaration from the dispatch record when the tracked column is NULL', async () => {
    // The synthetic-row swap re-INSERTs a job row, and a path that forgot to
    // restate the column leaves it NULL on a job whose lock did declare one.
    const read = createJobCredentialContextReader(
      fakeDb({
        execution_runs: RUN,
        execution_jobs: { git_credentials: null },
        dispatch_queue: dispatchRow(DECLARED),
      }),
    );
    await expect(read('run-1', JOB_ID)).resolves.toMatchObject({
      declaredCredentials: DECLARED,
    });
  });

  it('prefers the tracked row over the dispatch record when both carry one', async () => {
    const read = createJobCredentialContextReader(
      fakeDb({
        execution_runs: RUN,
        execution_jobs: { git_credentials: { forge: { kind: 'ssh' } } },
        dispatch_queue: dispatchRow(DECLARED),
      }),
    );
    await expect(read('run-1', JOB_ID)).resolves.toMatchObject({
      declaredCredentials: { forge: { kind: 'ssh' } },
    });
  });

  it('declares nothing when neither row carries a declaration', async () => {
    const read = createJobCredentialContextReader(
      fakeDb({ execution_runs: RUN, execution_jobs: { git_credentials: null } }),
    );
    await expect(read('run-1', JOB_ID)).resolves.toMatchObject({ declaredCredentials: {} });
  });

  it('declares nothing when the dispatch record names no git credentials', async () => {
    const read = createJobCredentialContextReader(
      fakeDb({ execution_runs: RUN, dispatch_queue: dispatchRow(undefined) }),
    );
    await expect(read('run-1', JOB_ID)).resolves.toMatchObject({ declaredCredentials: {} });
  });

  it('drops a dispatch-record entry that is not a flat string map', async () => {
    const read = createJobCredentialContextReader(
      fakeDb({
        execution_runs: RUN,
        dispatch_queue: dispatchRow({ nested: { kind: { deep: 1 } }, ok: { kind: 'token' } }),
      }),
    );
    await expect(read('run-1', JOB_ID)).resolves.toMatchObject({
      declaredCredentials: { ok: { kind: 'token' } },
    });
  });

  it('declares nothing when the dispatch record is unparseable', async () => {
    const read = createJobCredentialContextReader(
      fakeDb({ execution_runs: RUN, dispatch_queue: { job_config: 'not json' } }),
    );
    await expect(read('run-1', JOB_ID)).resolves.toMatchObject({ declaredCredentials: {} });
  });

  it('never queries the dispatch queue for a job id that is not a uuid', async () => {
    // `dispatch_queue.id` is a uuid column, so a synthetic id would make the
    // lookup a Postgres type error rather than a miss.
    const db = fakeDb({ execution_runs: RUN });
    const read = createJobCredentialContextReader(db);
    await expect(read('run-1', 'needs-pending-build-1')).resolves.toMatchObject({
      declaredCredentials: {},
    });
    const tables = (db as unknown as { selectFrom: { mock: { calls: string[][] } } }).selectFrom
      .mock.calls;
    expect(tables.map((c) => c[0])).toEqual(['execution_runs', 'execution_jobs']);
  });

  it('reads an absent trust tier as undefined — the lenient reading', async () => {
    const read = createJobCredentialContextReader(
      fakeDb({ execution_runs: RUN, execution_jobs: { git_credentials: null } }),
    );
    await expect(read('run-1', JOB_ID)).resolves.toMatchObject({ trustTier: undefined });
  });

  it('drops an unrecognized trust tier rather than passing it through', async () => {
    const read = createJobCredentialContextReader(
      fakeDb({
        execution_runs: { ...RUN, trust_tier: 'wat' },
        execution_jobs: { git_credentials: null },
      }),
    );
    await expect(read('run-1', JOB_ID)).resolves.toMatchObject({ trustTier: undefined });
  });

  it('reads an unrecorded trigger event as empty, which fails a trigger filter closed', async () => {
    const read = createJobCredentialContextReader(
      fakeDb({
        execution_runs: { ...RUN, trigger_event: null },
        execution_jobs: { git_credentials: null },
      }),
    );
    await expect(read('run-1', JOB_ID)).resolves.toMatchObject({ triggerType: '' });
  });
});
