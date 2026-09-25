/**
 * A generated job whose resolution throws is dropped on its own, so one bad job
 * does not poison the rest of the generated set. The drop must name the step
 * that failed, and must give back the in-pass concurrency slot the job's
 * context gate reserved: the job never dispatches. It is recorded on the run as
 * failed, so a job that needs it and the run itself reach a terminal state.
 */
import { describe, expect, it, vi } from 'vitest';
import { ExecutionJobStatus, InitFailureCategory } from '@kici-dev/engine';

const { mockError } = vi.hoisted(() => ({ mockError: vi.fn() }));
vi.mock('@kici-dev/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kici-dev/shared')>();
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: mockError, debug: vi.fn() }),
  };
});

import {
  dispatchMatchedWorkflow,
  type WorkflowDispatchContext,
} from './dispatch-matched-workflow.js';
import {
  awaitDispatchTasksSettled,
  makeGateTracker,
  makeHoldDb,
  makeJobContextRow,
  makeSingleJobContext,
  TEST_INBOUND_PROVIDER,
  type SingleJobContextOptions,
} from './dispatch-matched-workflow.test-helpers.js';
import type { GlobalDispatchIdentity } from './global-dispatch-identity.js';

const CONTEXT_NAME = 'prod';
const SECRET = { PROD_TOKEN: 'sekrit' };
/** A runs-on value the host roster lookup fails for. */
const BROKEN_HOST = 'broken-host';

const bundle = {
  normalizer: { provider: TEST_INBOUND_PROVIDER },
  repoUrlBuilder: { buildCloneUrl: (repo: string) => `https://git.example/${repo}.git` },
} as unknown as WorkflowDispatchContext['bundle'];

/** A root generated job named `name` binding `contexts`, routed to `runsOn`. */
function generatedJob(name: string, contexts: string[], runsOn = 'default') {
  return {
    name,
    runsOn: [{ kind: 'exact', value: runsOn }],
    steps: [{ name: 'echo', run: `echo ${name}` }],
    needs: [],
    contexts: contexts.map((value) => ({ value, dynamic: false })),
  };
}

interface Scenario {
  generatedJobs: unknown[];
  /** Columns overriding the `prod` context row. */
  row?: Record<string, unknown>;
  global?: GlobalDispatchIdentity;
  /** Runs once the eval reports its jobs, before they are resolved. */
  onEvalComplete?: (ctx: WorkflowDispatchContext) => void;
}

async function runScenario(s: Scenario) {
  mockError.mockClear();
  const tracker = makeGateTracker();
  const heldRunStore = {
    createHold: vi.fn().mockResolvedValue({ id: 'held-approval' }),
    create: vi.fn().mockResolvedValue({ id: 'held-gate' }),
  };
  let ctxRef: WorkflowDispatchContext | undefined;
  const opts: SingleJobContextOptions = {
    bundle,
    fullRepo: true,
    withDynamicEntry: true,
    executionTracker: tracker,
    heldRunStore,
    db: makeHoldDb(),
    contextStore: {
      matchContext: async (_org: string, n: string) => {
        if (n === 'unreadable') throw new Error('context store unavailable');
        return n === CONTEXT_NAME ? makeJobContextRow(n, opts, s.row ?? {}) : null;
      },
    },
    pendingDynamics: {
      track: vi.fn(async () => {
        s.onEvalComplete?.(ctxRef!);
        return s.generatedJobs;
      }),
      resolve: vi.fn(),
      reject: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      cleanup: vi.fn(),
    },
    secretResolver: {
      resolveForContext: async () => SECRET,
      resolveNamedInternal: async () => null,
      resolveForContextWithMeta: async () => SECRET,
    },
  };
  const { ctx, dispatched } = makeSingleJobContext(opts);
  ctxRef = ctx;
  (ctx.deps as unknown as Record<string, unknown>).hostRosterStore = {
    get: async (id: string) => {
      if (id === BROKEN_HOST) throw new Error('host roster unavailable');
      return null;
    },
  };
  if (s.global) {
    ctx.global = s.global;
    ctx.workflowRepoIdentifier = s.global.workflowRepoIdentifier;
  }
  await dispatchMatchedWorkflow(ctx);
  await vi.waitFor(() => expect(dispatched.some((d) => d.jobName.startsWith('__dynamic__'))));
  await awaitDispatchTasksSettled(tracker);
  return { heldRunStore, dispatched, tracker };
}

/** The error lines logged for the job named `job`. */
function errorsFor(job: string): Array<{ message: string; step?: string; error?: string }> {
  return mockError.mock.calls
    .filter((c) => (c[1] as { job?: string } | undefined)?.job === job)
    .map((c) => ({ message: c[0] as string, ...(c[1] as { step?: string; error?: string }) }));
}

describe('dispatchMatchedWorkflow — a generated job whose resolution throws', () => {
  it('gives back the concurrency slot of a job dropped after its gate admitted it', async () => {
    const { heldRunStore, dispatched } = await runScenario({
      row: { concurrency_limit: 1 },
      generatedJobs: [
        generatedJob('first', [CONTEXT_NAME], BROKEN_HOST),
        generatedJob('second', [CONTEXT_NAME]),
      ],
    });

    // fails-when: `first` keeps the slot its gate reserved, so the limit of 1 queues
    // `second` behind a job that never dispatches
    const heldIds = heldRunStore.create.mock.calls.map((c) => (c[1] as { jobId: string }).jobId);
    expect(heldIds).not.toContain('second');
    // breaks-if-wrong: the sibling still dispatches with its context secret
    const second = dispatched.find((d) => d.jobName === 'second');
    expect(second?.jobConfig.secrets).toMatchObject(SECRET);
    expect(dispatched.find((d) => d.jobName === 'first')).toBeUndefined();
  });

  it('queues the sibling behind a first job that does dispatch, so the case above discriminates', async () => {
    // Positive control: with `first` live, the same limit of 1 holds `second`.
    const { heldRunStore, dispatched } = await runScenario({
      row: { concurrency_limit: 1 },
      generatedJobs: [
        generatedJob('first', [CONTEXT_NAME]),
        generatedJob('second', [CONTEXT_NAME]),
      ],
    });

    const heldIds = heldRunStore.create.mock.calls.map((c) => (c[1] as { jobId: string }).jobId);
    expect(heldIds).toContain('second');
    expect(dispatched.find((d) => d.jobName === 'first')).toBeDefined();
  });

  it('names a job config failure, not a secret failure, for a global checkout it cannot build', async () => {
    const global: GlobalDispatchIdentity = {
      workflowRepoIdentifier: 'org/ci',
      workflowSha: 'a1',
      workflowBranch: 'main',
      workflowRoutingKey: 'rk-ci',
      workflowProviderContext: { installationId: 7 },
      workflowBundle: bundle,
      workflowCredentials: {},
    };
    await runScenario({
      generatedJobs: [generatedJob('gen', [])],
      global,
      // The eval job was built with a clone URL; the workflow bundle loses it before
      // the generated job's config is built.
      onEvalComplete: (ctx) => {
        ctx.global = { ...ctx.global!, workflowBundle: undefined };
      },
    });

    // fails-when: the drop is logged as "Failed to resolve secrets" although the global
    // checkout fields are what threw
    expect(errorsFor('gen')).toEqual([
      {
        message: 'Dropped a dynamic generated job: its job config could not be built',
        step: 'job-config',
        error: expect.stringContaining('cannot build a clone URL'),
        runId: 'run-1',
        job: 'gen',
      },
    ]);
  });

  it('names a context gate failure when matching the context throws', async () => {
    const { tracker } = await runScenario({ generatedJobs: [generatedJob('gen', ['unreadable'])] });

    // breaks-if-wrong: a failure inside the gate is still told apart from a config failure
    expect(errorsFor('gen')).toMatchObject([
      {
        message: 'Dropped a dynamic generated job: its context gate failed',
        step: 'context-gate',
        error: 'context store unavailable',
      },
    ]);
    expect(recordedFailure(tracker, 'gen')).toEqual({
      category: InitFailureCategory.enum.secret_resolution,
      message: 'Its contexts could not be resolved: context store unavailable',
    });
  });

  it('records the dropped job on the run under its name and routing labels', async () => {
    const { tracker } = await runScenario({
      generatedJobs: [generatedJob('first', [], BROKEN_HOST), generatedJob('second', [])],
    });

    // fails-when: the drop is only logged, so no row stands for `first` and a job that
    // needs it waits forever
    const added = tracker.addJobsToRun.mock.calls.flatMap(
      (c) => c[1] as Array<{ jobName: string; runsOnLabels: string[] }>,
    );
    expect(added.filter((j) => j.jobName === 'first')).toEqual([
      expect.objectContaining({ jobName: 'first', runsOnLabels: [BROKEN_HOST] }),
    ]);
    expect(recordedFailure(tracker, 'first')).toEqual({
      category: InitFailureCategory.enum.dynamic_eval,
      message: 'Its job config could not be built: host roster unavailable',
    });
    // breaks-if-wrong: the sibling that resolves is dispatched and records no failure
    expect(recordedFailure(tracker, 'second')).toBeUndefined();
  });

  it('records a job whose runs-on matcher is invalid, with no routing labels', async () => {
    const bad = { ...generatedJob('bad', []), runsOn: ['default'] };
    const { tracker } = await runScenario({ generatedJobs: [bad] });

    // fails-when: the record reads the invalid matcher again and throws, so the job the
    // matcher dropped is never recorded on the run
    const added = tracker.addJobsToRun.mock.calls.flatMap(
      (c) => c[1] as Array<{ jobName: string; runsOnLabels: string[] }>,
    );
    expect(added.filter((j) => j.jobName === 'bad')).toEqual([
      expect.objectContaining({ jobName: 'bad', runsOnLabels: [] }),
    ]);
    expect(recordedFailure(tracker, 'bad')).toMatchObject({
      category: InitFailureCategory.enum.dynamic_eval,
      message: expect.stringContaining('invalid label matcher'),
    });
  });
});

/** The init failure recorded as `failed` on the run for the job named `job`, if any. */
function recordedFailure(
  tracker: ReturnType<typeof makeGateTracker>,
  job: string,
): { category: string; message: string } | undefined {
  for (const call of tracker.onJobStatus.mock.calls) {
    const opts = call[5] as {
      initFailure?: { jobName?: string; category: string; message: string };
    };
    if (call[2] !== ExecutionJobStatus.enum.failed || opts?.initFailure?.jobName !== job) continue;
    return { category: opts.initFailure.category, message: opts.initFailure.message };
  }
  return undefined;
}
