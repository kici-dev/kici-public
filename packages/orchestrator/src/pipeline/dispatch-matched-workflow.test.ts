import { describe, it, expect, vi } from 'vitest';
import {
  runsOnSelectorsForLockJob,
  gatherInvokeResults,
  partitionGeneratedConfigsByPin,
  materializeStaticJobsSafe,
  resolveHostFanoutTargets,
  dispatchMatchedWorkflow,
  PENDING_CHECK_MARK_ATTEMPTS,
  evaluateJobContexts,
  concurrencyAdmissionKey,
  initDispatchSuppression,
  InitDispatchSuppression,
  findInvalidApprovalTimeout,
  buildBringupJobInput,
  hostCtxFromMat,
  envelopeEvent,
  NEEDS_PENDING_JOB_ID_PREFIX,
  type GeneratedJobConfig,
  type WorkflowDispatchContext,
} from './dispatch-matched-workflow.js';
import { SSH_TRANSPORT_CAPABILITY } from '@kici-dev/engine';
import {
  CheckRunConclusion,
  InitFailureCategory,
  SECONDS_PER_HOUR,
  SECURITY_HOLD_JOB_IDS,
} from '@kici-dev/engine';
import type { MaterializedJob } from '@kici-dev/engine';
import {
  ExecutionJobStatus,
  FanoutError,
  FanoutCause,
  HoldScope,
  HoldType,
  HostTargetSelector,
  TriggerSource,
} from '@kici-dev/engine';
import { HostStatus, type MatchedHost } from '../agent/host-roster.js';
import { ExecutionTracker } from '../reporting/execution-tracker.js';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { ProcessingDeps } from './processor.js';
import type { QueuedJobInput } from '../queue/job-queue.js';
import type { LockWorkflow, SimulatedEvent, WorkflowDecision } from '@kici-dev/engine';
import type { WebhookInfo } from '../webhook/handler.js';
import { consumePendingJobContext } from './processor.js';
import {
  clearPendingWorkflowContextsMap,
  loadPendingWorkflowContext,
  storePendingWorkflowContext,
} from './pending-workflow-context.js';
import { resumeWorkflow } from './resume-workflow.js';
import { releaseInvokeGate } from './invoke-gate.js';
import { SecurityHoldReason } from '../contexts/held-runs.js';
import { REDUCED_PRIVILEGE_MARKER } from '../security/reduced-privilege-note.js';
import type { TrustPolicyHoldReason, TrustPolicyOutcome } from '../security/trust-policy-gate.js';

/**
 * The Kysely surface `storePendingJobContext` needs inside a transaction. The
 * hold path writes the held_runs row and the pending context together, so every
 * db stub that can reach it hands this back from `transaction().execute`.
 */
let capturedGroups: string[] = [];

/** Records every value the running-count query filters `execution_runs.context` on. */
function makeGroupCapturingDb() {
  capturedGroups = [];
  const db: Record<string, unknown> = {
    fn: { countAll: () => ({ as: (alias: string) => alias }) },
    selectFrom: () => ({
      select: function (this: unknown) {
        return this;
      },
      where: function (this: unknown, col: unknown, _op: unknown, val: unknown) {
        if (col === 'execution_runs.context' && typeof val === 'string') capturedGroups.push(val);
        return this;
      },
      innerJoin: function (this: unknown) {
        return this;
      },
      executeTakeFirst: async () => ({ count: 0 }),
    }),
    insertInto: () => ({
      values: () => ({
        onConflict: () => ({ execute: async () => undefined }),
        execute: async () => undefined,
      }),
    }),
    updateTable: () => ({
      set: function (this: unknown) {
        return this;
      },
      where: function (this: unknown) {
        return this;
      },
      execute: async () => undefined,
      executeTakeFirst: async () => undefined,
    }),
  };
  db.transaction = () => ({ execute: async (cb: (t: unknown) => Promise<unknown>) => cb(db) });
  return db;
}

function makeHoldDbWithTrx() {
  const db: Record<string, unknown> = {
    fn: { countAll: () => ({ as: (alias: string) => alias }) },
    selectFrom: () => ({
      select: function (this: unknown) {
        return this;
      },
      where: function (this: unknown) {
        return this;
      },
      innerJoin: function (this: unknown) {
        return this;
      },
      executeTakeFirst: async () => ({ count: 0 }),
    }),
    insertInto: () => ({
      values: () => ({
        onConflict: () => ({ execute: async () => undefined }),
        execute: async () => undefined,
      }),
    }),
    updateTable: () => ({
      set: function (this: unknown) {
        return this;
      },
      where: function (this: unknown) {
        return this;
      },
      execute: async () => undefined,
      executeTakeFirst: async () => undefined,
    }),
  };
  db.transaction = () => ({ execute: async (cb: (t: unknown) => Promise<unknown>) => cb(db) });
  return db;
}

function makeTrxHandle() {
  return {
    insertInto: () => ({
      values: () => ({
        onConflict: () => ({ execute: async () => undefined }),
        execute: async () => undefined,
      }),
    }),
  };
}

/** Build a ProcessingDeps stub whose host roster returns the given matched hosts. */
function rosterDeps(matched: MatchedHost[]): ProcessingDeps {
  return {
    hostRosterStore: { findFanoutTargets: async () => matched },
    maxFanoutHosts: 1024,
  } as unknown as ProcessingDeps;
}

function host(over: Partial<MatchedHost>): MatchedHost {
  return {
    agentId: 'a1',
    host: 'h1',
    labels: ['kici:os:linux'],
    lifecycleClass: 'static',
    connectedInstanceId: 'inst-1',
    status: HostStatus.ready,
    platform: 'linux',
    arch: 'amd64',
    properties: {},
    ...over,
  } as MatchedHost;
}

const runsOnAllJob = {
  _type: 'static' as const,
  name: 'fan',
  runsOnAll: { include: [[{ kind: 'exact', value: 'kici:os:linux' }]], exclude: [] },
  steps: [],
  needs: [],
};

describe('materializeStaticJobsSafe — zero-host runsOnAll', () => {
  it('maps a zeroed fan-out to a synthetic terminal edge (its own name), not []', async () => {
    const job = { ...runsOnAllJob, onUnreachable: 'skip' as const };
    const deps = rosterDeps([host({ status: HostStatus.unreachable })]);
    const { expansionMap, matrixFailures, materializedJobs } = await materializeStaticJobsSafe(
      [job as never],
      deps,
    );
    expect(materializedJobs).toHaveLength(0);
    // Edge propagation: the base maps to a single synthetic child (its own name).
    expect(expansionMap.get('fan')).toEqual(['fan']);
    expect(matrixFailures).toHaveLength(1);
  });

  it('records a narrowed-to-empty (onUnreachable:skip) fan-out as skipped', async () => {
    const job = { ...runsOnAllJob, onUnreachable: 'skip' as const };
    const deps = rosterDeps([host({ status: HostStatus.unreachable })]);
    const { matrixFailures } = await materializeStaticJobsSafe([job as never], deps);
    expect(matrixFailures[0].terminalStatus).toBe(ExecutionJobStatus.enum.skipped);
    expect(matrixFailures[0].jobId).toMatch(/^matrix-skipped-/);
  });

  it('records an onUnreachable:fail zeroed fan-out as failed (no terminalStatus)', async () => {
    const job = { ...runsOnAllJob, onUnreachable: 'fail' as const };
    const deps = rosterDeps([host({ status: HostStatus.unreachable })]);
    const { matrixFailures } = await materializeStaticJobsSafe([job as never], deps);
    expect(matrixFailures[0].terminalStatus).toBeUndefined();
    expect(matrixFailures[0].jobId).toMatch(/^matrix-failed-/);
  });
});

describe('resolveHostFanoutTargets — --target post-filter', () => {
  const exact = (value: string) => ({ kind: 'exact' as const, value });
  const target = (
    values: {
      include: { kind: 'exact'; value: string }[];
      exclude: { kind: 'exact'; value: string }[];
    }[],
    allowEmpty: boolean,
  ) => HostTargetSelector.parse({ values, allowEmpty });

  // A runsOnAll job that matches every host carrying a `role:*` label.
  const roleJob = {
    ...runsOnAllJob,
    runsOnAll: { include: [[{ kind: 'regex', source: '^role:', flags: '' }]], exclude: [] },
  };

  const roster = [
    host({ agentId: 'web-01', host: 'web-01', labels: ['role:web'] }),
    host({ agentId: 'web-02', host: 'web-02', labels: ['role:web'] }),
    host({ agentId: 'db-01', host: 'db-01', labels: ['role:db'] }),
  ];

  it('narrows the runsOnAll roster, never widens', async () => {
    const deps = rosterDeps(roster);
    const t = target([{ include: [exact('role:web')], exclude: [] }], false);
    const resolved = await resolveHostFanoutTargets(roleJob as never, deps, t);
    expect(resolved.map((h) => h.agentId).sort()).toEqual(['web-01', 'web-02']);
  });

  it('no target leaves resolution unchanged (webhook parity)', async () => {
    const deps = rosterDeps(roster);
    const resolved = await resolveHostFanoutTargets(roleJob as never, deps);
    expect(resolved.map((h) => h.agentId).sort()).toEqual(['db-01', 'web-01', 'web-02']);
  });

  it('target to zero throws narrowedEmpty under allowEmpty', async () => {
    const deps = rosterDeps(roster);
    const t = target([{ include: [exact('role:gpu')], exclude: [] }], true);
    await expect(resolveHostFanoutTargets(roleJob as never, deps, t)).rejects.toMatchObject({
      cause: FanoutCause.narrowedEmpty,
    });
    await resolveHostFanoutTargets(roleJob as never, deps, t).catch((e) => {
      expect(e).toBeInstanceOf(FanoutError);
      expect((e as Error).message).toContain('--target left job');
    });
  });

  it('target to zero throws error (failed) by default', async () => {
    const deps = rosterDeps(roster);
    const t = target([{ include: [exact('role:gpu')], exclude: [] }], false);
    await expect(resolveHostFanoutTargets(roleJob as never, deps, t)).rejects.toMatchObject({
      cause: FanoutCause.error,
    });
  });

  it('a target that matches some hosts wins over the non-target zero-host heuristic', async () => {
    // roster all reachable; target narrows to db-01 only — non-target path would
    // have returned 3 hosts. Confirms the post-filter applies to candidates.
    const deps = rosterDeps(roster);
    const t = target([{ include: [exact('role:db')], exclude: [] }], false);
    const resolved = await resolveHostFanoutTargets(roleJob as never, deps, t);
    expect(resolved.map((h) => h.agentId)).toEqual(['db-01']);
  });
});

describe('resolveHostFanoutTargets — includeUninitialized', () => {
  const convergeJob = {
    ...runsOnAllJob,
    includeUninitialized: true,
  };

  it('flags an unreachable static host for bring-up and a ready host as live', async () => {
    const deps = rosterDeps([
      host({ agentId: 'live-01', host: 'live-01', status: HostStatus.ready }),
      host({
        agentId: 'fresh-01',
        host: 'fresh-01',
        status: HostStatus.unreachable,
        connectedInstanceId: null,
      }),
    ]);
    const resolved = await resolveHostFanoutTargets(convergeJob as never, deps);
    const byId = new Map(resolved.map((h) => [h.agentId, h]));
    expect(byId.get('live-01')?.needsBringup).toBe(false);
    expect(byId.get('fresh-01')?.needsBringup).toBe(true);
    expect(resolved.map((h) => h.agentId).sort()).toEqual(['fresh-01', 'live-01']);
  });

  it('without the flag, an unreachable static host is governed by onUnreachable (no bring-up)', async () => {
    // Default onUnreachable is 'hold' → the unreachable host is still a target,
    // but it carries no needsBringup (today's behavior, no init-runner attempt).
    const deps = rosterDeps([
      host({ agentId: 'live-01', host: 'live-01', status: HostStatus.ready }),
      host({
        agentId: 'fresh-01',
        host: 'fresh-01',
        status: HostStatus.unreachable,
        connectedInstanceId: null,
      }),
    ]);
    const resolved = await resolveHostFanoutTargets(runsOnAllJob as never, deps);
    for (const h of resolved) expect(h.needsBringup).toBeFalsy();
  });

  it('skips a stale ephemeral host even under includeUninitialized', async () => {
    const deps = rosterDeps([
      host({ agentId: 'live-01', host: 'live-01', status: HostStatus.ready }),
      host({
        agentId: 'eph-01',
        host: 'eph-01',
        lifecycleClass: 'ephemeral',
        status: HostStatus.stale,
        connectedInstanceId: null,
      }),
    ]);
    const resolved = await resolveHostFanoutTargets(convergeJob as never, deps);
    expect(resolved.map((h) => h.agentId)).toEqual(['live-01']);
  });
});

describe('buildBringupJobInput', () => {
  it('builds a bringupOnly job pinned to the ssh-transport capability for the target', () => {
    const ctx = {
      runId: 'run-1',
      ref: 'abc',
      workflow: { name: 'converge-fleet' },
      event: { sourceBranch: 'main' },
      credentials: { token: 't' },
    } as unknown as WorkflowDispatchContext;
    const setup = {
      effectiveDeliveryId: 'd1',
      info: { provider: 'local', routingKey: 'rk' },
    } as never;
    const input = buildBringupJobInput({ ctx, setup, targetAgentId: 'fresh-01' });
    expect(input.jobName).toBe('__bringup__converge-fleet__fresh-01');
    expect(input.runsOnLabels).toEqual([SSH_TRANSPORT_CAPABILITY]);
    expect((input.jobConfig as { bringupOnly?: boolean }).bringupOnly).toBe(true);
    expect((input.jobConfig as { bringupTarget?: string }).bringupTarget).toBe('fresh-01');
    // A bring-up clones nothing.
    expect(input.repoUrl).toBe('');
  });
});

describe('runsOnSelectorsForLockJob', () => {
  it('splits lock runsOn matchers into exact labels + regex patterns', () => {
    const lockJob = {
      name: 'web',
      runsOn: [
        { kind: 'exact', value: 'role:web' },
        { kind: 'regex', source: '^kici:host:box-', flags: '' },
      ],
      excludeLabels: [{ kind: 'regex', source: '-canary$', flags: '' }],
    } as never;
    expect(runsOnSelectorsForLockJob(lockJob)).toEqual({
      runsOnLabels: ['role:web'],
      runsOnPatterns: [{ kind: 'regex', source: '^kici:host:box-', flags: '' }],
      excludeLabels: [],
      excludePatterns: [{ kind: 'regex', source: '-canary$', flags: '' }],
    });
  });

  it('returns empty selectors for a job with no runsOn / excludeLabels', () => {
    expect(runsOnSelectorsForLockJob({} as never)).toEqual({
      runsOnLabels: [],
      runsOnPatterns: [],
      excludeLabels: [],
      excludePatterns: [],
    });
  });

  it('partitions exact excludeLabels into excludeLabels', () => {
    const lockJob = {
      runsOn: [{ kind: 'exact', value: 'role:db' }],
      excludeLabels: [{ kind: 'exact', value: 'role:retired' }],
    } as never;
    expect(runsOnSelectorsForLockJob(lockJob)).toEqual({
      runsOnLabels: ['role:db'],
      runsOnPatterns: [],
      excludeLabels: ['role:retired'],
      excludePatterns: [],
    });
  });
});

/**
 * Chainable Kysely `updateTable(...).set(...).where(...).execute()` stub that
 * records every `.set(...)` payload so a test can assert which run-row UPDATEs
 * fired (context, trust, test-run).
 */
function makeUpdateRecordingDb(): {
  db: unknown;
  updates: Array<Record<string, unknown>>;
} {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    updateTable: () => ({
      set: (payload: Record<string, unknown>) => {
        updates.push(payload);
        return { where: () => ({ execute: async () => undefined }) };
      },
    }),
  };
  return { db, updates };
}

/**
 * Assemble a minimal real `WorkflowDispatchContext` for a single static job,
 * with a capturing dispatcher and all optional deps absent unless overridden.
 * This is the test-mode shape: `bundle` may be undefined and `trustResolution`
 * is undefined (single-orch, no holds, no trust).
 */
function makeSingleJobContext(over: {
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
}): { ctx: WorkflowDispatchContext; dispatched: QueuedJobInput[] } {
  const dispatched: QueuedJobInput[] = [];
  const workflow = {
    name: 'ci',
    source: { file: '.kici/workflows/ci.ts', export: '#default' },
    contentHash: 'wf-hash',
    triggers: [],
    ...(over.withFilter ? { hasFilter: true } : {}),
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
    provider: 'local' as WebhookInfo['provider'],
    payload: { ref: 'refs/heads/main' },
  };
  const decision: WorkflowDecision = {
    workflowName: 'ci',
    matched: true,
    checks: [],
    summary: 'Direct test run',
  } as unknown as WorkflowDecision;
  const deps = {
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
              n === over.jobContext
                ? {
                    id: `env-${n}`,
                    org_id: '__default__',
                    name: n,
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
                  }
                : null,
          },
        }
      : {}),
    // An explicit contextStore wins over the jobContext-derived one above. It
    // used to be spread FIRST and was silently clobbered, so a test that passed
    // its own store (e.g. with a disabled row) was quietly run against the
    // harness's always-enabled stub instead.
    ...(over.contextStore ? { contextStore: over.contextStore } : {}),
    // Build infra present but bundle undefined: a local-repo run must NOT probe
    // the cache or dispatch a __build__ job (it carries a working-tree overlay).
    ...(over.withBuildInfra
      ? {
          buildCoordinator: { coalesce: async (_k: string, fn: () => unknown) => fn() },
          sourceCache: { has: async () => true, getUrl: async () => 'https://cache/tar.tgz' },
        }
      : {}),
    // Cache MISS + build infra: drives the real source-pack build path, where
    // the run is registered with the __build__ job alone while the build runs.
    ...(over.withBuildMiss
      ? {
          buildCoordinator: { ensureBuild: async (_k: string, fn: () => unknown) => fn() },
          sourceCache: { has: async () => false, getUrl: async () => 'https://cache/tar.tgz' },
        }
      : {}),
  } as unknown as ProcessingDeps;
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
    ...(over.fullRepo ? {} : {}),
    ...(over.testRun ? { testRun: over.testRun } : {}),
  };
  return { ctx, dispatched };
}

/**
 * A 2-job context where `deploy` needs `build`. Used to prove the single-orch
 * needs-gated path degrades cleanly with no coordinator / heldRunStore /
 * trust resolution.
 */
function makeNeedsContext(): { ctx: WorkflowDispatchContext; dispatched: QueuedJobInput[] } {
  const dispatched: QueuedJobInput[] = [];
  const workflow = {
    name: 'ci',
    source: { file: '.kici/workflows/ci.ts', export: '#default' },
    contentHash: 'wf-hash',
    triggers: [],
    jobs: [
      {
        _type: 'static' as const,
        name: 'build',
        runsOn: [{ kind: 'exact', value: 'default' }],
        steps: [{ name: 'b', run: 'echo build' }],
        needs: [],
        rules: [],
      },
      {
        _type: 'static' as const,
        name: 'deploy',
        runsOn: [{ kind: 'exact', value: 'default' }],
        steps: [{ name: 'd', run: 'echo deploy' }],
        needs: ['build'],
        rules: [],
      },
    ],
  } as unknown as LockWorkflow;
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
    provider: 'local' as WebhookInfo['provider'],
    payload: { ref: 'refs/heads/main' },
  };
  const decision: WorkflowDecision = {
    workflowName: 'ci',
    matched: true,
    checks: [],
    summary: 'Direct test run',
  } as unknown as WorkflowDecision;
  // No coordinator, heldRunStore, db, or executionTracker:
  // the single-orch, no-trust, no-hold path with no DB persistence.
  const deps = {
    dispatcher: {
      dispatch: async (input: QueuedJobInput) => {
        dispatched.push(input);
        return { status: 'dispatched' as const, agentId: 'a1', jobId: `job-${dispatched.length}` };
      },
    },
  } as unknown as ProcessingDeps;
  const ctx: WorkflowDispatchContext = {
    info,
    deps,
    bundle: undefined,
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
    runId: 'run-needs',
    trustResolution: undefined,
    lockFileSource: undefined,
    crossSource: false,
    // Required: the harness states the verdict explicitly, exactly as a real
    // dispatch path must. Cases that exercise the gate overwrite it.
    securityDecision: { action: 'pass' },
    extraJobConfig: { isTestRun: true, fixtureId: 'fx-needs' },
    testRun: { fixtureId: 'fx-needs' },
  };
  return { ctx, dispatched };
}

/** A `hold` outcome as the trust-policy gate produces it. */
function holdDecision(
  reason: SecurityHoldReason,
  approvalExpirySeconds: number | null = 72 * SECONDS_PER_HOUR,
) {
  return {
    action: 'hold' as const,
    reason: reason as TrustPolicyHoldReason,
    message: `held: ${reason}`,
    approvalExpirySeconds,
  };
}

/** A `reject` outcome as the trust-policy gate produces it. */
function rejectDecision(reason: SecurityHoldReason) {
  return { action: 'reject' as const, reason, message: `rejected: ${reason}` };
}

/** A TrustPolicyStore stand-in returning a fixed approval-expiry window. */
function storeReturningExpiry(approvalExpiryHours: number) {
  return {
    get: vi.fn().mockResolvedValue({
      forkPolicy: 'hold',
      unknownContributorPolicy: 'hold',
      workflowChangePolicy: 'hold',
      approvalExpiryHours,
      approvalExpirySeconds: approvalExpiryHours * SECONDS_PER_HOUR,
      source: 'platform',
      updatedAt: new Date(),
    }),
  };
}

describe('dispatchMatchedWorkflow — trust-policy security gate', () => {
  it('holds the run in the security queue for a non-trusted workflow-modifying PR', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'held-wm-1' });
    const recordRunHeld = vi.fn().mockResolvedValue(undefined);
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: {
        normalizer: { provider: 'github' },
        checkStatusPoster: { provider: 'github', postCheckStatus },
      } as unknown as WorkflowDispatchContext['bundle'],
    });
    ctx.securityDecision = holdDecision(SecurityHoldReason.enum.workflow_modification);
    ctx.trustResolution = {
      tier: 'unknown',
      contributorUsername: 'octocat',
    } as unknown as WorkflowDispatchContext['trustResolution'];
    (ctx.event as SimulatedEvent).prNumber = 42;
    (ctx.deps as unknown as Record<string, unknown>).heldRunStore = { create };
    (ctx.deps as unknown as Record<string, unknown>).executionTracker = {
      recordRunHeld,
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
    };

    const result = await dispatchMatchedWorkflow(ctx);

    expect(result.held).toBe(true);
    expect(result.dispatchedJobCount).toBe(0);
    expect(dispatched).toHaveLength(0);
    // A real hold is persisted in the security queue with the PR number stamped.
    expect(recordRunHeld).toHaveBeenCalledTimes(1);
    expect(recordRunHeld.mock.calls[0][0]).toMatchObject({
      reason: SecurityHoldReason.enum.workflow_modification,
      prNumber: 42,
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][1]).toMatchObject({
      queueType: 'security',
      holdType: HoldType.enum.security,
      reason: SecurityHoldReason.enum.workflow_modification,
      jobId: '__workflow_modification__',
      contextId: null,
    });
    // A resolvable pending check is posted on the security check name.
    expect(
      postCheckStatus.mock.calls.some((c) => c[2] === 'pending' && c[3] === 'Held for approval'),
    ).toBe(true);
  });

  it('posts no pending security check when there is no store to hold in', async () => {
    // Same verdict as the case above with the `heldRunStore` taken away, so the
    // hold row is never written. The pending `KiCI Security` check is settled
    // only through that row, so posting one here would leave it on the commit
    // forever.
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeSingleJobContext({
      bundle: {
        normalizer: { provider: 'github' },
        checkStatusPoster: { provider: 'github', postCheckStatus },
      } as unknown as WorkflowDispatchContext['bundle'],
    });
    ctx.securityDecision = holdDecision(SecurityHoldReason.enum.workflow_modification);
    (ctx.event as SimulatedEvent).prNumber = 42;

    await dispatchMatchedWorkflow(ctx);

    expect(
      postCheckStatus.mock.calls.some((c) => c[2] === 'pending' && c[3] === 'Held for approval'),
    ).toBe(false);
  });

  it('writes the trust-policy hold row and its resume context in one transaction', async () => {
    // The same pairing `holdJobForApproval` makes, and for the same reason: the
    // stored workflow context is the only thing that can replay this dispatch,
    // so a row that outlived a failed context write would be a hold nothing can
    // release. That run reaches `failRunResumeLost`, which by its own comment
    // cannot complete the queued `kici/…` checks — so the commit keeps those
    // too. Written sequentially, kysely leaves the insert on the store's own
    // pooled connection and it commits regardless of what follows.
    const create = vi.fn().mockResolvedValue({ id: 'held-fork-trx' });
    const contextInserts: string[] = [];
    const trxHandle = {
      insertInto: (table: string) => {
        contextInserts.push(table);
        return {
          values: () => ({
            onConflict: () => ({ execute: async () => undefined }),
            execute: async () => undefined,
          }),
        };
      },
    };
    const db = {
      transaction: () => ({
        execute: (cb: (t: unknown) => Promise<unknown>) => cb(trxHandle),
      }),
    };
    const { ctx } = makeSingleJobContext({ bundle: undefined, db });
    ctx.securityDecision = holdDecision(SecurityHoldReason.enum.fork_pr);
    (ctx.deps as unknown as Record<string, unknown>).heldRunStore = { create };
    (ctx.deps as unknown as Record<string, unknown>).executionTracker = {
      recordRunHeld: vi.fn().mockResolvedValue(undefined),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
    };

    await dispatchMatchedWorkflow(ctx);

    // The row through the transaction handle…
    expect(create.mock.calls[0][2]).toBe(trxHandle);
    // …and the resume context through the same one.
    expect(contextInserts).toContain('pending_workflow_contexts');
  });

  it('still holds when there is no database to open a transaction on', async () => {
    // A local test run (`kici run`) has no database: the context lives only in
    // memory, so there is nothing to make atomic and nothing to enrol. The hold
    // must still be written rather than dying on an absent `db.transaction`.
    const create = vi.fn().mockResolvedValue({ id: 'held-fork-nodb' });
    const { ctx } = makeSingleJobContext({ bundle: undefined, db: undefined });
    ctx.securityDecision = holdDecision(SecurityHoldReason.enum.fork_pr);
    (ctx.deps as unknown as Record<string, unknown>).db = undefined;
    (ctx.deps as unknown as Record<string, unknown>).heldRunStore = { create };

    const result = await dispatchMatchedWorkflow(ctx);

    expect(result.held).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][2]).toBeUndefined();
  });

  it("records the trust-policy hold's pending check on the row it just wrote", async () => {
    // The third of the three sites that post a pending `KiCI Security` status,
    // and it writes its row outside the dispatch loop's transaction. The record
    // is what stops a later settle terminalizing — and therefore CREATING — a
    // check this commit never received.
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const markPendingCheckPosted = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeSingleJobContext({
      bundle: {
        normalizer: { provider: 'github' },
        checkStatusPoster: { provider: 'github', postCheckStatus },
      } as unknown as WorkflowDispatchContext['bundle'],
    });
    ctx.securityDecision = holdDecision(SecurityHoldReason.enum.workflow_modification);
    (ctx.event as SimulatedEvent).prNumber = 42;
    (ctx.deps as unknown as Record<string, unknown>).heldRunStore = {
      create: vi.fn().mockResolvedValue({ id: 'held-wm-2' }),
      markPendingCheckPosted,
    };
    (ctx.deps as unknown as Record<string, unknown>).executionTracker = {
      recordRunHeld: vi.fn().mockResolvedValue(undefined),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
    };

    await dispatchMatchedWorkflow(ctx);

    expect(
      postCheckStatus.mock.calls.some((c) => c[2] === 'pending' && c[3] === 'Held for approval'),
    ).toBe(true);
    expect(markPendingCheckPosted).toHaveBeenCalledWith('__default__', ['held-wm-2']);
  });

  it('records nothing when the trust-policy check post is refused', async () => {
    const postCheckStatus = vi.fn().mockRejectedValue(new Error('403 from the provider'));
    const markPendingCheckPosted = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeSingleJobContext({
      bundle: {
        normalizer: { provider: 'github' },
        checkStatusPoster: { provider: 'github', postCheckStatus },
      } as unknown as WorkflowDispatchContext['bundle'],
    });
    ctx.securityDecision = holdDecision(SecurityHoldReason.enum.workflow_modification);
    (ctx.event as SimulatedEvent).prNumber = 42;
    (ctx.deps as unknown as Record<string, unknown>).heldRunStore = {
      create: vi.fn().mockResolvedValue({ id: 'held-wm-3' }),
      markPendingCheckPosted,
    };
    (ctx.deps as unknown as Record<string, unknown>).executionTracker = {
      recordRunHeld: vi.fn().mockResolvedValue(undefined),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
    };

    // The hold still stands; only the report of it failed.
    const result = await dispatchMatchedWorkflow(ctx);

    expect(result.held).toBe(true);
    expect(markPendingCheckPosted).not.toHaveBeenCalled();
  });

  it('does NOT hold when the policy passed the PR', async () => {
    const create = vi.fn();
    const { ctx, dispatched } = makeSingleJobContext({ bundle: undefined });
    ctx.securityDecision = { action: 'pass' };
    (ctx.deps as unknown as Record<string, unknown>).heldRunStore = { create };

    await dispatchMatchedWorkflow(ctx);

    expect(create).not.toHaveBeenCalled();
    // Dispatch proceeds normally (the single job runs).
    expect(dispatched.length).toBeGreaterThan(0);
  });

  /**
   * One fixture, two verdicts. Everything a dispatch could leave behind is
   * observable on it — including `checkRunReporter.setPendingAwait`, which is
   * how the queued `kici/<workflow>` check runs get created on the commit.
   */
  function makeVerdictFixture(decision: TrustPolicyOutcome) {
    const create = vi.fn();
    const recordRunHeld = vi.fn().mockResolvedValue(undefined);
    const recordInitFailureRun = vi.fn().mockResolvedValue(undefined);
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const setPendingAwait = vi.fn().mockResolvedValue(undefined);
    const completeUndispatchedCheckRuns = vi.fn().mockResolvedValue(undefined);
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: {
        normalizer: { provider: 'github' },
        checkStatusPoster: { provider: 'github', postCheckStatus },
      } as unknown as WorkflowDispatchContext['bundle'],
      checkRunReporter: { setPendingAwait, completeUndispatchedCheckRuns },
    });
    ctx.securityDecision = decision;
    (ctx.deps as unknown as Record<string, unknown>).heldRunStore = { create };
    (ctx.deps as unknown as Record<string, unknown>).executionTracker = {
      recordRunHeld,
      recordInitFailureRun,
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
    };
    return {
      ctx,
      dispatched,
      create,
      recordRunHeld,
      recordInitFailureRun,
      postCheckStatus,
      setPendingAwait,
      completeUndispatchedCheckRuns,
    };
  }

  it('drops silently on an ignore verdict — no run, no hold, no check, no check run', async () => {
    // `ignore` withholds every artifact a contributor could see. Reusing the
    // reject path would write a failed run and post a failure check, which is
    // exactly the trace `ignore` exists to avoid. The pipeline drops an ignored
    // event before dispatch; this arm covers the paths that evaluate the policy
    // for themselves (cross-source, globals).
    //
    // The check RUNS are the sharpest of these. They are created by the setup
    // phase, before the trust-policy gate ever reads the verdict, and nothing
    // on this path completes them — so an `ignore` that let setup run would
    // leave a permanently queued check on the commit, which a branch-protection
    // rule reads as a blocked pull request. That is worse than the visible
    // rejection `ignore` refuses to write, not merely different from it.
    const f = makeVerdictFixture({ action: 'ignore' });

    const result = await dispatchMatchedWorkflow(f.ctx);

    expect(result.dispatchedJobCount).toBe(0);
    expect(result.held).toBe(false);
    expect(f.dispatched).toHaveLength(0);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.recordRunHeld).not.toHaveBeenCalled();
    expect(f.recordInitFailureRun).not.toHaveBeenCalled();
    expect(f.postCheckStatus).not.toHaveBeenCalled();
    expect(f.setPendingAwait).not.toHaveBeenCalled();
  });

  it('still creates the queued check runs on a hold — the control for the ignore case', async () => {
    // Non-vacuity for the assertion above: the same fixture, changed only in
    // its verdict, DOES reach `setPendingAwait`. Without this the `ignore`
    // expectation would pass just as well against a harness that never wired a
    // reporter at all — which is exactly how the missing check runs went
    // unnoticed. It doubles as the guard that hoisting the `ignore` decision
    // ahead of setup left `hold` untouched: the check runs are still created,
    // and the hold is still recorded.
    const f = makeVerdictFixture(holdDecision(SecurityHoldReason.enum.fork_pr));

    const result = await dispatchMatchedWorkflow(f.ctx);

    expect(f.setPendingAwait).toHaveBeenCalledTimes(1);
    expect(f.setPendingAwait.mock.calls[0][0]).toMatchObject({
      workflowName: 'ci',
      jobNames: ['build'],
    });
    expect(result.held).toBe(true);
    expect(f.recordRunHeld).toHaveBeenCalledTimes(1);
    expect(f.dispatched).toHaveLength(0);
    // A hold leaves its check runs queued on purpose: the pull request is
    // genuinely waiting, and `/kici approve` replays the dispatch under the
    // same run. They are completed only when the hold ends without dispatching
    // — see `rejectWorkflow` and the stale detector's expiry sweep.
    expect(f.completeUndispatchedCheckRuns).not.toHaveBeenCalled();
  });

  it('completes the queued check runs on a pre-dispatch init failure', async () => {
    // Every early exit below the setup phase strands the same checks, not just
    // the hold ones: `recordInitFailureRun` fires `onExecutionStatusChange` and
    // never `onExecutionComplete`, the one callback wired to
    // `updateWorkflowStatus`. `recordInitFailureFromSkip` is the single funnel
    // for all six of those exits, so closing it there covers the class; the
    // approval-misconfig gate is the earliest of them and the cheapest to
    // provoke.
    const f = makeVerdictFixture({ action: 'pass' });
    // A realistic owner/repo: the completion refuses an identifier it cannot
    // split, so the harness's bare `repo` would short-circuit it.
    f.ctx.repoIdentifier = 'acme/app';
    f.ctx.workflowRepoIdentifier = 'acme/app';
    (f.ctx.workflow as unknown as Record<string, unknown>).approval = {
      clauses: [],
      timeoutSeconds: 0,
    };

    const result = await dispatchMatchedWorkflow(f.ctx);

    expect(result.dispatchedJobCount).toBe(0);
    expect(f.recordInitFailureRun).toHaveBeenCalledTimes(1);
    expect(f.setPendingAwait).toHaveBeenCalledTimes(1);
    expect(f.completeUndispatchedCheckRuns).toHaveBeenCalledTimes(1);
    const call = f.completeUndispatchedCheckRuns.mock.calls[0][0];
    expect(call.conclusion).toBe(CheckRunConclusion.enum.failure);
    expect(call.jobNames).toEqual(f.setPendingAwait.mock.calls[0][0].jobNames);
    expect(String(call.summary)).toContain('approval_misconfig');
    expect(String(call.summary)).toContain('must be a positive integer');
  });

  it('completes the queued check runs on a trust-policy rejection', async () => {
    // A rejection dispatches nothing and stores no resume context, so no run,
    // job, or queue record ever exists for the terminal reporter paths to key
    // off — and the stale sweep only touches `in_progress`. Without this the
    // checks the setup phase posted would stay `queued` on the commit forever.
    // The `KiCI Security` check the same function posts is a different check
    // run, so it closes none of these.
    const f = makeVerdictFixture(rejectDecision(SecurityHoldReason.enum.fork_pr));
    f.ctx.repoIdentifier = 'acme/app';
    f.ctx.workflowRepoIdentifier = 'acme/app';

    await dispatchMatchedWorkflow(f.ctx);

    expect(f.setPendingAwait).toHaveBeenCalledTimes(1);
    expect(f.completeUndispatchedCheckRuns).toHaveBeenCalledTimes(1);
    const call = f.completeUndispatchedCheckRuns.mock.calls[0][0];
    expect(call).toMatchObject({
      workflowName: 'ci',
      // The same name set `setPendingAwait` was given, or the completion
      // addresses check runs that do not exist.
      jobNames: f.setPendingAwait.mock.calls[0][0].jobNames,
      owner: f.setPendingAwait.mock.calls[0][0].owner,
      repo: f.setPendingAwait.mock.calls[0][0].repo,
      sha: f.setPendingAwait.mock.calls[0][0].sha,
      conclusion: CheckRunConclusion.enum.failure,
    });
    // The same body the `KiCI Security` check carries. Branch protection
    // usually requires `kici/<workflow>`, so this is often the only check a
    // contributor reads — it has to carry the actionable half too.
    const securityCall = f.postCheckStatus.mock.calls.find((c) => c[2] === 'failure');
    expect(securityCall).toBeDefined();
    expect(call.summary).toBe(securityCall![4]);
    expect(String(call.summary)).toContain('cannot be approved');
    expect(String(call.summary)).toContain('Settings > CI trust');
  });

  it('refuses to address check runs when the repo identifier is not owner/repo', async () => {
    // The harness default is a bare `repo`. A check run's identity is
    // (owner, repo, sha, name), so half a name addresses nothing — and
    // `repo: undefined` would be sent to the provider verbatim. Skipping is the
    // only safe answer, and it matches the helper's own guard.
    const f = makeVerdictFixture(rejectDecision(SecurityHoldReason.enum.fork_pr));
    expect(f.ctx.repoIdentifier).toBe('repo');

    await dispatchMatchedWorkflow(f.ctx);

    expect(f.recordInitFailureRun).toHaveBeenCalledTimes(1);
    expect(f.completeUndispatchedCheckRuns).not.toHaveBeenCalled();
  });

  it('cannot express an absent decision — omission is a compile error, not a pass', () => {
    // `securityDecision` is required on WorkflowDispatchContext, so a
    // production dispatch path that never states a verdict does not compile
    // (tsconfig excludes `**/*.test.ts`, so the compiler's guarantee covers
    // `src/**` — which is where the fail-open lived). This pins that the
    // harness, like every real call site, states `pass` explicitly rather than
    // leaving it undefined and relying on a falsy check to wave it through.
    const { ctx } = makeSingleJobContext({ bundle: undefined });
    expect(ctx.securityDecision).toEqual({ action: 'pass' });
  });

  it('denies on an unrecognised verdict rather than falling through', async () => {
    const create = vi.fn();
    const recordInitFailureRun = vi.fn().mockResolvedValue(undefined);
    const { ctx, dispatched } = makeSingleJobContext({ bundle: undefined });
    // Reachable in production: the policy columns are plain TEXT, so a newer
    // Platform can push a verdict this build has never seen.
    ctx.securityDecision = {
      action: 'quarantine',
      reason: SecurityHoldReason.enum.fork_pr,
      message: 'from a newer Platform',
    } as unknown as TrustPolicyOutcome;
    (ctx.deps as unknown as Record<string, unknown>).heldRunStore = { create };
    (ctx.deps as unknown as Record<string, unknown>).executionTracker = {
      recordInitFailureRun,
      releasePendingJobsHold: vi.fn(),
    };

    const result = await dispatchMatchedWorkflow(ctx);

    // A refusal, not a pass: no job ran, and the run is recorded as failed.
    expect(dispatched).toHaveLength(0);
    expect(result.dispatchedJobCount).toBe(0);
    expect(recordInitFailureRun).toHaveBeenCalledTimes(1);
    expect(recordInitFailureRun.mock.calls[0][0]).toMatchObject({
      initFailure: { category: InitFailureCategory.enum.trust_policy },
    });
  });

  it('states the defining repository on both pre-run recording paths', async () => {
    // The two recording paths that write a run row before any job starts — a
    // hold and an init failure — must say which repository DEFINES the
    // workflow, not just which one the run acts on. Omitting it records a NULL
    // marker, and a NULL marker is not "unknown": every consumer reads it as
    // "the workflow lives in the repository this run acted on"
    // (`registration/registration-run-match.ts`), so the authoring team's own
    // run is filed under someone else's repository.
    const WORKFLOW_REPO = 'acme/org-workflows';

    const recordRunHeld = vi.fn().mockResolvedValue(undefined);
    const held = makeSingleJobContext({ bundle: undefined });
    held.ctx.repoIdentifier = 'owner/source-repo';
    held.ctx.workflowRepoIdentifier = WORKFLOW_REPO;
    held.ctx.securityDecision = holdDecision(SecurityHoldReason.enum.workflow_modification);
    (held.ctx.deps as unknown as Record<string, unknown>).heldRunStore = {
      create: vi.fn().mockResolvedValue({ id: 'held-x' }),
    };
    (held.ctx.deps as unknown as Record<string, unknown>).executionTracker = {
      recordRunHeld,
      releasePendingJobsHold: vi.fn(),
    };

    await dispatchMatchedWorkflow(held.ctx);

    expect(recordRunHeld).toHaveBeenCalledTimes(1);
    expect(recordRunHeld.mock.calls[0][0]).toMatchObject({
      repoIdentifier: 'owner/source-repo',
      workflowRepoIdentifier: WORKFLOW_REPO,
    });

    const recordInitFailureRun = vi.fn().mockResolvedValue(undefined);
    const rejected = makeSingleJobContext({ bundle: undefined });
    rejected.ctx.repoIdentifier = 'owner/source-repo';
    rejected.ctx.workflowRepoIdentifier = WORKFLOW_REPO;
    rejected.ctx.securityDecision = rejectDecision(SecurityHoldReason.enum.fork_pr);
    (rejected.ctx.deps as unknown as Record<string, unknown>).executionTracker = {
      recordInitFailureRun,
      releasePendingJobsHold: vi.fn(),
    };

    await dispatchMatchedWorkflow(rejected.ctx);

    expect(recordInitFailureRun).toHaveBeenCalledTimes(1);
    expect(recordInitFailureRun.mock.calls[0][0]).toMatchObject({
      repoIdentifier: 'owner/source-repo',
      workflowRepoIdentifier: WORKFLOW_REPO,
    });
  });

  it('records the presented branch on a held PR run, never the PR head branch', async () => {
    // `execution_runs.ref` is the branch the run PRESENTS, and a held row is
    // the row the resumed run keeps (`onExecutionStarted` is a no-op via ON
    // CONFLICT). It is read back as the run's branch claim when an internal
    // event inherits from it, so recording the PR HEAD branch here would let a
    // fork contributor — who names that branch freely — hand a downstream
    // subscriber a branch claim the PR run itself was denied.
    //
    // `sourceBranch` differs from `targetBranch` here so the assertion can only
    // hold if the presented branch is what reaches the row.
    const recordRunHeld = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeSingleJobContext({ bundle: undefined });
    ctx.securityDecision = holdDecision(SecurityHoldReason.enum.fork_pr);
    (ctx.event as SimulatedEvent).type = 'pull_request';
    (ctx.event as SimulatedEvent).targetBranch = 'develop';
    (ctx.event as SimulatedEvent).sourceBranch = 'main';
    (ctx.event as SimulatedEvent).prNumber = 7;
    (ctx.deps as unknown as Record<string, unknown>).heldRunStore = {
      create: vi.fn().mockResolvedValue({ id: 'held-branch-1' }),
    };
    (ctx.deps as unknown as Record<string, unknown>).executionTracker = {
      recordRunHeld,
      releasePendingJobsHold: vi.fn(),
    };

    await dispatchMatchedWorkflow(ctx);

    expect(recordRunHeld).toHaveBeenCalledTimes(1);
    expect(recordRunHeld.mock.calls[0][0]).toMatchObject({ ref: 'develop' });
  });

  it('records the presented branch on a rejected PR run, never the PR head branch', async () => {
    // Same column, same rule, on the other pre-dispatch recording path.
    const recordInitFailureRun = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeSingleJobContext({ bundle: undefined });
    ctx.securityDecision = rejectDecision(SecurityHoldReason.enum.fork_pr);
    (ctx.event as SimulatedEvent).type = 'pull_request';
    (ctx.event as SimulatedEvent).targetBranch = 'develop';
    (ctx.event as SimulatedEvent).sourceBranch = 'main';
    (ctx.deps as unknown as Record<string, unknown>).executionTracker = {
      recordInitFailureRun,
      releasePendingJobsHold: vi.fn(),
    };

    await dispatchMatchedWorkflow(ctx);

    expect(recordInitFailureRun).toHaveBeenCalledTimes(1);
    expect(recordInitFailureRun.mock.calls[0][0]).toMatchObject({ ref: 'develop' });
  });

  it('does NOT re-hold on a resume re-entry (reuseRunId set)', async () => {
    const create = vi.fn();
    const { ctx } = makeSingleJobContext({ bundle: undefined });
    ctx.securityDecision = holdDecision(SecurityHoldReason.enum.workflow_modification);
    // heldRunStore present but no executionTracker: the gate would call
    // `create` if it fired — asserting it did not proves the resume skip.
    (ctx.deps as unknown as Record<string, unknown>).heldRunStore = { create };

    await dispatchMatchedWorkflow(ctx, { reuseRunId: 'run-1', skipInstallProtectionGate: true });

    expect(create).not.toHaveBeenCalled();
  });

  it('holds with the reason the policy produced, not a hardcoded one', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'held-fork-1' });
    const { ctx } = makeSingleJobContext({ bundle: undefined });
    ctx.securityDecision = holdDecision(SecurityHoldReason.enum.fork_pr);
    (ctx.deps as unknown as Record<string, unknown>).heldRunStore = { create };

    const result = await dispatchMatchedWorkflow(ctx);

    expect(result.held).toBe(true);
    expect(create.mock.calls[0][1]).toMatchObject({
      queueType: 'security',
      holdType: HoldType.enum.security,
      reason: SecurityHoldReason.enum.fork_pr,
      jobId: SECURITY_HOLD_JOB_IDS.fork_pr,
    });
  });

  it('holds the whole workflow and stores the context that replays it', async () => {
    // The release path is `routeRelease`, which discriminates on (scope,
    // triggerSource) and sends this pair to `resumeWorkflow`. That resume reads
    // the stored dispatch context; without it the approval would flip the row,
    // post a green check, and dispatch nothing.
    clearPendingWorkflowContextsMap();
    const create = vi.fn().mockResolvedValue({ id: 'held-fork-scope' });
    const { ctx } = makeSingleJobContext({ bundle: undefined });
    ctx.securityDecision = holdDecision(SecurityHoldReason.enum.fork_pr);
    ctx.trustResolution = {
      tier: 'unknown',
      contributorUsername: 'octocat',
    } as unknown as WorkflowDispatchContext['trustResolution'];
    (ctx.deps as unknown as Record<string, unknown>).heldRunStore = { create };

    await dispatchMatchedWorkflow(ctx);

    expect(create.mock.calls[0][1]).toMatchObject({
      scope: HoldScope.enum.workflow,
      triggerSource: TriggerSource.enum.context,
    });
    // Control: the loader is not a function that always answers. A run id no
    // dispatch held reads back null, so the assertion above is about this hold.
    expect(await loadPendingWorkflowContext(undefined, `${ctx.runId}-never-held`)).toBeNull();
    const pending = await loadPendingWorkflowContext(undefined, ctx.runId);
    expect(pending).not.toBeNull();
    // Approval means "let it run", never "make it trusted": the replay reuses
    // this run id, so the gate short-circuits rather than re-resolving trust and
    // the stored tier is the one the resumed run executes under.
    expect(pending!.trustResolution).toMatchObject({ tier: 'unknown' });
    expect(pending!.securityDecision).toMatchObject({ action: 'hold' });
  });

  it('stores no resume context when there is no hold row to release it', async () => {
    // The hold row is the only thing that can release a stored context, so an
    // orchestrator with no held-run store must write neither. A context written
    // without one is unreachable by every release path and unreferenced by every
    // cleanup path.
    clearPendingWorkflowContextsMap();
    const { ctx } = makeSingleJobContext({ bundle: undefined });
    ctx.securityDecision = holdDecision(SecurityHoldReason.enum.fork_pr);
    delete (ctx.deps as unknown as Record<string, unknown>).heldRunStore;

    await dispatchMatchedWorkflow(ctx);

    expect(await loadPendingWorkflowContext(undefined, ctx.runId)).toBeNull();
  });

  it('holds an unknown contributor under its own sentinel job id', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'held-unk-1' });
    const { ctx } = makeSingleJobContext({ bundle: undefined });
    ctx.securityDecision = holdDecision(SecurityHoldReason.enum.unknown_contributor);
    (ctx.deps as unknown as Record<string, unknown>).heldRunStore = { create };

    await dispatchMatchedWorkflow(ctx);

    expect(create.mock.calls[0][1]).toMatchObject({
      reason: SecurityHoldReason.enum.unknown_contributor,
      jobId: '__unknown_contributor__',
    });
  });

  it('derives the hold expiry from the decision, not a second policy read', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'held-exp-1' });
    const { ctx } = makeSingleJobContext({ bundle: undefined });
    ctx.securityDecision = holdDecision(
      SecurityHoldReason.enum.workflow_modification,
      5 * SECONDS_PER_HOUR,
    );
    (ctx.deps as unknown as Record<string, unknown>).heldRunStore = { create };
    // A store that would answer 99h if anyone asked. Nobody does: the window
    // rides on the decision, from the same read that produced the verdict.
    const store = storeReturningExpiry(99);
    (ctx.deps as unknown as Record<string, unknown>).trustPolicyStore = store;

    const before = Date.now();
    await dispatchMatchedWorkflow(ctx);

    const { expiresAt } = create.mock.calls[0][1] as { expiresAt: Date };
    const hours = (expiresAt.getTime() - before) / 3_600_000;
    expect(hours).toBeGreaterThan(4.9);
    expect(hours).toBeLessThan(5.1);
    // The TOCTOU is gone: no second read happens at hold-sizing time.
    expect(store.get).not.toHaveBeenCalled();
  });

  it('sizes a sub-hour hold in seconds instead of rounding it to an hour', async () => {
    // The reason the seconds window exists. An hours-granularity expiry cannot
    // express this at all, and the previous `hours * 3_600_000` arithmetic
    // would have turned 30 into 108,000,000 ms — 30 HOURS, not 30 seconds.
    const create = vi.fn().mockResolvedValue({ id: 'held-exp-sub-hour' });
    const { ctx } = makeSingleJobContext({ bundle: undefined });
    ctx.securityDecision = holdDecision(SecurityHoldReason.enum.workflow_modification, 30);
    (ctx.deps as unknown as Record<string, unknown>).heldRunStore = { create };

    const before = Date.now();
    await dispatchMatchedWorkflow(ctx);

    const { expiresAt } = create.mock.calls[0][1] as { expiresAt: Date };
    const seconds = (expiresAt.getTime() - before) / 1_000;
    expect(seconds).toBeGreaterThan(29);
    expect(seconds).toBeLessThan(31);
  });

  it('falls back to the 72h default in independent mode, which carries no expiry', async () => {
    // Independent mode has no upstream policy, so the decision carries `null`
    // rather than the 72h a second store read used to invent for it.
    const create = vi.fn().mockResolvedValue({ id: 'held-exp-2' });
    const { ctx } = makeSingleJobContext({ bundle: undefined });
    ctx.securityDecision = holdDecision(SecurityHoldReason.enum.workflow_modification, null);
    (ctx.deps as unknown as Record<string, unknown>).heldRunStore = { create };

    const before = Date.now();
    await dispatchMatchedWorkflow(ctx);

    const { expiresAt } = create.mock.calls[0][1] as { expiresAt: Date };
    const hours = (expiresAt.getTime() - before) / 3_600_000;
    expect(hours).toBeGreaterThan(71.9);
    expect(hours).toBeLessThan(72.1);
  });

  it('still holds when the policy store read throws', async () => {
    // A read failure must not dispatch a run the policy said to hold.
    const create = vi.fn().mockResolvedValue({ id: 'held-exp-3' });
    const { ctx } = makeSingleJobContext({ bundle: undefined });
    ctx.securityDecision = holdDecision(SecurityHoldReason.enum.workflow_modification);
    (ctx.deps as unknown as Record<string, unknown>).heldRunStore = { create };
    (ctx.deps as unknown as Record<string, unknown>).trustPolicyStore = {
      get: vi.fn().mockRejectedValue(new Error('db down')),
    };

    const result = await dispatchMatchedWorkflow(ctx);

    expect(result.held).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('rejects the run with a run-scoped trust_policy init failure', async () => {
    const recordInitFailureRun = vi.fn().mockResolvedValue(undefined);
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn();
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: {
        normalizer: { provider: 'github' },
        checkStatusPoster: { provider: 'github', postCheckStatus },
      } as unknown as WorkflowDispatchContext['bundle'],
    });
    ctx.securityDecision = rejectDecision(SecurityHoldReason.enum.fork_pr);
    (ctx.deps as unknown as Record<string, unknown>).heldRunStore = { create };
    (ctx.deps as unknown as Record<string, unknown>).executionTracker = {
      recordInitFailureRun,
      releasePendingJobsHold: vi.fn(),
    };

    const result = await dispatchMatchedWorkflow(ctx);

    expect(result.dispatchedJobCount).toBe(0);
    expect(dispatched).toHaveLength(0);
    // A reject is a failure, not a hold — nothing lands in the approval queue.
    expect(create).not.toHaveBeenCalled();
    expect(recordInitFailureRun).toHaveBeenCalledTimes(1);
    expect(recordInitFailureRun.mock.calls[0][0]).toMatchObject({
      initFailure: {
        scope: 'run',
        category: InitFailureCategory.enum.trust_policy,
      },
    });
    const rejectCall = postCheckStatus.mock.calls.find(
      (c) => c[2] === 'failure' && c[3] === 'Rejected by trust policy',
    );
    expect(rejectCall).toBeDefined();
    // A rejected run has no held_runs row, so the check must NOT tell the
    // contributor to seek an approval that can never happen.
    expect(String(rejectCall![4])).not.toContain('ci_trust:write');
    expect(String(rejectCall![4])).toContain('cannot be approved');
  });

  it('does NOT reject on a resume re-entry', async () => {
    // Mirrors the sibling re-hold test: no executionTracker, so the gate's own
    // side effect is observed through the check poster instead.
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeSingleJobContext({
      bundle: {
        normalizer: { provider: 'github' },
        checkStatusPoster: { provider: 'github', postCheckStatus },
      } as unknown as WorkflowDispatchContext['bundle'],
    });
    ctx.securityDecision = rejectDecision(SecurityHoldReason.enum.fork_pr);

    await dispatchMatchedWorkflow(ctx, { reuseRunId: 'run-1', skipInstallProtectionGate: true });

    expect(postCheckStatus.mock.calls.some((c) => c[3] === 'Rejected by trust policy')).toBe(false);
  });

  it('covers every trust-policy hold reason with a sentinel job id', () => {
    // A reason with no sentinel would write `undefined` into held_runs.job_id.
    // Scoped to the reasons the POLICY raises: `context_trust` comes from the
    // per-context gate, which writes the real expanded job name instead.
    const policyReasons = SecurityHoldReason.options.filter(
      (r) => r !== SecurityHoldReason.enum.context_trust,
    );
    for (const reason of policyReasons) {
      expect(
        SECURITY_HOLD_JOB_IDS[reason as keyof typeof SECURITY_HOLD_JOB_IDS],
        `${reason} needs a sentinel`,
      ).toBeTruthy();
    }
    // The historical value must not move, or holds created before the policy
    // was enforced stop resolving by job id.
    expect(SECURITY_HOLD_JOB_IDS.workflow_modification).toBe('__workflow_modification__');
    // And the phantom is gone: it was never written to a single row, and
    // existed only to satisfy a Record over the full reason enum.
    expect(SECURITY_HOLD_JOB_IDS).not.toHaveProperty('context_trust');
    expect(Object.keys(SECURITY_HOLD_JOB_IDS).sort()).toEqual(policyReasons.slice().sort());
  });
});

describe('dispatchMatchedWorkflow — absent trust/holds/coordinator deps', () => {
  it('dispatches only the root job of a needs DAG; the downstream stays gated', async () => {
    const { ctx, dispatched } = makeNeedsContext();
    const result = await dispatchMatchedWorkflow(ctx);
    // Both jobs are tracked (root dispatched + downstream gated synthetic), but
    // only the root `build` reaches the dispatcher — `deploy` is held by the
    // needs scheduler until `build` completes.
    expect(result.dispatchedJobCount).toBe(2);
    const dispatchedNames = dispatched.map((d) => d.jobName);
    expect(dispatchedNames).toEqual(['build']);

    // The gated downstream (`deploy`) is stored as a pending context that the
    // needs scheduler re-dispatches later through the base dispatcher (no
    // wrapper merge). Its stored jobInput MUST already carry extraJobConfig
    // (isTestRun/fixtureId) so a test run's overlay provenance survives the
    // deferred dispatch.
    const pending = await consumePendingJobContext(undefined, 'run-needs', 'deploy');
    expect(pending?.jobInput.jobConfig.isTestRun).toBe(true);
    expect(pending?.jobInput.jobConfig.fixtureId).toBe('fx-needs');
  });
});

describe('dispatchMatchedWorkflow — a job no agent can run', () => {
  it('registers a queued-no-backend job so the run cannot finish without it', async () => {
    // A `runsOn` no agent satisfies makes the dispatcher enqueue the job and
    // report `queued-no-backend`. Leaving it out of the tracked job set is what
    // let a run finish GREEN with the job never having run: `isRunComplete`
    // iterates the REGISTERED jobs, so an unregistered one is invisible to it.
    const { ctx, dispatched } = makeSingleJobContext({ bundle: undefined, fullRepo: true });
    ctx.deps.dispatcher.dispatch = async (input) => {
      dispatched.push(input);
      return { status: 'queued-no-backend' as const, jobId: 'queued-job-1' };
    };

    const result = await dispatchMatchedWorkflow(ctx);

    expect(dispatched.map((d) => d.jobName)).toEqual(['build']);
    expect(result.dispatchedJobCount).toBe(1);
  });

  it('carries the real queue jobId onto the tracked job, not a synthetic one', async () => {
    // The queue row is what the expiry sweep terminalizes, so the tracked job
    // must be keyed by the SAME id the dispatcher enqueued under — a synthetic
    // id would leave the expiry unable to reach the tracked job.
    const created: Array<{ jobId: string; jobName: string }> = [];
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: undefined,
      fullRepo: true,
      executionTracker: {
        // Named positionally after `ExecutionTracker.onExecutionStarted`, whose
        // 10th parameter is the tracked-job array. Spelling the leading
        // parameters out (rather than indexing a rest array) keeps the binding
        // legible if the signature ever grows.
        onExecutionStarted: vi.fn(
          async (
            _runId: string,
            _workflowName: string,
            _provider: string,
            _repoIdentifier: string,
            _ref: string,
            _sha: string,
            _deliveryId: string | null,
            _providerContext: unknown,
            _triggerDecision: unknown,
            jobs: Array<{ jobId: string; jobName: string }>,
          ) => {
            for (const j of jobs) {
              created.push({ jobId: j.jobId, jobName: j.jobName });
            }
          },
        ),
        // The run is registered before the dispatch loop, so its jobs arrive
        // through `addJobsToRun` rather than in the `onExecutionStarted` call.
        addJobsToRun: vi.fn(
          async (_runId: string, jobs: Array<{ jobId: string; jobName: string }>) => {
            for (const j of jobs) {
              created.push({ jobId: j.jobId, jobName: j.jobName });
            }
          },
        ),
        onJobStatus: vi.fn().mockResolvedValue(undefined),
        holdRunForPendingJobs: vi.fn(() => true),
        releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
      },
    });
    ctx.deps.dispatcher.dispatch = async (input) => {
      dispatched.push(input);
      return { status: 'queued-no-backend' as const, jobId: 'queue-row-42' };
    };

    await dispatchMatchedWorkflow(ctx);

    expect(created).toEqual([{ jobId: 'queue-row-42', jobName: 'build' }]);
  });
});

describe('dispatchMatchedWorkflow — the run exists before the first job reaches an agent', () => {
  /**
   * Build a tracker that records the order of every lifecycle call, plus the
   * job list each registration carried.
   */
  function makeOrderRecordingTracker(callOrder: string[]) {
    return {
      onExecutionStarted: vi.fn(
        async (
          _runId: string,
          _workflowName: string,
          _provider: string,
          _repoIdentifier: string,
          _ref: string,
          _sha: string,
          _deliveryId: string | null,
          _providerContext: unknown,
          _triggerDecision: unknown,
          jobs: Array<{ jobId: string; jobName: string }>,
        ) => {
          callOrder.push(`run-start:${jobs.length}`);
        },
      ),
      addJobsToRun: vi.fn(
        async (_runId: string, jobs: Array<{ jobId: string; jobName: string }>) => {
          callOrder.push(`add-jobs:${jobs.map((j) => j.jobName).join(',')}`);
        },
      ),
      onJobStatus: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => {
        callOrder.push('hold');
        return true;
      }),
      releasePendingJobsHold: vi.fn(async () => {
        callOrder.push('release');
      }),
      failRun: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('registers the run and holds it open before the dispatch loop, releasing only once its jobs are registered', async () => {
    // The ordering IS the fix. A root job dispatched before the run row exists
    // reports terminal into `onJobStatus`, which misses in memory, finds no row
    // via `recoverRunFromDb`, and DROPS the update — so no downstream is ever
    // released and the run hangs with nothing logged as wrong. The token is the
    // other half: without it, the first job to finish satisfies `isRunComplete`
    // while jobs 2..N are still dispatching, and the run is finalized mid-flight.
    const callOrder: string[] = [];
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: undefined,
      fullRepo: true,
      executionTracker: makeOrderRecordingTracker(callOrder),
    });
    ctx.deps.dispatcher.dispatch = async (input) => {
      dispatched.push(input);
      callOrder.push(`dispatch:${input.jobName}`);
      return { status: 'dispatched' as const, jobId: 'queue-row-1' };
    };

    await dispatchMatchedWorkflow(ctx);

    expect(callOrder).toEqual([
      'run-start:0',
      'hold',
      'dispatch:build',
      'add-jobs:build',
      'release',
    ]);
  });

  it('does not register the run a second time once it is started early', async () => {
    // A second `onExecutionStarted` resets the in-memory job map, so a run that
    // was started before the loop must only ever have jobs ADDED to it.
    const callOrder: string[] = [];
    const tracker = makeOrderRecordingTracker(callOrder);
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: undefined,
      fullRepo: true,
      executionTracker: tracker,
    });
    ctx.deps.dispatcher.dispatch = async (input) => {
      dispatched.push(input);
      return { status: 'dispatched' as const, jobId: 'queue-row-1' };
    };

    await dispatchMatchedWorkflow(ctx);

    expect(tracker.onExecutionStarted).toHaveBeenCalledTimes(1);
    expect(tracker.addJobsToRun).toHaveBeenCalledTimes(1);
  });

  it('terminalizes the run when the dispatch loop throws, so a zero-job row cannot strand', async () => {
    // A row with zero jobs can never satisfy `isRunComplete` (it ends
    // `run.jobs.size > 0`) and no sweeper reaps one — the stale-run detector
    // scans from `execution_jobs` / `dispatch_queue`, orphan recovery needs
    // `running`, cold-store archival needs a terminal status. Left alone it
    // sits `pending` forever while the deadline detector re-fires every tick.
    const callOrder: string[] = [];
    const tracker = makeOrderRecordingTracker(callOrder);
    const { ctx } = makeSingleJobContext({
      bundle: undefined,
      fullRepo: true,
      executionTracker: tracker,
    });
    ctx.deps.dispatcher.dispatch = async () => {
      throw new Error('dispatcher exploded');
    };

    await expect(dispatchMatchedWorkflow(ctx)).rejects.toThrow('dispatcher exploded');

    expect(tracker.failRun).toHaveBeenCalledTimes(1);
    expect(tracker.failRun.mock.calls[0][1]).toContain('dispatcher exploded');
  });
});

describe('dispatchMatchedWorkflow — optional bundle (test-mode / local repo)', () => {
  it('dispatches a single static job with an undefined bundle, repoUrl falls back to empty', async () => {
    const { ctx, dispatched } = makeSingleJobContext({ bundle: undefined, fullRepo: true });
    const result = await dispatchMatchedWorkflow(ctx);
    expect(result.dispatchedJobCount).toBe(1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].repoUrl).toBe('');
    // The extraJobConfig merge is applied by the dispatcher wrapper.
    expect(dispatched[0].jobConfig.isTestRun).toBe(true);
  });

  it('emits the resolved sandbox grant when the request is allow-listed', async () => {
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: undefined,
      fullRepo: true,
      jobContainer: 'node:20',
      jobSandbox: { capabilities: ['NET_ADMIN'], network: 'host' },
      sandboxAllowListReader: {
        read: async () => ({ capabilities: ['NET_ADMIN'], allowHostNetwork: true }),
      },
    });
    const result = await dispatchMatchedWorkflow(ctx);
    expect(result.dispatchedJobCount).toBe(1);
    expect(dispatched[0].jobConfig.sandboxGrant).toEqual({
      capabilities: ['NET_ADMIN'],
      network: 'host',
    });
  });

  it('records a queryable failed run and dispatches nothing when a sandbox request is not allow-listed', async () => {
    const recordInitFailureRun = vi.fn(async () => {});
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: undefined,
      fullRepo: true,
      jobContainer: 'node:20',
      jobSandbox: { capabilities: ['SYS_ADMIN'] },
      sandboxAllowListReader: {
        read: async () => ({ capabilities: [], allowHostNetwork: false }),
      },
      executionTracker: {
        onExecutionStarted: async () => {},
        releasePendingJobsHold: async () => {},
        recordInitFailureRun,
      },
    });
    const result = await dispatchMatchedWorkflow(ctx);
    expect(result.dispatchedJobCount).toBe(0);
    expect(dispatched).toHaveLength(0);
    // The deny records a queryable failed run (not a silent failRun) so the
    // author sees the denial + reason in the dashboard / runs API.
    expect(recordInitFailureRun).toHaveBeenCalledTimes(1);
    const arg = recordInitFailureRun.mock.calls[0][0] as {
      initFailure: { category: string; message: string };
    };
    expect(arg.initFailure.category).toBe('sandbox_denied');
    expect(arg.initFailure.message).toMatch(/SYS_ADMIN/);
    expect(arg.initFailure.message).toMatch(/sandboxAllowedCapabilities/);
    expect(arg.initFailure.message).toMatch(/build/); // names the offending job
  });

  it('emits no sandbox grant for a job with no request (default hardened posture)', async () => {
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: undefined,
      fullRepo: true,
      jobContainer: 'node:20',
    });
    await dispatchMatchedWorkflow(ctx);
    expect(dispatched[0].jobConfig.sandboxGrant).toBeUndefined();
  });

  it('omits contentHash on a test-run job so the agent skips the lock-vs-overlay hash check', async () => {
    // A test run ships the workflow body as a working-tree overlay that may
    // differ from the committed lock; the agent must not reject it for a
    // contentHash mismatch.
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: undefined,
      fullRepo: true,
      testRun: { fixtureId: 'fx-1' },
    });
    // The lock workflow carries a contentHash, but the dispatched job must not.
    (ctx.workflow as unknown as { contentHash?: string }).contentHash = 'wf-hash';
    await dispatchMatchedWorkflow(ctx);
    expect(dispatched[0].jobConfig.contentHash).toBeUndefined();
  });

  it('layers run-wide CLI flat secrets onto an env-less job', async () => {
    // `kici run --secret FOO=bar` on a job with no `context:` must still
    // receive the secret — the run-wide flat layer reaches every job.
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: undefined,
      fullRepo: true,
      testRun: { fixtureId: 'fx-1' },
      runWideFlatSecrets: { FOO: 'bar', SHARED: 'cli' },
    });
    await dispatchMatchedWorkflow(ctx);
    expect(dispatched[0].jobConfig.secrets).toEqual({ FOO: 'bar', SHARED: 'cli' });
  });

  it('merges run-wide CLI flat under the env-resolved secrets (CLI wins, no clobber)', async () => {
    // An env-declaring job gets its context secrets AND the run-wide CLI
    // flat overlay; on a key collision the CLI value wins (B1-env -> A-CLI-wins).
    const { db } = makeUpdateRecordingDb();
    // The env-rules path queries a running-count; answer 0 and supply db.fn.
    const envDb = {
      ...(db as object),
      fn: { countAll: () => ({ as: () => ({}) }) },
      selectFrom: () => ({
        select: () => ({
          where: function (this: unknown) {
            return this;
          },
          innerJoin: function (this: unknown) {
            return this;
          },
          executeTakeFirst: async () => ({ count: 0 }),
        }),
      }),
      insertInto: () => ({
        values: () => ({
          onConflict: () => ({ execute: async () => undefined }),
          execute: async () => undefined,
        }),
      }),
      // holdJobForApproval writes the hold row and the pending context in
      // one transaction; the stub hands the same handle back.
      transaction: () => ({
        execute: async (cb: (t: unknown) => Promise<unknown>) => cb(makeTrxHandle()),
      }),
    };
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: undefined,
      fullRepo: true,
      testRun: { fixtureId: 'fx-1' },
      jobContext: 'staging',
      db: envDb,
      secretResolver: {
        resolveForJob: async () => ({ DB_URL: 'env-db', SHARED: 'env' }),
        resolveNamed: async () => null,
        resolveForJobWithMeta: async () => ({}),
      },
      runWideFlatSecrets: { SHARED: 'cli', EXTRA: 'cli' },
    });
    await dispatchMatchedWorkflow(ctx);
    expect(dispatched[0].jobConfig.secrets).toEqual({
      DB_URL: 'env-db', // env-only secret preserved (no clobber)
      SHARED: 'cli', // CLI wins on collision
      EXTRA: 'cli', // run-wide CLI flat reaches the env job too
    });
  });

  it('eager context-gate hold records the expanded job name as job_id, per matrix child', async () => {
    // `held_runs.job_id` is the value the approval queue renders and that
    // `kici approve --job <name>` resolves, so the context gate must store the
    // materialized job's expanded name. A matrix job expands into one hold per
    // child, and each child must carry its own name.
    const created: Array<{ runId: string; jobId: string }> = [];
    const { db } = makeUpdateRecordingDb();
    const envDb = {
      ...(db as object),
      fn: { countAll: () => ({ as: () => ({}) }) },
      // A non-zero running count trips the concurrency gate, which is the
      // eager hold path under test.
      selectFrom: () => ({
        select: () => ({
          where: function (this: unknown) {
            return this;
          },
          innerJoin: function (this: unknown) {
            return this;
          },
          executeTakeFirst: async () => ({ count: 1 }),
        }),
      }),
      insertInto: () => ({
        values: () => ({
          onConflict: () => ({ execute: async () => undefined }),
          execute: async () => undefined,
        }),
      }),
      // holdJobForApproval writes the hold row and the pending context in
      // one transaction; the stub hands the same handle back.
      transaction: () => ({
        execute: async (cb: (t: unknown) => Promise<unknown>) => cb(makeTrxHandle()),
      }),
    };
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: undefined,
      fullRepo: true,
      jobContext: 'staging',
      contextConcurrencyLimit: 1,
      jobMatrix: { _type: 'static', values: ['18', '20'] },
      db: envDb,
      heldRunStore: {
        // Returns the row it wrote, as the real store does — `create` ends in
        // `executeTakeFirstOrThrow`, so it either yields a row or throws.
        create: async (_org: string, data: { runId: string; jobId: string }) => {
          created.push({ runId: data.runId, jobId: data.jobId });
          return { id: `held-${data.jobId}` };
        },
      },
    });
    await dispatchMatchedWorkflow(ctx);
    expect(dispatched).toHaveLength(0);
    expect(created.map((c) => c.jobId).sort()).toEqual(['build (18)', 'build (20)']);
  });

  it('holds the run non-terminal across the build window and releases it on return', async () => {
    // The run is registered with the __build__ job ALONE and the dispatch path
    // then AWAITS the build, so the build going terminal would otherwise satisfy
    // isRunComplete and finalize the run before its real jobs are dispatched.
    const timeline: string[] = [];
    const executionTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => timeline.push('register')),
      releasePendingJobsHold: vi.fn(async () => {
        timeline.push('clear');
      }),
    };
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      withBuildMiss: true,
      executionTracker,
    });
    const originalDispatch = ctx.deps.dispatcher.dispatch.bind(ctx.deps.dispatcher);
    ctx.deps.dispatcher.dispatch = async (input) => {
      timeline.push(`dispatch:${input.jobName}`);
      return originalDispatch(input);
    };

    await dispatchMatchedWorkflow(ctx);

    expect(dispatched.map((d) => d.jobName)).toEqual(['__build__ci', 'build']);
    // Registered before the workflow's own job is dispatched, cleared only once
    // dispatch is done registering it.
    expect(timeline).toEqual(['dispatch:__build__ci', 'register', 'dispatch:build', 'clear']);
  });

  it('releases the build-window token on the aborted-build early return', async () => {
    // A failed build short-circuits dispatch before any real job is registered.
    // The token taken when the build job was tracked must still be released, or
    // the run hangs in `running` until the stale detector reaps it.
    const releasePendingJobsHold = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      withBuildMiss: true,
      executionTracker: {
        onExecutionStarted: vi.fn().mockResolvedValue(undefined),
        addJobsToRun: vi.fn().mockResolvedValue(undefined),
        onJobStatus: vi.fn().mockResolvedValue(undefined),
        holdRunForPendingJobs: vi.fn(() => true),
        releasePendingJobsHold,
      },
    });
    // The build job dispatches fine, so the token IS taken; the build itself
    // then fails, which is the path that aborts dispatch early.
    (ctx.deps as { buildCoordinator: unknown }).buildCoordinator = {
      ensureBuild: async (_k: string, fn: () => Promise<unknown>) => {
        await fn();
        throw new Error('build agent unavailable');
      },
    };

    const result = await dispatchMatchedWorkflow(ctx);
    expect(result.dispatchedJobCount).toBe(0);
    expect(releasePendingJobsHold).toHaveBeenCalledWith('run-1');
  });

  it('completes the queued check runs on the aborted-build early return', async () => {
    // Same early return as the case above, from the check-run angle. The setup
    // phase already posted `kici/ci` and `kici/ci/job/build`; `onBuildFailed`
    // writes the terminal run row and reaches no check run, so without this
    // they sit `queued` on the commit for a run that will never start.
    const setPendingAwait = vi.fn().mockResolvedValue(undefined);
    const completeUndispatchedCheckRuns = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      withBuildMiss: true,
      checkRunReporter: {
        setPendingAwait,
        setBuildPending: vi.fn(),
        setBuildComplete: vi.fn(),
        completeUndispatchedCheckRuns,
      },
      executionTracker: {
        onExecutionStarted: vi.fn().mockResolvedValue(undefined),
        addJobsToRun: vi.fn().mockResolvedValue(undefined),
        onJobStatus: vi.fn().mockResolvedValue(undefined),
        onBuildFailed: vi.fn().mockResolvedValue(undefined),
        holdRunForPendingJobs: vi.fn(() => true),
        releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
      },
    });
    ctx.repoIdentifier = 'acme/app';
    ctx.workflowRepoIdentifier = 'acme/app';
    (ctx.deps as { buildCoordinator: unknown }).buildCoordinator = {
      ensureBuild: async (_k: string, fn: () => Promise<unknown>) => {
        await fn();
        throw new Error('build agent unavailable');
      },
    };

    await dispatchMatchedWorkflow(ctx);

    expect(setPendingAwait).toHaveBeenCalledTimes(1);
    expect(completeUndispatchedCheckRuns).toHaveBeenCalledTimes(1);
    const call = completeUndispatchedCheckRuns.mock.calls[0][0];
    expect(call.conclusion).toBe(CheckRunConclusion.enum.failure);
    expect(call.jobNames).toEqual(setPendingAwait.mock.calls[0][0].jobNames);
    expect(String(call.summary)).toContain('build did not complete');
  });

  it('releases exactly the one token it took, never an unpaired one', async () => {
    // Tokens are fungible, so an unpaired release consumes someone else's: a
    // dispatch that released more than it took would drop a deferred init /
    // dynamic task's token underneath it and finalize the run while that task's
    // jobs are still being registered.
    const releasePendingJobsHold = vi.fn().mockResolvedValue(undefined);
    const holdRunForPendingJobs = vi.fn(() => true);
    const { ctx } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      executionTracker: {
        onExecutionStarted: vi.fn().mockResolvedValue(undefined),
        addJobsToRun: vi.fn().mockResolvedValue(undefined),
        onJobStatus: vi.fn().mockResolvedValue(undefined),
        holdRunForPendingJobs,
        releasePendingJobsHold,
      },
    });

    // No build infra, so the token covers the plain dispatch window instead.
    await dispatchMatchedWorkflow(ctx);

    expect(holdRunForPendingJobs).toHaveBeenCalledTimes(1);
    expect(releasePendingJobsHold).toHaveBeenCalledTimes(1);
  });

  it('does not release a token it never took', async () => {
    // A dispatch that registers no run takes no token, so it must not
    // decrement the count on the way out.
    const releasePendingJobsHold = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      executionTracker: {
        onExecutionStarted: vi.fn().mockResolvedValue(undefined),
        addJobsToRun: vi.fn().mockResolvedValue(undefined),
        onJobStatus: vi.fn().mockResolvedValue(undefined),
        // The run is unknown or already complete, so no token is available.
        holdRunForPendingJobs: vi.fn(() => false),
        releasePendingJobsHold,
      },
    });

    await dispatchMatchedWorkflow(ctx);

    expect(releasePendingJobsHold).not.toHaveBeenCalled();
  });

  /**
   * A deferred task registers the run's real jobs after dispatch has returned,
   * so the token it holds must be taken while dispatch is still running and
   * released only when the task settles. These two tests pin that ordering: if
   * the token were taken inside the async task instead, `release` for the
   * build window would land before the deferred `hold`, leaving a window in
   * which the run is un-held and the build going terminal finalizes it.
   */
  function makeHoldTimeline() {
    const timeline: string[] = [];
    let outstanding = 0;
    // Mirrors the real tracker: a release with nothing outstanding is a no-op
    // (the count clamps at zero) rather than driving it negative.
    let spuriousReleases = 0;
    return {
      timeline,
      tracker: {
        onExecutionStarted: vi.fn().mockResolvedValue(undefined),
        addJobsToRun: vi.fn().mockResolvedValue(undefined),
        onJobStatus: vi.fn().mockResolvedValue(undefined),
        recordInitFailureRun: vi.fn().mockResolvedValue(undefined),
        holdRunForPendingJobs: vi.fn(() => {
          outstanding += 1;
          timeline.push('hold');
          return true;
        }),
        releasePendingJobsHold: vi.fn(async () => {
          if (outstanding <= 0) {
            spuriousReleases += 1;
            return;
          }
          outstanding -= 1;
          timeline.push('release');
        }),
      },
      markDeferredDone() {
        // Called once the deferred task's own work is done. If the run was
        // already un-held before this point, the hold did not cover the task.
        timeline.push('deferred-registered');
      },
      get outstanding() {
        return outstanding;
      },
      get spuriousReleases() {
        return spuriousReleases;
      },
    };
  }

  it('holds the run across a deferred dynamic entry until its task settles', async () => {
    const h = makeHoldTimeline();
    let sawUnheld = false;
    const pendingDynamics = {
      track: vi.fn(async () => {
        // The eval is still in flight here — dispatch has already returned and
        // dropped its own token, so only the deferred token keeps the run open.
        if (h.outstanding <= 0) sawUnheld = true;
        h.markDeferredDone();
        return { jobs: [] };
      }),
      resolve: vi.fn(),
      reject: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      cleanup: vi.fn(),
    };
    const { ctx } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      withDynamicEntry: true,
      pendingDynamics,
      executionTracker: h.tracker,
    });

    await dispatchMatchedWorkflow(ctx);
    // Let the fire-and-forget dynamic task settle.
    await new Promise((r) => setTimeout(r, 50));

    expect(h.tracker.holdRunForPendingJobs).toHaveBeenCalledWith('run-1');
    expect(sawUnheld).toBe(false);
    // The deferred token outlives dispatch: its release comes after the task
    // registered its jobs, and every token taken is released exactly once.
    expect(h.timeline).toContain('deferred-registered');
    expect(h.timeline.indexOf('deferred-registered')).toBeLessThan(
      h.timeline.lastIndexOf('release'),
    );
    expect(h.outstanding).toBe(0);
    // F1's detector: dispatch must never release a token it did not take.
    expect(h.spuriousReleases).toBe(0);
  });

  it('holds the run across a deferred init job until its task settles', async () => {
    const h = makeHoldTimeline();
    let sawUnheld = false;
    const pendingInits = {
      track: vi.fn(async () => {
        if (h.outstanding <= 0) sawUnheld = true;
        h.markDeferredDone();
        return { matrixValues: [{ variant: 'a' }] };
      }),
      resolve: vi.fn(),
      reject: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      cleanup: vi.fn(),
    };
    const { ctx } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      withDeferredInit: true,
      pendingInits,
      executionTracker: h.tracker,
    });

    await dispatchMatchedWorkflow(ctx);
    await new Promise((r) => setTimeout(r, 50));

    expect(h.tracker.holdRunForPendingJobs).toHaveBeenCalledWith('run-1');
    expect(sawUnheld).toBe(false);
    expect(h.timeline).toContain('deferred-registered');
    expect(h.timeline.indexOf('deferred-registered')).toBeLessThan(
      h.timeline.lastIndexOf('release'),
    );
    expect(h.outstanding).toBe(0);
    // F1's detector: dispatch must never release a token it did not take.
    expect(h.spuriousReleases).toBe(0);
  });

  it('releases the deferred token even when the deferred task fails', async () => {
    // The task's own catch writes a synthetic failed job row, which must land
    // while the token is still held — so the release runs after it, via
    // `.finally()` on the spawned promise rather than inside the task.
    const h = makeHoldTimeline();
    const pendingDynamics = {
      track: vi.fn().mockRejectedValue(new Error('eval exploded')),
      resolve: vi.fn(),
      reject: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      cleanup: vi.fn(),
    };
    const { ctx } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      withDynamicEntry: true,
      pendingDynamics,
      executionTracker: h.tracker,
    });

    await dispatchMatchedWorkflow(ctx);
    await new Promise((r) => setTimeout(r, 50));

    // No token is left outstanding, so the run cannot hang in `running`, and
    // no unpaired release stole one.
    expect(h.outstanding).toBe(0);
    expect(h.spuriousReleases).toBe(0);
    // The synthetic failure row was registered before the token was dropped.
    const failedCall = h.tracker.onJobStatus.mock.calls.find(
      (args: unknown[]) => args[2] === ExecutionJobStatus.enum.failed,
    );
    expect(failedCall).toBeDefined();
  });

  it('skips the __build__ job for a local run even when build infra is present', async () => {
    // A local-repo (no-bundle) run carries its source as a working-tree overlay;
    // the cache/build machinery must be bypassed so the static job dispatches
    // directly and no __build__ job is created (which would shadow the overlay).
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: undefined,
      fullRepo: true,
      withBuildInfra: true,
    });
    const result = await dispatchMatchedWorkflow(ctx);
    expect(result.dispatchedJobCount).toBe(1);
    const names = dispatched.map((d) => d.jobName);
    expect(names).toEqual(['build']); // the workflow's own static job, not __build__ci
    expect(names.some((n) => n.startsWith('__build__'))).toBe(false);
    // No cached source tarball is attached — the overlay is the source of truth.
    expect(dispatched[0].sourceTarUrl).toBeUndefined();
  });

  it('skips the __build__ job for an in-place local run (localWorkingTree) even WITH a bundle', async () => {
    // A `file://` in-place run has a bundle AND build infra, but the agent runs
    // the operator's real tree directly — so the source-pack build must be
    // skipped (packing a dist-less clone would be wrong) and no source tarball
    // attached.
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      withBuildInfra: true,
      localWorkingTree: true,
    });
    const result = await dispatchMatchedWorkflow(ctx);
    expect(result.dispatchedJobCount).toBe(1);
    const names = dispatched.map((d) => d.jobName);
    expect(names).toEqual(['build']);
    expect(names.some((n) => n.startsWith('__build__'))).toBe(false);
    expect(dispatched[0].sourceTarUrl).toBeUndefined();
  });
});

/**
 * Drive `evaluateJobContexts` directly with a single lock job and event,
 * constructing the minimal ctx/setup/buildPrep the deferred-init path reads.
 * `deps.pendingInits` is truthy so a dynamic field routes to the init round.
 */
async function runEvaluateJobContexts(over: {
  lockJob: Record<string, unknown> & { name: string };
  event: Partial<SimulatedEvent>;
  /** Merged onto the lock workflow — `hasFilter` routes every job to the init round. */
  workflow?: Record<string, unknown>;
  /** Merged onto ctx.deps — a contextStore / heldRunStore the per-job block needs. */
  deps?: Record<string, unknown>;
  /** Merged onto the materialized job — `pendingDynamicMatrix` is the 4th dynamic field. */
  mat?: Record<string, unknown>;
  /**
   * Full materialized-job list, overriding the single `mat` above. A STATIC
   * matrix reaches `evaluateJobContexts` already expanded, so this is how a
   * case drives N sibling children through the per-job block.
   */
  mats?: Array<Record<string, unknown>>;
}): ReturnType<typeof evaluateJobContexts> {
  const lockJob = {
    _type: 'static' as const,
    runsOn: [{ kind: 'exact', value: 'default' }],
    steps: [{ name: 'echo', run: 'echo hi' }],
    needs: [],
    rules: [],
    ...over.lockJob,
  };
  const event: SimulatedEvent = {
    type: 'push',
    action: undefined,
    targetBranch: 'main',
    sourceBranch: undefined,
    payload: {},
    changedFiles: undefined,
    ...over.event,
  };
  const baseMat = { lockJob, baseName: lockJob.name, expandedName: lockJob.name };
  const materializedJobs = over.mats
    ? over.mats.map((m) => ({ ...baseMat, ...m }))
    : [{ ...baseMat, ...over.mat }];
  const ctx = {
    runId: 'run-1',
    workflow: { name: 'ci', source: { file: '.kici/workflows/ci.ts' }, ...over.workflow },
    fullLockFile: { source: { file: '.kici/workflows/ci.ts' } },
    bundle: undefined,
    repoIdentifier: 'local/repo',
    credentials: {},
    event,
    ref: 'sha',
    resolvedOrgId: '__default__',
    deps: { pendingInits: { has: () => false }, ...over.deps },
  };
  const setup = {
    dispatcher: {
      dispatch: async () => ({ status: 'dispatched' as const, agentId: 'a1', jobId: 'j1' }),
    },
    info: { provider: 'local', routingKey: 'local:repo', deliveryId: 'd' },
    effectiveDeliveryId: 'd',
  };
  const buildPrep = { materializedJobs, targetPlatform: 'linux', targetArch: 'amd64' };
  return evaluateJobContexts({ ctx, setup, buildPrep } as unknown as Parameters<
    typeof evaluateJobContexts
  >[0]);
}

describe('evaluateJobContexts — dynamic fields defer to the init round', () => {
  it('defers a pure inline env to the init round instead of evaluating it in-process', async () => {
    const { deferredInitJobs, jobContextData } = await runEvaluateJobContexts({
      lockJob: {
        _type: 'static',
        name: 'build',
        env: { _type: 'inline', expression: '(event) => ({ E: event.type })' },
        dynamicEnv: true,
      },
      event: { type: 'push' },
    });
    expect(deferredInitJobs).toHaveLength(1);
    expect(jobContextData.get('build')?.pendingInit).toBe(true);
    expect(jobContextData.get('build')?.jobEnv).toBeUndefined();
  });

  it('requests an init job for a non-global workflow that declares a filter', async () => {
    // The job itself is entirely static: without the workflow-level filter it
    // would dispatch straight through, which is the control below.
    const staticJob = { _type: 'static' as const, name: 'build' };
    const { deferredInitJobs } = await runEvaluateJobContexts({
      lockJob: staticJob,
      event: { type: 'push' },
      workflow: { hasFilter: true },
    });
    expect(deferredInitJobs).toHaveLength(1);
    expect(deferredInitJobs[0].initJobInput.jobConfig.hasFilter).toBe(true);

    const control = await runEvaluateJobContexts({
      lockJob: staticJob,
      event: { type: 'push' },
    });
    expect(control.deferredInitJobs).toHaveLength(0);
  });

  it('omits hasFilter from the init job config when the workflow declares none', async () => {
    // `LockWorkflow.hasFilter` is never emitted as `false`, so the init config
    // must not invent one either — the agent reads "key absent" as "no filter".
    const { deferredInitJobs } = await runEvaluateJobContexts({
      lockJob: { _type: 'static', name: 'build', dynamicEnv: true },
      event: { type: 'push' },
    });
    expect(deferredInitJobs).toHaveLength(1);
    expect('hasFilter' in deferredInitJobs[0].initJobInput.jobConfig).toBe(false);
  });
});

describe('evaluateJobContexts — a filter defers dispatch, never the evaluation', () => {
  // A workflow-level filter routes EVERY job through an init job, including
  // fully static ones. Reusing the dynamic-field `continue` for that skipped the
  // whole per-job evaluation block — so declaring a filter silently dropped a
  // job's bound contexts, the context rules that can reject it, and its
  // approval hold. These pin each of those to the same value with and without
  // the filter; the no-filter run in each is the control.
  const CONTEXT_JOB = { _type: 'static' as const, name: 'build', contexts: [{ value: 'prod' }] };

  /**
   * A context store whose `prod` config carries no rules, plus the same row with
   * `enabled: false` so the hard-reject gate fires (`disabledRow`).
   */
  function contextStore() {
    const row = (enabled: boolean) => ({
      id: 'env-prod',
      org_id: '__default__',
      name: 'prod',
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
      enabled,
      created_at: new Date(),
      updated_at: new Date(),
      created_by: null,
    });
    return {
      disabledRow: row(false),
      matchContext: async (_org: string, n: string) =>
        n === 'prod'
          ? {
              id: 'env-prod',
              org_id: '__default__',
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
              allow_local_execution: true,
              enabled: true,
              created_at: new Date(),
              updated_at: new Date(),
              created_by: null,
            }
          : null,
    };
  }

  it('still resolves a static bound context when the workflow declares a filter', async () => {
    const withFilter = await runEvaluateJobContexts({
      lockJob: CONTEXT_JOB,
      event: { type: 'push' },
      workflow: { hasFilter: true },
      deps: { contextStore: contextStore() },
    });
    const control = await runEvaluateJobContexts({
      lockJob: CONTEXT_JOB,
      event: { type: 'push' },
      deps: { contextStore: contextStore() },
    });

    // The control proves the context IS resolvable in this harness, so the
    // assertion below cannot pass vacuously.
    expect(control.jobContextData.get('build')?.contextId).toBe('env-prod');
    expect(control.runContextName).toBe('prod');

    expect(withFilter.jobContextData.get('build')?.contextId).toBe('env-prod');
    expect(withFilter.runContextName).toBe('prod');
    // …and the dispatch is still deferred to the filter verdict.
    expect(withFilter.jobContextData.get('build')?.pendingInit).toBe(true);
    expect(withFilter.deferredInitJobs).toHaveLength(1);
  });

  it('still holds a job for approval when the workflow declares a filter', async () => {
    const approval = { clauses: [], reason: 'ship it', when: 'always' as const };
    const withFilter = await runEvaluateJobContexts({
      lockJob: { _type: 'static', name: 'build', approval },
      event: { type: 'push' },
      workflow: { hasFilter: true },
      deps: { heldRunStore: { create: vi.fn() } },
    });

    const envData = withFilter.jobContextData.get('build');
    expect(envData?.held).toBe(true);
    expect(envData?.approvalHold?.requirement.reason).toBe('ship it');
    // A held job gets NO init job: the flow-back would otherwise dispatch it
    // past the very hold that stopped it. Approval, not the filter, is its gate.
    expect(withFilter.deferredInitJobs).toHaveLength(0);
    expect(envData?.pendingInit).toBeUndefined();
  });

  it('still holds a root job for a workflow-level requireApproval under a filter', async () => {
    const approval = { clauses: [], reason: 'workflow gate', when: 'always' as const };
    const withFilter = await runEvaluateJobContexts({
      lockJob: { _type: 'static', name: 'build' },
      event: { type: 'push' },
      workflow: { hasFilter: true, approval },
      deps: { heldRunStore: { create: vi.fn() } },
    });

    expect(withFilter.jobContextData.get('build')?.held).toBe(true);
    expect(withFilter.deferredInitJobs).toHaveLength(0);
  });

  it('still rejects a job by context rule when the workflow declares a filter', async () => {
    // The rejection half of the same boundary as the approval hold: a disabled
    // context hard-rejects the job, and a filter must not make that evaluation
    // (or its `rejected` verdict) disappear.
    const disabledContext = {
      matchContext: async (_org: string, n: string) =>
        n === 'prod' ? { ...contextStore().disabledRow, name: n } : null,
    };
    const withFilter = await runEvaluateJobContexts({
      lockJob: CONTEXT_JOB,
      event: { type: 'push' },
      workflow: { hasFilter: true },
      deps: { contextStore: disabledContext },
    });
    const control = await runEvaluateJobContexts({
      lockJob: CONTEXT_JOB,
      event: { type: 'push' },
      deps: { contextStore: disabledContext },
    });

    // The control proves the rejection is the context's doing, not the filter's.
    expect(control.jobContextData.get('build')?.rejected).toBe(true);
    expect(withFilter.jobContextData.get('build')?.rejected).toBe(true);
    // A rejected job gets NO init job: it is not dispatching either way, and the
    // flow-back would otherwise carry it past the rule that rejected it.
    expect(withFilter.deferredInitJobs).toHaveLength(0);
    expect(withFilter.jobContextData.get('build')?.pendingInit).toBeUndefined();
  });

  it('keeps deferring a dynamic job before its evaluation, as it must', async () => {
    // The dynamic path is unchanged: its values are unknowable here, so the
    // whole block IS skipped and the init result drives it.
    const { deferredInitJobs, jobContextData } = await runEvaluateJobContexts({
      lockJob: { _type: 'static', name: 'build', contexts: [{ value: 'prod' }], dynamicEnv: true },
      event: { type: 'push' },
      deps: { contextStore: contextStore() },
    });
    expect(deferredInitJobs).toHaveLength(1);
    expect(jobContextData.get('build')?.pendingInit).toBe(true);
    expect(jobContextData.get('build')?.contextId).toBeUndefined();
  });
});

describe('evaluateJobContexts — a context reviewer hold unions the workflow-level approval', () => {
  // A context-driven reviewer hold REPLACES whatever `applyStaticApprovalHolds`
  // would have minted (both of that function's branches are guarded on
  // `!jobEnvData.approvalHold`), so the clauses it carries are the run's only
  // approval requirement. It must therefore carry every source that would
  // otherwise have gated the job: the context's own reviewers, the job's
  // `requireApproval`, and — for a root job, the only kind a workflow-level gate
  // ever holds — the workflow's.
  const CTX_REVIEWER = 'ctx-reviewer';

  /** A `prod` context requiring one reviewer, so its gate returns a reviewer hold. */
  function reviewerContextStore() {
    return {
      matchContext: async (_org: string, n: string) =>
        n === 'prod'
          ? {
              id: 'env-prod',
              org_id: '__default__',
              name: n,
              type: 'deployment',
              glob_pattern: null,
              branch_restrictions: null,
              trigger_type_filters: null,
              repo_patterns: null,
              concurrency_limit: null,
              concurrency_strategy: null,
              concurrency_timeout_ms: null,
              required_reviewers: JSON.stringify([CTX_REVIEWER]),
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
    };
  }

  /** Evaluate one job bound to `prod` and return the approval hold it minted. */
  async function holdFor(over: {
    lockJob?: Record<string, unknown>;
    workflow?: Record<string, unknown>;
  }) {
    const res = await runEvaluateJobContexts({
      lockJob: { _type: 'static', name: 'build', contexts: [{ value: 'prod' }], ...over.lockJob },
      event: { type: 'push' },
      ...(over.workflow ? { workflow: over.workflow } : {}),
      deps: {
        contextStore: reviewerContextStore(),
        heldRunStore: { create: vi.fn(), createHold: vi.fn() },
      },
    });
    return res.jobContextData.get('build')?.approvalHold;
  }

  /** The hold's clause set as sorted comparable keys. */
  const keys = (hold: Awaited<ReturnType<typeof holdFor>>): string[] =>
    (hold?.requirement.clauses ?? [])
      .map((c) => ('team' in c ? `team:${c.team}` : `user:${c.user}`))
      .sort();

  const wfApproval = (user: string) => ({
    clauses: [{ user }],
    reason: 'workflow gate',
    when: 'always' as const,
  });
  const jobApproval = (user: string) => ({
    clauses: [{ user }],
    reason: 'job gate',
    when: 'always' as const,
  });

  it('mints a context reviewer hold at all (the control)', async () => {
    // Proves the harness reaches the reviewer branch, so every assertion below
    // about what that branch carries is non-vacuous.
    const hold = await holdFor({});
    expect(hold).toBeDefined();
    expect(keys(hold)).toEqual([`user:${CTX_REVIEWER}`]);
  });

  it('retains the workflow-level reviewers on a root job', async () => {
    const hold = await holdFor({ workflow: { approval: wfApproval('wf-owner') } });
    expect(keys(hold)).toEqual([`user:${CTX_REVIEWER}`, 'user:wf-owner']);
  });

  it('unions all three sources — context, job and workflow', async () => {
    const hold = await holdFor({
      lockJob: { approval: jobApproval('job-owner') },
      workflow: { approval: wfApproval('wf-owner') },
    });
    expect(keys(hold)).toEqual([`user:${CTX_REVIEWER}`, 'user:job-owner', 'user:wf-owner']);
  });

  it('dedupes a reviewer named by all three sources', async () => {
    const hold = await holdFor({
      lockJob: { approval: jobApproval(CTX_REVIEWER) },
      workflow: { approval: wfApproval(CTX_REVIEWER) },
    });
    expect(keys(hold)).toEqual([`user:${CTX_REVIEWER}`]);
  });

  it('leaves a NON-root job untouched — a workflow gate never held one', async () => {
    // `applyStaticApprovalHolds` mints the workflow hold for root jobs only
    // (downstream jobs are gated by their `needs` edges), so unioning the
    // workflow clauses into a downstream job's hold would ADD an approver the
    // job never had.
    const hold = await holdFor({
      lockJob: { needs: ['prev'], approval: jobApproval('job-owner') },
      workflow: { approval: wfApproval('wf-owner') },
    });
    expect(keys(hold)).toEqual([`user:${CTX_REVIEWER}`, 'user:job-owner']);
  });

  it('never shrinks the clause set, for a root or a non-root job', async () => {
    // The additive-only invariant of an approval surface: adding a
    // workflow-level gate may only ever ADD required approvers to a hold that
    // already exists, never remove or replace one.
    for (const needs of [[], ['prev']]) {
      const before = await holdFor({
        lockJob: { needs, approval: jobApproval('job-owner') },
      });
      const after = await holdFor({
        lockJob: { needs, approval: jobApproval('job-owner') },
        workflow: { approval: wfApproval('wf-owner') },
      });
      for (const k of keys(before)) expect(keys(after)).toContain(k);
    }
  });

  it('does not relabel the hold when the workflow contributes clauses', async () => {
    // `scope` drives the resume path, so the hold stays job-scoped and
    // context-triggered however many sources its clauses come from.
    const hold = await holdFor({ workflow: { approval: wfApproval('wf-owner') } });
    expect(hold?.scope).toBe(HoldScope.enum.job);
    expect(hold?.triggerSource).toBe(TriggerSource.enum.context);
    expect(hold?.contextId).toBe('env-prod');
  });
});

describe('evaluateJobContexts — a dynamic field defers dispatch, and the hold follows it', () => {
  // The approval hold for a dynamic-field job is minted in the FLOW-BACK, not
  // here. Setting `held` before the init round makes
  // `applyContextRulesAndSecrets` skip its own final block (guarded on `!held`),
  // so the job's context vars, secrets and registry auth never resolve — and the
  // stored input the release path dispatches verbatim is missing them.
  //
  // So this seam guarantees the DEFERRAL only. That such a job is then held
  // rather than dispatched is asserted end-to-end in "dispatchMatchedWorkflow —
  // a held job whose dynamic fields defer"; that its secrets survive the hold in
  // "— a held dynamic job keeps its context secrets".
  const APPROVAL = { clauses: [], reason: 'ship it', when: 'always' as const };
  const heldDeps = () => ({ heldRunStore: { create: vi.fn(), createHold: vi.fn() } });

  /** The four fields that route a job through the deferred-init round. */
  const DYNAMIC_FIELDS: Array<{
    label: string;
    lockJob?: Record<string, unknown>;
    mat?: Record<string, unknown>;
  }> = [
    { label: 'dynamicEnv', lockJob: { dynamicEnv: true } },
    { label: 'a dynamic bound context', lockJob: { contexts: [{ dynamic: true }] } },
    { label: 'dynamicConcurrencyGroup', lockJob: { dynamicConcurrencyGroup: true } },
    { label: 'a dynamic matrix', mat: { pendingDynamicMatrix: true } },
  ];

  for (const variant of DYNAMIC_FIELDS) {
    it(`defers a job with ${variant.label} even when it requires approval`, async () => {
      // The init round must still run: nothing else can resolve a dynamic value,
      // so suppressing it would make the job undispatchable rather than gated.
      const res = await runEvaluateJobContexts({
        lockJob: { _type: 'static', name: 'build', approval: APPROVAL, ...variant.lockJob },
        event: { type: 'push' },
        deps: heldDeps(),
        ...(variant.mat ? { mat: variant.mat } : {}),
      });
      expect(res.deferredInitJobs).toHaveLength(1);
      expect(res.jobContextData.get('build')?.pendingInit).toBe(true);
      // Not held YET — the flow-back mints it, after the context rules have run.
      expect(res.jobContextData.get('build')?.held).toBeUndefined();
    });
  }

  it('leaves a dynamic job with no approval deferred all the same', async () => {
    // The control: deferral is driven by the dynamic field, not by the approval.
    const res = await runEvaluateJobContexts({
      lockJob: { _type: 'static', name: 'build', dynamicEnv: true },
      event: { type: 'push' },
      deps: heldDeps(),
    });
    expect(res.deferredInitJobs).toHaveLength(1);
    expect(res.jobContextData.get('build')?.pendingInit).toBe(true);
    expect(res.jobContextData.get('build')?.approvalHold).toBeUndefined();
  });
});

describe('initDispatchSuppression', () => {
  // The flow-back's own guard. `evaluateJobContexts` never gives a rejected or
  // held job an init job, so the Gated branch is unreachable through
  // dispatchMatchedWorkflow — which is exactly why the predicate is exported and
  // tested directly. An untestable security check is one nobody can prove works.
  const filtered = { hasFilter: true } as const;

  it('suppresses on a false verdict from a workflow that declares a filter', () => {
    expect(initDispatchSuppression(filtered, { filterPassed: false }, {})).toBe(
      InitDispatchSuppression.Filter,
    );
  });

  it('ignores a false verdict when the workflow declares no filter', () => {
    expect(initDispatchSuppression({}, { filterPassed: false }, {})).toBeNull();
  });

  it('does not suppress on a passing verdict, or on no verdict at all', () => {
    expect(initDispatchSuppression(filtered, { filterPassed: true }, {})).toBeNull();
    // An agent that predates the filter reports nothing; reading that absence as
    // "suppress" would stop every dispatch it handles.
    expect(initDispatchSuppression(filtered, {}, {})).toBeNull();
  });

  it('refuses to dispatch a rejected or held job', () => {
    expect(initDispatchSuppression({}, {}, { rejected: true })).toBe(InitDispatchSuppression.Gated);
    expect(initDispatchSuppression({}, {}, { held: true })).toBe(InitDispatchSuppression.Gated);
    // …including when the filter itself passed: the hold outranks the verdict.
    expect(initDispatchSuppression(filtered, { filterPassed: true }, { held: true })).toBe(
      InitDispatchSuppression.Gated,
    );
  });

  it('dispatches an ungated job with nothing to suppress it', () => {
    expect(initDispatchSuppression({}, {}, {})).toBeNull();
  });
});

describe('dispatchMatchedWorkflow — a held job whose dynamic fields defer', () => {
  // A job can be BOTH held (approval is read from the lock file) and pendingInit
  // (its dynamic values are not). The dispatch loop must skip it — holding it
  // there would store a pending dispatch context built from unresolved values,
  // and the release path dispatches that stored input verbatim. The flow-back
  // owns the hold instead, because only it has the resolved values.
  const APPROVAL = { clauses: [], reason: 'ship it', when: 'always' as const };
  const INIT_JOB_NAME = '__init__ci__build';

  function makePendingInits(initResult: Record<string, unknown>) {
    return {
      track: vi.fn(async () => initResult),
      resolve: vi.fn(),
      reject: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      cleanup: vi.fn(),
    };
  }

  /** Minimal tracker: the run-hold pair plus the registration call under test. */
  function makeTracker(addJobsToRun: ReturnType<typeof vi.fn>) {
    addJobsToRun.mockResolvedValue(undefined);
    return {
      addJobsToRun,
      onExecutionStarted: vi.fn(),
      onJobStatus: vi.fn(),
      holdRunForPendingJobs: vi.fn().mockReturnValue(true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
    };
  }

  /** Enough Kysely surface for storePendingJobContext's upsert and the reads
   * the dispatch path makes along the way (org settings, concurrency count). */
  function makeDb() {
    return {
      fn: { countAll: () => ({ as: (alias: string) => alias }) },
      selectFrom: () => ({
        select: function (this: unknown) {
          return this;
        },
        where: function (this: unknown) {
          return this;
        },
        innerJoin: function (this: unknown) {
          return this;
        },
        executeTakeFirst: async () => undefined,
      }),
      insertInto: () => ({
        values: () => ({
          onConflict: () => ({ execute: async () => undefined }),
          execute: async () => undefined,
        }),
      }),
      // holdJobForApproval writes the hold row and the pending context in
      // one transaction; the stub hands the same handle back.
      transaction: () => ({
        execute: async (cb: (t: unknown) => Promise<unknown>) => cb(makeTrxHandle()),
      }),
    };
  }

  async function run(over: { jobApproval?: unknown }) {
    const create = vi.fn().mockResolvedValue({ id: 'held-dyn-1' });
    const heldRunStore = { createHold: create, create: vi.fn() };
    const addJobsToRun = vi.fn().mockResolvedValue(undefined);
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      withDynamicEnv: true,
      pendingInits: makePendingInits({ env: { RESOLVED: 'yes' } }),
      heldRunStore,
      db: makeDb(),
      executionTracker: makeTracker(addJobsToRun),
      ...(over.jobApproval ? { jobApproval: over.jobApproval } : {}),
    });
    await dispatchMatchedWorkflow(ctx);
    // Let the fire-and-forget deferred-init task settle.
    await new Promise((r) => setTimeout(r, 50));
    return { create, addJobsToRun, names: dispatched.map((d) => d.jobName) };
  }

  it('dispatches a dynamic job with no approval, after its init round', async () => {
    // The positive control. Same setup minus the approval: the init job runs and
    // the real job follows it to the dispatcher, and no hold is created. Without
    // this, the assertions below would pass for a build that never dispatches
    // anything at all.
    const { create, names } = await run({});
    expect(names).toEqual([INIT_JOB_NAME, 'build']);
    expect(create).not.toHaveBeenCalled();
  });

  it('holds a dynamic job with requireApproval instead of dispatching it', async () => {
    const { create, names } = await run({ jobApproval: APPROVAL });
    // The init job still runs — nothing else can resolve the dynamic env — but
    // the job itself never reaches the dispatcher.
    expect(names).toEqual([INIT_JOB_NAME]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('stores a pending context carrying the values the init round resolved', async () => {
    // The whole reason the flow-back owns this hold. `dispatchReadyJob`
    // dispatches the STORED input verbatim on release, so if the hold were
    // created in the dispatch loop the released job would run with its dynamic
    // env unresolved. Reading the stored context is the only way to see that.
    const create = vi.fn().mockResolvedValue({ id: 'held-dyn-2' });
    const { ctx } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      withDynamicEnv: true,
      jobApproval: APPROVAL,
      pendingInits: makePendingInits({ env: { RESOLVED: 'yes' } }),
      heldRunStore: { createHold: create, create: vi.fn() },
      db: makeDb(),
      executionTracker: makeTracker(vi.fn()),
    });

    await dispatchMatchedWorkflow(ctx);
    await new Promise((r) => setTimeout(r, 50));

    expect(create).toHaveBeenCalledTimes(1);
    const pending = await consumePendingJobContext(undefined, ctx.runId, 'build');
    expect(pending).toBeDefined();
    expect(pending?.jobInput.jobConfig.jobEnv).toEqual({ RESOLVED: 'yes' });
  });

  it('holds every child of a dynamic matrix, not one placeholder', async () => {
    // A static matrix + approval mints one hold PER CHILD, because
    // evaluateJobContexts iterates the expanded jobs. A dynamic matrix has only
    // a placeholder at that point, so its children exist solely after the init
    // round — and the hold has to fan out with them, or approving would resume
    // a single un-expanded job instead of the N the matrix asked for.
    const createHold = vi.fn().mockResolvedValue({ id: 'held-mx' });
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      withDeferredInit: true,
      jobApproval: APPROVAL,
      pendingInits: makePendingInits({
        matrixValues: [{ variant: 'a' }, { variant: 'b' }],
      }),
      heldRunStore: { createHold, create: vi.fn() },
      db: makeDb(),
      executionTracker: makeTracker(vi.fn()),
    });

    await dispatchMatchedWorkflow(ctx);
    await new Promise((r) => setTimeout(r, 50));

    // One hold per combination, and no child reaches the dispatcher.
    expect(createHold).toHaveBeenCalledTimes(2);
    const heldJobIds = createHold.mock.calls.map((c) => (c[1] as { jobId: string }).jobId).sort();
    expect(new Set(heldJobIds).size).toBe(2);
    expect(dispatched.map((d) => d.jobName)).toEqual([INIT_JOB_NAME]);
  });

  it('registers the held job under a synthetic id so the run cannot complete without it', async () => {
    const { addJobsToRun } = await run({ jobApproval: APPROVAL });
    const registered = addJobsToRun.mock.calls.flatMap(
      (c) => c[1] as Array<{ jobName: string; jobId: string }>,
    );
    const build = registered.find((j) => j.jobName === 'build');
    expect(build).toBeDefined();
    // The id is what discriminates, not the name: a DISPATCHED job registers
    // the dispatcher's real job id, while a HELD one registers the
    // `needs-pending-` placeholder that the release path swaps out. Asserting
    // only the name passes whether or not the job was gated, so it would have
    // been satisfied by the ungated dispatch this fix removes.
    expect(build?.jobId.startsWith(NEEDS_PENDING_JOB_ID_PREFIX)).toBe(true);
  });

  it('gates every child of a dynamic matrix against the context concurrency limit', async () => {
    // The wish's defect: `dispatchResolvedDynamicMatrix` expands AFTER the gate
    // ran once for the un-expanded placeholder, and each child inherited the
    // base job's already-decided data via `{ ...baseEnvData }` without being
    // gated again — so all N combinations dispatched against one checked slot.
    // The concurrency gate returns `queue` with `holdType: 'concurrency'`, which
    // is NOT a reviewer hold — so `holdJobForApproval` writes it through
    // `heldRunStore.create`, not `createHold`. Both are stubbed so a hold that
    // took the wrong branch would still show up.
    const create = vi.fn().mockResolvedValue({ id: 'held-conc' });
    const createHold = vi.fn().mockResolvedValue({ id: 'held-conc-approval' });
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      withDeferredInit: true,
      jobContext: 'prod',
      contextConcurrencyLimit: 2,
      pendingInits: makePendingInits({
        matrixValues: [{ variant: 'a' }, { variant: 'b' }, { variant: 'c' }],
      }),
      heldRunStore: { createHold, create },
      db: makeDb(),
      executionTracker: makeTracker(vi.fn()),
    });

    await dispatchMatchedWorkflow(ctx);
    await new Promise((r) => setTimeout(r, 50));

    // Two slots, three combinations: two children dispatch, the third is queued
    // by the concurrency gate and gets its own hold row.
    const childNames = dispatched.map((d) => d.jobName).filter((n) => n !== INIT_JOB_NAME);
    expect(childNames).toHaveLength(2);
    expect(create).toHaveBeenCalledTimes(1);
    expect(createHold).not.toHaveBeenCalled();
    const held = create.mock.calls[0][1] as { jobId: string; holdType: string };
    expect(held.holdType).toBe(HoldType.enum.concurrency);
    // The placeholder must not be what got held — the hold has to name a child.
    expect(held.jobId).not.toBe('build');
    expect(childNames).not.toContain(held.jobId);
  });

  it('does not spend a slot on the dynamic-matrix placeholder', async () => {
    // The placeholder is gated before the agent resolves the combinations and
    // is then REPLACED by its children rather than dispatched. Its reservation
    // has to be released before they are gated, or a fan-out of N children
    // would consume N+1 slots and the last child would be held for nothing.
    const create = vi.fn().mockResolvedValue({ id: 'held-conc-2' });
    const createHold = vi.fn().mockResolvedValue({ id: 'held-conc-2-approval' });
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      withDeferredInit: true,
      jobContext: 'prod',
      contextConcurrencyLimit: 2,
      pendingInits: makePendingInits({
        matrixValues: [{ variant: 'a' }, { variant: 'b' }],
      }),
      heldRunStore: { createHold, create },
      db: makeDb(),
      executionTracker: makeTracker(vi.fn()),
    });

    await dispatchMatchedWorkflow(ctx);
    await new Promise((r) => setTimeout(r, 50));

    const childNames = dispatched.map((d) => d.jobName).filter((n) => n !== INIT_JOB_NAME);
    expect(childNames).toHaveLength(2);
    expect(create).not.toHaveBeenCalled();
    expect(createHold).not.toHaveBeenCalled();
  });
});

describe('dispatchMatchedWorkflow — a STATIC context on a dynamic-field job still applies', () => {
  // `evaluateJobContexts` skips the whole per-job block for any dynamic field,
  // and the flow-back used to delegate only when the job had a DYNAMIC context.
  // So a job binding a perfectly static context and declaring `dynamicEnv`
  // had that context ignored entirely: no gates, no vars, no secrets — because
  // some OTHER field on the job happened to be dynamic.
  //
  // The agent cannot help here: init-runner only emits `contextNames` when
  // `flags.dynamicContext` is set, which is false for a static binding. The
  // orchestrator already has the names in the lock file.
  const prodRow = (over: Record<string, unknown> = {}) => ({
    id: 'env-prod',
    org_id: '__default__',
    name: 'prod',
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
    ...over,
  });

  async function run(rowOver: Record<string, unknown> = {}) {
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      withDynamicEnv: true,
      jobContext: 'prod',
      contextStore: {
        matchContext: async (_o: string, n: string) => (n === 'prod' ? prodRow(rowOver) : null),
      },
      secretResolver: {
        resolveForJob: async () => ({ DEPLOY_TOKEN: 'sekrit' }),
        resolveNamed: async () => null,
        resolveForJobWithMeta: async () => ({}),
      },
      pendingInits: {
        track: vi.fn(async () => ({ env: { RESOLVED: 'yes' } })),
        resolve: vi.fn(),
        reject: vi.fn(),
        has: vi.fn().mockReturnValue(false),
        cleanup: vi.fn(),
      },
      heldRunStore: { createHold: vi.fn(), create: vi.fn() },
      db: makeHoldDbWithTrx(),
      executionTracker: {
        addJobsToRun: vi.fn().mockResolvedValue(undefined),
        onExecutionStarted: vi.fn(),
        onJobStatus: vi.fn(),
        holdRunForPendingJobs: vi.fn().mockReturnValue(true),
        releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
        recordInitFailureRun: vi.fn().mockResolvedValue(undefined),
      },
    });
    await dispatchMatchedWorkflow(ctx);
    await new Promise((r) => setTimeout(r, 50));
    return dispatched;
  }

  it("resolves the static context's secrets for a dynamicEnv job", async () => {
    const dispatched = await run();
    const build = dispatched.find((d) => d.jobName === 'build');
    expect(build).toBeDefined();
    expect(build?.jobConfig.secrets).toMatchObject({ DEPLOY_TOKEN: 'sekrit' });
  });

  it("enforces the static context's gates for a dynamicEnv job", async () => {
    // A disabled context must reject the job. Before this, the gate never ran at
    // all and the job dispatched regardless.
    const dispatched = await run({ enabled: false });
    expect(dispatched.map((d) => d.jobName)).not.toContain('build');
  });
});

describe('applyInitResultContext — the agent-resolved concurrency group is used', () => {
  // `init-runner.ts` evaluates a dynamicConcurrencyGroup and reports it as
  // `initResult.concurrencyGroup`. Nothing read it — the parameter type did not
  // even name the field — so the job was gated under the CONTEXT name instead
  // of its own group, silently sharing a limit with everything bound to it.
  it('gates on the group the init round resolved, not the context name', async () => {
    const matched: string[] = [];
    const { ctx } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      withDynamicContext: true,
      pendingInits: {
        track: vi.fn(async () => ({ contextNames: ['prod'], concurrencyGroup: 'deploy-queue' })),
        resolve: vi.fn(),
        reject: vi.fn(),
        has: vi.fn().mockReturnValue(false),
        cleanup: vi.fn(),
      },
      contextStore: {
        matchContext: async (_o: string, n: string) => {
          matched.push(n);
          return n === 'prod'
            ? {
                id: 'env-prod',
                org_id: '__default__',
                name: 'prod',
                type: 'deployment',
                glob_pattern: null,
                branch_restrictions: null,
                trigger_type_filters: null,
                repo_patterns: null,
                // A limit, so the concurrency gate actually evaluates and the
                // group it counts against matters.
                concurrency_limit: 5,
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
            : null;
        },
      },
      db: makeGroupCapturingDb(),
      executionTracker: {
        addJobsToRun: vi.fn().mockResolvedValue(undefined),
        onExecutionStarted: vi.fn(),
        onJobStatus: vi.fn(),
        holdRunForPendingJobs: vi.fn().mockReturnValue(true),
        releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
        recordInitFailureRun: vi.fn().mockResolvedValue(undefined),
      },
    });

    await dispatchMatchedWorkflow(ctx);
    await new Promise((r) => setTimeout(r, 50));

    // The running-count query is scoped to the concurrency group; it must be the
    // agent-resolved one.
    expect(capturedGroups).toContain('deploy-queue');
    expect(capturedGroups).not.toContain('prod');
  });
});

describe('dispatchMatchedWorkflow — a held job is held on the cluster path too', () => {
  // With a peer connected, `dispatchableJobs` filters out held jobs and nothing
  // else in that branch touched them: no held_runs row, no pending context, no
  // placeholder. The job vanished and the run could report success without it,
  // while the approval it was waiting on never appeared in any queue.
  it('creates the hold and registers the placeholder when peers are connected', async () => {
    const createHold = vi.fn().mockResolvedValue({ id: 'held-cluster-1' });
    const addJobsToRun = vi.fn().mockResolvedValue(undefined);
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      jobApproval: { clauses: [], reason: 'ship it', when: 'always' as const },
      heldRunStore: { createHold, create: vi.fn() },
      db: makeHoldDbWithTrx(),
      executionTracker: {
        addJobsToRun,
        onExecutionStarted: vi.fn(),
        onJobStatus: vi.fn(),
        holdRunForPendingJobs: vi.fn().mockReturnValue(true),
        releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
        recordInitFailureRun: vi.fn().mockResolvedValue(undefined),
      },
    });
    // Put the run on the cluster path.
    (ctx.deps as unknown as Record<string, unknown>).coordinator = {
      hasConnectedPeers: () => true,
      routeJobs: vi.fn().mockResolvedValue({ localJobs: [], remoteJobs: [] }),
    };

    await dispatchMatchedWorkflow(ctx);

    expect(createHold).toHaveBeenCalledTimes(1);
    expect(dispatched.map((d) => d.jobName)).toEqual([]);
    const registered = addJobsToRun.mock.calls.flatMap(
      (c) => c[1] as Array<{ jobName: string; jobId: string }>,
    );
    const build = registered.find((j) => j.jobName === 'build');
    expect(build?.jobId.startsWith(NEEDS_PENDING_JOB_ID_PREFIX)).toBe(true);
  });
});

describe('dispatchMatchedWorkflow — a held dynamic job keeps its context secrets', () => {
  // `applyStaticApprovalHolds` used to run BEFORE the init round, so by the time
  // the flow-back delegated to `applyContextRulesAndSecrets`, `held` was already
  // true and that function's final block — guarded on `!held` — skipped
  // resolving context vars, secrets and registry auth. The values were baked out
  // of the stored jobInput, and `dispatchReadyJob` dispatches it verbatim on
  // release: the approved job ran with none of its context's secrets.
  it('resolves and stores the context secrets for a job held with a dynamic env', async () => {
    const createHold = vi.fn().mockResolvedValue({ id: 'held-sec-1' });
    const { ctx } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      withDynamicEnv: true,
      // A DYNAMIC context: `applyInitResultContext` delegates to
      // `applyContextRulesAndSecrets` only when the job has one, which is the
      // path whose ordering this test pins.
      withDynamicContext: true,
      jobApproval: { clauses: [], reason: 'ship it', when: 'always' as const },
      contextStore: {
        matchContext: async (_o: string, n: string) =>
          n === 'prod'
            ? {
                id: 'env-prod',
                org_id: '__default__',
                name: 'prod',
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
      },
      pendingInits: {
        track: vi.fn(async () => ({ env: { RESOLVED: 'yes' }, contextNames: ['prod'] })),
        resolve: vi.fn(),
        reject: vi.fn(),
        has: vi.fn().mockReturnValue(false),
        cleanup: vi.fn(),
      },
      secretResolver: {
        resolveForJob: async () => ({ DEPLOY_TOKEN: 'sekrit' }),
        resolveNamed: async () => null,
        resolveForJobWithMeta: async () => ({}),
      },
      heldRunStore: { createHold, create: vi.fn() },
      db: makeHoldDbWithTrx(),
      executionTracker: {
        addJobsToRun: vi.fn().mockResolvedValue(undefined),
        onExecutionStarted: vi.fn(),
        onJobStatus: vi.fn(),
        holdRunForPendingJobs: vi.fn().mockReturnValue(true),
        releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
        recordInitFailureRun: vi.fn().mockResolvedValue(undefined),
      },
    });

    await dispatchMatchedWorkflow(ctx);
    await new Promise((r) => setTimeout(r, 50));

    expect(createHold).toHaveBeenCalledTimes(1);
    const pending = await consumePendingJobContext(undefined, ctx.runId, 'build');
    expect(pending).toBeDefined();
    // The init-resolved env survives (it always did)…
    expect(pending?.jobInput.jobConfig.jobEnv).toEqual({ RESOLVED: 'yes' });
    // …and so must the context's secrets, which the release path has no other
    // chance to resolve.
    expect(pending?.jobInput.jobConfig.secrets).toMatchObject({ DEPLOY_TOKEN: 'sekrit' });
  });
});

describe('dispatchMatchedWorkflow — a non-reviewer context hold is resumable', () => {
  // A wait-timer gate sets held=true but NO approvalHold, and holdJobForApproval
  // used to return early on that — so the job was registered nowhere, had no
  // stored dispatch context, and `isRunComplete` could pass without it. The run
  // reported success while a gated job never ran.

  /** Enough Kysely surface for the hold path: the concurrency count, the
   * pending-context upsert, and the transaction the two writes share. */
  function makeHoldDb() {
    const db: Record<string, unknown> = {
      fn: { countAll: () => ({ as: (alias: string) => alias }) },
      selectFrom: () => ({
        select: function (this: unknown) {
          return this;
        },
        where: function (this: unknown) {
          return this;
        },
        innerJoin: function (this: unknown) {
          return this;
        },
        executeTakeFirst: async () => ({ count: 0 }),
      }),
      insertInto: () => ({
        values: () => ({
          onConflict: () => ({ execute: async () => undefined }),
          execute: async () => undefined,
        }),
      }),
      // holdJobForApproval writes the hold row and the pending context in
      // one transaction; the stub hands the same handle back.
      transaction: () => ({
        execute: async (cb: (t: unknown) => Promise<unknown>) => cb(makeTrxHandle()),
      }),
      updateTable: () => ({
        set: function (this: unknown) {
          return this;
        },
        where: function (this: unknown) {
          return this;
        },
        execute: async () => undefined,
        executeTakeFirst: async () => undefined,
      }),
    };
    // The transaction hands the same handle back, which is what lets
    // storePendingJobContext take `trx` with no signature change.
    db.transaction = () => ({ execute: async (cb: (t: unknown) => Promise<unknown>) => cb(db) });
    return db;
  }

  it('registers a wait-held job and stores its pending dispatch context', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'held-wait-1' });
    const addJobsToRun = vi.fn().mockResolvedValue(undefined);
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      jobContext: 'prod',
      contextWaitTimerSeconds: 300,
      heldRunStore: { create, createHold: vi.fn() },
      db: makeHoldDb(),
      secretResolver: {
        resolveForJob: async () => ({}),
        resolveNamed: async () => null,
        resolveForJobWithMeta: async () => ({}),
      },
      executionTracker: {
        addJobsToRun,
        onExecutionStarted: vi.fn(),
        onJobStatus: vi.fn(),
        holdRunForPendingJobs: vi.fn().mockReturnValue(true),
        releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
        // Reached only while the bug is present: with no placeholder pushed,
        // dispatchedJobs is empty and the run takes the init-failure/skip path
        // (dispatch-matched-workflow.ts, the `dispatchedJobs.length === 0`
        // branch). After the fix the placeholder makes that branch unreachable
        // for a held job, and this stub goes unused.
        recordInitFailureRun: vi.fn().mockResolvedValue(undefined),
      },
    });

    await dispatchMatchedWorkflow(ctx);

    // The job never reaches an agent — the gate held it.
    expect(dispatched.map((d) => d.jobName)).toEqual([]);
    // The hold row is created through the non-reviewer path.
    expect(create).toHaveBeenCalledTimes(1);
    // It is registered under the synthetic id, so the run cannot complete.
    const registered = addJobsToRun.mock.calls.flatMap(
      (c) => c[1] as Array<{ jobName: string; jobId: string }>,
    );
    const build = registered.find((j) => j.jobName === 'build');
    expect(build).toBeDefined();
    expect(build?.jobId.startsWith(NEEDS_PENDING_JOB_ID_PREFIX)).toBe(true);
    // And the release path has something to dispatch.
    const pending = await consumePendingJobContext(undefined, ctx.runId, 'build');
    expect(pending?.jobInput.jobName).toBe('build');
  });
});

describe('dispatchMatchedWorkflow — a dynamically-bound context is still gated', () => {
  // `applyContextRulesAndSecrets` — the only caller of `evaluateProtectionRules`
  // on this path — lives inside the per-job block the dynamic-field deferral
  // skips. The flow-back re-implemented only the test-run fail-safe, so a job
  // whose contexts resolve at init time had NO `enabled` check, no branch
  // restriction, no minimum-trust check, no concurrency limit, no
  // required-reviewers hold and no wait timer.
  const INIT_JOB_NAME = '__init__ci__build';

  function makePendingInits(initResult: Record<string, unknown>) {
    return {
      track: vi.fn(async () => initResult),
      resolve: vi.fn(),
      reject: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      cleanup: vi.fn(),
    };
  }

  function makeDb() {
    return {
      // The concurrency gate counts running jobs through `db.fn.countAll`.
      fn: { countAll: () => ({ as: (alias: string) => alias }) },
      selectFrom: () => ({
        select: function (this: unknown) {
          return this;
        },
        where: function (this: unknown) {
          return this;
        },
        innerJoin: function (this: unknown) {
          return this;
        },
        executeTakeFirst: async () => ({ count: 0 }),
      }),
      insertInto: () => ({
        values: () => ({
          onConflict: () => ({ execute: async () => undefined }),
          execute: async () => undefined,
        }),
      }),
      // holdJobForApproval writes the hold row and the pending context in
      // one transaction; the stub hands the same handle back.
      transaction: () => ({
        execute: async (cb: (t: unknown) => Promise<unknown>) => cb(makeTrxHandle()),
      }),
    };
  }

  /** A context row named `prod`, with the given gate-bearing overrides. */
  function contextRow(over: Record<string, unknown>) {
    return {
      id: 'env-prod',
      org_id: '__default__',
      name: 'prod',
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
      ...over,
    };
  }

  async function run(rowOver: Record<string, unknown>) {
    const createHold = vi.fn().mockResolvedValue({ id: 'held-ctx-1' });
    const tracker = {
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      onExecutionStarted: vi.fn(),
      onJobStatus: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn().mockReturnValue(true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
    };
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      withDynamicContext: true,
      pendingInits: makePendingInits({ contextNames: ['prod'] }),
      contextStore: {
        matchContext: async (_org: string, n: string) =>
          n === 'prod' ? contextRow(rowOver) : null,
      },
      heldRunStore: { createHold, create: vi.fn() },
      db: makeDb(),
      executionTracker: tracker,
      secretResolver: {
        resolveForJob: async () => ({}),
        resolveNamed: async () => null,
        resolveForJobWithMeta: async () => ({}),
      },
    });
    await dispatchMatchedWorkflow(ctx);
    await new Promise((r) => setTimeout(r, 50));
    return { createHold, tracker, names: dispatched.map((d) => d.jobName) };
  }

  /** The `(runId, jobId, status, …, data)` call that terminalized a `rejected-*` row. */
  function rejectionStatusCall(tracker: { onJobStatus: ReturnType<typeof vi.fn> }) {
    return tracker.onJobStatus.mock.calls.find(
      (args: unknown[]) =>
        typeof args[1] === 'string' && (args[1] as string).startsWith('rejected-'),
    );
  }

  it('dispatches when the resolved context passes every gate', async () => {
    // The positive control. Without it, a build that dispatches nothing at all
    // would satisfy both assertions below.
    const { createHold, names } = await run({});
    expect(names).toEqual([INIT_JOB_NAME, 'build']);
    expect(createHold).not.toHaveBeenCalled();
  });

  it('rejects the job when the resolved context is disabled', async () => {
    const { names } = await run({ enabled: false });
    expect(names).toEqual([INIT_JOB_NAME]);
  });

  it('holds the job when the resolved context requires reviewers', async () => {
    const { createHold, names } = await run({ required_reviewers: ['@alice'] });
    expect(names).toEqual([INIT_JOB_NAME]);
    expect(createHold).toHaveBeenCalledTimes(1);
  });

  it('rejects the job when the resolved context restricts the branch', async () => {
    // The event is a push to `main`; this context admits only `release/*`.
    const { names } = await run({ branch_restrictions: ['release/*'] });
    expect(names).toEqual([INIT_JOB_NAME]);
  });

  it('records the rejection on the run, naming the context and the rule', async () => {
    // The rejection used to end at a `logger.warn` and a `return`. The static
    // collector cannot cover it — the context is only named by the init round,
    // long after that collector ran — so the flow-back records it here.
    const { tracker } = await run({ branch_restrictions: ['release/*'] });

    const registered = tracker.addJobsToRun.mock.calls.flatMap(
      (c: unknown[]) => c[1] as Array<{ jobName: string; jobId: string; contexts?: string[] }>,
    );
    const rejected = registered.find((j) => j.jobId.startsWith('rejected-'));
    expect(rejected?.jobName).toBe('build');
    // The resolved context travels onto the row, so the run names what gated it.
    expect(rejected?.contexts).toEqual(['prod']);

    const statusCall = rejectionStatusCall(tracker);
    expect(statusCall).toBeDefined();
    const [, , status, , , data] = statusCall as unknown[];
    expect(status).toBe(ExecutionJobStatus.enum.failed);
    expect(data).toMatchObject({
      initFailure: {
        scope: 'job',
        category: InitFailureCategory.enum.context_rules,
        jobName: 'build',
      },
    });
    const message = (data as { initFailure: { message: string } }).initFailure.message;
    expect(message).toContain('prod');
    expect(message).toContain('branch');
    expect((data as { error: string }).error).toBe(message);
  });

  it('registers the rejected job before the pending-jobs token is released', async () => {
    // Without the recorded row this run finished GREEN: `__init__` is itself a
    // tracked job, so the run held one terminal job and the last release
    // finalized it successfully. The ordering is what makes the rejection part
    // of that verdict — a row registered after finalization would attach a
    // non-terminal job to an already-completed run.
    const { tracker } = await run({ enabled: false });

    const statusCall = rejectionStatusCall(tracker);
    expect(statusCall).toBeDefined();
    const terminalizedAt = Math.min(
      ...tracker.onJobStatus.mock.invocationCallOrder.filter(
        (_: number, i: number) =>
          typeof tracker.onJobStatus.mock.calls[i][1] === 'string' &&
          (tracker.onJobStatus.mock.calls[i][1] as string).startsWith('rejected-'),
      ),
    );
    // The run carries two tokens: the dispatch window, released as soon as the
    // synchronous dispatch returns, and this init round, released in the
    // spawned task's `.finally()`. Only the LAST release can drop the count to
    // zero and finalize, so that is the one the row must precede.
    expect(tracker.holdRunForPendingJobs).toHaveBeenCalled();
    const lastRelease = Math.max(...tracker.releasePendingJobsHold.mock.invocationCallOrder);
    expect(terminalizedAt).toBeLessThan(lastRelease);
  });
});

describe('dispatchMatchedWorkflow — a non-global workflow filter', () => {
  const INIT_JOB_NAME = '__init__ci__build';

  /** A pendingInits stub whose init result carries the given filter verdict. */
  function makePendingInits(initResult: Record<string, unknown>) {
    return {
      track: vi.fn(async () => initResult),
      resolve: vi.fn(),
      reject: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      cleanup: vi.fn(),
    };
  }

  async function dispatchWith(initResult: Record<string, unknown>): Promise<string[]> {
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      withFilter: true,
      pendingInits: makePendingInits(initResult),
    });
    await dispatchMatchedWorkflow(ctx);
    // Let the fire-and-forget deferred-init task settle.
    await new Promise((r) => setTimeout(r, 50));
    return dispatched.map((d) => d.jobName);
  }

  it('suppresses dispatch when the init result reports filterPassed:false', async () => {
    const names = await dispatchWith({ filterPassed: false });
    // The init job itself still ran — that is where the verdict came from — but
    // the workflow's own job never reached the dispatcher.
    expect(names).toEqual([INIT_JOB_NAME]);
  });

  it('dispatches the job when the filter passes', async () => {
    // Positive control for the assertion above: the identical setup, differing
    // only in the verdict, does reach the dispatcher.
    const names = await dispatchWith({ filterPassed: true });
    expect(names).toEqual([INIT_JOB_NAME, 'build']);
  });

  it('carries hasFilter on the dynamic eval job so a generator cannot bypass the filter', async () => {
    // A generator-only workflow has no static job to carry the filter, and a
    // mixed one would half-dispatch. The eval job has to gate the generator.
    const pendingDynamics = {
      track: vi.fn(async () => []),
      resolve: vi.fn(),
      reject: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      cleanup: vi.fn(),
    };
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      withDynamicEntry: true,
      withFilter: true,
      pendingDynamics,
    });
    await dispatchMatchedWorkflow(ctx);
    await new Promise((r) => setTimeout(r, 50));

    const evalJob = dispatched.find((d) => d.jobName.startsWith('__dynamic__'));
    expect(evalJob).toBeDefined();
    expect(evalJob!.jobConfig.hasFilter).toBe(true);
  });

  it('omits hasFilter from the dynamic eval job when the workflow declares none', async () => {
    const pendingDynamics = {
      track: vi.fn(async () => []),
      resolve: vi.fn(),
      reject: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      cleanup: vi.fn(),
    };
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      withDynamicEntry: true,
      pendingDynamics,
    });
    await dispatchMatchedWorkflow(ctx);
    await new Promise((r) => setTimeout(r, 50));

    const evalJob = dispatched.find((d) => d.jobName.startsWith('__dynamic__'));
    expect(evalJob).toBeDefined();
    expect('hasFilter' in evalJob!.jobConfig).toBe(false);
  });

  it('ignores a filterPassed:false from an agent when the workflow declares no filter', async () => {
    // Defence against a buggy or rogue agent inventing the field: the verdict is
    // only honoured for a workflow that actually declares a filter.
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      // No withFilter — but the job still defers, via a dynamic matrix.
      withDeferredInit: true,
      pendingInits: makePendingInits({ filterPassed: false, matrixValues: [{ variant: 'a' }] }),
    });
    await dispatchMatchedWorkflow(ctx);
    await new Promise((r) => setTimeout(r, 50));

    expect(dispatched.map((d) => d.jobName)).toContain('build (a)');
  });

  it('dispatches when the agent reports no verdict at all', async () => {
    // An agent that predates the filter sends an init result with no
    // `filterPassed` key. Reading that absence as "suppress" would stop every
    // dispatch such an agent handles, so only an explicit `false` suppresses.
    const names = await dispatchWith({});
    expect(names).toEqual([INIT_JOB_NAME, 'build']);
  });
});

describe('dispatchMatchedWorkflow — testRun run-row stamp', () => {
  it('stamps is_test_run + fixture_id when ctx.testRun is present', async () => {
    const { db, updates } = makeUpdateRecordingDb();
    const executionTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
    };
    const { ctx } = makeSingleJobContext({
      bundle: undefined,
      fullRepo: true,
      db,
      executionTracker,
      testRun: { fixtureId: 'fx-1' },
    });
    await dispatchMatchedWorkflow(ctx);
    await vi.waitFor(() => {
      expect(updates.some((u) => u.is_test_run === true && u.fixture_id === 'fx-1')).toBe(true);
    });
  });

  it('does NOT stamp is_test_run when ctx.testRun is absent (webhook parity)', async () => {
    const { db, updates } = makeUpdateRecordingDb();
    const executionTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
    };
    const { ctx } = makeSingleJobContext({
      bundle: undefined,
      fullRepo: true,
      db,
      executionTracker,
    });
    await dispatchMatchedWorkflow(ctx);
    // Give any fire-and-forget UPDATEs a tick to land.
    await new Promise((r) => setTimeout(r, 10));
    expect(updates.some((u) => 'is_test_run' in u)).toBe(false);
  });

  it('stamps the matched context_id on the run-level UPDATE for an env-bound job', async () => {
    // The History tab keys off context_id, so the run-level write must carry
    // the configured env's id alongside the declared context name. The env
    // store's matchContext returns `id: env-<name>` for the bound name.
    const { db, updates } = makeUpdateRecordingDb();
    const envDb = {
      ...(db as object),
      fn: { countAll: () => ({ as: () => ({}) }) },
      selectFrom: () => ({
        select: () => ({
          where: function (this: unknown) {
            return this;
          },
          innerJoin: function (this: unknown) {
            return this;
          },
          executeTakeFirst: async () => ({ count: 0 }),
        }),
      }),
      insertInto: () => ({
        values: () => ({
          onConflict: () => ({ execute: async () => undefined }),
          execute: async () => undefined,
        }),
      }),
      // holdJobForApproval writes the hold row and the pending context in
      // one transaction; the stub hands the same handle back.
      transaction: () => ({
        execute: async (cb: (t: unknown) => Promise<unknown>) => cb(makeTrxHandle()),
      }),
    };
    const executionTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
    };
    const { ctx } = makeSingleJobContext({
      bundle: undefined,
      fullRepo: true,
      jobContext: 'staging',
      db: envDb,
      executionTracker,
      secretResolver: {
        resolveForJob: async () => ({}),
        resolveNamed: async () => null,
        resolveForJobWithMeta: async () => ({}),
      },
    });
    await dispatchMatchedWorkflow(ctx);
    await vi.waitFor(() => {
      expect(updates.some((u) => u.context === 'staging' && u.context_id === 'env-staging')).toBe(
        true,
      );
    });
  });
});

describe('dispatchMatchedWorkflow — checkMode threading', () => {
  // The run-level check mode (`--check` / `--check --fail-on-drift`) rides on
  // ctx.extraJobConfig.checkMode. It MUST reach onExecutionStarted's trailing
  // checkMode argument so the execution_runs.check_mode column is persisted —
  // otherwise computeRunStatus can never fail a drifted check-fail-on-drift run.
  // onExecutionStarted's signature ends with (..., workflowConcurrency,
  // workflowTimeoutMs, checkMode, localWorkingTree); checkMode is the
  // second-to-last positional arg.
  function lastCallCheckMode(mock: ReturnType<typeof vi.fn>): unknown {
    const call = mock.mock.calls.at(-1);
    // Trailing args: …, checkMode, localWorkingTree, triggerActorUsername,
    // triggerActorUserId, triggeredByAgentLabel, prNumber → checkMode is the
    // 6th from the end.
    return call?.[call.length - 6];
  }

  it('threads ctx.extraJobConfig.checkMode into onExecutionStarted', async () => {
    const onExecutionStarted = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeSingleJobContext({
      bundle: undefined,
      fullRepo: true,
      executionTracker: {
        onExecutionStarted,
        addJobsToRun: vi.fn().mockResolvedValue(undefined),
        holdRunForPendingJobs: vi.fn(() => true),
        releasePendingJobsHold: vi.fn(),
      },
      checkMode: 'check-fail-on-drift',
    });
    await dispatchMatchedWorkflow(ctx);
    expect(onExecutionStarted).toHaveBeenCalled();
    expect(lastCallCheckMode(onExecutionStarted)).toBe('check-fail-on-drift');
  });

  it('passes checkMode undefined for the default apply-mode path', async () => {
    const onExecutionStarted = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeSingleJobContext({
      bundle: undefined,
      fullRepo: true,
      executionTracker: {
        onExecutionStarted,
        addJobsToRun: vi.fn().mockResolvedValue(undefined),
        holdRunForPendingJobs: vi.fn(() => true),
        releasePendingJobsHold: vi.fn(),
      },
    });
    await dispatchMatchedWorkflow(ctx);
    expect(onExecutionStarted).toHaveBeenCalled();
    expect(lastCallCheckMode(onExecutionStarted)).toBeUndefined();
  });
});

describe('partitionGeneratedConfigsByPin', () => {
  function cfg(name: string, pinnedAgentId?: string): GeneratedJobConfig {
    return {
      genJob: { name } as never,
      genJobConfig: {},
      runsOnLabels: pinnedAgentId ? [] : [name],
      runsOnPatterns: [],
      excludeLabels: [],
      excludePatterns: [],
      ...(pinnedAgentId && { pinnedAgentId, connectedInstanceId: null }),
    };
  }

  it('routes pinned configs to the pin path and the rest to label routing', () => {
    const pinned = cfg('migrate-agent-eu-1', 'agent-eu-1');
    const unpinned = cfg('build');
    const { pinnedConfigs, unpinnedConfigs } = partitionGeneratedConfigsByPin([pinned, unpinned]);
    expect(pinnedConfigs).toEqual([pinned]);
    expect(unpinnedConfigs).toEqual([unpinned]);
  });

  it('handles all-pinned and all-unpinned sets', () => {
    expect(partitionGeneratedConfigsByPin([cfg('a', 'a'), cfg('b', 'b')])).toEqual({
      pinnedConfigs: [cfg('a', 'a'), cfg('b', 'b')],
      unpinnedConfigs: [],
    });
    expect(partitionGeneratedConfigsByPin([cfg('a'), cfg('b')])).toEqual({
      pinnedConfigs: [],
      unpinnedConfigs: [cfg('a'), cfg('b')],
    });
  });
});

describe('hostCtxFromMat — per-host secret-resolution context', () => {
  const baseMat = { lockJob: {} } as unknown as MaterializedJob;

  it('prefers mat.agent facts (agentId/host/labels) for a runsOnAll host child', () => {
    const mat = {
      ...baseMat,
      agent: { agentId: 'box-00002', host: 'box-00002.prod', labels: ['role:db'] },
    } as unknown as MaterializedJob;
    expect(hostCtxFromMat(mat)).toEqual({
      agentId: 'box-00002',
      host: 'box-00002.prod',
      labels: ['role:db'],
    });
  });

  it('falls back to pinnedAgentId/host with no labels when agent facts are absent', () => {
    const mat = {
      ...baseMat,
      pinnedAgentId: 'box-00003',
      host: 'box-00003',
    } as unknown as MaterializedJob;
    expect(hostCtxFromMat(mat)).toEqual({ agentId: 'box-00003', host: 'box-00003', labels: [] });
  });

  it('uses the agentId as host when pinnedAgentId is set but host is absent', () => {
    const mat = { ...baseMat, pinnedAgentId: 'box-00004' } as unknown as MaterializedJob;
    expect(hostCtxFromMat(mat)).toEqual({ agentId: 'box-00004', host: 'box-00004', labels: [] });
  });

  it('returns undefined for a non-host child (no fan-out facts → fleet-wide resolution)', () => {
    expect(hostCtxFromMat(baseMat)).toBeUndefined();
  });
});

describe('findInvalidApprovalTimeout', () => {
  const wf = (over: Record<string, unknown>) =>
    ({ name: 'w', jobs: [], ...over }) as unknown as LockWorkflow;

  it('returns null when timeouts are valid or absent', () => {
    expect(findInvalidApprovalTimeout(wf({}))).toBeNull();
    expect(
      findInvalidApprovalTimeout(wf({ approval: { clauses: [], timeoutSeconds: 3600 } })),
    ).toBeNull();
  });

  it('flags an invalid workflow-level timeout', () => {
    expect(
      findInvalidApprovalTimeout(wf({ approval: { clauses: [], timeoutSeconds: 0 } })),
    ).toEqual({ scope: 'workflow', value: 0 });
  });

  it('flags an invalid job-level timeout', () => {
    const job = {
      _type: 'static' as const,
      name: 'deploy',
      steps: [],
      runsOn: [],
      needs: [],
      rules: [],
      approval: { clauses: [], timeoutSeconds: -5 },
    };
    expect(findInvalidApprovalTimeout(wf({ jobs: [job] }))).toEqual({
      scope: 'job',
      jobName: 'deploy',
      value: -5,
    });
  });
});

describe('envelopeEvent', () => {
  it('threads changedFiles + status from eventWithFiles onto the base event', () => {
    const base = { type: 'push', targetBranch: 'main' } as any;
    const withFiles = {
      type: 'push',
      targetBranch: 'main',
      changedFiles: ['src/a.ts', 'README.md'],
      changedFilesStatus: 'fetched',
    } as any;
    const env = envelopeEvent(base, withFiles);
    expect(env.changedFiles).toEqual(['src/a.ts', 'README.md']);
    expect(env.changedFilesStatus).toBe('fetched');
    // base fields preserved
    expect(env.type).toBe('push');
    expect(env.targetBranch).toBe('main');
  });

  it('carries an unavailable status through unchanged', () => {
    const base = { type: 'schedule' } as any;
    const withFiles = { type: 'schedule', changedFilesStatus: 'unavailable' } as any;
    const env = envelopeEvent(base, withFiles);
    expect(env.changedFilesStatus).toBe('unavailable');
    expect(env.changedFiles).toBeUndefined();
  });
});

/** A minimal Kysely stub returning seeded rows per table for gatherInvokeResults. */
function invokeResultsDb(rows: {
  proxies: Array<{
    base_job_name: string | null;
    summoned_run_id: string | null;
    status: string | null;
    outputs: string | null;
  }>;
  runs: Array<{ run_id: string; repo_identifier: string; workflow_name: string }>;
}): Kysely<Database> {
  const builder = (table: string) => {
    const chain = {
      select: () => chain,
      where: () => chain,
      orderBy: () => chain,
      execute: async () => (table === 'execution_jobs' ? rows.proxies : rows.runs),
    };
    return chain;
  };
  return { selectFrom: (t: string) => builder(t) } as unknown as Kysely<Database>;
}

describe('gatherInvokeResults', () => {
  it('maps proxy children to InvokeResult[] keyed by gate name, with repo/workflow/outputs', async () => {
    const db = invokeResultsDb({
      proxies: [
        {
          base_job_name: 'repo-tests',
          summoned_run_id: 'r1',
          status: 'success',
          outputs: JSON.stringify({ coverage: '92' }),
        },
        { base_job_name: 'repo-tests', summoned_run_id: 'r2', status: 'failed', outputs: null },
      ],
      runs: [
        { run_id: 'r1', repo_identifier: 'myorg/backend', workflow_name: 'unit' },
        { run_id: 'r2', repo_identifier: 'myorg/backend', workflow_name: 'lint' },
      ],
    });
    const res = await gatherInvokeResults(db, 'gate-run', ['repo-tests']);
    expect(Object.keys(res)).toEqual(['repo-tests']);
    expect(res['repo-tests'].map((e) => e.runId)).toEqual(['r1', 'r2']);
    expect(res['repo-tests'].map((e) => e.repo)).toEqual(['myorg/backend', 'myorg/backend']);
    expect(res['repo-tests'].map((e) => e.workflow)).toEqual(['unit', 'lint']);
    expect(res['repo-tests'].map((e) => e.status)).toEqual(['success', 'failed']);
    expect(res['repo-tests'][0].outputs.coverage).toBe('92');
    expect(res['repo-tests'][1].outputs).toEqual({});
  });

  it('returns an empty map when no gate names are declared (no DB read)', async () => {
    const db = invokeResultsDb({ proxies: [], runs: [] });
    expect(await gatherInvokeResults(db, 'run', [])).toEqual({});
  });

  it('returns an empty map when a declared need has no proxy children', async () => {
    const db = invokeResultsDb({ proxies: [], runs: [] });
    expect(await gatherInvokeResults(db, 'run', ['not-a-gate'])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Internal-trigger context fields
// ---------------------------------------------------------------------------

/**
 * A Kysely stand-in that RECORDS what the real `ExecutionTracker` writes.
 *
 * These cases run the production tracker rather than a `vi.fn()` stub on
 * purpose: all three fields fail silently when unthreaded, and asserting that
 * `onExecutionStarted` was called with a value would pass just as happily
 * against a recorder that dropped it on the floor. Capturing the row payload
 * the tracker actually builds closes that gap.
 */
function makeRecordingRunDb() {
  const runInserts: Array<Record<string, unknown>> = [];
  const runUpdates: Array<{ set: Record<string, unknown>; runId: string | undefined }> = [];
  // Ordered log of everything that touched `execution_runs`, so a test can
  // assert WHEN the chain-depth write landed and not merely that it did.
  const ops: RunRowOp[] = [];

  const db: Record<string, unknown> = {
    fn: { countAll: () => ({ as: (alias: string) => alias }) },
    selectFrom: () => {
      const q: Record<string, unknown> = {
        select: () => q,
        where: () => q,
        innerJoin: () => q,
        orderBy: () => q,
        limit: () => q,
        executeTakeFirst: async () => undefined,
        execute: async () => [],
      };
      return q;
    },
    insertInto: (table: string) => ({
      values: (v: Record<string, unknown>) => {
        if (table === 'execution_runs') {
          runInserts.push(v);
          ops.push('insert');
          // A pre-dispatch site carries the depth ON the insert (it writes the
          // row and returns), so the ordering assertions see one op kind
          // whichever path put the value there.
          if ('chain_depth' in v) ops.push('chain-depth-write');
        }
        return {
          onConflict: () => ({
            execute: async () => undefined,
            // `recordInitFailureRun` reads the write back through
            // `guardedWriteApplied` and suppresses its forward when nothing
            // landed, so the stub has to report that the row DID land.
            executeTakeFirst: async () => ({ numInsertedOrUpdatedRows: 1n }),
          }),
          execute: async () => undefined,
        };
      },
    }),
    updateTable: (table: string) => {
      let captured: Record<string, unknown> | undefined;
      let runId: string | undefined;
      const q: Record<string, unknown> = {
        set: (v: Record<string, unknown>) => {
          captured = v;
          return q;
        },
        where: (col: string, _op: unknown, val: unknown) => {
          if (col === 'run_id' && typeof val === 'string') runId = val;
          return q;
        },
        execute: async () => {
          if (table === 'execution_runs' && captured) {
            runUpdates.push({ set: captured, runId });
            ops.push('chain_depth' in captured ? 'chain-depth-write' : 'update');
          }
          return [];
        },
        executeTakeFirst: async () => {
          if (table === 'execution_runs' && captured) {
            runUpdates.push({ set: captured, runId });
            ops.push('chain_depth' in captured ? 'chain-depth-write' : 'update');
          }
          return undefined;
        },
      };
      return q;
    },
    deleteFrom: () => {
      const q: Record<string, unknown> = {
        where: () => q,
        execute: async () => [],
      };
      return q;
    },
  };
  db.transaction = () => ({ execute: async (cb: (t: unknown) => Promise<unknown>) => cb(db) });
  return { db, runInserts, runUpdates, ops };
}

/** One recorded touch of the `execution_runs` table, in order. */
type RunRowOp = 'insert' | 'update' | 'chain-depth-write' | 'gate-read';

/**
 * The run row as it stands after a dispatch: the INSERT payload with every
 * subsequent UPDATE merged onto it — i.e. exactly what a later reader of
 * `execution_runs` would see.
 */
function settledRunRow(
  runInserts: Array<Record<string, unknown>>,
  runUpdates: Array<{ set: Record<string, unknown>; runId: string | undefined }>,
  runId: string,
): Record<string, unknown> {
  const row = { ...(runInserts.find((r) => r.run_id === runId) ?? {}) };
  for (const u of runUpdates) {
    if (u.runId === undefined || u.runId === runId) Object.assign(row, u.set);
  }
  return row;
}

/**
 * A Kysely stand-in that serves `releaseInvokeGate` the run row a dispatch
 * actually wrote, appending its read to the SAME ordered op log — so the gate's
 * chain-depth read can be placed relative to the dispatch's chain-depth write.
 */
function makeGateReadDb(row: Record<string, unknown>, ops: RunRowOp[]): unknown {
  return {
    selectFrom: (table: string) => {
      const q: Record<string, unknown> = {
        select: () => q,
        where: () => q,
        executeTakeFirst: async () => {
          if (table !== 'execution_runs') return undefined;
          ops.push('gate-read');
          return { repo_identifier: row.repo_identifier, chain_depth: row.chain_depth ?? 0 };
        },
      };
      return q;
    },
    updateTable: () => {
      const q: Record<string, unknown> = {
        set: () => q,
        where: () => q,
        execute: async () => [],
      };
      return q;
    },
  };
}

/**
 * Dispatch a single-job workflow through the REAL `ExecutionTracker`, returning
 * everything it wrote plus the run contexts it forwarded.
 */
async function dispatchWithRealTracker(
  over: Partial<
    Pick<
      WorkflowDispatchContext,
      | 'triggerEventOverride'
      | 'chainDepth'
      | 'dispatchedByFailureLifecycle'
      | 'securityDecision'
      | 'runId'
    >
  >,
  /**
   * Harness knobs that shape the WORKFLOW rather than the context — used to
   * drive the install-gate hold, which needs a workflow that declares
   * `installEnv:` plus a context whose protection rules return `wait`.
   */
  harness: {
    installEnv?: string[];
    jobContext?: string;
    contextWaitTimerSeconds?: number;
  } = {},
) {
  const { db, runInserts, runUpdates, ops } = makeRecordingRunDb();
  const forwarded: Array<Record<string, unknown>> = [];
  const tracker = new ExecutionTracker({
    db: db as unknown as Kysely<Database>,
    onExecutionStatusChange: (_runId, _status, context) => {
      forwarded.push(context as unknown as Record<string, unknown>);
    },
  });
  const { ctx } = makeSingleJobContext({
    bundle: undefined,
    db,
    executionTracker: tracker,
    ...(harness.jobContext && { jobContext: harness.jobContext }),
    ...(harness.contextWaitTimerSeconds !== undefined && {
      contextWaitTimerSeconds: harness.contextWaitTimerSeconds,
    }),
    ...(harness.installEnv && { secretResolver: { resolve: async () => null } }),
  });
  if (harness.installEnv) {
    // The lock file holds the same workflow object, so one assignment is seen
    // by both `ctx.workflow` and `ctx.fullLockFile.workflows[0]`.
    (ctx.workflow as { installEnv?: readonly string[] }).installEnv = harness.installEnv;
  }
  Object.assign(ctx, over);

  await dispatchMatchedWorkflow(ctx);

  return { ctx, runInserts, runUpdates, forwarded, ops };
}

describe('dispatchMatchedWorkflow — internal-trigger context fields', () => {
  it('records triggerEventOverride verbatim instead of deriving from the event', async () => {
    const { forwarded } = await dispatchWithRealTracker({
      triggerEventOverride: 'kici.scaler.scale-up',
    });

    expect(forwarded.length).toBeGreaterThan(0);
    expect(forwarded[0].triggerEvent).toBe('kici.scaler.scale-up');
  });

  it('falls back to the derived trigger event when no override is given', async () => {
    // The harness event is a plain `push`, exactly as the webhook path produces.
    const { forwarded } = await dispatchWithRealTracker({});

    expect(forwarded.length).toBeGreaterThan(0);
    expect(forwarded[0].triggerEvent).toBe('push');
  });

  it('merges dispatchedByFailureLifecycle into trigger_decision without replacing it', async () => {
    const { runInserts } = await dispatchWithRealTracker({ dispatchedByFailureLifecycle: true });

    expect(runInserts.length).toBeGreaterThan(0);
    const decision = JSON.parse(String(runInserts[0].trigger_decision)) as Record<string, unknown>;
    // The flag `EventRouter.isFailureLifecycleRun` reads back...
    expect(decision.dispatchedByFailureLifecycle).toBe(true);
    // ...alongside everything the decision summary already carried. A replace
    // rather than a merge would silently drop the match provenance.
    expect(decision.matched).toBe(true);
    expect(decision.workflowName).toBe('ci');
  });

  it('omits dispatchedByFailureLifecycle entirely when the dispatch is not one', async () => {
    const { runInserts } = await dispatchWithRealTracker({});

    const decision = JSON.parse(String(runInserts[0].trigger_decision)) as Record<string, unknown>;
    expect('dispatchedByFailureLifecycle' in decision).toBe(false);
  });

  it('stamps chainDepth on the run row so the chain-depth breaker can read it back', async () => {
    const { ctx, runUpdates } = await dispatchWithRealTracker({ chainDepth: 3 });

    const stamped = runUpdates.filter((u) => 'chain_depth' in u.set);
    expect(stamped.length).toBeGreaterThan(0);
    expect(stamped[0].set.chain_depth).toBe(3);
    expect(stamped[0].runId).toBe(ctx.runId);
  });

  it('writes no chain_depth at all for a run that starts its own chain', async () => {
    const { runUpdates } = await dispatchWithRealTracker({});

    expect(runUpdates.filter((u) => 'chain_depth' in u.set)).toHaveLength(0);
  });

  it.each([
    ['an empty', ''],
    ['a whitespace-only', '   '],
  ])('treats %s override as unstated and falls back to the derived event', async (_label, ov) => {
    // A blank string is not a stated value. `??` alone would let it through,
    // and the run's only answer to "what fired this?" would render as nothing.
    const { forwarded } = await dispatchWithRealTracker({ triggerEventOverride: ov });

    expect(forwarded.length).toBeGreaterThan(0);
    expect(forwarded[0].triggerEvent).toBe('push');
  });
});

// ---------------------------------------------------------------------------
// Pre-dispatch recording sites (hold / init failure)
// ---------------------------------------------------------------------------

describe('dispatchMatchedWorkflow — a run recorded before dispatch keeps its chain depth', () => {
  // These four sites (install-gate hold, trust-policy hold, trust-policy
  // reject, init-failure skip) write their `execution_runs` row and RETURN, so
  // no later dispatch step stamps anything for them. A hold is resumable, so a
  // summoned run held here goes on to fire its own invoke gate — and a lost
  // depth reads as `0`, i.e. "starts a chain", so the circuit breaker fails
  // OPEN. Asserting the row payload (not a mock call) is the point: a recorder
  // that dropped the field would satisfy a call assertion just as happily.

  it('stamps the depth on the row a trust-policy HOLD inserts', async () => {
    const { ctx, runInserts } = await dispatchWithRealTracker({
      chainDepth: 3,
      securityDecision: holdDecision(SecurityHoldReason.enum.workflow_modification),
    });

    const held = runInserts.find((r) => r.run_id === ctx.runId);
    expect(held?.status).toBe('held');
    expect(held?.chain_depth).toBe(3);
  });

  it('stamps the depth on the row the INSTALL GATE hold inserts', async () => {
    // The requirement's own worked example: a summoned run held by the install
    // gate. This site is reached through a different branch from the
    // trust-policy hold (`resolveWorkflowInstallSecrets` → `held`), so covering
    // one says nothing about the other.
    const { ctx, runInserts } = await dispatchWithRealTracker(
      { chainDepth: 4 },
      { installEnv: ['prod:NPM_TOKEN'], jobContext: 'prod', contextWaitTimerSeconds: 600 },
    );

    const held = runInserts.find((r) => r.run_id === ctx.runId);
    expect(held?.status).toBe('held');
    expect(held?.context).toBe('prod');
    expect(held?.chain_depth).toBe(4);
  });

  it('stamps the depth on the row a build failure BEFORE tracking inserts', async () => {
    // The fifth site. Its row is terminal with no resume path, so no gate ever
    // reads this depth back — it is stamped because the row is the run's only
    // record, and one saying 0 claims to have started the chain it died inside.
    // Reached only when the build throws before the run was registered, which
    // is why `ensureBuild` never calls its closure here.
    const { db, runInserts } = makeRecordingRunDb();
    const tracker = new ExecutionTracker({ db: db as unknown as Kysely<Database> });
    const { ctx } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      withBuildMiss: true,
      db,
      executionTracker: tracker,
    });
    (ctx.deps as { buildCoordinator: unknown }).buildCoordinator = {
      ensureBuild: async () => {
        throw new Error('build coordinator timed out');
      },
    };
    ctx.chainDepth = 6;
    ctx.dispatchedByFailureLifecycle = true;

    await dispatchMatchedWorkflow(ctx);

    const row = runInserts.find((r) => r.run_id === ctx.runId);
    expect(row?.status).toBe('failed');
    expect(row?.chain_depth).toBe(6);
    const parsed = JSON.parse(String(row?.trigger_decision)) as Record<string, unknown>;
    expect(parsed.dispatchedByFailureLifecycle).toBe(true);
  });

  it('stamps the depth on the row a trust-policy REJECT inserts', async () => {
    const { ctx, runInserts } = await dispatchWithRealTracker({
      chainDepth: 5,
      securityDecision: rejectDecision(SecurityHoldReason.enum.fork_pr),
    });

    const failed = runInserts.find((r) => r.run_id === ctx.runId);
    expect(failed?.status).toBe('failed');
    expect(failed?.chain_depth).toBe(5);
  });

  it('writes no chain_depth on a held row for a run that starts its own chain', async () => {
    const { ctx, runInserts } = await dispatchWithRealTracker({
      securityDecision: holdDecision(SecurityHoldReason.enum.workflow_modification),
    });

    const held = runInserts.find((r) => r.run_id === ctx.runId);
    expect(held).toBeDefined();
    expect('chain_depth' in held!).toBe(false);
  });

  it.each([
    ['hold', () => holdDecision(SecurityHoldReason.enum.workflow_modification)],
    ['reject', () => rejectDecision(SecurityHoldReason.enum.fork_pr)],
  ])('records the failure-lifecycle marker on the row a %s inserts', async (_label, decision) => {
    // The HELD case is the load-bearing one: the run resumes onto this same
    // row, completes, and its completion is what a `workflows_failed_batch`
    // accumulator would otherwise fold back into the batch that spawned it.
    // The reject case records it for consistency — that path emits no
    // completion event today.
    const { ctx, runInserts } = await dispatchWithRealTracker({
      dispatchedByFailureLifecycle: true,
      securityDecision: decision() as unknown as TrustPolicyOutcome,
    });

    const row = runInserts.find((r) => r.run_id === ctx.runId);
    const parsed = JSON.parse(String(row?.trigger_decision)) as Record<string, unknown>;
    expect(parsed.dispatchedByFailureLifecycle).toBe(true);
  });

  it('leaves trigger_decision null on a plain pre-dispatch row', async () => {
    const { ctx, runInserts } = await dispatchWithRealTracker({
      securityDecision: holdDecision(SecurityHoldReason.enum.workflow_modification),
    });

    const held = runInserts.find((r) => r.run_id === ctx.runId);
    expect(held?.trigger_decision).toBeNull();
  });
});

describe('dispatchMatchedWorkflow — the chain-depth stamp precedes the gate that reads it', () => {
  /** A `releaseInvokeGate` tracker stand-in — it only has to not get in the way. */
  function gateTrackerStub() {
    return {
      findSyntheticJobId: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as ExecutionTracker;
  }

  it('a gate released after a HELD dispatch reads the stamped depth and refuses to summon', async () => {
    // The end-to-end statement of the invariant, as ONE chain: the run is held
    // (so the depth arrives on the pre-dispatch INSERT, not via
    // `stampChainDepth`'s update), the row is settled exactly as a reader would
    // see it, and the real breaker reads it back. That is the requirement's own
    // worked example — a summoned run held by a gate, released, firing its own
    // gate. Lose the write and the breaker reads 0, summons, and the recursion
    // is unbounded — so this fails LOUDLY (summon called) rather than
    // vacuously.
    const { ctx, runInserts, runUpdates, ops } = await dispatchWithRealTracker({
      chainDepth: 3,
      securityDecision: holdDecision(SecurityHoldReason.enum.workflow_modification),
    });

    const row = settledRunRow(runInserts, runUpdates, ctx.runId);
    expect(row.status).toBe('held');
    expect(row.chain_depth).toBe(3);

    const summon = vi.fn().mockResolvedValue([]);
    const onJobStatus = vi.fn().mockResolvedValue(undefined);
    const gateDb = makeGateReadDb(row, ops);

    await releaseInvokeGate(
      {
        db: gateDb as unknown as Kysely<Database>,
        executionTracker: gateTrackerStub(),
        invokeGateDeps: {
          db: gateDb as unknown as Kysely<Database>,
          executionTracker: {
            addJobsToRun: vi.fn().mockResolvedValue(undefined),
            onJobStatus,
            reconcileSummonedRunIfTerminal: vi.fn().mockResolvedValue(undefined),
          },
          summon,
          maxChainDepth: 3,
        },
      },
      ctx.runId,
      'gate',
      { event: 'deploy', optional: false },
    );

    // The breaker read depth 3 against a bound of 3 and stopped.
    expect(summon).not.toHaveBeenCalled();
    expect(onJobStatus).toHaveBeenCalledTimes(1);
    expect(String(onJobStatus.mock.calls[0][5]?.error)).toContain('chain depth 3');

    // …and the write it read was already on the row before it looked.
    const write = ops.indexOf('chain-depth-write');
    const read = ops.indexOf('gate-read');
    expect(write).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(write);
  });

  it('stamps the depth immediately after the row exists, before anything reads it back', async () => {
    // The ordering half the case above cannot see: `stampChainDepth` is called
    // per recording site, NOT once at the end of dispatch. A refactor that
    // deferred it would still satisfy "write before the later gate read" while
    // leaving every in-dispatch reader looking at 0.
    const { ops } = await dispatchWithRealTracker({ chainDepth: 4 });

    const insert = ops.indexOf('insert');
    const write = ops.indexOf('chain-depth-write');
    expect(insert).toBeGreaterThanOrEqual(0);
    expect(write).toBe(insert + 1);
  });
});

describe('a fork-PR hold, held and released end to end', () => {
  /**
   * The seam the other fork-hold cases each cover one side of: they assert what
   * the hold STORES and what the resume PASSES to a mocked dispatch. This joins
   * them with the real `dispatchMatchedWorkflow` on both ends, so "approving a
   * fork PR runs the workflow" is asserted rather than inferred from two halves.
   */
  it('dispatches the workflow on approval, still under the untrusted tier', async () => {
    clearPendingWorkflowContextsMap();
    const create = vi.fn().mockResolvedValue({ id: 'held-fork-e2e' });
    const resumeHeldRun = vi.fn().mockResolvedValue(undefined);
    const setRunTrustContext = vi.fn();
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: undefined,
      heldRunStore: { create },
      executionTracker: {
        recordRunHeld: vi.fn().mockResolvedValue(undefined),
        resumeHeldRun,
        onExecutionStarted: vi.fn().mockResolvedValue(undefined),
        addJobsToRun: vi.fn().mockResolvedValue(undefined),
        onJobStatus: vi.fn().mockResolvedValue(undefined),
        holdRunForPendingJobs: vi.fn(() => true),
        releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
        setRunTrustContext,
      },
    });
    ctx.securityDecision = holdDecision(SecurityHoldReason.enum.fork_pr);
    ctx.trustResolution = {
      tier: 'unknown',
      contributorUsername: 'octocat',
    } as unknown as WorkflowDispatchContext['trustResolution'];
    ctx.lockFileSource = 'base';

    // 1. The policy holds. Nothing dispatches — this is the state the bug left
    //    the run in permanently.
    const heldResult = await dispatchMatchedWorkflow(ctx);
    expect(heldResult.held).toBe(true);
    expect(dispatched).toHaveLength(0);

    // 2. Force the JSON round trip the in-memory Map skips. A hold routinely
    //    outlives the process that wrote it, so in production the context
    //    reaches the resume as a `pending_workflow_contexts` row — round-trip
    //    it here so the assertions below cannot pass on shared object identity.
    const stored = await loadPendingWorkflowContext(undefined, ctx.runId);
    expect(stored).not.toBeNull();
    await storePendingWorkflowContext(undefined, JSON.parse(JSON.stringify(stored)));

    // 3. `/kici approve` releases the hold. The real resume rebuilds the
    //    context and re-enters the real dispatch.
    (ctx.deps as unknown as Record<string, unknown>).providerRegistry = {
      getByRoutingKey: () => ({ normalizer: { provider: 'local' } }),
    };
    await resumeWorkflow(
      {
        holdId: 'held-fork-e2e',
        runId: ctx.runId,
        jobId: SECURITY_HOLD_JOB_IDS.fork_pr,
        scope: HoldScope.enum.workflow,
        stepIndex: null,
        triggerSource: TriggerSource.enum.context,
      },
      ctx.deps,
      undefined,
    );

    // The gated work RAN: a job reached the dispatcher, and the held run row was
    // flipped back off `held` on the way.
    expect(dispatched.length).toBeGreaterThan(0);
    expect(dispatched[0].jobName).toBe('build');
    expect(resumeHeldRun).toHaveBeenCalledWith(ctx.runId);

    // …and it ran UNTRUSTED. Approval means "let it run", never "make it
    // trusted": the replay short-circuits the trust gate rather than
    // re-resolving it, so the tier stamped on the run is the one the hold
    // stored, and no second hold was created.
    expect(setRunTrustContext).toHaveBeenCalledWith(ctx.runId, 'unknown', 'base');
    expect(create).toHaveBeenCalledTimes(1);

    // The context is consumed, so a re-fired release is inert rather than a
    // second dispatch.
    expect(await loadPendingWorkflowContext(undefined, ctx.runId)).toBeNull();
  });
});

describe('dispatchMatchedWorkflow — the run trust posture reaches its call sites', () => {
  /**
   * The tier is `known`, deliberately. It is legacy vocabulary
   * `resolveRefTrust` no longer produces, so no call site would ever hardcode
   * it — a summary that prints it can only have read the run's real
   * `trustResolution.tier`. `unknown` would pass just as well against a
   * literal, which is exactly the gap these two cases close.
   */
  const LEGACY_UNTRUSTED_TIER = 'known';

  it('threads the real tier into the security-hold summary and carries the posture note', async () => {
    // A trust-policy hold stores a resume context, so `/kici approve` replays
    // the dispatch under this same trust resolution. The check must therefore
    // describe the posture the resumed run really executes under.
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeSingleJobContext({
      bundle: {
        normalizer: { provider: 'github' },
        checkStatusPoster: { provider: 'github', postCheckStatus },
      } as unknown as WorkflowDispatchContext['bundle'],
    });
    ctx.securityDecision = holdDecision(SecurityHoldReason.enum.fork_pr);
    ctx.trustResolution = {
      tier: LEGACY_UNTRUSTED_TIER,
      contributorUsername: 'octocat',
    } as unknown as WorkflowDispatchContext['trustResolution'];
    ctx.lockFileSource = 'base';
    (ctx.deps as unknown as Record<string, unknown>).heldRunStore = {
      create: vi.fn().mockResolvedValue({ id: 'held-1' }),
    };
    (ctx.deps as unknown as Record<string, unknown>).executionTracker = {
      recordRunHeld: vi.fn().mockResolvedValue(undefined),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
    };

    await dispatchMatchedWorkflow(ctx);

    const holdCall = postCheckStatus.mock.calls.find(
      (c) => c[2] === 'pending' && c[3] === 'Held for approval',
    );
    expect(holdCall).toBeDefined();
    expect(String(holdCall![4])).toContain(`(tier: ${LEGACY_UNTRUSTED_TIER})`);
    expect(String(holdCall![4])).toContain(REDUCED_PRIVILEGE_MARKER);
    // `lockFileSource` is 'base' above, so the note's base-branch clause is the
    // half that can only come from the run's own recorded source.
    expect(String(holdCall![4])).toContain('read from the base branch');
  });

  it('leaves the posture note off the trust-policy rejection check', async () => {
    // The control for the case above: identical tier and lock source, opposite
    // verdict. A rejected run is never dispatched, so a note there would promise
    // reductions for a run that does not happen — and its absence proves the
    // hold's note comes from that call site rather than from every check.
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeSingleJobContext({
      bundle: {
        normalizer: { provider: 'github' },
        checkStatusPoster: { provider: 'github', postCheckStatus },
      } as unknown as WorkflowDispatchContext['bundle'],
    });
    ctx.securityDecision = rejectDecision(SecurityHoldReason.enum.fork_pr);
    ctx.trustResolution = {
      tier: LEGACY_UNTRUSTED_TIER,
      contributorUsername: 'octocat',
    } as unknown as WorkflowDispatchContext['trustResolution'];
    ctx.lockFileSource = 'base';
    (ctx.deps as unknown as Record<string, unknown>).executionTracker = {
      recordInitFailureRun: vi.fn().mockResolvedValue(undefined),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
    };

    await dispatchMatchedWorkflow(ctx);

    const rejectCall = postCheckStatus.mock.calls.find((c) => c[2] === 'failure');
    expect(rejectCall).toBeDefined();
    expect(String(rejectCall![4])).toContain(`(tier: ${LEGACY_UNTRUSTED_TIER})`);
    expect(String(rejectCall![4])).not.toContain(REDUCED_PRIVILEGE_MARKER);
  });

  it('stamps the real tier and lock-file source onto the tracked run', async () => {
    // The in-memory mirror of the two `execution_runs` columns this same site
    // writes. Without it a job's completion check has no posture to name.
    const setRunTrustContext = vi.fn();
    const { ctx } = makeSingleJobContext({
      bundle: undefined,
      executionTracker: {
        onExecutionStarted: vi.fn().mockResolvedValue(undefined),
        addJobsToRun: vi.fn().mockResolvedValue(undefined),
        onJobStatus: vi.fn().mockResolvedValue(undefined),
        holdRunForPendingJobs: vi.fn(() => true),
        releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
        setRunTrustContext,
      },
    });
    ctx.trustResolution = {
      tier: LEGACY_UNTRUSTED_TIER,
      contributorUsername: 'octocat',
    } as unknown as WorkflowDispatchContext['trustResolution'];
    ctx.lockFileSource = 'base';

    await dispatchMatchedWorkflow(ctx);

    expect(setRunTrustContext).toHaveBeenCalledWith(ctx.runId, LEGACY_UNTRUSTED_TIER, 'base');
  });

  it('still records the rest of the run when the stamp cannot be applied', async () => {
    // Every post-start write in `recordRunStart` is best-effort — the two DB
    // updates beside the stamp each carry their own `.catch()`. A tracker
    // without the method must therefore cost only the note, not the trust
    // columns, the test-run stamp, or the dispatch itself.
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: undefined,
      executionTracker: {
        onExecutionStarted: vi.fn().mockResolvedValue(undefined),
        addJobsToRun: vi.fn().mockResolvedValue(undefined),
        onJobStatus: vi.fn().mockResolvedValue(undefined),
        holdRunForPendingJobs: vi.fn(() => true),
        releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
        // no setRunTrustContext
      },
    });
    ctx.trustResolution = {
      tier: LEGACY_UNTRUSTED_TIER,
      contributorUsername: 'octocat',
    } as unknown as WorkflowDispatchContext['trustResolution'];
    ctx.lockFileSource = 'base';

    const result = await dispatchMatchedWorkflow(ctx);

    expect(result.dispatchedJobCount).toBe(1);
    expect(dispatched.map((d) => d.jobName)).toEqual(['build']);
  });

  /** The trust posture a fork ref carries, plus the base lock it was read against. */
  function untrustedFork(ctx: WorkflowDispatchContext): void {
    ctx.trustResolution = {
      tier: 'unknown',
      contributorUsername: 'octocat',
    } as unknown as WorkflowDispatchContext['trustResolution'];
    ctx.lockFileSource = 'base';
  }

  /** The pending 'Held for approval' summary, or undefined if none was posted. */
  function heldSummary(postCheckStatus: ReturnType<typeof vi.fn>): string | undefined {
    const call = postCheckStatus.mock.calls.find(
      (c) => c[2] === 'pending' && c[3] === 'Held for approval',
    );
    return call ? String(call[4]) : undefined;
  }

  /**
   * A context whose `minimum_trust` no untrusted fork can satisfy, so the
   * per-env gate raises a security-typed job hold.
   */
  function minimumTrustContextStore(): unknown {
    return {
      matchContext: async (_org: string, n: string) =>
        n === 'staging'
          ? {
              id: 'env-staging',
              org_id: '__default__',
              name: 'staging',
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
              minimum_trust: 'trusted',
              allow_local_execution: true,
              enabled: true,
              created_at: new Date(),
              updated_at: new Date(),
              created_by: null,
            }
          : null,
    };
  }

  /**
   * The store + database + tracker a hold needs to actually persist. Without
   * all three `holdJobForApproval` returns before writing anything, which is
   * exactly the case the check post must not fire in.
   */
  function holdPersistenceStubs(): {
    heldRunStore: unknown;
    db: unknown;
    executionTracker: unknown;
  } {
    const trxHandle = {
      insertInto: () => ({
        values: () => ({
          onConflict: () => ({ execute: async () => undefined }),
          execute: async () => undefined,
        }),
      }),
    };
    return {
      heldRunStore: {
        // Distinct ids: a job carrying both an approval hold and a
        // non-approval one writes BOTH rows, and the two are told apart here.
        createHold: vi.fn().mockResolvedValue({ id: 'held-approval' }),
        create: vi.fn().mockResolvedValue({ id: 'held-nonapproval' }),
        markPendingCheckPosted: vi.fn().mockResolvedValue(undefined),
      },
      db: {
        fn: { countAll: () => ({ as: (alias: string) => alias }) },
        selectFrom: () => ({
          select: function (this: unknown) {
            return this;
          },
          where: function (this: unknown) {
            return this;
          },
          innerJoin: function (this: unknown) {
            return this;
          },
          executeTakeFirst: async () => undefined,
        }),
        insertInto: trxHandle.insertInto,
        updateTable: () => ({
          set: () => ({
            where: function (this: unknown) {
              return this;
            },
            execute: async () => [],
          }),
        }),
        transaction: () => ({
          execute: async (cb: (t: unknown) => Promise<unknown>) => cb(trxHandle),
        }),
      },
      executionTracker: {
        addJobsToRun: vi.fn().mockResolvedValue(undefined),
        onExecutionStarted: vi.fn().mockResolvedValue(undefined),
        onJobStatus: vi.fn().mockResolvedValue(undefined),
        holdRunForPendingJobs: vi.fn().mockReturnValue(true),
        releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
        setRunTrustContext: vi.fn(),
      },
    };
  }

  it('names the posture on a per-context minimum-trust hold, which resumes', async () => {
    // `holdJobForApproval` writes this hold's pending dispatch context, so
    // release re-dispatches the job under the same untrusted tier — unlike the
    // trust-policy hold, whose sentinel job id has no stored context.
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeSingleJobContext({
      bundle: {
        normalizer: { provider: 'github' },
        checkStatusPoster: { provider: 'github', postCheckStatus },
      } as unknown as WorkflowDispatchContext['bundle'],
      jobContext: 'staging',
      contextStore: minimumTrustContextStore(),
      ...holdPersistenceStubs(),
    });
    untrustedFork(ctx);

    await dispatchMatchedWorkflow(ctx);

    const summary = heldSummary(postCheckStatus);
    expect(summary).toBeDefined();
    expect(summary).toContain('Context requires a higher trust level');
    expect(summary).toContain(REDUCED_PRIVILEGE_MARKER);
    expect(summary).toContain('Workflow definitions were read from the base branch');
  });

  it('posts no pending security check when the hold row cannot be written', async () => {
    // Identical to the case above except that nothing persists the hold: with
    // no `heldRunStore`, `holdJobForApproval` logs and returns before the
    // transaction. Every route that terminalizes a `KiCI Security` check
    // reaches it through that row, so a pending post here would sit on the
    // commit forever — a permanent branch-protection blocker.
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeSingleJobContext({
      bundle: {
        normalizer: { provider: 'github' },
        checkStatusPoster: { provider: 'github', postCheckStatus },
      } as unknown as WorkflowDispatchContext['bundle'],
      jobContext: 'staging',
      contextStore: minimumTrustContextStore(),
    });
    untrustedFork(ctx);

    await dispatchMatchedWorkflow(ctx);

    expect(heldSummary(postCheckStatus)).toBeUndefined();
  });

  it('posts no pending security check when the hold transaction rolls back', async () => {
    // The store and the database are both present, so the gate is reached and
    // the write is attempted — and it throws. The row is gone with the
    // transaction, so the check must not be on the commit either.
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const stubs = holdPersistenceStubs();
    const { ctx } = makeSingleJobContext({
      bundle: {
        normalizer: { provider: 'github' },
        checkStatusPoster: { provider: 'github', postCheckStatus },
      } as unknown as WorkflowDispatchContext['bundle'],
      jobContext: 'staging',
      contextStore: minimumTrustContextStore(),
      ...stubs,
      db: {
        ...(stubs.db as Record<string, unknown>),
        transaction: () => ({
          execute: async () => {
            throw new Error('deadlock detected');
          },
        }),
      },
    });
    untrustedFork(ctx);

    await expect(dispatchMatchedWorkflow(ctx)).rejects.toThrow('deadlock detected');

    expect(heldSummary(postCheckStatus)).toBeUndefined();
  });

  it('completes the queued kici/… checks when the hold transaction rolls back', async () => {
    // The `KiCI Security` check above is a different check run from the queued
    // `kici/<workflow>` and per-job ones the setup phase posted. Those are
    // already on the commit when the transaction throws, and the throw reaches
    // none of the named early exits that complete their own — so without this
    // they stay `queued` forever and block branch protection.
    //
    // Asserted through a real throw rather than by calling the helper: the
    // condition is "the checks were posted and the dispatch threw", and only
    // driving the dispatch proves the catch is wired to it.
    const setPendingAwait = vi.fn().mockResolvedValue(undefined);
    const completeUndispatchedCheckRuns = vi.fn().mockResolvedValue(undefined);
    const stubs = holdPersistenceStubs();
    const { ctx } = makeSingleJobContext({
      bundle: {
        normalizer: { provider: 'github' },
        checkStatusPoster: { provider: 'github', postCheckStatus: vi.fn() },
      } as unknown as WorkflowDispatchContext['bundle'],
      jobContext: 'staging',
      contextStore: minimumTrustContextStore(),
      checkRunReporter: { setPendingAwait, completeUndispatchedCheckRuns },
      ...stubs,
      db: {
        ...(stubs.db as Record<string, unknown>),
        transaction: () => ({
          execute: async () => {
            throw new Error('deadlock detected');
          },
        }),
      },
    });
    // The completion refuses an identifier it cannot split into owner/repo.
    ctx.repoIdentifier = 'acme/app';
    untrustedFork(ctx);

    await expect(dispatchMatchedWorkflow(ctx)).rejects.toThrow('deadlock detected');

    expect(setPendingAwait).toHaveBeenCalledTimes(1);
    expect(completeUndispatchedCheckRuns).toHaveBeenCalledTimes(1);
    const call = completeUndispatchedCheckRuns.mock.calls[0][0];
    expect(call.conclusion).toBe(CheckRunConclusion.enum.failure);
    // The same names the setup phase posted — a conclusion under a different
    // name would create a second check rather than close the first.
    expect(call.jobNames).toEqual(setPendingAwait.mock.calls[0][0].jobNames);
    expect(call.workflowName).toBe(setPendingAwait.mock.calls[0][0].workflowName);
    expect(String(call.summary)).toContain('deadlock detected');
  });

  it('completes no checks when the throw lands before they are posted', async () => {
    // The negative control for the flag. `setupDispatchContext` posts the
    // checks; a throw from inside `setPendingAwait` itself means nothing is on
    // the commit, and concluding then would CREATE the very check run it claims
    // to be closing — a fabricated failing check on a pull request.
    const setPendingAwait = vi.fn().mockRejectedValue(new Error('provider 502'));
    const completeUndispatchedCheckRuns = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'github' } } as WorkflowDispatchContext['bundle'],
      checkRunReporter: { setPendingAwait, completeUndispatchedCheckRuns },
    });
    ctx.repoIdentifier = 'acme/app';

    await expect(dispatchMatchedWorkflow(ctx)).rejects.toThrow('provider 502');

    expect(completeUndispatchedCheckRuns).not.toHaveBeenCalled();
  });

  /**
   * `holdPersistenceStubs`' database, wrapped so the transaction handle it
   * hands the callback is captured. The hold row and the job's pending dispatch
   * context are written together on purpose; asserting the row went through
   * THIS handle is what proves they can still roll back together.
   */
  function captureTransactionHandle(db: unknown): { db: unknown; handles: unknown[] } {
    const handles: unknown[] = [];
    const root = db as {
      transaction: () => { execute: (cb: (t: unknown) => Promise<unknown>) => Promise<unknown> };
    };
    return {
      db: {
        ...(db as Record<string, unknown>),
        transaction: () => ({
          execute: (cb: (t: unknown) => Promise<unknown>) =>
            root.transaction().execute(async (t) => {
              handles.push(t);
              return cb(t);
            }),
        }),
      },
      handles,
    };
  }

  it('writes a reviewer hold row through the transaction that carries its resume path', async () => {
    // Kysely has no ambient transaction: an insert left on the store's own
    // connection commits regardless of what the `storePendingJobContext` write
    // beside it does. The row would then survive a rolled-back context — a hold
    // nothing can resume, which is precisely what writing them together avoids.
    const stubs = holdPersistenceStubs();
    const captured = captureTransactionHandle(stubs.db);
    const { ctx } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'github' } } as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      jobApproval: { clauses: [{ user: 'cto' }], reason: 'ship it', when: 'always' as const },
      ...stubs,
      db: captured.db,
    });

    await dispatchMatchedWorkflow(ctx);

    const createHold = (stubs.heldRunStore as { createHold: ReturnType<typeof vi.fn> }).createHold;
    expect(captured.handles).toHaveLength(1);
    expect(createHold.mock.calls[0][2]).toBe(captured.handles[0]);
  });

  it('writes a security hold row through the transaction that carries its resume path', async () => {
    // The other arm of the same write: a security-typed context gate takes
    // `create` rather than `createHold`, and carries the same pending context.
    const stubs = holdPersistenceStubs();
    const captured = captureTransactionHandle(stubs.db);
    const { ctx } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'github' } } as WorkflowDispatchContext['bundle'],
      jobContext: 'staging',
      contextStore: minimumTrustContextStore(),
      ...stubs,
      db: captured.db,
    });
    untrustedFork(ctx);

    await dispatchMatchedWorkflow(ctx);

    const create = (stubs.heldRunStore as { create: ReturnType<typeof vi.fn> }).create;
    expect(captured.handles).toHaveLength(1);
    expect(create.mock.calls[0][2]).toBe(captured.handles[0]);
  });

  /** The `markPendingCheckPosted` mock inside a `holdPersistenceStubs()` value. */
  function markMock(stubs: { heldRunStore: unknown }): ReturnType<typeof vi.fn> {
    return (stubs.heldRunStore as { markPendingCheckPosted: ReturnType<typeof vi.fn> })
      .markPendingCheckPosted;
  }

  it('records on the hold row that its pending security check reached the provider', async () => {
    // The settle reads this record to decide whether the hold has a check to
    // terminalize. Without it the decision falls back to the row's SHAPE, which
    // says what the post was MEANT to do — and terminalizing a check that was
    // never posted creates one, on a commit that never carried it.
    const order: string[] = [];
    const postCheckStatus = vi.fn().mockImplementation(async () => {
      order.push('post');
    });
    const stubs = holdPersistenceStubs();
    markMock(stubs).mockImplementation(async () => {
      order.push('record');
    });
    const { ctx } = makeSingleJobContext({
      bundle: {
        normalizer: { provider: 'github' },
        checkStatusPoster: { provider: 'github', postCheckStatus },
      } as unknown as WorkflowDispatchContext['bundle'],
      jobContext: 'staging',
      contextStore: minimumTrustContextStore(),
      ...stubs,
    });
    untrustedFork(ctx);

    await dispatchMatchedWorkflow(ctx);

    expect(heldSummary(postCheckStatus)).toBeDefined();
    expect(markMock(stubs)).toHaveBeenCalledWith('__default__', ['held-nonapproval']);
    // The record goes SECOND. Recording first and dying before the post would
    // leave a row claiming a check the commit does not have, and the settle
    // would then create one — the fabrication this record exists to prevent.
    expect(order).toEqual(['post', 'record']);
  });

  it('records nothing when the provider refuses the pending security check', async () => {
    // The case the shape derivation answered wrong. The post failed, so the
    // commit has no `KiCI Security` run — and the record has to say so, or the
    // settle fabricates one when the hold ends.
    const postCheckStatus = vi.fn().mockRejectedValue(new Error('403 from the provider'));
    const stubs = holdPersistenceStubs();
    const { ctx } = makeSingleJobContext({
      bundle: {
        normalizer: { provider: 'github' },
        checkStatusPoster: { provider: 'github', postCheckStatus },
      } as unknown as WorkflowDispatchContext['bundle'],
      jobContext: 'staging',
      contextStore: minimumTrustContextStore(),
      ...stubs,
    });
    untrustedFork(ctx);

    // A refused check post must not fail the dispatch either.
    await dispatchMatchedWorkflow(ctx);

    expect(postCheckStatus).toHaveBeenCalled();
    expect(markMock(stubs)).not.toHaveBeenCalled();
  });

  it('retries the record so a transient database error does not strand the check', async () => {
    // The record is written AFTER the post, deliberately — the reverse order
    // fabricates a check. So a failure between the two leaves a pending check
    // no settle will close, and nothing sweeps it. Half that window is a
    // transient database error, and a retry closes that half. Two failures
    // then a success is pinned as a literal: a count derived from
    // PENDING_CHECK_MARK_ATTEMPTS would move with it and still pass at 1.
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const stubs = holdPersistenceStubs();
    let calls = 0;
    markMock(stubs).mockImplementation(async () => {
      calls++;
      if (calls <= 2) throw new Error('connection terminated');
    });
    const { ctx } = makeSingleJobContext({
      bundle: {
        normalizer: { provider: 'github' },
        checkStatusPoster: { provider: 'github', postCheckStatus },
      } as unknown as WorkflowDispatchContext['bundle'],
      jobContext: 'staging',
      contextStore: minimumTrustContextStore(),
      ...stubs,
    });
    untrustedFork(ctx);

    await dispatchMatchedWorkflow(ctx);

    expect(calls).toBe(3);
    expect(markMock(stubs)).toHaveBeenLastCalledWith('__default__', ['held-nonapproval']);
  });

  it('gives up on the record without failing the dispatch', async () => {
    // The give-up is bounded: the mark is best-effort by construction, and a
    // dispatch that threw here would strand the hold as well as the check.
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const stubs = holdPersistenceStubs();
    markMock(stubs).mockRejectedValue(new Error('connection terminated'));
    const { ctx } = makeSingleJobContext({
      bundle: {
        normalizer: { provider: 'github' },
        checkStatusPoster: { provider: 'github', postCheckStatus },
      } as unknown as WorkflowDispatchContext['bundle'],
      jobContext: 'staging',
      contextStore: minimumTrustContextStore(),
      ...stubs,
    });
    untrustedFork(ctx);

    await dispatchMatchedWorkflow(ctx);

    expect(markMock(stubs)).toHaveBeenCalledTimes(PENDING_CHECK_MARK_ATTEMPTS);
  });

  it('budgets enough mark attempts to ride out a blip', () => {
    // One attempt would make every transient database error a stranded check.
    expect(PENDING_CHECK_MARK_ATTEMPTS).toBeGreaterThanOrEqual(3);
  });

  it('records the reviewer hold post too, on the row the transaction wrote', async () => {
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const stubs = holdPersistenceStubs();
    const { ctx } = makeSingleJobContext({
      bundle: {
        normalizer: { provider: 'github' },
        checkStatusPoster: { provider: 'github', postCheckStatus },
      } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      jobApproval: { clauses: [{ user: 'cto' }], reason: 'ship it', when: 'always' as const },
      ...stubs,
    });
    untrustedFork(ctx);

    await dispatchMatchedWorkflow(ctx);

    expect(heldSummary(postCheckStatus)).toBeDefined();
    expect(markMock(stubs)).toHaveBeenCalledWith('__default__', ['held-approval']);
  });

  /**
   * A job whose SDK `requireApproval` meets a security-typed context gate. The
   * gate mints `nonApprovalHold`, and `applyStaticApprovalHolds` runs after it
   * and mints `approvalHold` on a `!approvalHold` guard alone — so the job
   * carries both.
   */
  function bothHoldsContext(postCheckStatus: ReturnType<typeof vi.fn>) {
    const stubs = holdPersistenceStubs();
    const { ctx } = makeSingleJobContext({
      bundle: {
        normalizer: { provider: 'github' },
        checkStatusPoster: { provider: 'github', postCheckStatus },
      } as unknown as WorkflowDispatchContext['bundle'],
      jobContext: 'staging',
      contextStore: minimumTrustContextStore(),
      jobApproval: { clauses: [{ user: 'cto' }], reason: 'ship it', when: 'always' as const },
      ...stubs,
    });
    untrustedFork(ctx);
    return { ctx, stubs };
  }

  it('writes BOTH hold rows for a job carrying a reviewer and a security hold', async () => {
    // Two independent requirements gate one job, so both must be satisfied for
    // it to run. Writing only the reviewer row did not merely lose a record —
    // the trust gate went unenforced, and the reviewer hold releases on
    // `contexts:write` plus clause eligibility where the trust hold required
    // `ci_trust:write`. A lower permission was releasing a job the security
    // gate held, and the resume short-circuits the trust gate rather than
    // re-resolving trust.
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const { ctx, stubs } = bothHoldsContext(postCheckStatus);

    await dispatchMatchedWorkflow(ctx);

    const store = stubs.heldRunStore as {
      createHold: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
    expect(store.createHold).toHaveBeenCalledTimes(1);
    expect(store.create).toHaveBeenCalledTimes(1);
    // The security row keeps its own queue type, which is what scopes it to
    // `/kici approve`'s `ci_trust:write` surface rather than the reviewer one.
    expect(store.create.mock.calls[0][1]).toMatchObject({
      holdType: HoldType.enum.security,
      queueType: 'security',
    });
    // Both through the one transaction that also carries the resume context.
    expect(store.createHold.mock.calls[0][2]).toBe(store.create.mock.calls[0][2]);
    expect(store.create.mock.calls[0][2]).toBeDefined();
  });

  it('posts one pending check for a job carrying both a reviewer and a security hold', async () => {
    // Both post blocks used to fire into the one `KiCI Security` check run, so
    // which summary a contributor read was decided by whichever provider call
    // landed second. One post now, rendering the reviewer copy because it names
    // concrete clauses a human can act on.
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const { ctx } = bothHoldsContext(postCheckStatus);

    await dispatchMatchedWorkflow(ctx);

    const pending = postCheckStatus.mock.calls.filter(
      (c) => c[2] === 'pending' && c[3] === 'Held for approval',
    );
    expect(pending).toHaveLength(1);
    // The reviewer copy, not the trust-gate copy.
    expect(String(pending[0][4])).toContain('cto');
    expect(String(pending[0][4])).not.toContain('Context requires a higher trust level');
  });

  it('records BOTH holds as owning the one check, in a single call', async () => {
    // The commit has a single `KiCI Security` run and both holds gate it. If
    // only the rendered row were recorded, the first hold to end would find no
    // other owner in the contention query and terminalize the check —
    // `success`, on an approve — while the other hold still gates the job.
    // Branch protection would go green over held work.
    //
    // ONE call, not two: marking them separately admits a partial mark, whose
    // survivor is exactly that unrecorded owner. The store turns the id list
    // into one `WHERE id IN (…)`, so the pair lands atomically or not at all.
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const { ctx, stubs } = bothHoldsContext(postCheckStatus);

    await dispatchMatchedWorkflow(ctx);

    expect(markMock(stubs)).toHaveBeenCalledTimes(1);
    expect(markMock(stubs)).toHaveBeenCalledWith('__default__', [
      'held-approval',
      'held-nonapproval',
    ]);
  });

  it('names the trust hold in the reviewer check description', async () => {
    // Both holds gate the job and the commit carries one check run. Naming only
    // the approval clauses leaves a contributor asking the named approver, the
    // approver approving, the job not running, and the text unchanged — a
    // satisfied requirement with no statement of what is still outstanding.
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const { ctx } = bothHoldsContext(postCheckStatus);

    await dispatchMatchedWorkflow(ctx);

    const summary = heldSummary(postCheckStatus) ?? '';
    expect(summary).toContain('cto');
    expect(summary).toContain('security trust hold also gates this job');
    // The two ways it can be cleared, named where the contributor reads them.
    expect(summary).toContain('ci_trust:write');
    expect(summary).toContain('/kici approve');
  });

  it('says nothing about a trust hold on an approval-only job', async () => {
    // The control: the line is conditional on a security hold actually existing,
    // so an ordinary `requireApproval` check does not tell a contributor to go
    // clear a gate that is not there.
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeSingleJobContext({
      bundle: {
        normalizer: { provider: 'github' },
        checkStatusPoster: { provider: 'github', postCheckStatus },
      } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      jobApproval: { clauses: [{ user: 'cto' }], reason: 'ship it', when: 'always' as const },
      ...holdPersistenceStubs(),
    });
    untrustedFork(ctx);

    await dispatchMatchedWorkflow(ctx);

    const summary = heldSummary(postCheckStatus) ?? '';
    expect(summary).toContain('cto');
    expect(summary).not.toContain('security trust hold also gates this job');
  });

  it('audits both holds it wrote, not just the one whose summary was posted', async () => {
    // A hold an operator can be asked to approve, with no access-log entry
    // saying it was raised, is a gap regardless of what was raised alongside it.
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const record = vi.fn().mockResolvedValue(undefined);
    const { ctx } = bothHoldsContext(postCheckStatus);
    (ctx.deps as unknown as Record<string, unknown>).accessLogWriter = { record };

    await dispatchMatchedWorkflow(ctx);

    const holdRequests = record.mock.calls
      .map((c) => c[0] as { action: string; target: { id: string } })
      .filter((e) => e.action === 'held_run.request');
    expect(holdRequests.map((e) => e.target.id).sort()).toEqual([
      'held-approval',
      'held-nonapproval',
    ]);
  });

  it('names the posture on a reviewer-approval hold, which also resumes', async () => {
    // The hold row and its pending dispatch context are written in one
    // transaction, so approval re-dispatches the job under this run's own
    // trust resolution. The note says what that resumed job will not have.
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeSingleJobContext({
      bundle: {
        normalizer: { provider: 'github' },
        checkStatusPoster: { provider: 'github', postCheckStatus },
      } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      jobApproval: { clauses: [{ user: 'cto' }], reason: 'ship it', when: 'always' as const },
      ...holdPersistenceStubs(),
    });
    untrustedFork(ctx);

    await dispatchMatchedWorkflow(ctx);

    const summary = heldSummary(postCheckStatus);
    expect(summary).toBeDefined();
    expect(summary).toContain('Awaiting approval: user cto');
    expect(summary).toContain(REDUCED_PRIVILEGE_MARKER);
    expect(summary).toContain('Workflow definitions were read from the base branch');
  });
});

describe('evaluateJobContexts — a context concurrency limit counts siblings admitted in the same pass', () => {
  // The running-count query counts jobs whose status is already `running`, and
  // nothing dispatched in THIS pass is running yet — so before the in-pass
  // tally every child of a fan-out was evaluated against the same unchanged
  // number and all N were admitted against one slot. The static path gated each
  // child individually and was still wrong for exactly this reason.
  const CONTEXT_ROW = {
    id: 'env-prod',
    org_id: '__default__',
    name: 'prod',
    type: 'deployment',
    glob_pattern: null,
    branch_restrictions: null,
    trigger_type_filters: null,
    repo_patterns: null,
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
  };

  /** A context store whose `prod` row carries the given concurrency limit. */
  function contextStore(concurrencyLimit: number | null) {
    return {
      matchContext: async (_org: string, n: string) =>
        n === 'prod' ? { ...CONTEXT_ROW, concurrency_limit: concurrencyLimit } : null,
    };
  }

  /** A Kysely stub whose running-count query answers `count`. */
  function makeCountingDb(count: number) {
    return {
      fn: { countAll: () => ({ as: (alias: string) => alias }) },
      selectFrom: () => ({
        select: function (this: unknown) {
          return this;
        },
        where: function (this: unknown) {
          return this;
        },
        innerJoin: function (this: unknown) {
          return this;
        },
        executeTakeFirst: async () => ({ count }),
      }),
    };
  }

  const MATRIX_JOB = { _type: 'static' as const, name: 'build', contexts: [{ value: 'prod' }] };
  const CHILDREN = [
    { expandedName: 'build (a)' },
    { expandedName: 'build (b)' },
    { expandedName: 'build (c)' },
  ];

  it('admits only up to the limit across the expanded children of a static matrix', async () => {
    const { jobContextData } = await runEvaluateJobContexts({
      lockJob: MATRIX_JOB,
      event: { type: 'push' },
      mats: CHILDREN,
      deps: { contextStore: contextStore(2), db: makeCountingDb(0) },
    });

    // Two slots, three children: the first two are admitted, the third is
    // queued by the concurrency gate. Pre-fix all three passed.
    expect(jobContextData.get('build (a)')?.held).toBeUndefined();
    expect(jobContextData.get('build (b)')?.held).toBeUndefined();
    expect(jobContextData.get('build (c)')?.held).toBe(true);
  });

  it('adds the in-pass tally to the running count rather than replacing it', async () => {
    // One job already running + a limit of 2 leaves exactly one free slot, so
    // the FIRST child is admitted and the second is not. This fails if the
    // tally is used alone (both admitted) or the DB count alone (both admitted).
    const { jobContextData } = await runEvaluateJobContexts({
      lockJob: MATRIX_JOB,
      event: { type: 'push' },
      mats: CHILDREN.slice(0, 2),
      deps: { contextStore: contextStore(2), db: makeCountingDb(1) },
    });

    expect(jobContextData.get('build (a)')?.held).toBeUndefined();
    expect(jobContextData.get('build (b)')?.held).toBe(true);
  });

  it('leaves a context with no concurrency limit unaffected', async () => {
    // The control that proves the two assertions above are not vacuous: the
    // same three children against an unlimited context all pass.
    const { jobContextData } = await runEvaluateJobContexts({
      lockJob: MATRIX_JOB,
      event: { type: 'push' },
      mats: CHILDREN,
      deps: { contextStore: contextStore(null), db: makeCountingDb(0) },
    });

    for (const name of ['build (a)', 'build (b)', 'build (c)']) {
      expect(jobContextData.get(name)?.held).toBeUndefined();
      expect(jobContextData.get(name)?.contextId).toBe('env-prod');
    }
  });

  it('leaves a job with no bound context unaffected', async () => {
    const { jobContextData } = await runEvaluateJobContexts({
      lockJob: { _type: 'static', name: 'build' },
      event: { type: 'push' },
      mats: CHILDREN,
      deps: { contextStore: contextStore(1), db: makeCountingDb(0) },
    });

    for (const name of ['build (a)', 'build (b)', 'build (c)']) {
      expect(jobContextData.get(name)?.held).toBeUndefined();
    }
  });

  it('does not spend an in-pass slot on a needs-gated job', async () => {
    // A needs-gated job does not dispatch from this pass — the dispatch loop
    // stores its pending context and the needs scheduler dispatches it later.
    // Letting it reserve a slot is not merely conservative: a job the
    // concurrency gate queues takes the hold branch, which the dispatch loop
    // evaluates BEFORE the needs branch, so the job never reaches the needs
    // scheduler and the queued-hold release path dispatches it with no upstream
    // check — beside a still-pending upstream, or after a FAILED one.
    const deployJob = {
      _type: 'static' as const,
      name: 'deploy',
      runsOn: [{ kind: 'exact', value: 'default' }],
      steps: [{ name: 'echo', run: 'echo hi' }],
      needs: ['build'],
      rules: [],
      contexts: [{ value: 'prod' }],
    };
    const { jobContextData } = await runEvaluateJobContexts({
      lockJob: MATRIX_JOB,
      event: { type: 'push' },
      mats: [{ expandedName: 'build' }, { expandedName: 'deploy', lockJob: deployJob }],
      deps: { contextStore: contextStore(1), db: makeCountingDb(0) },
    });

    // The root job takes the single slot. The needs-gated one is evaluated
    // against the DB count alone, so it passes through to the needs scheduler.
    expect(jobContextData.get('build')?.held).toBeUndefined();
    expect(jobContextData.get('deploy')?.held).toBeUndefined();

    // Non-vacuity by construction: make the same second job a ROOT job and it
    // IS held, so the assertion above can only hold because it is needs-gated.
    const control = await runEvaluateJobContexts({
      lockJob: MATRIX_JOB,
      event: { type: 'push' },
      mats: [
        { expandedName: 'build' },
        { expandedName: 'deploy', lockJob: { ...deployJob, needs: [] } },
      ],
      deps: { contextStore: contextStore(1), db: makeCountingDb(0) },
    });
    expect(control.jobContextData.get('deploy')?.held).toBe(true);
  });

  it('keys the admission tally by org id as well as concurrency group', async () => {
    // The tally inherits the cross-tenant scoping the running-count query
    // already enforces on `execution_runs.customer_id`. One dispatch pass
    // carries a single resolved org id, so this is asserted on the key builder
    // directly — that is the only place the invariant is observable.
    expect(concurrencyAdmissionKey('org-a', 'prod')).not.toBe(
      concurrencyAdmissionKey('org-b', 'prod'),
    );
    expect(concurrencyAdmissionKey('org-a', 'prod')).toBe(concurrencyAdmissionKey('org-a', 'prod'));
    // No delimiter collision: ("a", "b:c") and ("a:b", "c") must stay distinct.
    expect(concurrencyAdmissionKey('a', 'b:c')).not.toBe(concurrencyAdmissionKey('a:b', 'c'));
  });
});
