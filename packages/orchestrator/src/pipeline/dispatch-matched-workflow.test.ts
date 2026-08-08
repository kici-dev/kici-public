import { describe, it, expect, vi } from 'vitest';
import {
  runsOnSelectorsForLockJob,
  partitionGeneratedConfigsByPin,
  materializeStaticJobsSafe,
  resolveHostFanoutTargets,
  dispatchMatchedWorkflow,
  findInvalidApprovalTimeout,
  buildBringupJobInput,
  hostCtxFromMat,
  envelopeEvent,
  type GeneratedJobConfig,
  type WorkflowDispatchContext,
} from './dispatch-matched-workflow.js';
import { SSH_TRANSPORT_CAPABILITY } from '@kici-dev/engine';
import { InitFailureCategory, SECURITY_HOLD_JOB_IDS } from '@kici-dev/engine';
import type { MaterializedJob } from '@kici-dev/engine';
import {
  ExecutionJobStatus,
  FanoutError,
  FanoutCause,
  HoldType,
  HostTargetSelector,
} from '@kici-dev/engine';
import { HostStatus, type MatchedHost } from '../agent/host-roster.js';
import type { ProcessingDeps } from './processor.js';
import type { QueuedJobInput } from '../queue/job-queue.js';
import type { LockWorkflow, SimulatedEvent, WorkflowDecision } from '@kici-dev/engine';
import type { WebhookInfo } from '../webhook/handler.js';
import { consumePendingJobContext } from './processor.js';
import { SecurityHoldReason } from '../contexts/held-runs.js';
import type { TrustPolicyHoldReason, TrustPolicyOutcome } from '../security/trust-policy-gate.js';

/** Build a ProcessingDeps stub whose host roster returns the given matched hosts. */
function rosterDeps(matched: MatchedHost[]): ProcessingDeps {
  return {
    hostRosterStore: { findMatching: async () => matched },
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
  heldRunStore?: unknown;
  /** Append a dynamic job fn, so dispatch spawns a deferred dynamic entry. */
  withDynamicEntry?: boolean;
  /** Give the static job a dynamic matrix, so its init is deferred. */
  withDeferredInit?: boolean;
  pendingDynamics?: unknown;
  pendingInits?: unknown;
}): { ctx: WorkflowDispatchContext; dispatched: QueuedJobInput[] } {
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
        steps: [{ name: 'echo', run: 'echo hi' }],
        needs: [],
        rules: [],
        ...(over.jobContext ? { contexts: [{ value: over.jobContext, dynamic: false }] } : {}),
        ...(over.jobContainer ? { container: over.jobContainer } : {}),
        ...(over.jobSandbox ? { sandbox: over.jobSandbox } : {}),
        ...(over.jobMatrix ? { matrix: over.jobMatrix } : {}),
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
        }
      : {}),
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
 * trustResolver.
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
  // No coordinator, heldRunStore, trustResolver, db, or executionTracker:
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
function holdDecision(reason: SecurityHoldReason, approvalExpiryHours: number | null = 72) {
  return {
    action: 'hold' as const,
    reason: reason as TrustPolicyHoldReason,
    message: `held: ${reason}`,
    approvalExpiryHours,
  };
}

/** A `reject` outcome as the trust-policy gate produces it. */
function rejectDecision(reason: SecurityHoldReason) {
  return { action: 'reject' as const, reason, message: `rejected: ${reason}` };
}

/** A TrustPolicyStore stand-in returning a fixed `approvalExpiryHours`. */
function storeReturningExpiry(approvalExpiryHours: number) {
  return {
    get: vi.fn().mockResolvedValue({
      forkPolicy: 'hold',
      unknownContributorPolicy: 'hold',
      workflowChangePolicy: 'hold',
      approvalExpiryHours,
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
      releasePendingJobsHold: vi.fn(),
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
      jobId: '__fork_pr__',
    });
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
    ctx.securityDecision = holdDecision(SecurityHoldReason.enum.workflow_modification, 5);
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
        addJobsToRun: vi.fn().mockResolvedValue(undefined),
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
    };
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: undefined,
      fullRepo: true,
      jobContext: 'staging',
      contextConcurrencyLimit: 1,
      jobMatrix: { _type: 'static', values: ['18', '20'] },
      db: envDb,
      heldRunStore: {
        create: async (_org: string, data: { runId: string; jobId: string }) => {
          created.push({ runId: data.runId, jobId: data.jobId });
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

  it('does not release a token it never took', async () => {
    // Tokens are fungible, so an unpaired release consumes someone else's:
    // a dispatch that took no build-window token must not decrement the count,
    // or a deferred init / dynamic task's token is dropped underneath it and
    // the run finalizes while its jobs are still being registered.
    const releasePendingJobsHold = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      executionTracker: {
        onExecutionStarted: vi.fn().mockResolvedValue(undefined),
        addJobsToRun: vi.fn().mockResolvedValue(undefined),
        onJobStatus: vi.fn().mockResolvedValue(undefined),
        holdRunForPendingJobs: vi.fn(() => true),
        releasePendingJobsHold,
      },
    });

    // No build infra, so no build window and no token.
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

describe('dispatchMatchedWorkflow — testRun run-row stamp', () => {
  it('stamps is_test_run + fixture_id when ctx.testRun is present', async () => {
    const { db, updates } = makeUpdateRecordingDb();
    const executionTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
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
    };
    const executionTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
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
      executionTracker: { onExecutionStarted, releasePendingJobsHold: vi.fn() },
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
      executionTracker: { onExecutionStarted, releasePendingJobsHold: vi.fn() },
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
