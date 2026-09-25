/**
 * Shared fixtures for the `dispatchMatchedWorkflow` test files.
 *
 * Kept out of any `*.test.ts` file so importing it does not re-register another
 * file's suites in the importer.
 */
import { expect, vi, type Mock } from 'vitest';
import type {
  LockWorkflow,
  ProviderType,
  SimulatedEvent,
  WorkflowDecision,
} from '@kici-dev/engine';
import type { ProcessingDeps } from './processor.js';
import type { QueuedJobInput } from '../queue/job-queue.js';
import type { WebhookInfo } from '../webhook/handler.js';
import type { WorkflowDispatchContext } from './dispatch-matched-workflow.js';

/** Provider of the inbound event every {@link makeSingleJobContext} fixture carries. */
export const TEST_INBOUND_PROVIDER: ProviderType = 'local';

/** Overrides {@link makeSingleJobContext} accepts. */
export interface SingleJobContextOptions {
  bundle: WorkflowDispatchContext['bundle'];
  fullRepo?: boolean;
  testRun?: { fixtureId: string };
  db?: unknown;
  executionTracker?: unknown;
  withBuildInfra?: boolean;
  withBuildMiss?: boolean;
  localWorkingTree?: boolean;
  runWideFlatSecrets?: Record<string, string>;
  jobContext?: string;
  /** Workflow-level context names (`LockWorkflow.contexts`) bound by every job. */
  workflowContexts?: string[];
  secretResolver?: unknown;
  checkMode?: string;
  jobContainer?: unknown;
  jobSandbox?: { capabilities?: string[]; network?: string };
  sandboxAllowListReader?: unknown;
  jobMatrix?: unknown;
  contextConcurrencyLimit?: number | null;
  /** Set wait_timer_seconds on the jobContext row, so its gate returns `wait`. */
  contextWaitTimerSeconds?: number | null;
  heldRunStore?: unknown;
  /** Append a dynamic job fn, so dispatch spawns a deferred dynamic entry. */
  withDynamicEntry?: boolean;
  /** Give the static job a dynamic matrix, so its init is deferred. */
  withDeferredInit?: boolean;
  /** Declare a workflow-level filter, so every job defers to the init round. */
  withFilter?: boolean;
  pendingDynamics?: unknown;
  pendingInits?: unknown;
  /** Give the static job an explicit SDK requireApproval. */
  jobApproval?: unknown;
  /** Give the job a dynamic env, so its init is deferred without a matrix. */
  withDynamicEnv?: boolean;
  /** Bind the job to a DYNAMIC context, resolved only by the init round. */
  withDynamicContext?: boolean;
  /** A contextStore stub used verbatim (overrides the jobContext-derived one). */
  contextStore?: unknown;
  /**
   * A checkRunReporter stub, so a case can observe the queued check runs the
   * dispatch setup phase creates against the commit.
   */
  checkRunReporter?: unknown;
}

/** The single static `build` job workflow, shaped by the fixture options. */
function makeSingleJobWorkflow(over: SingleJobContextOptions): LockWorkflow {
  return {
    name: 'ci',
    source: { file: '.kici/workflows/ci.ts', export: '#default' },
    contentHash: 'wf-hash',
    triggers: [],
    ...(over.withFilter ? { hasFilter: true } : {}),
    ...(over.workflowContexts ? { contexts: over.workflowContexts } : {}),
    jobs: [
      {
        _type: 'static' as const,
        name: 'build',
        runsOn: [{ kind: 'exact', value: 'default' }],
        steps: [{ name: 'echo', run: 'echo hi' }],
        needs: [],
        rules: [],
        ...(over.jobContext ? { contexts: [{ value: over.jobContext, dynamic: false }] } : {}),
        ...(over.jobContainer ? { container: over.jobContainer } : {}),
        ...(over.jobSandbox ? { sandbox: over.jobSandbox } : {}),
        ...(over.jobMatrix ? { matrix: over.jobMatrix } : {}),
        ...(over.jobApproval ? { approval: over.jobApproval } : {}),
        ...(over.withDynamicEnv ? { dynamicEnv: true } : {}),
        ...(over.withDynamicContext ? { contexts: [{ dynamic: true }] } : {}),
        ...(over.withDeferredInit
          ? {
              matrix: {
                _type: 'dynamic' as const,
                source: { file: '.kici/workflows/ci.ts', jobName: 'build' },
              },
            }
          : {}),
      },
      ...(over.withDynamicEntry
        ? [
            {
              _type: 'dynamic' as const,
              source: { file: '.kici/workflows/ci.ts', index: 0 },
            },
          ]
        : []),
    ],
  } as unknown as LockWorkflow;
}

/**
 * A context row named `name` with no rules, always enabled; `rowOver` replaces
 * any column.
 */
export function makeJobContextRow(
  name: string,
  over: SingleJobContextOptions,
  rowOver: Record<string, unknown> = {},
) {
  return {
    id: `env-${name}`,
    org_id: '__default__',
    name,
    type: 'deployment',
    glob_pattern: null,
    branch_restrictions: null,
    trigger_type_filters: null,
    repo_patterns: null,
    concurrency_limit: over.contextConcurrencyLimit ?? null,
    concurrency_strategy: null,
    concurrency_timeout_ms: null,
    required_reviewers: null,
    wait_timer_seconds: over.contextWaitTimerSeconds ?? null,
    hold_expiry_seconds: null,
    minimum_trust: null,
    allow_local_execution: true,
    enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
    created_by: null,
    ...rowOver,
  };
}

/** The dependency bag: a capturing dispatcher plus every optional dep the options name. */
function makeSingleJobDeps(
  over: SingleJobContextOptions,
  dispatched: QueuedJobInput[],
): ProcessingDeps {
  return {
    dispatcher: {
      dispatch: async (input: QueuedJobInput) => {
        dispatched.push(input);
        return { status: 'dispatched' as const, agentId: 'a1', jobId: `job-${dispatched.length}` };
      },
    },
    ...(over.db ? { db: over.db } : {}),
    ...(over.executionTracker ? { executionTracker: over.executionTracker } : {}),
    ...(over.secretResolver ? { secretResolver: over.secretResolver } : {}),
    ...(over.sandboxAllowListReader ? { sandboxAllowListReader: over.sandboxAllowListReader } : {}),
    ...(over.heldRunStore ? { heldRunStore: over.heldRunStore } : {}),
    ...(over.pendingDynamics ? { pendingDynamics: over.pendingDynamics } : {}),
    ...(over.pendingInits ? { pendingInits: over.pendingInits } : {}),
    ...(over.checkRunReporter ? { checkRunReporter: over.checkRunReporter } : {}),
    // An env-declaring job needs a context store so the core resolves its
    // per-job secrets (matchContext returns a no-rules config).
    ...(over.jobContext
      ? {
          contextStore: {
            matchContext: async (_org: string, n: string) =>
              n === over.jobContext ? makeJobContextRow(n, over) : null,
          },
        }
      : {}),
    // An explicit contextStore wins over the jobContext-derived one above: it is
    // spread after it, so a case that passes its own store (e.g. with a disabled
    // row) runs against that store rather than the always-enabled stub.
    ...(over.contextStore ? { contextStore: over.contextStore } : {}),
    // Build infra present but bundle undefined: a local-repo run must NOT probe
    // the cache or dispatch a __build__ job (it carries a working-tree overlay).
    ...(over.withBuildInfra
      ? {
          buildCoordinator: { coalesce: async (_k: string, fn: () => unknown) => fn() },
          sourceCache: {
            has: async () => true,
            getUrl: async () => 'https://cache/tar.tgz',
            getUrlAndDigest: async () => ({ url: 'https://cache/tar.tgz', digest: 'd' }),
          },
        }
      : {}),
    // Cache MISS + build infra: drives the real source-pack build path, where
    // the run is registered with the __build__ job alone while the build runs.
    ...(over.withBuildMiss
      ? {
          buildCoordinator: { ensureBuild: async (_k: string, fn: () => unknown) => fn() },
          sourceCache: {
            has: async () => false,
            getUrl: async () => 'https://cache/tar.tgz',
            getUrlAndDigest: async () => null,
          },
        }
      : {}),
  } as unknown as ProcessingDeps;
}

/**
 * Assemble a minimal real `WorkflowDispatchContext` for a single static job,
 * with a capturing dispatcher and all optional deps absent unless overridden.
 * This is the test-mode shape: `bundle` may be undefined and `trustResolution`
 * is undefined (single-orch, no holds, no trust).
 */
export function makeSingleJobContext(over: SingleJobContextOptions): {
  ctx: WorkflowDispatchContext;
  dispatched: QueuedJobInput[];
} {
  const dispatched: QueuedJobInput[] = [];
  const workflow = makeSingleJobWorkflow(over);
  const fullLockFile = {
    schemaVersion: 4 as const,
    source: { file: '.kici/workflows/ci.ts', export: '#default' },
    contentHash: 'abc',
    lockfileHash: 'lock',
    workflows: [workflow],
  } as unknown as WorkflowDispatchContext['fullLockFile'];
  const event: SimulatedEvent = {
    type: 'push',
    action: undefined,
    targetBranch: 'main',
    sourceBranch: undefined,
    payload: { ref: 'refs/heads/main' },
    changedFiles: undefined,
  };
  const info: WebhookInfo = {
    routingKey: 'local:repo',
    deliveryId: 'test:delivery',
    event: 'push',
    action: null,
    provider: TEST_INBOUND_PROVIDER,
    payload: { ref: 'refs/heads/main' },
  };
  const decision: WorkflowDecision = {
    workflowName: 'ci',
    matched: true,
    checks: [],
    summary: 'Direct test run',
  } as unknown as WorkflowDecision;
  const deps = makeSingleJobDeps(over, dispatched);
  const ctx: WorkflowDispatchContext = {
    info,
    deps,
    bundle: over.bundle,
    payload: info.payload,
    repoIdentifier: 'repo',
    // Required, and stated as the acted-on repository — the per-repository
    // shape every real caller of this function produces. A case about a
    // cross-repository workflow overwrites it.
    workflowRepoIdentifier: 'repo',
    credentials: {},
    event,
    eventWithFiles: event,
    ref: 'main',
    fullLockFile,
    resolvedOrgId: '__default__',
    workflow,
    decision,
    runId: 'run-1',
    trustResolution: undefined,
    lockFileSource: undefined,
    crossSource: false,
    localWorkingTree: over.localWorkingTree ?? false,
    // Required: the harness states the verdict explicitly, exactly as a real
    // dispatch path must. Cases that exercise the gate overwrite it.
    securityDecision: { action: 'pass' },
    extraJobConfig: {
      isTestRun: true,
      fixtureId: 'fx-1',
      ...(over.checkMode ? { checkMode: over.checkMode } : {}),
    },
    ...(over.runWideFlatSecrets ? { runWideFlatSecrets: over.runWideFlatSecrets } : {}),
    ...(over.testRun ? { testRun: over.testRun } : {}),
  };
  return { ctx, dispatched };
}

/** An execution-tracker stub covering the calls a gated dispatch makes. */
export interface GateTracker {
  addJobsToRun: Mock;
  onExecutionStarted: Mock;
  onJobStatus: Mock;
  holdRunForPendingJobs: Mock;
  releasePendingJobsHold: Mock;
  recordInitFailureRun: Mock;
}

/**
 * Resolve once every background task a dispatch started has finished. Each task
 * (a dynamic entry, a deferred init job) takes a pending-jobs token before
 * `dispatchMatchedWorkflow` returns and gives it back when it settles, so the
 * two counts match only when none is still running. A negative assertion made
 * after this cannot pass by running before the task reached its decision.
 */
export async function awaitDispatchTasksSettled(tracker: GateTracker): Promise<void> {
  await vi.waitFor(() => {
    // fails-when: a task is still running, so fewer tokens came back than were taken
    expect(tracker.releasePendingJobsHold).toHaveBeenCalledTimes(
      tracker.holdRunForPendingJobs.mock.calls.length,
    );
  });
}

/** A fresh {@link GateTracker}. */
export function makeGateTracker(): GateTracker {
  return {
    addJobsToRun: vi.fn().mockResolvedValue(undefined),
    onExecutionStarted: vi.fn().mockResolvedValue(undefined),
    onJobStatus: vi.fn().mockResolvedValue(undefined),
    holdRunForPendingJobs: vi.fn().mockReturnValue(true),
    releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
    recordInitFailureRun: vi.fn().mockResolvedValue(undefined),
  };
}

/** Enough Kysely surface for the hold path: counts, upserts, and one transaction. */
export function makeHoldDb() {
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'selectAll', 'where', 'innerJoin', 'set', 'orderBy', 'limit']) {
      c[m] = () => c;
    }
    c.execute = async () => [];
    c.executeTakeFirst = async () => ({ count: 0 });
    return c;
  };
  const db: Record<string, unknown> = {
    fn: { countAll: () => ({ as: (alias: string) => alias }) },
    selectFrom: chain,
    updateTable: chain,
    deleteFrom: chain,
    insertInto: () => ({
      values: () => ({
        onConflict: () => ({ execute: async () => undefined }),
        execute: async () => undefined,
      }),
    }),
  };
  db.transaction = () => ({ execute: async (cb: (t: unknown) => Promise<unknown>) => cb(db) });
  return db;
}
