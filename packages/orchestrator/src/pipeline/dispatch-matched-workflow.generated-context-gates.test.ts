/**
 * A job a `DynamicJobFn` generates binds its contexts through the same gates a
 * static job does: the all-must-pass reject rules (repository, branch, trigger,
 * enabled) and the protection gates (required reviewers, wait timer, minimum
 * trust, concurrency). Its context's secrets are resolved only once both pass.
 */
import { describe, expect, it, vi } from 'vitest';
import { ContextGateRejectReason, ExecutionJobStatus } from '@kici-dev/engine';
import {
  concurrencyAdmissionKey,
  dispatchMatchedWorkflow,
  NEEDS_PENDING_JOB_ID_PREFIX,
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
import type { QueuedJobInput } from '../queue/job-queue.js';
import { consumePendingJobContext } from './processor.js';

const CONTEXT_NAME = 'prod';
const SECRET = { PROD_TOKEN: 'sekrit' };
const GEN = 'gen';

const bundle = {
  normalizer: { provider: TEST_INBOUND_PROVIDER },
  repoUrlBuilder: { buildCloneUrl: (repo: string) => `https://git.example/${repo}.git` },
} as unknown as WorkflowDispatchContext['bundle'];

/** A generated job binding `contexts` (none when omitted). */
function generatedJob(contexts?: string[], over: Record<string, unknown> = {}) {
  return {
    name: GEN,
    runsOn: [{ kind: 'exact', value: 'default' }],
    steps: [{ name: 'echo', run: 'echo gen' }],
    needs: [],
    ...(contexts && { contexts: contexts.map((value) => ({ value, dynamic: false })) }),
    ...over,
  };
}

interface Scenario {
  /** Columns overriding the `prod` context row. */
  row?: Record<string, unknown>;
  /** Contexts the generated job binds. */
  genContexts?: string[];
  /** Also bind the static `build` job to `prod`, as the control case. */
  staticBindsContext?: boolean;
  eventBranch?: string;
  repoIdentifier?: string;
  trustTier?: 'trusted' | 'unknown';
  global?: GlobalDispatchIdentity;
  /** The generated jobs the eval returns, instead of one `gen` job binding `genContexts`. */
  generatedJobs?: unknown[];
}

async function runScenario(s: Scenario) {
  const tracker = makeGateTracker();
  const heldRunStore = {
    createHold: vi.fn().mockResolvedValue({ id: 'held-approval' }),
    create: vi.fn().mockResolvedValue({ id: 'held-gate' }),
  };
  const matchContext = vi.fn(async (_org: string, n: string) =>
    n === CONTEXT_NAME ? makeJobContextRow(n, opts, s.row ?? {}) : null,
  );
  const opts: SingleJobContextOptions = {
    bundle,
    fullRepo: true,
    withDynamicEntry: true,
    executionTracker: tracker,
    heldRunStore,
    db: makeHoldDb(),
    contextStore: { matchContext },
    ...(s.staticBindsContext && { jobContext: CONTEXT_NAME }),
    pendingDynamics: {
      track: vi.fn(async () => s.generatedJobs ?? [generatedJob(s.genContexts)]),
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
  if (s.eventBranch) {
    const event = { ...ctx.event, targetBranch: s.eventBranch };
    ctx.event = event;
    ctx.eventWithFiles = event;
  }
  if (s.repoIdentifier) ctx.repoIdentifier = s.repoIdentifier;
  if (s.trustTier) {
    ctx.trustResolution = { tier: s.trustTier, contributorUsername: 'someone', reason: 'test' };
  }
  if (s.global) {
    ctx.global = s.global;
    ctx.workflowRepoIdentifier = s.global.workflowRepoIdentifier;
  }
  await dispatchMatchedWorkflow(ctx);
  // The eval and its generated jobs run in a task dispatch does not await; the
  // eval job's own dispatch is the last step before they are processed.
  await vi.waitFor(() => expect(dispatched.some((d) => d.jobName.startsWith('__dynamic__'))));
  return { tracker, heldRunStore, dispatched, matchContext, ctx };
}

/** The generated job, once the dynamic task has dispatched it. */
async function awaitGenerated(dispatched: QueuedJobInput[]): Promise<QueuedJobInput> {
  await vi.waitFor(() => expect(dispatched.some((d) => d.jobName === GEN)).toBe(true));
  return dispatched.find((d) => d.jobName === GEN)!;
}

/** The init-failure message recorded for `jobName`'s context-rule rejection. */
async function awaitRejection(
  tracker: ReturnType<typeof makeGateTracker>,
  jobName: string,
): Promise<{ status: unknown; message: string }> {
  let found: { status: unknown; message: string } | undefined;
  await vi.waitFor(() => {
    const call = tracker.onJobStatus.mock.calls.find((args: unknown[]) => {
      const data = args[5] as { initFailure?: { jobName?: string } } | undefined;
      return (
        typeof args[1] === 'string' &&
        (args[1] as string).startsWith('rejected-') &&
        data?.initFailure?.jobName === jobName
      );
    });
    expect(call).toBeDefined();
    const data = call![5] as { initFailure: { message: string } };
    found = { status: call![2], message: data.initFailure.message };
  });
  return found!;
}

describe('dispatchMatchedWorkflow — generated jobs pass their contexts protection gates', () => {
  it('rejects a generated job whose context restricts the branch, with no secrets', async () => {
    // fails-when: resolveGeneratedJobConfigs resolves a context's secrets without evaluateMultiContextGates
    const { tracker, dispatched } = await runScenario({
      row: { branch_restrictions: ['main'] },
      genContexts: [CONTEXT_NAME],
      eventBranch: 'feature',
    });
    const rejection = await awaitRejection(tracker, GEN);
    expect(rejection.status).toBe(ExecutionJobStatus.enum.failed);
    expect(rejection.message).toContain(ContextGateRejectReason.enum.branch_restricted);
    await awaitDispatchTasksSettled(tracker);
    expect(dispatched.find((d) => d.jobName === GEN)).toBeUndefined();
  });

  it('binds the same generated job on an allowed branch and gives it the secret', async () => {
    // breaks-if-wrong: a generated job whose context admits the branch must still receive its secrets
    const { dispatched } = await runScenario({
      row: { branch_restrictions: ['main'] },
      genContexts: [CONTEXT_NAME],
      eventBranch: 'main',
    });
    const gen = await awaitGenerated(dispatched);
    expect(gen.jobConfig.secrets).toMatchObject(SECRET);
    expect(gen.jobConfig.context).toBe(CONTEXT_NAME);
  });

  it('rejects a generated job whose context excludes the repository, with no secrets', async () => {
    // fails-when: the generated path skips the repoPatterns rule
    const { tracker, dispatched } = await runScenario({
      row: { repo_patterns: ['org/ci'] },
      genContexts: [CONTEXT_NAME],
      repoIdentifier: 'org/app',
    });
    const rejection = await awaitRejection(tracker, GEN);
    expect(rejection.message).toContain(ContextGateRejectReason.enum.repo_unmatched);
    await awaitDispatchTasksSettled(tracker);
    expect(dispatched.find((d) => d.jobName === GEN)).toBeUndefined();
  });

  it('holds a generated job exactly as the static path holds a job under minimumTrust', async () => {
    // fails-when: the generated path skips applyContextProtectionGates, so an untrusted run gets prod's secrets
    // breaks-if-wrong: the static control job must still be held by the same gate
    const { heldRunStore, tracker, dispatched } = await runScenario({
      row: { minimum_trust: 'trusted' },
      genContexts: [CONTEXT_NAME],
      staticBindsContext: true,
      trustTier: 'unknown',
    });
    await vi.waitFor(() =>
      expect(
        heldRunStore.create.mock.calls.map((c) => (c[1] as { jobId: string }).jobId),
      ).toContain(GEN),
    );
    const heldIds = heldRunStore.create.mock.calls.map((c) => (c[1] as { jobId: string }).jobId);
    // The static control took the same verdict for the same input.
    expect(heldIds).toContain('build');
    await awaitDispatchTasksSettled(tracker);
    expect(dispatched.map((d) => d.jobName)).not.toContain('build');
    expect(dispatched.map((d) => d.jobName)).not.toContain(GEN);
  });

  it('holds a generated job whose context requires reviewers and registers it on the run', async () => {
    // fails-when: a reviewer-gated context's generated job is dispatched with its secrets
    const { heldRunStore, tracker, dispatched } = await runScenario({
      row: { required_reviewers: '["alice"]' },
      genContexts: [CONTEXT_NAME],
    });
    await vi.waitFor(() => expect(heldRunStore.createHold).toHaveBeenCalledTimes(1));
    expect((heldRunStore.createHold.mock.calls[0][1] as { jobId: string }).jobId).toBe(GEN);
    // The placeholder keeps the run open while the hold waits.
    await vi.waitFor(() => {
      const registered = tracker.addJobsToRun.mock.calls.flatMap(
        (c) => c[1] as Array<{ jobName: string; jobId: string }>,
      );
      const gen = registered.find((j) => j.jobName === GEN);
      expect(gen?.jobId.startsWith(NEEDS_PENDING_JOB_ID_PREFIX)).toBe(true);
    });
    await awaitDispatchTasksSettled(tracker);
    expect(dispatched.find((d) => d.jobName === GEN)).toBeUndefined();
    // The resume path exists and carries the generated job's own config, and no
    // context secret was resolved for a job that has not been approved.
    const pending = await consumePendingJobContext(undefined, 'run-1', GEN);
    expect(pending?.jobInput.jobConfig.dynamicSource).toBeDefined();
    expect(pending?.jobInput.jobConfig).not.toHaveProperty('secrets');
  });

  it('keeps a needs-gated generated job out of the in-pass concurrency tally', async () => {
    const downstream = 'gen-after';
    const { tracker, heldRunStore, dispatched, ctx } = await runScenario({
      row: { concurrency_limit: 1 },
      generatedJobs: [
        generatedJob([CONTEXT_NAME]),
        generatedJob([CONTEXT_NAME], { name: downstream, needs: [GEN] }),
      ],
    });
    await awaitGenerated(dispatched);
    await awaitDispatchTasksSettled(tracker);

    // fails-when: the needs-gated job reserves a slot beside the root one, so the limit of
    // 1 queues it behind a sibling it will only ever run after
    const heldIds = heldRunStore.create.mock.calls.map((c) => (c[1] as { jobId: string }).jobId);
    expect(heldIds).not.toContain(downstream);
    const admitted = ctx.concurrencyAdmissions?.get(
      concurrencyAdmissionKey(ctx.resolvedOrgId, CONTEXT_NAME),
    );
    expect([...(admitted ?? [])]).toEqual([GEN]);
    // breaks-if-wrong: the needs-gated job is still registered for the needs scheduler
    const registered = tracker.addJobsToRun.mock.calls.flatMap(
      (c) => c[1] as Array<{ jobName: string; jobId: string }>,
    );
    expect(
      registered
        .find((j) => j.jobName === downstream)
        ?.jobId.startsWith(NEEDS_PENDING_JOB_ID_PREFIX),
    ).toBe(true);
  });

  it('gates each child of a generated matrix job under its own expanded name', async () => {
    const { heldRunStore, tracker, dispatched } = await runScenario({
      row: { required_reviewers: '["alice"]' },
      generatedJobs: [
        generatedJob([CONTEXT_NAME], {
          matrix: { _type: 'static', values: { variant: ['a', 'b'] } },
        }),
      ],
    });
    await vi.waitFor(() => expect(heldRunStore.createHold).toHaveBeenCalledTimes(2));
    await awaitDispatchTasksSettled(tracker);

    // fails-when: the gate holds each child under the base job name, so the two holds collide
    // and an approval of one child releases (or misses) the other
    const heldIds = heldRunStore.createHold.mock.calls.map(
      (c) => (c[1] as { jobId: string }).jobId,
    );
    expect(heldIds.sort()).toEqual([`${GEN} (a)`, `${GEN} (b)`]);
    expect(dispatched.filter((d) => d.jobName.startsWith(GEN))).toEqual([]);
  });

  it('dispatches a generated job with no contexts exactly as before', async () => {
    // breaks-if-wrong: a context-free generated job must dispatch with no context lookup
    const { dispatched, matchContext } = await runScenario({});
    const gen = await awaitGenerated(dispatched);
    expect(gen.jobConfig).not.toHaveProperty('context');
    expect(gen.jobConfig).not.toHaveProperty('secrets');
    expect(matchContext).not.toHaveBeenCalled();
  });

  it('skips a context the store does not know and dispatches with no secrets', async () => {
    // breaks-if-wrong: an unconfigured bound name contributes nothing and never rejects
    const { dispatched, tracker } = await runScenario({ genContexts: ['ghost'] });
    const gen = await awaitGenerated(dispatched);
    expect(gen.jobConfig).not.toHaveProperty('secrets');
    expect(
      tracker.onJobStatus.mock.calls.some(
        (args: unknown[]) => typeof args[1] === 'string' && args[1].startsWith('rejected-'),
      ),
    ).toBe(false);
  });

  it("gates a global run's generated job on the workflow repository and branch", async () => {
    // fails-when: the generated job's gate reads the event repository, so repoPatterns ['org/ci'] refuses it
    const global: GlobalDispatchIdentity = {
      workflowRepoIdentifier: 'org/ci',
      workflowSha: 'a1',
      workflowBranch: 'main',
      workflowRoutingKey: 'rk-ci',
      workflowProviderContext: { installationId: 7 },
      workflowBundle: bundle,
      workflowCredentials: {},
    };
    const { dispatched } = await runScenario({
      row: { repo_patterns: ['org/ci'], branch_restrictions: ['main'] },
      genContexts: [CONTEXT_NAME],
      repoIdentifier: 'org/app',
      eventBranch: 'feature',
      global,
    });
    const gen = await awaitGenerated(dispatched);
    expect(gen.jobConfig.secrets).toMatchObject(SECRET);
  });
});
