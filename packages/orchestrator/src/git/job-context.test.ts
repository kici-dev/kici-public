import { describe, it, expect, vi } from 'vitest';
import { createJobCredentialContextReader } from './job-context.js';

type RunRow = {
  customer_id: string;
  repo_identifier: string;
  ref: string;
  trigger_event: string | null;
  trust_tier: string | null;
  workflow_repo_identifier?: string | null;
  workflow_branch?: string | null;
  provider_context?: unknown;
  routing_key?: string | null;
  dispatch_routing_key?: string | null;
};
type JobRow = { git_credentials: Record<string, Record<string, string>> | null };
type DispatchRow = { job_config: string; repo_url?: string; routing_key?: string };
type SourceRow = { github_url: string | null };

/** A dispatch-queue id is a uuid column, so the fixture uses a real one. */
const JOB_ID = '3f9b6c02-3a1f-4c19-9a2f-6b0d1e7c4a55';

/**
 * A db that answers by table name, so a reader that adds, drops or reorders a
 * query keeps getting the row it asked for rather than the next one in a list.
 */
function fakeDb(
  rows: {
    execution_runs?: RunRow | undefined;
    execution_jobs?: JobRow | undefined;
    dispatch_queue?: DispatchRow | undefined;
    sources?: SourceRow | undefined;
  },
  selected: Record<string, unknown> = {},
  wheres: Record<string, unknown[][]> = {},
) {
  const selectFrom = vi.fn((table: keyof typeof rows) => {
    const chain = {
      select: (columns: unknown) => {
        selected[table] = columns;
        return chain;
      },
      where: (...args: unknown[]) => {
        (wheres[table] ??= []).push(args);
        return chain;
      },
      executeTakeFirst: vi.fn(async () => rows[table]),
    };
    return chain;
  });
  return { selectFrom } as never;
}

const RUN: RunRow = {
  customer_id: 'org-1',
  repo_identifier: 'acme/main',
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
      sourceRepo: 'acme/main',
      declaredCredentials: { forge: { kind: 'token' } },
      trustTier: 'trusted',
      policyRepo: 'acme/main',
      policyBranch: 'main',
      triggerType: 'push',
    });
  });

  it('a global run presents the workflow repo and its registered branch to the credential gate', async () => {
    const read = createJobCredentialContextReader(
      fakeDb({
        execution_runs: {
          customer_id: 'org-1',
          repo_identifier: 'org/app',
          ref: 'feature',
          trigger_event: 'push',
          trust_tier: 'trusted',
          workflow_repo_identifier: 'org/ci',
          workflow_branch: 'main',
        },
        execution_jobs: { git_credentials: null },
      }),
    );
    const ctx = await read('run-1', JOB_ID);
    // fails-when: the gate repository is repo_identifier (org/app) for a run
    // whose workflow_repo_identifier is set.
    expect(ctx?.policyRepo).toBe('org/ci');
    // fails-when: the gate branch is the event's ref (feature) instead of the
    // workflow's registered branch.
    expect(ctx?.policyBranch).toBe('main');
    // breaks-if-wrong: the write-credential fence stays anchored on the
    // event's repository.
    expect(ctx?.sourceRepo).toBe('org/app');
  });

  it('a global run with no recorded workflow branch presents an empty branch', async () => {
    // fails-when: a missing workflow_branch falls back to the event's ref,
    // which would let the event's branch satisfy the workflow repo's context.
    const read = createJobCredentialContextReader(
      fakeDb({
        execution_runs: {
          ...RUN,
          ref: 'feature',
          workflow_repo_identifier: 'org/ci',
          workflow_branch: null,
        },
      }),
    );
    await expect(read('run-1', JOB_ID)).resolves.toMatchObject({
      policyRepo: 'org/ci',
      policyBranch: '',
    });
  });

  it('a same-repo run keeps its own repository and presented branch', async () => {
    // breaks-if-wrong: a NULL workflow_repo_identifier must leave the gate on
    // repo_identifier and ref, exactly as for every per-repo run.
    const read = createJobCredentialContextReader(
      fakeDb({
        execution_runs: { ...RUN, workflow_repo_identifier: null, workflow_branch: null },
      }),
    );
    await expect(read('run-1', JOB_ID)).resolves.toMatchObject({
      sourceRepo: 'acme/main',
      policyRepo: 'acme/main',
      policyBranch: 'main',
    });
  });

  /** A provider context a routing-key-scoped token wrote through a manual registration. */
  const INJECTED = { installationId: 7, githubUrl: 'https://evil.example' };

  it("mints at the server the job's source stores, never at one its provider context names", async () => {
    const wheres: Record<string, unknown[][]> = {};
    const read = createJobCredentialContextReader(
      fakeDb(
        {
          execution_runs: { ...RUN, routing_key: 'github:1', provider_context: INJECTED },
          dispatch_queue: { ...dispatchRow(undefined), routing_key: 'github:7' },
          sources: { github_url: 'https://ghe.corp.example' },
        },
        {},
        wheres,
      ),
    );
    const ctx = await read('run-1', JOB_ID);
    // fails-when: the injected host wins and the App JWT is sent to https://evil.example
    expect(ctx?.githubUrl).toBe('https://ghe.corp.example');
    // The job's own source (the bundle that dispatched it) is the one read.
    expect(wheres.sources).toContainEqual(['routing_key', '=', 'github:7']);
  });

  it('a github.com source ignores a server its provider context names', async () => {
    const read = createJobCredentialContextReader(
      fakeDb({
        execution_runs: { ...RUN, routing_key: 'github:1', provider_context: INJECTED },
        sources: { github_url: null },
      }),
    );
    // breaks-if-wrong: a github.com job keeps minting at github.com
    const ctx = await read('run-1', JOB_ID);
    expect(ctx).not.toHaveProperty('githubUrl');
    expect(ctx).not.toHaveProperty('githubAppMintRefusal');
  });

  it('a job of a removed GitHub source has its App mint refused', async () => {
    const read = createJobCredentialContextReader(
      fakeDb({ execution_runs: { ...RUN, routing_key: 'github:1', provider_context: INJECTED } }),
    );
    const ctx = await read('run-1', JOB_ID);
    // fails-when: the mint falls back to the stamp or to api.github.com for a source that is gone
    expect(ctx?.githubAppMintRefusal).toMatch(/GitHub source github:1 .* no longer configured/);
    expect(ctx).not.toHaveProperty('githubUrl');
  });

  it('a job whose source stores a server that is not a GitHub web URL has its App mint refused', async () => {
    const read = createJobCredentialContextReader(
      fakeDb({
        execution_runs: { ...RUN, routing_key: 'github:1', provider_context: INJECTED },
        sources: { github_url: 'http://evil.example/x' },
      }),
    );
    const ctx = await read('run-1', JOB_ID);
    // fails-when: the planted value becomes the mint's server, or the mint falls back to github.com
    expect(ctx?.githubAppMintRefusal).toMatch(/GitHub source github:1 .*stored GitHub server URL/);
    expect(ctx).not.toHaveProperty('githubUrl');
  });

  it("a job of another provider's source mints at github.com", async () => {
    const read = createJobCredentialContextReader(
      fakeDb({
        execution_runs: { ...RUN, routing_key: 'generic:org-1:src', provider_context: INJECTED },
      }),
    );
    // breaks-if-wrong: a generic source's job may still mint its own github.com App token
    const ctx = await read('run-1', JOB_ID);
    expect(ctx).not.toHaveProperty('githubUrl');
    expect(ctx).not.toHaveProperty('githubAppMintRefusal');
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
    expect(tables.map((c) => c[0])).toEqual(['execution_runs', 'execution_jobs', 'sources']);
  });

  it("names the job's checkout from the dispatch record's clone URL", async () => {
    const read = createJobCredentialContextReader(
      fakeDb({
        execution_runs: RUN,
        execution_jobs: { git_credentials: DECLARED },
        dispatch_queue: { ...dispatchRow(undefined), repo_url: 'git@github.com:acme/main.git' },
      }),
    );
    await expect(read('run-1', JOB_ID)).resolves.toMatchObject({ checkoutRepo: 'acme/main' });
  });

  it('keeps a file:// checkout URL whole', async () => {
    const read = createJobCredentialContextReader(
      fakeDb({
        execution_runs: RUN,
        dispatch_queue: { ...dispatchRow(DECLARED), repo_url: 'file:///srv/repos/app' },
      }),
    );
    await expect(read('run-1', JOB_ID)).resolves.toMatchObject({
      checkoutRepo: 'file:///srv/repos/app',
      declaredCredentials: DECLARED,
    });
  });

  it('names no checkout when the dispatch record is missing', async () => {
    const read = createJobCredentialContextReader(fakeDb({ execution_runs: RUN }));
    const ctx = await read('run-1', JOB_ID);
    expect(ctx).not.toBeNull();
    expect(ctx).not.toHaveProperty('checkoutRepo');
  });

  it('reads an absent trust tier as undefined — the lenient reading', async () => {
    const read = createJobCredentialContextReader(
      fakeDb({ execution_runs: RUN, execution_jobs: { git_credentials: null } }),
    );
    await expect(read('run-1', JOB_ID)).resolves.toMatchObject({ trustTier: undefined });
  });

  // fails-when: a non-null stored tier the schema no longer admits reads as
  // `undefined`, which the relay's `isUntrustedTier` treats as "not untrusted"
  it.each([['known'], ['wat']])(
    'reads a stored %s tier the schema no longer admits as unknown, not as unresolved',
    async (stored) => {
      const read = createJobCredentialContextReader(
        fakeDb({
          execution_runs: { ...RUN, trust_tier: stored },
          execution_jobs: { git_credentials: null },
        }),
      );
      await expect(read('run-1', JOB_ID)).resolves.toMatchObject({ trustTier: 'unknown' });
    },
  );

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
