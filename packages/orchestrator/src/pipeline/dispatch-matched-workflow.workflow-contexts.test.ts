/**
 * A context a lock workflow names at the workflow level (`LockWorkflow.contexts`)
 * is bound by every job of that workflow and gated per job, exactly like a
 * context the job names itself: the reject rules (repository, branch, trigger,
 * enabled), then the protection gates (required reviewers, wait timer, minimum
 * trust, concurrency), and only after both the context's secrets.
 *
 * The lock file is committed in the repository, so a workflow-level entry is
 * as attacker-controlled as a job-level one and must cost the same.
 */
import { describe, expect, it, vi } from 'vitest';
import { ContextGateRejectReason, ExecutionJobStatus } from '@kici-dev/engine';
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
import type { QueuedJobInput } from '../queue/job-queue.js';

const WF_CONTEXT = 'prod';
const JOB_CONTEXT = 'job-ctx';
const STATIC_JOB = 'build';
const GEN = 'gen';

/** Secrets per context. `TOKEN` collides so merge order is observable. */
const SECRETS: Record<string, Record<string, string>> = {
  [WF_CONTEXT]: { PROD_TOKEN: 'prod-sekrit', TOKEN: 'from-workflow' },
  [JOB_CONTEXT]: { TOKEN: 'from-job' },
};

const bundle = {
  normalizer: { provider: TEST_INBOUND_PROVIDER },
  repoUrlBuilder: { buildCloneUrl: (repo: string) => `https://git.example/${repo}.git` },
} as unknown as WorkflowDispatchContext['bundle'];

interface Scenario {
  /** Columns overriding the workflow-level context's row. */
  row?: Record<string, unknown>;
  /** Workflow-level context names; `[WF_CONTEXT]` when omitted, none when `[]`. */
  workflowContexts?: string[];
  /** A context the static job binds itself. */
  jobContext?: string;
  eventBranch?: string;
  /** Append a dynamic job fn whose eval generates one context-free job. */
  withGenerated?: boolean;
  /** Give the static job a dynamic env, so its contexts are gated after init. */
  withDeferredInit?: boolean;
  /**
   * Bind the static job to one DYNAMIC context, which its init round resolves to
   * this name: the job's contexts are gated after the round, from the names it
   * reports.
   */
  dynamicJobContext?: string;
}

/** One recorded `where` / `set` call on a table. */
interface DbCall {
  table: string;
  method: string;
  args: unknown[];
}

/** {@link makeHoldDb}, recording every `where` and `set` made on each table. */
function recordingHoldDb(): { db: unknown; calls: DbCall[] } {
  const db = makeHoldDb() as unknown as Record<string, (table: string) => Record<string, unknown>>;
  const calls: DbCall[] = [];
  for (const verb of ['selectFrom', 'updateTable']) {
    const open = db[verb];
    db[verb] = (table: string) => {
      const chain = open(table);
      for (const method of ['where', 'set']) {
        const next = chain[method] as (...args: unknown[]) => unknown;
        chain[method] = (...args: unknown[]) => {
          calls.push({ table, method, args });
          return next(...args);
        };
      }
      return chain;
    };
  }
  return { db, calls };
}

async function runScenario(s: Scenario) {
  const tracker = makeGateTracker();
  const heldRunStore = {
    createHold: vi.fn().mockResolvedValue({ id: 'held-approval' }),
    create: vi.fn().mockResolvedValue({ id: 'held-gate' }),
  };
  const workflowContexts = s.workflowContexts ?? [WF_CONTEXT];
  const matchContext = vi.fn(async (_org: string, n: string) => {
    if (n === WF_CONTEXT) return makeJobContextRow(n, opts, s.row ?? {});
    if (n === JOB_CONTEXT) return makeJobContextRow(n, opts);
    return null;
  });
  const resolveForContext = vi.fn(
    async (_org: string, context: { name: string }) => SECRETS[context.name] ?? {},
  );
  const recording = recordingHoldDb();
  const opts: SingleJobContextOptions = {
    bundle,
    fullRepo: true,
    executionTracker: tracker,
    heldRunStore,
    db: recording.db,
    contextStore: { matchContext },
    ...(workflowContexts.length > 0 && { workflowContexts }),
    ...(s.jobContext && { jobContext: s.jobContext }),
    ...(s.withDeferredInit && {
      withDynamicEnv: true,
      pendingInits: {
        track: vi.fn(async () => ({})),
        resolve: vi.fn(),
        reject: vi.fn(),
        has: vi.fn().mockReturnValue(false),
        cleanup: vi.fn(),
      },
    }),
    ...(s.dynamicJobContext && {
      withDynamicContext: true,
      pendingInits: {
        track: vi.fn(async () => ({ contextNames: [s.dynamicJobContext] })),
        resolve: vi.fn(),
        reject: vi.fn(),
        has: vi.fn().mockReturnValue(false),
        cleanup: vi.fn(),
      },
    }),
    ...(s.withGenerated && {
      withDynamicEntry: true,
      pendingDynamics: {
        track: vi.fn(async () => [
          {
            name: GEN,
            runsOn: [{ kind: 'exact', value: 'default' }],
            steps: [{ name: 'echo', run: 'echo gen' }],
            needs: [],
          },
        ]),
        resolve: vi.fn(),
        reject: vi.fn(),
        has: vi.fn().mockReturnValue(false),
        cleanup: vi.fn(),
      },
    }),
    secretResolver: {
      resolveForContext,
      resolveNamedInternal: async () => null,
      resolveForContextWithMeta: resolveForContext,
    },
  };
  const { ctx, dispatched } = makeSingleJobContext(opts);
  if (s.eventBranch) {
    const event = { ...ctx.event, targetBranch: s.eventBranch };
    ctx.event = event;
    ctx.eventWithFiles = event;
  }
  await dispatchMatchedWorkflow(ctx);
  return {
    tracker,
    heldRunStore,
    dispatched,
    matchContext,
    resolveForContext,
    dbCalls: recording.calls,
  };
}

/** The dispatched job named `jobName`, once it has reached the dispatcher. */
async function awaitDispatched(
  dispatched: QueuedJobInput[],
  jobName: string,
): Promise<QueuedJobInput> {
  await vi.waitFor(() => expect(dispatched.some((d) => d.jobName === jobName)).toBe(true));
  return dispatched.find((d) => d.jobName === jobName)!;
}

/** The init-failure recorded for `jobName`'s context-rule rejection. */
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

/** Every secret value any dispatched job config carries. */
function dispatchedSecretValues(dispatched: QueuedJobInput[]): string[] {
  return dispatched.flatMap((d) =>
    Object.values((d.jobConfig.secrets as Record<string, string> | undefined) ?? {}),
  );
}

describe('dispatchMatchedWorkflow — workflow-level contexts are gated per job', () => {
  it('rejects every job when the workflow context restricts the branch, with no secrets', async () => {
    // fails-when: resolveWorkflowSecretsAndKey resolves workflow.contexts with no gate, so
    // the job dispatches on `feature` carrying prod's secret
    const { tracker, dispatched } = await runScenario({
      row: { branch_restrictions: ['main'] },
      eventBranch: 'feature',
    });
    const rejection = await awaitRejection(tracker, STATIC_JOB);
    expect(rejection.status).toBe(ExecutionJobStatus.enum.failed);
    expect(rejection.message).toContain(ContextGateRejectReason.enum.branch_restricted);
    expect(dispatched.find((d) => d.jobName === STATIC_JOB)).toBeUndefined();
    expect(dispatchedSecretValues(dispatched)).not.toContain(SECRETS[WF_CONTEXT].PROD_TOKEN);
  });

  it('gives every job the workflow context secret on an allowed branch', async () => {
    // breaks-if-wrong: a workflow-level context that admits the run must still reach its jobs
    const { dispatched } = await runScenario({
      row: { branch_restrictions: ['main'] },
      eventBranch: 'main',
    });
    const job = await awaitDispatched(dispatched, STATIC_JOB);
    expect(job.jobConfig.secrets).toMatchObject({ PROD_TOKEN: SECRETS[WF_CONTEXT].PROD_TOKEN });
    expect(job.jobConfig.context).toBe(WF_CONTEXT);
  });

  it('holds a job whose workflow context requires reviewers, without its secrets', async () => {
    // fails-when: the workflow-level context skips applyContextProtectionGates, so the
    // reviewer-gated job dispatches immediately with prod's secret
    const { heldRunStore, dispatched } = await runScenario({
      row: { required_reviewers: '["alice"]' },
    });
    await vi.waitFor(() => expect(heldRunStore.createHold).toHaveBeenCalledTimes(1));
    expect((heldRunStore.createHold.mock.calls[0][1] as { jobId: string }).jobId).toBe(STATIC_JOB);
    expect(dispatched.find((d) => d.jobName === STATIC_JOB)).toBeUndefined();
    expect(dispatchedSecretValues(dispatched)).not.toContain(SECRETS[WF_CONTEXT].PROD_TOKEN);
  });

  it("lets the job's own context win a key collision with the workflow context", async () => {
    // fails-when: workflow-level names are placed after the job's own, so TOKEN is 'from-workflow'
    // breaks-if-wrong: a non-colliding workflow key must still reach the job
    const { dispatched } = await runScenario({ jobContext: JOB_CONTEXT });
    const job = await awaitDispatched(dispatched, STATIC_JOB);
    expect(job.jobConfig.secrets).toMatchObject({
      TOKEN: SECRETS[JOB_CONTEXT].TOKEN,
      PROD_TOKEN: SECRETS[WF_CONTEXT].PROD_TOKEN,
    });
  });

  it('gates a generated job on the workflow context', async () => {
    // fails-when: gateGeneratedJobContexts reads only the generated job's own contexts, so
    // the context-free generated job dispatches on `feature` with prod's secret
    const { tracker, dispatched } = await runScenario({
      row: { branch_restrictions: ['main'] },
      eventBranch: 'feature',
      withGenerated: true,
    });
    const rejection = await awaitRejection(tracker, GEN);
    expect(rejection.message).toContain(ContextGateRejectReason.enum.branch_restricted);
    await awaitDispatchTasksSettled(tracker);
    expect(dispatched.find((d) => d.jobName === GEN)).toBeUndefined();
  });

  it('gives a generated job the workflow context secret on an allowed branch', async () => {
    // breaks-if-wrong: the generated path must still resolve an admitting workflow context
    const { dispatched } = await runScenario({
      row: { branch_restrictions: ['main'] },
      eventBranch: 'main',
      withGenerated: true,
    });
    const gen = await awaitDispatched(dispatched, GEN);
    expect(gen.jobConfig.secrets).toMatchObject({ PROD_TOKEN: SECRETS[WF_CONTEXT].PROD_TOKEN });
  });

  it('gates a job whose contexts resolve after its init round on the workflow context', async () => {
    // fails-when: applyInitResultContext reads only lockJob.contexts, so the deferred job
    // dispatches on `feature` with prod's secret
    const { tracker, dispatched } = await runScenario({
      row: { branch_restrictions: ['main'] },
      eventBranch: 'feature',
      withDeferredInit: true,
    });
    const rejection = await awaitRejection(tracker, STATIC_JOB);
    expect(rejection.message).toContain(ContextGateRejectReason.enum.branch_restricted);
    await awaitDispatchTasksSettled(tracker);
    expect(dispatched.find((d) => d.jobName === STATIC_JOB)).toBeUndefined();
  });

  it('gates a job whose own context the init round resolves on the workflow context too', async () => {
    // fails-when: the dynamic-context branch gates only the names the agent reports, so the
    // workflow context's branch rule is skipped and the job dispatches on `feature`
    const { tracker, dispatched } = await runScenario({
      row: { branch_restrictions: ['main'] },
      eventBranch: 'feature',
      dynamicJobContext: JOB_CONTEXT,
    });
    const rejection = await awaitRejection(tracker, STATIC_JOB);
    expect(rejection.message).toContain(ContextGateRejectReason.enum.branch_restricted);
    await awaitDispatchTasksSettled(tracker);
    expect(dispatched.find((d) => d.jobName === STATIC_JOB)).toBeUndefined();
    expect(dispatchedSecretValues(dispatched)).not.toContain(SECRETS[WF_CONTEXT].PROD_TOKEN);
  });

  it('binds both the workflow context and the init-resolved one, the job one winning', async () => {
    // breaks-if-wrong: the name the init round resolves must still bind after the workflow names
    const { dispatched } = await runScenario({
      row: { branch_restrictions: ['main'] },
      eventBranch: 'main',
      dynamicJobContext: JOB_CONTEXT,
    });
    const job = await awaitDispatched(dispatched, STATIC_JOB);
    expect(job.jobConfig.secrets).toMatchObject({
      TOKEN: SECRETS[JOB_CONTEXT].TOKEN,
      PROD_TOKEN: SECRETS[WF_CONTEXT].PROD_TOKEN,
    });
    expect(job.jobConfig.context).toBe(WF_CONTEXT);
  });

  it('makes the first workflow-level context the primary context and concurrency group', async () => {
    const { dispatched, dbCalls } = await runScenario({ jobContext: JOB_CONTEXT });
    const job = await awaitDispatched(dispatched, STATIC_JOB);

    // fails-when: the job's own context, not the first workflow-level one, names the run's
    // primary context and the concurrency group its slot is counted under
    expect(job.jobConfig.context).toBe(WF_CONTEXT);
    const runContext = dbCalls.find(
      (c) =>
        c.table === 'execution_runs' &&
        c.method === 'set' &&
        (c.args[0] as { context?: string }).context !== undefined,
    );
    expect((runContext?.args[0] as { context: string }).context).toBe(WF_CONTEXT);
    const groups = dbCalls
      .filter((c) => c.method === 'where' && c.args[0] === 'execution_runs.context')
      .map((c) => c.args[2]);
    expect(groups).toEqual([WF_CONTEXT]);
  });

  it('leaves a workflow with no workflow-level contexts unchanged', async () => {
    // breaks-if-wrong: a context-free workflow must dispatch with no context lookup or secret
    const { dispatched, matchContext, resolveForContext } = await runScenario({
      workflowContexts: [],
    });
    const job = await awaitDispatched(dispatched, STATIC_JOB);
    expect(job.jobConfig).not.toHaveProperty('secrets');
    expect(job.jobConfig).not.toHaveProperty('context');
    expect(matchContext).not.toHaveBeenCalled();
    expect(resolveForContext).not.toHaveBeenCalled();
  });
});
