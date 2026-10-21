import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

// Capture the module logger so a skipped fixture mapping's warning can be asserted.
const mockWarn = vi.hoisted(() => vi.fn());
vi.mock('@kici-dev/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kici-dev/shared')>();
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), warn: mockWarn, error: vi.fn(), debug: vi.fn() }),
  };
});

import { encryptJson } from '@kici-dev/shared';
import {
  processTestTrigger,
  repoIdentityFromInlineInput,
  type TestTriggerInput,
} from './test-pipeline.js';
import type { ProcessingDeps } from './processor.js';
import type { ActorPrincipal } from '@kici-dev/engine';
import { lockFileFixture, staticJob } from '../__test-helpers__/lock-fixtures.js';

describe('repoIdentityFromInlineInput', () => {
  it('derives identity from the event payload, never the routing key', () => {
    const result = repoIdentityFromInlineInput({
      routingKey: 'remote:org_WDVAbHTQhWjK',
      event: { payload: { repository: { full_name: 'acme/app', provider: 'github' } } },
    } as never);
    expect(result).toEqual({ repoIdentifier: 'acme/app', provider: 'github' });
  });
  it('falls back to local provider when payload has no provider', () => {
    const result = repoIdentityFromInlineInput({
      routingKey: 'remote:org_X',
      event: { payload: { repository: { full_name: 'local/app' } } },
    } as never);
    expect(result).toEqual({ repoIdentifier: 'local/app', provider: 'local' });
  });
  it('falls back to local/unknown when payload lacks a repository', () => {
    const result = repoIdentityFromInlineInput({
      routingKey: 'remote:org_X',
      event: { payload: {} },
    } as never);
    expect(result).toEqual({ repoIdentifier: 'local/unknown', provider: 'local' });
  });
});

// --- Mock helpers ---

/**
 * Kysely-like `updateTable` builder mock with chainable `.where()`:
 * `insertEdgesForRun` and `recomputeNeedsSatisfied` chain several, and a
 * non-chaining `.where()` throws into the callers' catch, silently leaving the
 * root jobs unmarked. `.where()` discards its predicates, so a test observes
 * WHAT an update set, not WHICH rows it targeted.
 *
 * @param onSet called as soon as `.set()` is applied, even if the chain never
 *   reaches `.execute()`.
 * @param onExecute called only when the whole chain reaches `.execute()`.
 */
function makeUpdateTableMock(
  onSet?: (payload: Record<string, unknown>) => void,
  onExecute?: (payload: Record<string, unknown>) => void,
) {
  return vi.fn(() => ({
    set: vi.fn((payload: Record<string, unknown>) => {
      onSet?.(payload);
      const chain: any = {
        where: vi.fn(() => chain),
        execute: vi.fn(async () => {
          onExecute?.(payload);
        }),
      };
      return chain;
    }),
  }));
}

function createMockLockFile(workflows: any[] = []) {
  return lockFileFixture({
    schemaVersion: 4 as const,
    contentHash: 'abc123',
    lockfileHash: 'lock123',
    workflows,
  });
}

function createMockWorkflow(name: string, jobs: any[] = []) {
  return {
    name,
    source: { file: '.kici/workflows/ci.ts', export: '#default' },
    contentHash: 'wf-hash-123',
    triggers: [
      {
        _type: 'push' as const,
        branches: [{ type: 'glob' as const, pattern: 'main' }],
        paths: [],
      },
    ],
    jobs:
      jobs.length > 0
        ? jobs
        : [
            staticJob({
              name: 'test-job',
              runsOn: [{ kind: 'exact', value: 'default' }],
              steps: [{ name: 'echo', run: 'echo hello' }],
              rules: [],
            }),
          ],
  };
}

function createMockDeps(overrides: Partial<ProcessingDeps> = {}): ProcessingDeps {
  return {
    lockFileCache: {
      get: vi.fn().mockResolvedValue(null),
      getStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0 }),
    } as any,
    dispatcher: {
      dispatch: vi
        .fn()
        .mockResolvedValue({ status: 'dispatched', agentId: 'agent-1', jobId: 'job-1' }),
    } as any,
    agentRegistry: {
      findAvailable: vi.fn().mockReturnValue([]),
    } as any,
    providerRegistry: {
      getByRoutingKey: vi.fn().mockReturnValue({
        normalizer: {},
        lockFileFetcher: { fetchLockFile: vi.fn() },
        repoUrlBuilder: { buildCloneUrl: vi.fn().mockReturnValue('https://example.com/repo.git') },
      }),
    } as any,
    ...overrides,
  };
}

function createMockInput(overrides: Partial<TestTriggerInput> = {}): TestTriggerInput {
  return {
    fixtureId: 'push-main',
    event: {
      type: 'push',
      targetBranch: 'main',
      payload: { ref: 'refs/heads/main' },
    },
    routingKey: 'github:42',
    requestId: 'req-123',
    actor: { type: 'user', sub: 'kc-sub-123' },
    ...overrides,
  };
}

describe('processTestTrigger', () => {
  let deps: ProcessingDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('creates execution run with isTestRun=true marker', async () => {
    const lockFile = createMockLockFile([createMockWorkflow('ci')]);
    (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

    const setCalls: Array<Record<string, unknown>> = [];
    // The shared core (recordRunStart) stamps is_test_run / fixture_id via
    // deps.db, from the testRun meta the adapter sets.
    const mockDb = {
      // resolveOrgId chain → no source row → '__default__'.
      selectFrom: vi.fn(() => ({
        select: vi.fn(() => ({
          where: vi.fn(() => ({ executeTakeFirst: vi.fn().mockResolvedValue(undefined) })),
        })),
      })),
      insertInto: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflict: vi.fn(() => ({ execute: vi.fn().mockResolvedValue(undefined) })),
          execute: vi.fn().mockResolvedValue(undefined),
        })),
      })),
      updateTable: makeUpdateTableMock((payload) => setCalls.push(payload)),
    };

    const executionTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
      markTestRun: vi.fn(),
    };

    deps.executionTracker = executionTracker as any;
    deps.db = mockDb as any;
    const input = createMockInput();

    const result = await processTestTrigger(input, deps);

    expect(result.status).toBe('accepted');
    expect(result.runId).toBeDefined();
    expect(result.jobIds.length).toBeGreaterThan(0);

    // The in-memory test-run marker fires before dispatch.
    expect(executionTracker.markTestRun).toHaveBeenCalledWith(result.runId);
    expect(executionTracker.onExecutionStarted).toHaveBeenCalledOnce();
    const trackerArgs = executionTracker.onExecutionStarted.mock.calls[0];
    expect(trackerArgs[0]).toBe(result.runId); // runId
    expect(trackerArgs[1]).toBe('ci'); // workflowName

    // Wait for the async is_test_run stamp (fire-and-forget UPDATE in the core).
    await vi.waitFor(() => {
      expect(setCalls.some((p) => p.is_test_run === true && p.fixture_id === 'push-main')).toBe(
        true,
      );
    });
  });

  it('matches triggers from lock file for push event', async () => {
    const lockFile = createMockLockFile([createMockWorkflow('ci'), createMockWorkflow('deploy')]);
    (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

    const input = createMockInput({
      event: {
        type: 'push',
        targetBranch: 'main',
        payload: { ref: 'refs/heads/main' },
      },
      acceptsMultipleRuns: true,
    });

    const result = await processTestTrigger(input, deps);

    // Both workflows have push triggers matching 'main'
    expect(result.status).toBe('accepted');
    expect(result.jobIds.length).toBeGreaterThan(0);
    expect(result.runs?.map((r) => r.workflowName)).toEqual(['ci', 'deploy']);
  });

  it('creates one run per matched workflow for a caller that follows several runs', async () => {
    // Both workflows define `test-job`, the name collision a shared run cannot hold.
    const lockFile = createMockLockFile([createMockWorkflow('ci'), createMockWorkflow('deploy')]);
    (deps.lockFileCache.get as any).mockResolvedValue(lockFile);
    const started: Array<[string, string]> = [];
    const tracker = {
      onExecutionStarted: vi.fn(async (runId: string, workflowName: string) => {
        started.push([runId, workflowName]);
      }),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
      markTestRun: vi.fn(),
    };
    deps.executionTracker = tracker as any;

    const result = await processTestTrigger(createMockInput({ acceptsMultipleRuns: true }), deps);

    expect(result.status).toBe('accepted');
    const runs = result.runs ?? [];
    // fails-when: the matched workflows share the one run id minted before matching
    expect(runs.map((r) => r.workflowName)).toEqual(['ci', 'deploy']);
    expect(new Set(runs.map((r) => r.runId)).size).toBe(2);
    expect(started).toEqual(runs.map((r) => [r.runId, r.workflowName]));
    // breaks-if-wrong: the deprecated runId still names the first run
    expect(result.runId).toBe(runs[0]!.runId);
    for (const run of runs) {
      expect(run.jobIds.length).toBeGreaterThan(0);
      expect(tracker.markTestRun).toHaveBeenCalledWith(run.runId);
    }
  });

  it('refuses a caller that follows one run when the matched workflows share a job name', async () => {
    const lockFile = createMockLockFile([createMockWorkflow('ci'), createMockWorkflow('deploy')]);
    (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

    const result = await processTestTrigger(createMockInput(), deps);

    // fails-when: both workflows' `test-job` land in one run, keyed by the same name
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('share job names (test-job)');
    expect(result.reason).toContain('--workflow');
    expect(deps.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('refuses a caller that follows one run when a matched workflow has dynamic jobs', async () => {
    const dynamic = createMockWorkflow('deploy', [
      { _type: 'dynamic', source: { file: '.kici/workflows/ci.ts', index: 0 } },
    ]);
    const lockFile = createMockLockFile([createMockWorkflow('ci'), dynamic]);
    (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

    const result = await processTestTrigger(createMockInput(), deps);

    // fails-when: unknowable dynamic job names are treated as collision-free
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('dynamic jobs');
  });

  it('runs a single matched workflow as one run whether or not the caller follows several', async () => {
    (deps.lockFileCache.get as any).mockResolvedValue(
      createMockLockFile([createMockWorkflow('ci')]),
    );
    const result = await processTestTrigger(createMockInput(), deps);
    // breaks-if-wrong: an older CLI's single-workflow fixture keeps running
    expect(result.status).toBe('accepted');
    expect(result.runs?.map((r) => [r.runId, r.workflowName])).toEqual([[result.runId, 'ci']]);
  });

  it('holds a shared run of several workflows open until the last workflow registers', async () => {
    // A caller without acceptsMultipleRuns, and job names that cannot collide.
    const job = (name: string) =>
      staticJob({
        name,
        runsOn: [{ kind: 'exact', value: 'default' }],
        steps: [{ name: 'echo', run: 'echo hello' }],
        rules: [],
      });
    const lockFile = createMockLockFile([
      createMockWorkflow('ci', [job('ci-job')]),
      createMockWorkflow('deploy', [job('deploy-job')]),
    ]);
    (deps.lockFileCache.get as any).mockResolvedValue(lockFile);
    const events: string[] = [];
    deps.executionTracker = {
      onExecutionStarted: vi.fn(async (_runId: string, workflowName: string) => {
        events.push(`start:${workflowName}`);
      }),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => {
        events.push('hold');
        return true;
      }),
      releasePendingJobsHold: vi.fn(async () => {
        events.push('release');
      }),
      markTestRun: vi.fn(),
    } as any;

    const result = await processTestTrigger(createMockInput(), deps);
    expect(result.status).toBe('accepted');
    // A shared run names no single workflow, so it carries no `runs`.
    expect(result.runs).toBeUndefined();

    // Open tokens after each event, from the first registration to the last.
    const first = events.indexOf('start:ci');
    const last = events.indexOf('start:deploy');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(last).toBeGreaterThan(first);
    let open = 0;
    const openBetween: number[] = [];
    events.forEach((e, i) => {
      if (e === 'hold') open++;
      if (e === 'release') open--;
      if (i > first && i < last) openBetween.push(open);
    });
    // fails-when: the first workflow's own release drops the run to zero holds
    // before the second workflow registers, so the run can complete in between
    expect(openBetween.length).toBeGreaterThan(0);
    expect(Math.min(...openBetween)).toBeGreaterThan(0);
    // breaks-if-wrong: every hold is released, so the run can still complete
    expect(open).toBe(0);
  });

  it('expands a matrix job into N dispatches each carrying matrixValues', async () => {
    const matrixWorkflow = createMockWorkflow('ci', [
      staticJob({
        name: 'test-job',
        runsOn: [{ kind: 'exact', value: 'default' }],
        steps: [{ name: 'echo', run: 'echo hello' }],
        rules: [],
        matrix: { _type: 'static', values: { variant: ['a', 'b'] } },
      }),
    ]);
    (deps.lockFileCache.get as any).mockResolvedValue(createMockLockFile([matrixWorkflow]));

    await processTestTrigger(createMockInput(), deps);

    const dispatchSpy = deps.dispatcher.dispatch as any;
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
    const calls = dispatchSpy.mock.calls.map((c: any[]) => c[0]);
    const byName = Object.fromEntries(calls.map((c: any) => [c.jobName, c]));
    expect(Object.keys(byName).sort()).toEqual(['test-job (a)', 'test-job (b)']);
    expect(byName['test-job (a)'].jobConfig.matrixValues).toEqual({ variant: 'a' });
    expect(byName['test-job (a)'].jobConfig.baseJobName).toBe('test-job');
    expect(byName['test-job (a)'].jobConfig.matrix).toBeUndefined();
  });

  it('honors the needs DAG: only the root job is dispatched, the downstream stays gated', async () => {
    const needsWorkflow = createMockWorkflow('ci', [
      staticJob({
        runsOn: [{ kind: 'exact', value: 'default' }],
        steps: [{ name: 'b', run: 'echo build' }],
        rules: [],
      }),
      staticJob({
        name: 'deploy',
        runsOn: [{ kind: 'exact', value: 'default' }],
        steps: [{ name: 'd', run: 'echo deploy' }],
        needs: ['build'],
        rules: [],
      }),
    ]);
    (deps.lockFileCache.get as any).mockResolvedValue(createMockLockFile([needsWorkflow]));

    const dispatchSpy = deps.dispatcher.dispatch as any;
    const result = await processTestTrigger(createMockInput(), deps);

    expect(result.status).toBe('accepted');
    // Only the root `build` reaches the dispatcher; the needs scheduler gates
    // `deploy` until `build` completes, as on the webhook path.
    const dispatchedNames = dispatchSpy.mock.calls.map((c: any[]) => c[0].jobName);
    expect(dispatchedNames).toEqual(['build']);
  });

  it('fans out a runsOnAll job into one pinned child per matching roster host', async () => {
    const fanWorkflow = createMockWorkflow('ci', [
      {
        _type: 'static' as const,
        name: 'fan',
        runsOnAll: { include: [[{ kind: 'exact', value: 'kici:os:linux' }]], exclude: [] },
        steps: [{ name: 's', run: 'echo go' }],
        needs: [],
        rules: [],
      },
    ]);
    const matchedHosts = [
      {
        agentId: 'a1',
        host: 'h1',
        labels: ['kici:os:linux'],
        lifecycleClass: 'static',
        connectedInstanceId: 'inst-1',
        status: 'ready',
        platform: 'linux',
        arch: 'amd64',
        properties: {},
      },
      {
        agentId: 'a2',
        host: 'h2',
        labels: ['kici:os:linux'],
        lifecycleClass: 'static',
        connectedInstanceId: 'inst-1',
        status: 'ready',
        platform: 'linux',
        arch: 'amd64',
        properties: {},
      },
    ];
    deps.hostRosterStore = { findFanoutTargets: vi.fn().mockResolvedValue(matchedHosts) } as any;
    deps.maxFanoutHosts = 1024;
    (deps.lockFileCache.get as any).mockResolvedValue(createMockLockFile([fanWorkflow]));

    const dispatchSpy = deps.dispatcher.dispatch as any;
    const result = await processTestTrigger(createMockInput(), deps);

    expect(result.status).toBe('accepted');
    const dispatchedNames = dispatchSpy.mock.calls.map((c: any[]) => c[0].jobName).sort();
    // One pinned execution per host, as in the webhook runsOnAll fan-out.
    expect(dispatchedNames).toEqual(['fan (h1)', 'fan (h2)']);
  });

  it('narrows a runsOnAll fan-out to hosts matching input.target', async () => {
    const fanWorkflow = createMockWorkflow('ci', [
      {
        _type: 'static' as const,
        name: 'fan',
        runsOnAll: { include: [[{ kind: 'regex', source: '^role:', flags: '' }]], exclude: [] },
        steps: [{ name: 's', run: 'echo go' }],
        needs: [],
        rules: [],
      },
    ]);
    const matchedHosts = [
      {
        agentId: 'a1',
        host: 'web-01',
        labels: ['role:web'],
        lifecycleClass: 'static',
        connectedInstanceId: 'inst-1',
        status: 'ready',
        platform: 'linux',
        arch: 'amd64',
        properties: {},
      },
      {
        agentId: 'a2',
        host: 'db-01',
        labels: ['role:db'],
        lifecycleClass: 'static',
        connectedInstanceId: 'inst-1',
        status: 'ready',
        platform: 'linux',
        arch: 'amd64',
        properties: {},
      },
    ];
    deps.hostRosterStore = { findFanoutTargets: vi.fn().mockResolvedValue(matchedHosts) } as any;
    deps.maxFanoutHosts = 1024;
    (deps.lockFileCache.get as any).mockResolvedValue(createMockLockFile([fanWorkflow]));

    const dispatchSpy = deps.dispatcher.dispatch as any;
    const result = await processTestTrigger(
      createMockInput({
        target: {
          values: [{ include: [{ kind: 'exact', value: 'role:web' }], exclude: [] }],
          allowEmpty: false,
        },
      }),
      deps,
    );

    expect(result.status).toBe('accepted');
    // Only the role:web host produces a pinned execution; role:db is narrowed out.
    const dispatchedNames = dispatchSpy.mock.calls.map((c: any[]) => c[0].jobName).sort();
    expect(dispatchedNames).toEqual(['fan (web-01)']);
  });

  it('stamps isTestRun + fixtureId on every dispatched job and marks the run in-memory', async () => {
    (deps.lockFileCache.get as any).mockResolvedValue(
      createMockLockFile([createMockWorkflow('ci')]),
    );
    const markTestRun = vi.fn();
    deps.executionTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
      markTestRun,
      db: {
        updateTable: makeUpdateTableMock(),
      },
    } as any;

    const dispatchSpy = deps.dispatcher.dispatch as any;
    const result = await processTestTrigger(createMockInput(), deps);

    expect(result.status).toBe('accepted');
    const jobConfig = dispatchSpy.mock.calls[0][0].jobConfig;
    expect(jobConfig.isTestRun).toBe(true);
    expect(jobConfig.fixtureId).toBe('push-main');
    expect(markTestRun).toHaveBeenCalledWith(result.runId);
  });

  describe('dispatch inputs validation', () => {
    function createDispatchWorkflow() {
      return {
        name: 'deploy-prod',
        source: { file: '.kici/workflows/deploy.ts', export: '#default' },
        contentHash: 'wf-hash-disp',
        triggers: [
          {
            _type: 'dispatch' as const,
            types: ['deploy-prod'],
            inputs: {
              skipCveScan: {
                type: 'boolean' as const,
                optional: false,
                nullable: false,
                default: false,
              },
              mode: {
                type: 'enum' as const,
                optional: false,
                nullable: false,
                values: ['full', 'edge-only'],
                default: 'full',
              },
            },
          },
        ],
        jobs: [
          staticJob({
            name: 'gates',
            runsOn: [{ kind: 'exact', value: 'default' }],
            steps: [{ name: 'echo', run: 'echo hello' }],
            rules: [],
          }),
        ],
      };
    }

    const dispatchEventInput = (overrides: Partial<TestTriggerInput> = {}) =>
      createMockInput({
        fixtureId: 'deploy-prod',
        event: {
          type: 'dispatch',
          action: 'deploy-prod',
          targetBranch: 'main',
          payload: { action: 'deploy-prod' },
        },
        ...overrides,
      });

    it('validates + defaults operator dispatch inputs against the lock descriptor', async () => {
      (deps.lockFileCache.get as any).mockResolvedValue(
        createMockLockFile([createDispatchWorkflow()]),
      );
      const dispatchSpy = deps.dispatcher.dispatch as any;

      const result = await processTestTrigger(
        dispatchEventInput({ dispatchInputs: { skipCveScan: 'true' } }),
        deps,
      );

      expect(result.status).toBe('accepted');
      const jobConfig = dispatchSpy.mock.calls[0][0].jobConfig;
      // skipCveScan coerced from 'true', mode defaulted to 'full'.
      expect(jobConfig.dispatchInputs).toEqual({ skipCveScan: true, mode: 'full' });
    });

    it('applies defaults when no operator inputs are given', async () => {
      (deps.lockFileCache.get as any).mockResolvedValue(
        createMockLockFile([createDispatchWorkflow()]),
      );
      const dispatchSpy = deps.dispatcher.dispatch as any;

      const result = await processTestTrigger(dispatchEventInput(), deps);

      expect(result.status).toBe('accepted');
      const jobConfig = dispatchSpy.mock.calls[0][0].jobConfig;
      expect(jobConfig.dispatchInputs).toEqual({ skipCveScan: false, mode: 'full' });
    });

    it('rejects an invalid operator input before dispatch (no job dispatched)', async () => {
      (deps.lockFileCache.get as any).mockResolvedValue(
        createMockLockFile([createDispatchWorkflow()]),
      );
      const dispatchSpy = deps.dispatcher.dispatch as any;

      const result = await processTestTrigger(
        dispatchEventInput({ dispatchInputs: { mode: 'nope' } }),
        deps,
      );

      expect(result.status).toBe('rejected');
      expect(result.reason).toMatch(/mode/);
      expect(dispatchSpy).not.toHaveBeenCalled();
    });

    it('rejects an unknown operator input key before dispatch', async () => {
      (deps.lockFileCache.get as any).mockResolvedValue(
        createMockLockFile([createDispatchWorkflow()]),
      );
      const dispatchSpy = deps.dispatcher.dispatch as any;

      const result = await processTestTrigger(
        dispatchEventInput({ dispatchInputs: { nope: 'x' } }),
        deps,
      );

      expect(result.status).toBe('rejected');
      expect(result.reason).toMatch(/nope/);
      expect(dispatchSpy).not.toHaveBeenCalled();
    });
  });

  it('accepts the full ProcessingDeps bag (hostRosterStore + maxFanoutHosts) and dispatches', async () => {
    // The test path takes the same ProcessingDeps the webhook entry builds
    // (single-orch: no coordinator).
    const procDeps = createMockDeps({
      hostRosterStore: { findFanoutTargets: vi.fn().mockResolvedValue([]) } as any,
      maxFanoutHosts: 1024,
      pendingInits: {} as any,
      pendingDynamics: {} as any,
    });
    (procDeps.lockFileCache.get as any).mockResolvedValue(
      createMockLockFile([createMockWorkflow('ci')]),
    );

    const result = await processTestTrigger(createMockInput(), procDeps);

    expect(result.status).toBe('accepted');
    expect(procDeps.hostRosterStore).toBeDefined();
    expect(procDeps.maxFanoutHosts).toBe(1024);
  });

  it('with workflowName bypasses trigger matching', async () => {
    // Create a workflow whose triggers do NOT match the event
    const lockFile = createMockLockFile([createMockWorkflow('ci')]);
    (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

    const input = createMockInput({
      event: {
        type: 'push',
        targetBranch: 'feature/something',
        payload: {},
      },
      workflowName: 'ci',
    });

    const result = await processTestTrigger(input, deps);

    // Even though the event doesn't match triggers, direct mode should work
    expect(result.status).toBe('accepted');
    expect(result.jobIds.length).toBeGreaterThan(0);
  });

  it('with workflowName rejects unknown workflow', async () => {
    const lockFile = createMockLockFile([createMockWorkflow('ci')]);
    (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

    const input = createMockInput({
      workflowName: 'nonexistent-workflow',
    });

    const result = await processTestTrigger(input, deps);

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('nonexistent-workflow');
    expect(result.reason).toContain('not found');
    // fails-when: the rejection stops naming the workflows the lock does have.
    expect(result.reason).toContain('Available workflows: ci');
    expect(result.jobIds).toEqual([]);
  });

  it('with no matching triggers returns rejected status', async () => {
    const lockFile = createMockLockFile([createMockWorkflow('ci')]);
    (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

    const input = createMockInput({
      event: {
        type: 'push',
        targetBranch: 'feature/unmatched',
        payload: {},
      },
    });

    const result = await processTestTrigger(input, deps);

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('No matching workflows');
    expect(result.jobIds).toEqual([]);
  });

  it('deliveryId has test: prefix', async () => {
    const lockFile = createMockLockFile([createMockWorkflow('ci')]);
    (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

    const input = createMockInput();
    const dispatchSpy = deps.dispatcher.dispatch as any;

    await processTestTrigger(input, deps);

    expect(dispatchSpy).toHaveBeenCalled();
    const dispatchArg = dispatchSpy.mock.calls[0][0];
    expect(dispatchArg.deliveryId).toMatch(/^test:/);
  });

  it('uploadId is passed through to job config', async () => {
    const lockFile = createMockLockFile([createMockWorkflow('ci')]);
    (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

    const input = createMockInput({
      uploadId: 'upload-abc-123',
    });

    const dispatchSpy = deps.dispatcher.dispatch as any;

    await processTestTrigger(input, deps);

    expect(dispatchSpy).toHaveBeenCalled();
    const jobConfig = dispatchSpy.mock.calls[0][0].jobConfig;
    expect(jobConfig.tarballUploadId).toBe('upload-abc-123');
    expect(jobConfig.isTestRun).toBe(true);
    expect(jobConfig.fixtureId).toBe('push-main');
  });

  it('rejects when no lock file found', async () => {
    (deps.lockFileCache.get as any).mockResolvedValue(null);

    const input = createMockInput();
    const result = await processTestTrigger(input, deps);

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('No lock file');
  });

  it('rejects when no provider found for routing key', async () => {
    (deps.providerRegistry.getByRoutingKey as any).mockReturnValue(null);

    const input = createMockInput();
    const result = await processTestTrigger(input, deps);

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('No provider found');
  });

  it('returns unique runId', async () => {
    const lockFile = createMockLockFile([createMockWorkflow('ci')]);
    (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

    const input = createMockInput();

    const result1 = await processTestTrigger(input, deps);
    const result2 = await processTestTrigger(input, deps);

    expect(result1.runId).not.toBe(result2.runId);
  });

  it('does not forward the raw fixture secret mapping as testSecrets', async () => {
    const lockFile = createMockLockFile([createMockWorkflow('ci')]);
    (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

    const input = createMockInput({
      secrets: { db: 'test-database', api: 'test-api-key' },
    });

    const dispatchSpy = deps.dispatcher.dispatch as any;
    await processTestTrigger(input, deps);

    // The fixture mapping resolves into namespaced secrets, never forwarded
    // verbatim as `testSecrets`.
    const jobConfig = dispatchSpy.mock.calls[0][0].jobConfig;
    expect(jobConfig.testSecrets).toBeUndefined();
  });

  it('warns when fixture secret mappings are skipped for want of a context store', async () => {
    mockWarn.mockClear();
    const lockFile = createMockLockFile([createMockWorkflow('ci')]);
    (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

    await processTestTrigger(createMockInput({ secrets: { db: 'test-database' } }), deps);

    // fails-when: the mapping is dropped with no trace
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringMatching(/no context store/),
      expect.objectContaining({ mappings: ['db=test-database'] }),
    );
  });

  it('does not warn about fixture mappings when the fixture maps none', async () => {
    mockWarn.mockClear();
    const lockFile = createMockLockFile([createMockWorkflow('ci')]);
    (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

    await processTestTrigger(createMockInput(), deps);

    // breaks-if-wrong: a fixture with no `secrets:` mapping logs nothing about one
    const mappingWarnings = mockWarn.mock.calls.filter(([message]) =>
      String(message).includes('no context store'),
    );
    expect(mappingWarnings).toEqual([]);
  });

  it('rejects when provider has no lockFileFetcher', async () => {
    (deps.providerRegistry.getByRoutingKey as any).mockReturnValue({
      normalizer: {},
      // No lockFileFetcher
    });

    const input = createMockInput();
    const result = await processTestTrigger(input, deps);

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('No provider found');
  });

  describe('inline lock file (fullRepo mode)', () => {
    it('uses inline lock file and skips provider lookup', async () => {
      const lockFile = createMockLockFile([createMockWorkflow('ci')]);
      const input = createMockInput({
        inlineLockFile: JSON.stringify(lockFile),
        fullRepo: true,
        routingKey: 'local:my-project',
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('accepted');
      expect(result.jobIds.length).toBeGreaterThan(0);
      // Provider registry should NOT be called for inline lock file path
      expect(deps.providerRegistry.getByRoutingKey).not.toHaveBeenCalled();
    });

    it('rejects invalid inline lock file JSON', async () => {
      const input = createMockInput({
        inlineLockFile: 'not valid json{{{',
        fullRepo: true,
        routingKey: 'local:my-project',
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('rejected');
      expect(result.reason).toBe('Invalid inline lock file JSON');
    });

    it('propagates fullRepo in jobConfig', async () => {
      const lockFile = createMockLockFile([createMockWorkflow('ci')]);
      const input = createMockInput({
        inlineLockFile: JSON.stringify(lockFile),
        fullRepo: true,
        routingKey: 'local:my-project',
      });

      const dispatchSpy = deps.dispatcher.dispatch as any;
      await processTestTrigger(input, deps);

      expect(dispatchSpy).toHaveBeenCalled();
      const jobConfig = dispatchSpy.mock.calls[0][0].jobConfig;
      expect(jobConfig.fullRepo).toBe(true);
    });

    it('sets repoUrl to empty string for fullRepo', async () => {
      const lockFile = createMockLockFile([createMockWorkflow('ci')]);
      const input = createMockInput({
        inlineLockFile: JSON.stringify(lockFile),
        fullRepo: true,
        routingKey: 'local:my-project',
      });

      const dispatchSpy = deps.dispatcher.dispatch as any;
      await processTestTrigger(input, deps);

      expect(dispatchSpy).toHaveBeenCalled();
      const jobInput = dispatchSpy.mock.calls[0][0];
      expect(jobInput.repoUrl).toBe('');
    });
  });

  describe('context skip-on-test', () => {
    /** matchContext mock returning a full row with the given allowLocalExecution. */
    function envStore(name: string, allowLocalExecution: boolean) {
      return {
        matchContext: vi.fn(async (_org: string, n: string) =>
          n === name
            ? {
                id: `env-${name}`,
                org_id: 'org-gate',
                name,
                type: 'deployment',
                glob_pattern: null,
                branch_restrictions: null,
                trigger_type_filters: null,
                repo_patterns: null,
                concurrency_limit: null,
                concurrency_strategy: null,
                concurrency_timeout_ms: null,
                required_reviewers: null,
                wait_timer_seconds: null,
                hold_expiry_seconds: null,
                minimum_trust: null,
                allow_local_execution: allowLocalExecution,
                enabled: true,
                created_at: new Date(),
                updated_at: new Date(),
                created_by: null,
              }
            : null,
        ),
      } as any;
    }

    function gateDb(envName: string, allowLocalExecution: boolean) {
      return {
        fn: { countAll: () => ({ as: () => ({}) }) },
        selectFrom: vi.fn((table: string) => ({
          select: vi.fn(() => {
            let name: string | undefined;
            const chain: any = {
              where: vi.fn((col: string, _op: string, val: string) => {
                if (col === 'name') name = val;
                return chain;
              }),
              innerJoin: vi.fn(() => chain),
              executeTakeFirst: vi.fn(async () => {
                if (table === 'sources') return { customer_id: 'org-gate' };
                if (table === 'generic_webhook_sources') return undefined;
                if (table === 'contexts')
                  return name === envName
                    ? { allow_local_execution: allowLocalExecution }
                    : undefined;
                if (table === 'execution_jobs') return { count: 0 };
                return undefined;
              }),
            };
            return chain;
          }),
        })),
        insertInto: vi.fn(() => ({
          values: vi.fn(() => ({
            onConflict: vi.fn(() => ({ execute: vi.fn().mockResolvedValue(undefined) })),
            execute: vi.fn().mockResolvedValue(undefined),
          })),
        })),
        updateTable: makeUpdateTableMock(),
      };
    }

    it('skips a non-test-allowed bound env on a fullRepo run (no longer rejects)', async () => {
      const workflowWithEnv = createMockWorkflow('ci', [
        staticJob({
          name: 'deploy-job',
          runsOn: [{ kind: 'exact', value: 'default' }],
          steps: [{ name: 'deploy', run: 'echo deploy' }],
          rules: [],
          contexts: [{ value: 'production', dynamic: false }],
        }),
      ]);
      const lockFile = createMockLockFile([workflowWithEnv]);

      deps.db = gateDb('production', false) as any;
      deps.contextStore = envStore('production', false);
      const dispatch = vi
        .fn()
        .mockResolvedValue({ status: 'dispatched', agentId: 'agent-1', jobId: 'job-1' });
      (deps.dispatcher as any).dispatch = dispatch;

      const input = createMockInput({
        inlineLockFile: JSON.stringify(lockFile),
        fullRepo: true,
        routingKey: 'local:my-project',
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('accepted');
      const jobConfig = dispatch.mock.calls[0]?.[0]?.jobConfig;
      // The env is skipped on a test run: its vars do not flow, though the
      // declared name is still recorded as the run context.
      expect(jobConfig.context).toBe('production');
      expect(jobConfig.contextVars).toBeUndefined();
      // Allow-and-warn: a user-visible warning names the skipped non-test env.
      expect(result.warnings ?? []).toEqual(
        expect.arrayContaining([expect.stringContaining('production')]),
      );
      expect(result.warnings?.[0]).toContain('unavailable for this test run');
    });

    it('applies a test-allowed bound env on a fullRepo run', async () => {
      const workflowWithEnv = createMockWorkflow('ci', [
        staticJob({
          name: 'deploy-job',
          runsOn: [{ kind: 'exact', value: 'default' }],
          steps: [{ name: 'deploy', run: 'echo deploy' }],
          rules: [],
          contexts: [{ value: 'staging', dynamic: false }],
        }),
      ]);
      const lockFile = createMockLockFile([workflowWithEnv]);

      deps.db = gateDb('staging', true) as any;
      deps.contextStore = envStore('staging', true);
      const dispatch = vi
        .fn()
        .mockResolvedValue({ status: 'dispatched', agentId: 'agent-1', jobId: 'job-1' });
      (deps.dispatcher as any).dispatch = dispatch;

      const input = createMockInput({
        inlineLockFile: JSON.stringify(lockFile),
        fullRepo: true,
        routingKey: 'local:my-project',
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('accepted');
      expect(result.jobIds.length).toBeGreaterThan(0);
      expect(dispatch.mock.calls[0]?.[0]?.jobConfig.context).toBe('staging');
      // A test-allowed env participates normally — no skip, no warning.
      expect(result.warnings ?? []).toEqual([]);
    });

    it('skips a non-test-allowed bound env on a real-repo (remote) run', async () => {
      const workflowWithEnv = createMockWorkflow('ci', [
        staticJob({
          name: 'deploy-job',
          runsOn: [{ kind: 'exact', value: 'default' }],
          steps: [{ name: 'deploy', run: 'echo deploy' }],
          rules: [],
          contexts: [{ value: 'production', dynamic: false }],
        }),
      ]);
      const lockFile = createMockLockFile([workflowWithEnv]);
      (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

      deps.db = gateDb('production', false) as any;
      deps.contextStore = envStore('production', false);
      const dispatch = vi
        .fn()
        .mockResolvedValue({ status: 'dispatched', agentId: 'agent-1', jobId: 'job-1' });
      (deps.dispatcher as any).dispatch = dispatch;

      // fullRepo is NOT set -- this is a normal remote test run.
      const input = createMockInput({ routingKey: 'github:42' });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('accepted');
      const jobConfig = dispatch.mock.calls[0]?.[0]?.jobConfig;
      // Skipped on the test run: no env vars flow; declared name still recorded.
      expect(jobConfig.context).toBe('production');
      expect(jobConfig.contextVars).toBeUndefined();
    });

    /** matchContext mock keyed by name → allowLocalExecution (missing name => null). */
    function multiEnvStore(
      byName: Record<string, boolean>,
      otherOrgsByName: Record<string, string[]> = {},
    ) {
      return {
        matchContext: vi.fn(async (_org: string, n: string) =>
          n in byName
            ? {
                id: `env-${n}`,
                org_id: 'org-gate',
                name: n,
                type: 'deployment',
                glob_pattern: null,
                branch_restrictions: null,
                trigger_type_filters: null,
                repo_patterns: null,
                concurrency_limit: null,
                concurrency_strategy: null,
                concurrency_timeout_ms: null,
                required_reviewers: null,
                wait_timer_seconds: null,
                hold_expiry_seconds: null,
                minimum_trust: null,
                allow_local_execution: byName[n],
                enabled: true,
                created_at: new Date(),
                updated_at: new Date(),
                created_by: null,
              }
            : null,
        ),
        orgsMatchingContext: vi.fn(async (n: string) => otherOrgsByName[n] ?? []),
      } as any;
    }

    it('warns but dispatches with the test-allowed env when a job binds [test-allowed, non-test]', async () => {
      const workflowWithEnv = createMockWorkflow('ci', [
        staticJob({
          name: 'deploy-job',
          runsOn: [{ kind: 'exact', value: 'default' }],
          steps: [{ name: 'deploy', run: 'echo deploy' }],
          rules: [],
          contexts: [
            { value: 'staging', dynamic: false },
            { value: 'production', dynamic: false },
          ],
        }),
      ]);
      const lockFile = createMockLockFile([workflowWithEnv]);

      deps.db = gateDb('staging', true) as any;
      deps.contextStore = multiEnvStore({ staging: true, production: false });
      const dispatch = vi
        .fn()
        .mockResolvedValue({ status: 'dispatched', agentId: 'agent-1', jobId: 'job-1' });
      (deps.dispatcher as any).dispatch = dispatch;

      const input = createMockInput({
        inlineLockFile: JSON.stringify(lockFile),
        fullRepo: true,
        routingKey: 'local:my-project',
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('accepted');
      // The non-test env is skipped and warned; the test-allowed env still runs.
      expect(result.warnings ?? []).toEqual(
        expect.arrayContaining([expect.stringContaining('production')]),
      );
      expect(result.warnings?.[0]).toContain('staging');
      expect(dispatch.mock.calls[0]?.[0]?.jobConfig.context).toBe('staging');
    });

    it('warns (does not reject) when a bound env is unconfigured on a test run', async () => {
      const workflowWithEnv = createMockWorkflow('ci', [
        staticJob({
          name: 'deploy-job',
          runsOn: [{ kind: 'exact', value: 'default' }],
          steps: [{ name: 'deploy', run: 'echo deploy' }],
          rules: [],
          contexts: [{ value: 'ghost-env', dynamic: false }],
        }),
      ]);
      const lockFile = createMockLockFile([workflowWithEnv]);

      // gateDb answers no contexts row; envStore returns null for the name.
      deps.db = gateDb('nonexistent', true) as any;
      deps.contextStore = multiEnvStore({});
      const dispatch = vi
        .fn()
        .mockResolvedValue({ status: 'dispatched', agentId: 'agent-1', jobId: 'job-1' });
      (deps.dispatcher as any).dispatch = dispatch;

      const input = createMockInput({
        inlineLockFile: JSON.stringify(lockFile),
        fullRepo: true,
        routingKey: 'local:my-project',
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('accepted');
      expect(result.warnings ?? []).toEqual(
        expect.arrayContaining([expect.stringContaining('ghost-env')]),
      );
    });

    it('skips context gate when no db is provided', async () => {
      const lockFile = createMockLockFile([createMockWorkflow('ci')]);
      (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

      const input = createMockInput(); // no deps.db set

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('accepted');
    });
  });

  describe('test-scoped secret resolution', () => {
    const TEST_ORG = 'org-secret-test';

    // Answers resolveOrgId, the env gate + fixture-namespaced env lookups, and
    // the core's env-rules concurrency query, keyed on the table name.
    function makeSecretDb(envRows: Record<string, { allow_local_execution: boolean }>) {
      return {
        fn: { countAll: () => ({ as: () => ({}) }) },
        selectFrom: vi.fn((table: string) => ({
          select: vi.fn(() => {
            // Capture the env name from the chained `.where('name', '=', X)`.
            let envName: string | undefined;
            const chain: any = {
              where: vi.fn((col: string, _op: string, val: string) => {
                if (col === 'name') envName = val;
                return chain;
              }),
              innerJoin: vi.fn(() => chain),
              executeTakeFirst: vi.fn(async () => {
                if (table === 'sources') return { customer_id: TEST_ORG };
                if (table === 'generic_webhook_sources') return undefined;
                if (table === 'contexts') return envName ? envRows[envName] : undefined;
                if (table === 'execution_jobs') return { count: 0 };
                return undefined;
              }),
            };
            return chain;
          }),
        })),
        insertInto: vi.fn(() => ({
          values: vi.fn(() => ({
            onConflict: vi.fn(() => ({ execute: vi.fn().mockResolvedValue(undefined) })),
            execute: vi.fn().mockResolvedValue(undefined),
          })),
        })),
        updateTable: makeUpdateTableMock(),
      };
    }

    /** Env store whose matchContext returns a full row (no protection rules). */
    function makeTestEnvStore(name: string, allowLocalExecution = true) {
      return {
        matchContext: vi.fn(async (_org: string, n: string) =>
          n === name
            ? {
                id: `env-${name}`,
                org_id: TEST_ORG,
                name,
                type: 'deployment',
                glob_pattern: null,
                branch_restrictions: null,
                trigger_type_filters: null,
                repo_patterns: null,
                concurrency_limit: null,
                concurrency_strategy: null,
                concurrency_timeout_ms: null,
                required_reviewers: null,
                wait_timer_seconds: null,
                hold_expiry_seconds: null,
                minimum_trust: null,
                allow_local_execution: allowLocalExecution,
                enabled: true,
                created_at: new Date(),
                updated_at: new Date(),
                created_by: null,
              }
            : null,
        ),
      } as any;
    }

    function captureDispatchedJobConfig(deps: ProcessingDeps): () => any {
      const dispatch = vi
        .fn()
        .mockResolvedValue({ status: 'dispatched', agentId: 'agent-1', jobId: 'job-1' });
      (deps.dispatcher as any).dispatch = dispatch;
      return () => dispatch.mock.calls[0]?.[0]?.jobConfig;
    }

    /** Generate an orchestrator x25519 keypair as base64 DER (matches route shape). */
    function makeOrchestratorKeypair(): { publicKeyDer: Buffer; privateKeyB64: string } {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
      return {
        publicKeyDer: Buffer.from(publicKey.export({ type: 'spki', format: 'der' })),
        privateKeyB64: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' })).toString(
          'base64',
        ),
      };
    }

    it('resolves test-env namespaced secrets via the fixture mapping', async () => {
      const lockFile = createMockLockFile([createMockWorkflow('ci')]);
      const perEnv = new Map<string, Record<string, string>>([
        ['test-database', { KICI_DATABASE_URL: 'test://db' }],
      ]);
      deps.db = makeSecretDb({ 'test-database': { allow_local_execution: true } }) as any;
      deps.contextStore = makeTestEnvStore('test-database');
      deps.secretResolver = {
        resolveForContext: vi.fn(
          async (_org: string, context: { name: string }) => perEnv.get(context.name) ?? {},
        ),
      } as any;
      const getJobConfig = captureDispatchedJobConfig(deps);

      const input = createMockInput({
        inlineLockFile: JSON.stringify(lockFile),
        routingKey: 'github:42',
        secrets: { db: 'test-database' },
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('accepted');
      expect(getJobConfig().namespacedSecrets.db.KICI_DATABASE_URL).toBe('test://db');
    });

    it('resolves a fixture mapping through a glob-matched context row', async () => {
      const lockFile = createMockLockFile([createMockWorkflow('ci')]);
      deps.db = makeSecretDb({}) as any;
      // 'preview-7' matches the glob context 'preview-*'; the store answers
      // with that glob row, whose id is not derived from the declared name.
      const globStore = makeTestEnvStore('preview-7');
      const globRow = await globStore.matchContext(TEST_ORG, 'preview-7');
      globStore.matchContext.mockResolvedValue({
        ...globRow,
        id: 'env-preview-glob',
        name: 'preview-*',
      });
      deps.contextStore = globStore;
      const resolveForContext = vi.fn(async (_org: string, context: { id: string }) =>
        context.id === 'env-preview-glob' ? { KICI_DATABASE_URL: 'preview://db' } : {},
      );
      deps.secretResolver = { resolveForContext } as any;
      const getJobConfig = captureDispatchedJobConfig(deps);

      const result = await processTestTrigger(
        createMockInput({
          inlineLockFile: JSON.stringify(lockFile),
          routingKey: 'github:42',
          secrets: { db: 'preview-7' },
        }),
        deps,
      );

      // fails-when: the fixture gate or the resolution looks the context up by exact name
      expect(result.status).toBe('accepted');
      expect(getJobConfig().namespacedSecrets.db.KICI_DATABASE_URL).toBe('preview://db');
      expect(resolveForContext).toHaveBeenCalledWith(TEST_ORG, {
        id: 'env-preview-glob',
        name: 'preview-7',
      });
    });

    it('CLI-uploaded secrets override test-env values', async () => {
      const workflowWithEnv = createMockWorkflow('ci', [
        staticJob({
          name: 'test-job',
          runsOn: [{ kind: 'exact', value: 'default' }],
          steps: [{ name: 'echo', run: 'echo hi' }],
          rules: [],
          contexts: [{ value: 'test-database', dynamic: false }],
        }),
      ]);
      const lockFile = createMockLockFile([workflowWithEnv]);
      const perEnv = new Map<string, Record<string, string>>([
        ['test-database', { KICI_DATABASE_URL: 'shared' }],
      ]);
      deps.db = makeSecretDb({ 'test-database': { allow_local_execution: true } }) as any;
      deps.contextStore = makeTestEnvStore('test-database');
      deps.secretResolver = {
        resolveForContext: vi.fn(
          async (_org: string, context: { name: string }) => perEnv.get(context.name) ?? {},
        ),
      } as any;
      const getJobConfig = captureDispatchedJobConfig(deps);

      const kp = makeOrchestratorKeypair();
      const { ciphertextB64, senderPublicKeyB64 } = encryptJson(
        { flat: { KICI_DATABASE_URL: 'local' }, contexts: {} },
        kp.publicKeyDer,
      );

      const input = createMockInput({
        inlineLockFile: JSON.stringify(lockFile),
        routingKey: 'github:42',
        encryptedSecrets: ciphertextB64,
        encryptedSecretsKey: senderPublicKeyB64,
        resolvedOverlay: {
          tarballUrl: 'https://example.com/t.tgz',
          cliPublicKey: 'cli-pub',
          orchestratorPrivateKey: kp.privateKeyB64,
        },
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('accepted');
      expect(getJobConfig().secrets.KICI_DATABASE_URL).toBe('local');
    });

    it('rejects when a fixture maps to a non-test-allowed context', async () => {
      const lockFile = createMockLockFile([createMockWorkflow('ci')]);
      deps.db = makeSecretDb({ production: { allow_local_execution: false } }) as any;
      deps.contextStore = makeTestEnvStore('production', false);
      deps.secretResolver = {
        resolveForContext: vi.fn(async () => ({})),
      } as any;

      const input = createMockInput({
        inlineLockFile: JSON.stringify(lockFile),
        routingKey: 'github:42',
        secrets: { db: 'production' },
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('db');
      expect(result.reason).toContain('production');
    });
  });

  describe('context resolution at test dispatch', () => {
    const CTX_ORG = 'org-ctx';

    // db mock answering resolveOrgId (sources -> ORG) and the org-scoped
    // contexts lookup keyed on the env name.
    function makeContextDb(envRows: Record<string, { allow_local_execution: boolean }>) {
      return {
        fn: { countAll: () => ({ as: () => ({}) }) },
        selectFrom: vi.fn((table: string) => ({
          select: vi.fn(() => {
            let envName: string | undefined;
            const chain: any = {
              where: vi.fn((col: string, _op: string, val: string) => {
                if (col === 'name') envName = val;
                return chain;
              }),
              innerJoin: vi.fn(() => chain),
              executeTakeFirst: vi.fn(async () => {
                if (table === 'sources') return { customer_id: CTX_ORG };
                if (table === 'generic_webhook_sources') return undefined;
                if (table === 'contexts') return envName ? envRows[envName] : undefined;
                if (table === 'execution_jobs') return { count: 0 };
                return undefined;
              }),
            };
            return chain;
          }),
        })),
        insertInto: vi.fn(() => ({
          values: vi.fn(() => ({
            onConflict: vi.fn(() => ({ execute: vi.fn().mockResolvedValue(undefined) })),
            execute: vi.fn().mockResolvedValue(undefined),
          })),
        })),
        updateTable: makeUpdateTableMock(),
      };
    }

    /** Env store whose matchContext returns a full row (no protection rules). */
    function makeContextEnvStore(name: string, allowLocalExecution = true) {
      return {
        matchContext: vi.fn(async (_org: string, n: string) =>
          n === name
            ? {
                id: `env-${name}`,
                org_id: CTX_ORG,
                name,
                type: 'deployment',
                glob_pattern: null,
                branch_restrictions: null,
                trigger_type_filters: null,
                repo_patterns: null,
                concurrency_limit: null,
                concurrency_strategy: null,
                concurrency_timeout_ms: null,
                required_reviewers: null,
                wait_timer_seconds: null,
                hold_expiry_seconds: null,
                minimum_trust: null,
                allow_local_execution: allowLocalExecution,
                enabled: true,
                created_at: new Date(),
                updated_at: new Date(),
                created_by: null,
              }
            : null,
        ),
      } as any;
    }

    function staticContextWorkflow() {
      return createMockWorkflow('ci', [
        staticJob({
          name: 'deploy-job',
          runsOn: [{ kind: 'exact', value: 'default' }],
          steps: [{ name: 'deploy', run: 'echo deploy' }],
          rules: [],
          contexts: [{ value: 'test-db', dynamic: false }],
        }),
      ]);
    }

    it('marks the run root jobs needs_satisfied through the chained update', async () => {
      const lockFile = createMockLockFile([staticContextWorkflow()]);
      (deps.lockFileCache.get as any).mockResolvedValue(lockFile);
      const executed: Array<Record<string, unknown>> = [];
      const db = makeContextDb({ 'test-db': { allow_local_execution: true } });
      db.updateTable = makeUpdateTableMock(undefined, (payload) => executed.push(payload));
      deps.db = db as any;
      deps.contextStore = makeContextEnvStore('test-db');
      deps.secretResolver = { resolveForContext: vi.fn(async () => ({ DB_URL: 'x' })) } as any;

      const input = createMockInput({
        routingKey: 'github:42',
        workflowName: 'ci',
        event: { type: 'push', targetBranch: 'master', payload: {} },
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('accepted');
      // Asserting the chained root-job update reached `.execute()` keeps the
      // mock honest (see `makeUpdateTableMock`).
      expect(executed.some((payload) => payload.needs_satisfied === true)).toBe(true);
    });

    it('skips dynamic contexts (marker set, no value)', async () => {
      const impureWorkflow = createMockWorkflow('ci', [
        {
          _type: 'static' as const,
          name: 'impure-job',
          runsOn: [{ kind: 'exact', value: 'default' }],
          steps: [{ name: 'deploy', run: 'echo deploy' }],
          needs: [],
          rules: [],
          dynamicContext: true,
          // NO context field -- a dynamic context is resolved by the init round.
        },
      ]);
      const lockFile = createMockLockFile([impureWorkflow]);
      (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

      const envQueries: string[] = [];
      const mockDb = {
        selectFrom: vi.fn((table: string) => ({
          select: vi.fn(() => {
            const chain: any = {
              where: vi.fn((col: string, _op: string, val: string) => {
                if (table === 'contexts' && col === 'name') envQueries.push(val);
                return chain;
              }),
              executeTakeFirst: vi.fn(async () => {
                if (table === 'sources') return { customer_id: CTX_ORG };
                return undefined;
              }),
            };
            return chain;
          }),
        })),
        updateTable: makeUpdateTableMock(),
      };
      deps.db = mockDb as any;

      const resolveForContext = vi.fn(async () => ({}));
      deps.secretResolver = { resolveForContext } as any;

      const input = createMockInput({
        routingKey: 'github:42',
        workflowName: 'ci',
        event: { type: 'push', targetBranch: 'master', payload: {} },
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('accepted');
      // No context gate query happened for the impure job.
      expect(envQueries).toEqual([]);
      // resolveForContext was never called with a context for this job.
      expect(resolveForContext).not.toHaveBeenCalled();
    });
  });

  describe('test dispatch parity', () => {
    const ORG = 'org-parity';

    // db mock answering resolveOrgId (sources -> ORG) and the org-scoped
    // contexts gate lookup keyed on the env name.
    function makeParityDb(envRows: Record<string, { allow_local_execution: boolean }>) {
      return {
        fn: { countAll: () => ({ as: () => ({}) }) },
        selectFrom: vi.fn((table: string) => ({
          select: vi.fn(() => {
            let envName: string | undefined;
            const chain: any = {
              where: vi.fn((col: string, _op: string, val: string) => {
                if (col === 'name') envName = val;
                return chain;
              }),
              innerJoin: vi.fn(() => chain),
              executeTakeFirst: vi.fn(async () => {
                if (table === 'sources') return { customer_id: ORG };
                if (table === 'generic_webhook_sources') return undefined;
                if (table === 'contexts') return envName ? envRows[envName] : undefined;
                // execution_jobs running-count query → no concurrent jobs.
                if (table === 'execution_jobs') return { count: 0 };
                return undefined;
              }),
            };
            return chain;
          }),
          insertInto: vi.fn(),
        })),
        insertInto: vi.fn(() => ({
          values: vi.fn(() => ({
            onConflict: vi.fn(() => ({ execute: vi.fn().mockResolvedValue(undefined) })),
            execute: vi.fn().mockResolvedValue(undefined),
          })),
        })),
        updateTable: makeUpdateTableMock(),
      };
    }

    function captureDispatchedJobConfig(deps: ProcessingDeps): () => any {
      const dispatch = vi
        .fn()
        .mockResolvedValue({ status: 'dispatched', agentId: 'agent-1', jobId: 'job-1' });
      (deps.dispatcher as any).dispatch = dispatch;
      return () => dispatch.mock.calls[0]?.[0]?.jobConfig;
    }

    /** Env store whose matchContext returns a full row (no protection rules). */
    function makeContextStore(name: string, id: string) {
      return {
        matchContext: vi.fn(async (_org: string, n: string) =>
          n === name
            ? {
                id,
                org_id: ORG,
                name,
                type: 'deployment',
                glob_pattern: null,
                branch_restrictions: null,
                trigger_type_filters: null,
                repo_patterns: null,
                concurrency_limit: null,
                concurrency_strategy: null,
                concurrency_timeout_ms: null,
                required_reviewers: null,
                wait_timer_seconds: null,
                hold_expiry_seconds: null,
                minimum_trust: null,
                allow_local_execution: true,
                enabled: true,
                created_at: new Date(),
                updated_at: new Date(),
                created_by: null,
              }
            : null,
        ),
      } as any;
    }

    function staticEnvWorkflow() {
      return createMockWorkflow('ci', [
        staticJob({
          name: 'deploy-job',
          runsOn: [{ kind: 'exact', value: 'default' }],
          steps: [{ name: 'deploy', run: 'echo deploy' }],
          rules: [],
          contexts: [{ value: 'test-db', dynamic: false }],
          env: { FOO: 'bar' },
        }),
      ]);
    }

    it('passes the fixture envelope, resolved context, jobEnv and contextVars to the agent', async () => {
      const lockFile = createMockLockFile([staticEnvWorkflow()]);
      (deps.lockFileCache.get as any).mockResolvedValue(lockFile);
      deps.db = makeParityDb({ 'test-db': { allow_local_execution: true } }) as any;
      deps.contextStore = makeContextStore('test-db', 'env-1');
      deps.variableStore = {
        getResolvedVars: vi.fn(async (_org: string, _envId: string, _rk?: string) => ({
          STAGE: 'test',
        })),
      } as any;
      const getJobConfig = captureDispatchedJobConfig(deps);

      const input = createMockInput({
        routingKey: 'github:42',
        workflowName: 'ci',
        event: {
          type: 'push',
          targetBranch: 'master',
          payload: { ref: 'refs/heads/master' },
        },
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('accepted');
      const jobConfig = getJobConfig();
      expect(jobConfig.event).toEqual({
        type: 'push',
        action: undefined,
        targetBranch: 'master',
        sourceBranch: undefined,
        payload: { ref: 'refs/heads/master' },
        changedFiles: undefined,
      });
      expect(jobConfig.context).toBe('test-db');
      expect(jobConfig.contextVars).toEqual({ STAGE: 'test' });
      expect(jobConfig.jobEnv).toEqual({ FOO: 'bar' });
      // variable store resolved against the env row's id + routing key.
      expect(deps.variableStore!.getResolvedVars).toHaveBeenCalledWith(ORG, 'env-1', 'github:42');
    });

    it('dispatches a dynamic jobEnv with no in-process value (resolved by the init round)', async () => {
      // The agent's init job resolves a dynamic env, so the dispatched job
      // carries no in-process jobEnv — the field takes the init marker.
      const dynamicEnvJobWorkflow = createMockWorkflow('ci', [
        staticJob({
          name: 'deploy-job',
          runsOn: [{ kind: 'exact', value: 'default' }],
          steps: [{ name: 'deploy', run: 'echo deploy' }],
          rules: [],
          dynamicEnv: true,
        }),
      ]);
      const lockFile = createMockLockFile([dynamicEnvJobWorkflow]);
      (deps.lockFileCache.get as any).mockResolvedValue(lockFile);
      deps.db = makeParityDb({}) as any;
      const getJobConfig = captureDispatchedJobConfig(deps);

      const input = createMockInput({
        routingKey: 'github:42',
        workflowName: 'ci',
        event: { type: 'push', targetBranch: 'master', payload: {} },
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('accepted');
      expect(getJobConfig().jobEnv).toBeUndefined();
    });

    it('omits contextVars when no variable store is wired', async () => {
      const lockFile = createMockLockFile([staticEnvWorkflow()]);
      (deps.lockFileCache.get as any).mockResolvedValue(lockFile);
      deps.db = makeParityDb({ 'test-db': { allow_local_execution: true } }) as any;
      deps.contextStore = makeContextStore('test-db', 'env-1');
      // No variableStore wired.
      const getJobConfig = captureDispatchedJobConfig(deps);

      const input = createMockInput({
        routingKey: 'github:42',
        workflowName: 'ci',
        event: { type: 'push', targetBranch: 'master', payload: { ref: 'refs/heads/master' } },
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('accepted');
      const jobConfig = getJobConfig();
      expect(jobConfig.contextVars).toBeUndefined();
      expect(jobConfig.event).toEqual({
        type: 'push',
        action: undefined,
        targetBranch: 'master',
        sourceBranch: undefined,
        payload: { ref: 'refs/heads/master' },
        changedFiles: undefined,
      });
      expect(jobConfig.context).toBe('test-db');
      expect(jobConfig.jobEnv).toEqual({ FOO: 'bar' });
    });
  });
});

/**
 * Attribution of a remote test run (`kici run remote`) onto
 * `execution_runs.triggered_by`. The rendering reuses the dashboard re-run
 * path's `stringifyActor` + `agentLabelOf`: two renderings of one identity
 * drift.
 */
describe('processTestTrigger records the triggering actor', () => {
  let deps: ProcessingDeps;
  beforeEach(() => {
    deps = createMockDeps();
  });

  /**
   * Positional indices into `onExecutionStarted`, read off the call sites in
   * `dispatch-matched-workflow.ts`. A reordered signature fails these
   * assertions rather than silently reading a neighbouring argument.
   */
  const TRIGGERED_BY_ARG = 15;
  const TRIGGERED_BY_AGENT_LABEL_ARG = 23;

  function trackerAndDb() {
    const executionTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
      markTestRun: vi.fn(),
    };
    const db = {
      selectFrom: vi.fn(() => ({
        select: vi.fn(() => ({
          where: vi.fn(() => ({ executeTakeFirst: vi.fn().mockResolvedValue(undefined) })),
        })),
      })),
      insertInto: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflict: vi.fn(() => ({ execute: vi.fn().mockResolvedValue(undefined) })),
          execute: vi.fn().mockResolvedValue(undefined),
        })),
      })),
      updateTable: makeUpdateTableMock(() => {}),
    };
    return { executionTracker, db };
  }

  async function runWithActor(actor: ActorPrincipal) {
    const lockFile = createMockLockFile([createMockWorkflow('ci')]);
    (deps.lockFileCache.get as any).mockResolvedValue(lockFile);
    const { executionTracker, db } = trackerAndDb();
    deps.executionTracker = executionTracker as any;
    deps.db = db as any;

    const result = await processTestTrigger(createMockInput({ actor }), deps);
    expect(result.status).toBe('accepted');
    expect(executionTracker.onExecutionStarted).toHaveBeenCalled();
    return executionTracker.onExecutionStarted.mock.calls[0];
  }

  it('records a plain user actor as triggered_by with no agent label', async () => {
    const args = await runWithActor({ type: 'user', sub: 'kc-sub-123' });
    expect(args[TRIGGERED_BY_ARG]).toBe('user:kc-sub-123');
    // Null, not "null" or a stray label: a non-agent run has no agent label.
    expect(args[TRIGGERED_BY_AGENT_LABEL_ARG]).toBeNull();
  });

  it('splits an agent-kind actor across triggered_by and the agent label', async () => {
    const args = await runWithActor({
      type: 'user',
      sub: 'kc-sub-123',
      agent: { patId: 'pat-9', label: 'ci' },
    });
    expect(args[TRIGGERED_BY_ARG]).toBe('user:kc-sub-123 via agent:ci');
    expect(args[TRIGGERED_BY_AGENT_LABEL_ARG]).toBe('ci');
  });

  it('records an API-key actor by its key id', async () => {
    const args = await runWithActor({
      type: 'api_key',
      keyId: 'key-1',
      ownerSub: 'kc-sub-123',
    });
    expect(args[TRIGGERED_BY_ARG]).toBe('api_key:key-1');
  });
});

describe('processTestTrigger records the commit the run acted on', () => {
  /** Positional indices into `onExecutionStarted` (see the actor block above). */
  const BRANCH_ARG = 4;
  const SHA_ARG = 5;
  const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';

  async function runWith(input: Partial<TestTriggerInput>) {
    const deps = createMockDeps();
    (deps.lockFileCache.get as any).mockResolvedValue(
      createMockLockFile([createMockWorkflow('ci')]),
    );
    const executionTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
      markTestRun: vi.fn(),
    };
    deps.executionTracker = executionTracker as any;
    const result = await processTestTrigger(createMockInput(input), deps);
    expect(result.status).toBe('accepted');
    return executionTracker.onExecutionStarted.mock.calls[0];
  }

  it("records the push event's commit SHA, not its branch name", async () => {
    const args = await runWith({
      event: {
        type: 'push',
        targetBranch: 'main',
        payload: { ref: 'refs/heads/main', after: HEAD_SHA },
      },
    });
    expect(args[BRANCH_ARG]).toBe('main');
    // fails-when: the run's sha column holds the branch name (#470)
    expect(args[SHA_ARG]).toBe(HEAD_SHA);
  });

  it("records a PR event's head SHA", async () => {
    const args = await runWith({
      workflowName: 'ci',
      event: {
        type: 'pull_request',
        action: 'opened',
        targetBranch: 'main',
        sourceBranch: 'feature/x',
        payload: { pull_request: { head: { ref: 'feature/x', sha: HEAD_SHA } } },
      },
    });
    expect(args[SHA_ARG]).toBe(HEAD_SHA);
  });

  it("falls back to the overlay upload's commit when the event names none", async () => {
    const args = await runWith({ uploadSha: HEAD_SHA, workflowName: 'ci' });
    // fails-when: a bare --workflow run (manual event, no SHA field) records a branch name
    expect(args[SHA_ARG]).toBe(HEAD_SHA);
  });

  it('keeps the branch when nothing names a commit', async () => {
    // breaks-if-wrong: a provider-fetch test run clones by this value, so a
    // missing SHA must still resolve to a cloneable ref
    const args = await runWith({});
    expect(args[SHA_ARG]).toBe('main');
  });
});
