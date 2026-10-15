import { describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
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
  resolveGeneratedJobConfigs,
  type GeneratedJobConfig,
  type WorkflowDispatchContext,
} from './dispatch-matched-workflow.js';
import { canonicalizeLabels, SSH_TRANSPORT_CAPABILITY } from '@kici-dev/engine';
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
import { makeSingleJobContext } from './dispatch-matched-workflow.test-helpers.js';
import { releaseInvokeGate } from './invoke-gate.js';
import { SecurityHoldReason } from '../contexts/held-runs.js';
import { REDUCED_PRIVILEGE_MARKER } from '../security/reduced-privilege-note.js';
import type { TrustPolicyHoldReason, TrustPolicyOutcome } from '../security/trust-policy-gate.js';
import { lockFileFixture, staticJob } from '../__test-helpers__/lock-fixtures.js';

/**
 * The Kysely surface `storePendingJobContext` needs in a transaction. The hold
 * path writes the held_runs row and pending context together, so every db stub
 * that can reach it returns this from `transaction().execute`.
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

/** One `execution_jobs` row joined to its `execution_runs` parent. */
interface SlotRow {
  run_id: string;
  job_id: string;
  job_name: string;
  status: string;
  /** `execution_runs.context` — the concurrency group. */
  context: string;
  /** `execution_runs.customer_id` — the owning org. */
  customer_id: string;
}

type SlotPredicate = (row: SlotRow) => boolean;

const SLOT_COLUMNS: Record<string, (row: SlotRow) => string> = {
  'execution_jobs.run_id': (r) => r.run_id,
  'execution_jobs.job_id': (r) => r.job_id,
  'execution_jobs.job_name': (r) => r.job_name,
  'execution_jobs.status': (r) => r.status,
  'execution_runs.context': (r) => r.context,
  'execution_runs.customer_id': (r) => r.customer_id,
};

/**
 * Throws on anything it does not model (the positive control): a slot count
 * that grows a clause this fake cannot read fails loudly instead of answering
 * zero and turning every admission assertion green.
 */
function slotPredicate(column: string, operator: string, value: unknown): SlotPredicate {
  const read = SLOT_COLUMNS[column];
  if (!read) throw new Error(`slot-counting fake: unhandled column ${column}`);
  switch (operator) {
    case '=':
      return (row) => read(row) === value;
    case 'in':
      return (row) => (value as unknown[]).includes(read(row));
    case 'not in':
      return (row) => !(value as unknown[]).includes(read(row));
    case 'not like':
      return (row) =>
        !new RegExp(
          `^${String(value)
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/%/g, '.*')}$`,
        ).test(read(row));
    default:
      throw new Error(`slot-counting fake: unhandled operator ${operator}`);
  }
}

/** The sliver of Kysely's expression builder the slot-count exclusion uses. */
const slotExpressionBuilder = Object.assign(
  (column: string, operator: string, value: unknown) => slotPredicate(column, operator, value),
  {
    and:
      (parts: SlotPredicate[]): SlotPredicate =>
      (row) =>
        parts.every((p) => p(row)),
    or:
      (parts: SlotPredicate[]): SlotPredicate =>
      (row) =>
        parts.some((p) => p(row)),
    not:
      (part: SlotPredicate): SlotPredicate =>
      (row) =>
        !part(row),
  },
);

/**
 * A db stub whose slot count is a real filter over seeded rows: the concurrency
 * assertions are about which rows a count can SEE, which a constant cannot
 * show. `rows` is live: push mid-run to model a sibling's row landing while
 * the pass is still gating.
 */
function makeSlotCountingDb(rows: SlotRow[], stats?: { slotQueries: number }) {
  const db: Record<string, unknown> = {
    fn: { countAll: () => ({ as: (alias: string) => alias }) },
    selectFrom: (table: string) => {
      const predicates: SlotPredicate[] = [];
      const qb = {
        select: () => qb,
        innerJoin: () => qb,
        where: (first: unknown, operator?: unknown, value?: unknown) => {
          if (typeof first === 'function') {
            predicates.push(
              (first as (eb: typeof slotExpressionBuilder) => SlotPredicate)(slotExpressionBuilder),
            );
          } else {
            predicates.push(slotPredicate(first as string, operator as string, value));
          }
          return qb;
        },
        executeTakeFirst: async () => {
          if (table !== 'execution_jobs') return undefined;
          if (stats) stats.slotQueries++;
          return { count: rows.filter((row) => predicates.every((p) => p(row))).length };
        },
      };
      return qb;
    },
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
  db.transaction = () => ({
    execute: async (cb: (t: unknown) => Promise<unknown>) => cb(makeTrxHandle()),
  });
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

function rosterDeps(matched: MatchedHost[]): ProcessingDeps {
  return {
    hostRosterStore: { findFanoutTargets: async () => matched },
    maxFanoutHosts: 1024,
  } as unknown as ProcessingDeps;
}

/** A roster `MatchedHost`; labels are folded here exactly as `matchRows` folds them. */
function host(over: Partial<Omit<MatchedHost, 'labels'>> & { labels?: string[] }): MatchedHost {
  return {
    agentId: 'a1',
    host: 'h1',
    lifecycleClass: 'static',
    connectedInstanceId: 'inst-1',
    status: HostStatus.ready,
    platform: 'linux',
    arch: 'amd64',
    properties: {},
    ...over,
    labels: canonicalizeLabels(over.labels ?? ['kici:os:linux']),
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
    // All reachable; target narrows to db-01 (non-target would give 3 hosts),
    // so the post-filter applies to candidates.
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
    // Default onUnreachable 'hold': the unreachable host stays a target with no
    // needsBringup (no init-runner attempt).
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
    // Matchers come back canonical: exact values folded, regex sources kept with
    // `i` forced (lowercasing would corrupt the pattern). `runsOnExactRaw` alone
    // keeps the lock file's spelling, because the host pin reads agent ids there.
    expect(runsOnSelectorsForLockJob(lockJob)).toEqual({
      runsOnLabels: ['role:web'],
      runsOnPatterns: [{ kind: 'regex', source: '^kici:host:box-', flags: 'i' }],
      excludeLabels: [],
      excludePatterns: [{ kind: 'regex', source: '-canary$', flags: 'i' }],
      runsOnExactRaw: ['role:web'],
    });
  });

  it('returns empty selectors for a job with no runsOn / excludeLabels', () => {
    expect(runsOnSelectorsForLockJob({} as never)).toEqual({
      runsOnLabels: [],
      runsOnPatterns: [],
      excludeLabels: [],
      excludePatterns: [],
      runsOnExactRaw: [],
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
      runsOnExactRaw: ['role:db'],
    });
  });
});

/** Chainable `updateTable` stub recording every `.set(...)` payload (which run-row UPDATEs fired). */
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
 * `deploy` needs `build`: proves the single-orch needs-gated path degrades
 * cleanly with no coordinator / heldRunStore / trust resolution.
 */
function makeNeedsContext(): { ctx: WorkflowDispatchContext; dispatched: QueuedJobInput[] } {
  const dispatched: QueuedJobInput[] = [];
  const workflow = {
    name: 'ci',
    source: { file: '.kici/workflows/ci.ts', export: '#default' },
    contentHash: 'wf-hash',
    triggers: [],
    jobs: [
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
    ],
  } as unknown as LockWorkflow;
  const fullLockFile = lockFileFixture({
    schemaVersion: 4 as const,
    contentHash: 'abc',
    lockfileHash: 'lock',
    workflows: [workflow],
  }) as unknown as WorkflowDispatchContext['fullLockFile'];
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
    // Required; the acted-on repository, as every per-repository caller sets it.
    // Cross-repository cases overwrite it.
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
    // Required: stated explicitly, as a real dispatch path must. Gate cases overwrite it.
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
function storeReturningExpiry(hours: number) {
  return {
    get: vi.fn().mockResolvedValue({
      forkPolicy: 'hold',
      approvalExpirySeconds: hours * SECONDS_PER_HOUR,
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
    // No `heldRunStore`, so no hold row. The pending `KiCI Security` check is
    // settled only through that row; posting one would strand it on the commit.
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
    // Same pairing as `holdJobForApproval`: only the stored context can replay
    // this dispatch, so a row outliving a failed context write is an
    // unreleasable hold (it reaches `failRunResumeLost`, which cannot complete
    // the queued `kici/…` checks). Written sequentially, kysely commits the
    // insert on the store's own pooled connection regardless of what follows.
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
    // `kici run` has no database (context is in memory only): the hold must
    // still be written rather than dying on an absent `db.transaction`.
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
    // The third site posting a pending `KiCI Security` status, writing outside
    // the dispatch loop's transaction. The record stops a later settle
    // terminalizing (and so CREATING) a check this commit never received.
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
   * One fixture, two verdicts; everything a dispatch leaves behind is
   * observable, including `checkRunReporter.setPendingAwait`, which creates the
   * queued `kici/<workflow>` check runs.
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
    // `ignore` withholds every contributor-visible artifact; the reject path's
    // failed run and failure check are the trace it exists to avoid. The
    // pipeline drops ignored events before dispatch; this arm covers paths
    // that evaluate the policy themselves (cross-source, globals).
    //
    // Check RUNS matter most: setup creates them before the gate reads the
    // verdict and nothing here completes them, so letting setup run leaves a
    // permanently queued check that branch protection reads as a blocked PR.
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
    // Non-vacuity: the same fixture with only the verdict changed DOES reach
    // `setPendingAwait`, so the `ignore` case cannot pass against an unwired
    // reporter. Also guards that hoisting `ignore` ahead of setup left `hold`
    // untouched: check runs are created and the hold recorded.
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
    // A hold leaves its check runs queued on purpose (`/kici approve` replays
    // under the same run); they complete only when the hold ends without
    // dispatching — see `rejectWorkflow` and the stale detector's expiry sweep.
    expect(f.completeUndispatchedCheckRuns).not.toHaveBeenCalled();
  });

  it('completes the queued check runs on a pre-dispatch init failure', async () => {
    // Every early exit after setup strands the same checks: `recordInitFailureRun`
    // fires `onExecutionStatusChange`, never `onExecutionComplete` (the one
    // callback wired to `updateWorkflowStatus`). `recordInitFailureFromSkip`
    // funnels all those exits, so closing it there covers the class; the
    // approval-misconfig gate is the cheapest to provoke.
    const f = makeVerdictFixture({ action: 'pass' });
    // owner/repo: the completion refuses an unsplittable identifier like bare `repo`.
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
    // A rejection leaves no run, job or queue record for terminal reporters to
    // key off, and the stale sweep only touches `in_progress`, so setup's
    // checks would stay `queued` forever. The `KiCI Security` check is a
    // different check run and closes none of these.
    const f = makeVerdictFixture(rejectDecision(SecurityHoldReason.enum.fork_pr));
    f.ctx.repoIdentifier = 'acme/app';
    f.ctx.workflowRepoIdentifier = 'acme/app';

    await dispatchMatchedWorkflow(f.ctx);

    expect(f.setPendingAwait).toHaveBeenCalledTimes(1);
    expect(f.completeUndispatchedCheckRuns).toHaveBeenCalledTimes(1);
    const call = f.completeUndispatchedCheckRuns.mock.calls[0][0];
    expect(call).toMatchObject({
      workflowName: 'ci',
      // Must match `setPendingAwait`'s names, or it addresses nonexistent check runs.
      jobNames: f.setPendingAwait.mock.calls[0][0].jobNames,
      owner: f.setPendingAwait.mock.calls[0][0].owner,
      repo: f.setPendingAwait.mock.calls[0][0].repo,
      sha: f.setPendingAwait.mock.calls[0][0].sha,
      conclusion: CheckRunConclusion.enum.failure,
    });
    // Same body as `KiCI Security`: branch protection usually requires
    // `kici/<workflow>`, often the only check a contributor reads.
    const securityCall = f.postCheckStatus.mock.calls.find((c) => c[2] === 'failure');
    expect(securityCall).toBeDefined();
    expect(call.summary).toBe(securityCall![4]);
    expect(String(call.summary)).toContain('cannot be approved');
    expect(String(call.summary)).toContain('Settings > CI trust');
  });

  it('refuses to address check runs when the repo identifier is not owner/repo', async () => {
    // Harness default is bare `repo`. A check run is (owner, repo, sha, name),
    // so half a name addresses nothing and would send `repo: undefined`
    // verbatim; skipping matches the helper's own guard.
    const f = makeVerdictFixture(rejectDecision(SecurityHoldReason.enum.fork_pr));
    expect(f.ctx.repoIdentifier).toBe('repo');

    await dispatchMatchedWorkflow(f.ctx);

    expect(f.recordInitFailureRun).toHaveBeenCalledTimes(1);
    expect(f.completeUndispatchedCheckRuns).not.toHaveBeenCalled();
  });

  it('cannot express an absent decision — omission is a compile error, not a pass', () => {
    // `securityDecision` is required, so a `src/**` dispatch path without a
    // verdict does not compile (tsconfig excludes `**/*.test.ts`). This pins
    // that the harness, like real call sites, states `pass` explicitly rather
    // than relying on a falsy check.
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
    // Pre-job run rows (hold, init failure) must name the repository that
    // DEFINES the workflow. A NULL marker is not "unknown": consumers read it as
    // "defined in the acted-on repo" (`registration/registration-run-match.ts`),
    // misfiling the authoring team's run.
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
    // `execution_runs.ref` is the PRESENTED branch, and the resumed run keeps
    // the held row (`onExecutionStarted` no-ops via ON CONFLICT). Internal
    // events inherit it as a branch claim, so recording the fork-chosen PR HEAD
    // branch would hand subscribers a claim the PR run was denied.
    // `sourceBranch` differs from `targetBranch` so the assertion is non-vacuous.
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
    // `routeRelease` sends this (scope, triggerSource) to `resumeWorkflow`,
    // which reads the stored context; without it approval flips the row, posts
    // a green check, and dispatches nothing.
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
    // Control: an unheld run id reads back null, so the loader does not always answer.
    expect(await loadPendingWorkflowContext(undefined, `${ctx.runId}-never-held`)).toBeNull();
    const pending = await loadPendingWorkflowContext(undefined, ctx.runId);
    expect(pending).not.toBeNull();
    // Approval means "let it run", never "make it trusted": the replay reuses
    // this run id, so the gate skips re-resolving trust and the stored tier holds.
    expect(pending!.trustResolution).toMatchObject({ tier: 'unknown' });
    expect(pending!.securityDecision).toMatchObject({ action: 'hold' });
  });

  it('stores no resume context when there is no hold row to release it', async () => {
    // Only the hold row releases a stored context, so with no held-run store
    // write neither: a lone context is unreachable by release and cleanup.
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
    // The store would answer 99h, but nobody asks: the window rides on the decision.
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
    // Why the window is in seconds: hours granularity cannot express this, and
    // `hours * 3_600_000` turns 30 into 108,000,000 ms (30 HOURS, not seconds).
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
    // Independent mode has no upstream policy: the decision carries `null`, not an invented 72h.
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
    // No held_runs row, so the check must NOT tell the contributor to seek approval.
    expect(String(rejectCall![4])).not.toContain('ci_trust:write');
    expect(String(rejectCall![4])).toContain('cannot be approved');
  });

  it('does NOT reject on a resume re-entry', async () => {
    // As the re-hold test: no executionTracker, so observe via the check poster.
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
    // A reason with no sentinel writes `undefined` into held_runs.job_id. Only
    // POLICY reasons: `context_trust` (per-context gate) writes the expanded job name.
    const policyReasons = SecurityHoldReason.options.filter(
      (r) => r !== SecurityHoldReason.enum.context_trust,
    );
    for (const reason of policyReasons) {
      expect(
        SECURITY_HOLD_JOB_IDS[reason as keyof typeof SECURITY_HOLD_JOB_IDS],
        `${reason} needs a sentinel`,
      ).toBeTruthy();
    }
    // Fixed value: holds created before the policy was enforced resolve by it.
    expect(SECURITY_HOLD_JOB_IDS.workflow_modification).toBe('__workflow_modification__');
    // No phantom entry: it was never written to a row, only padding a Record
    // over the full reason enum.
    expect(SECURITY_HOLD_JOB_IDS).not.toHaveProperty('context_trust');
    expect(Object.keys(SECURITY_HOLD_JOB_IDS).sort()).toEqual(policyReasons.slice().sort());
  });
});

describe('dispatchMatchedWorkflow — absent trust/holds/coordinator deps', () => {
  it('dispatches only the root job of a needs DAG; the downstream stays gated', async () => {
    const { ctx, dispatched } = makeNeedsContext();
    const result = await dispatchMatchedWorkflow(ctx);
    // Both jobs are tracked, but only root `build` is dispatched; the needs
    // scheduler holds `deploy` until `build` completes.
    expect(result.dispatchedJobCount).toBe(2);
    const dispatchedNames = dispatched.map((d) => d.jobName);
    expect(dispatchedNames).toEqual(['build']);

    // `deploy` is re-dispatched later through the base dispatcher (no wrapper
    // merge), so its stored jobInput MUST already carry extraJobConfig
    // (isTestRun/fixtureId) for overlay provenance to survive.
    const pending = await consumePendingJobContext(undefined, 'run-needs', 'deploy');
    expect(pending?.jobInput.jobConfig.isTestRun).toBe(true);
    expect(pending?.jobInput.jobConfig.fixtureId).toBe('fx-needs');
  });
});

describe('dispatchMatchedWorkflow — a job no agent can run', () => {
  it('registers a queued-no-backend job so the run cannot finish without it', async () => {
    // An unsatisfiable `runsOn` enqueues with `queued-no-backend`. It must be
    // tracked: `isRunComplete` iterates REGISTERED jobs, so an untracked one
    // lets the run finish GREEN without it running.
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
    // The expiry sweep terminalizes the queue row, so the tracked job must use
    // the SAME id the dispatcher enqueued under.
    const created: Array<{ jobId: string; jobName: string }> = [];
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: undefined,
      fullRepo: true,
      executionTracker: {
        // Positional after `ExecutionTracker.onExecutionStarted` (10th param is
        // the tracked-job array), spelled out to stay legible if it grows.
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
  /** Records lifecycle call order and each registration's job list. */
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
    // The ordering is load-bearing: a root job dispatched before the run row exists
    // reports terminal into `onJobStatus`, misses in memory and via
    // `recoverRunFromDb`, and DROPS the update, hanging the run silently. The
    // token stops the first finished job satisfying `isRunComplete` while
    // jobs 2..N still dispatch.
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

  it('registers the run with the context-derived positional arguments', async () => {
    // fails-when: a registration site drifts from the shared argument list
    // (wrong position, a dropped localWorkingTree, or a lost routing key)
    const tracker = makeOrderRecordingTracker([]);
    const { ctx } = makeSingleJobContext({
      bundle: undefined,
      fullRepo: true,
      localWorkingTree: true,
      executionTracker: tracker,
    });

    await dispatchMatchedWorkflow(ctx);

    expect(tracker.onExecutionStarted).toHaveBeenCalledTimes(1);
    const call = tracker.onExecutionStarted.mock.calls[0] as unknown[];
    expect(call.slice(0, 6)).toEqual(['run-1', 'ci', 'local', 'repo', 'main', 'main']);
    expect(call[6]).toBe('test:delivery');
    expect(call[9]).toEqual([]);
    expect(call[10]).toBe('local:repo');
    expect(call[20]).toBe(true);
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
    // A zero-job row never satisfies `isRunComplete` (`run.jobs.size > 0`) and
    // no sweeper reaps it (stale-run scans `execution_jobs` / `dispatch_queue`,
    // orphan recovery needs `running`, archival needs terminal): it sits
    // `pending` forever while the deadline detector re-fires every tick.
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
    // A queryable failed run (not a silent failRun): the denial shows in the
    // dashboard / runs API.
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
    // A test run's working-tree overlay may differ from the committed lock;
    // the agent must not reject it for a contentHash mismatch.
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
    // Context secrets AND the run-wide CLI flat overlay; the CLI value wins a collision.
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
      // holdJobForApproval writes row and context in one transaction.
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
        resolveForContext: async () => ({ DB_URL: 'env-db', SHARED: 'env' }),
        resolveNamedInternal: async () => null,
        resolveForContextWithMeta: async () => ({}),
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
    // The approval queue renders `held_runs.job_id` and `kici approve --job`
    // resolves it, so store the expanded name: one hold per matrix child, each named.
    const created: Array<{ runId: string; jobId: string }> = [];
    const { db } = makeUpdateRecordingDb();
    const envDb = {
      ...(db as object),
      fn: { countAll: () => ({ as: () => ({}) }) },
      // A non-zero running count trips the concurrency gate (the eager hold path).
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
      // holdJobForApproval writes row and context in one transaction.
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
    // The run is registered with __build__ ALONE and dispatch AWAITS it, so the
    // build going terminal would otherwise finalize the run before its real jobs.
    const timeline: string[] = [];
    const executionTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => timeline.push('register')),
      // The durable token must land before the build wait starts.
      registrationWindowSettled: vi.fn(async () => {
        timeline.push('durable');
      }),
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
    expect(timeline).toEqual([
      'dispatch:__build__ci',
      'register',
      'durable',
      'dispatch:build',
      'clear',
    ]);
  });

  it('releases the build-window token on the aborted-build early return', async () => {
    // A failed build short-circuits dispatch; the build's token must still be
    // released, or the run hangs in `running` until the stale detector reaps it.
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
    // The build dispatches (token taken), then fails, aborting dispatch early.
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
    // Same early return, check-run angle: setup posted `kici/ci` and
    // `kici/ci/job/build`, and `onBuildFailed` reaches no check run, so they
    // would sit `queued` for a run that never starts.
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
    // Tokens are fungible: an unpaired release drops a deferred init / dynamic
    // task's token and finalizes the run while that task still registers jobs.
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
    // No run registered, no token taken, so no decrement.
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
   * A deferred task registers jobs after dispatch returns, so its token is
   * taken while dispatch runs and released when the task settles. Taken inside
   * the async task, the build window's `release` would precede the deferred
   * `hold`, and the build going terminal would finalize the un-held run.
   */
  function makeHoldTimeline() {
    const timeline: string[] = [];
    let outstanding = 0;
    // As the real tracker: releasing with nothing outstanding clamps at zero.
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
        // After the deferred task's work: an un-held run here means the hold missed the task.
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
        // Eval in flight after dispatch dropped its token: only the deferred token holds the run.
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
    // The deferred token is released after the task registers its jobs; every token exactly once.
    expect(h.timeline).toContain('deferred-registered');
    expect(h.timeline.indexOf('deferred-registered')).toBeLessThan(
      h.timeline.lastIndexOf('release'),
    );
    expect(h.outstanding).toBe(0);
    // Dispatch must never release a token it did not take.
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
    // Dispatch must never release a token it did not take.
    expect(h.spuriousReleases).toBe(0);
  });

  it('releases the deferred token even when the deferred task fails', async () => {
    // The task's catch writes a synthetic failed job row while the token is
    // held, so release runs in `.finally()` on the spawned promise.
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

    // No token outstanding (no `running` hang) and no unpaired release.
    expect(h.outstanding).toBe(0);
    expect(h.spuriousReleases).toBe(0);
    // The synthetic failure row was registered before the token was dropped.
    const failedCall = h.tracker.onJobStatus.mock.calls.find(
      (args: unknown[]) => args[2] === ExecutionJobStatus.enum.failed,
    );
    expect(failedCall).toBeDefined();
  });

  it('skips the __build__ job for a local run even when build infra is present', async () => {
    // A no-bundle local run's source is a working-tree overlay: bypass the build
    // machinery so no __build__ job shadows the overlay.
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
    // A `file://` in-place run has a bundle and build infra, but the agent runs
    // the operator's real tree: skip the source pack (a dist-less clone) and
    // attach no tarball.
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
 * Drives `evaluateJobContexts` with the minimal ctx/setup/buildPrep the
 * deferred-init path reads; truthy `deps.pendingInits` routes dynamic fields
 * to the init round.
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
  /** Overrides `mat`: a STATIC matrix arrives expanded, so N children go through the per-job block. */
  mats?: Array<Record<string, unknown>>;
  /** Merged onto the workflow's match decision — `deferredPaths` routes every job to the init round. */
  decision?: Record<string, unknown>;
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
    // A held job records its routing key from the webhook info.
    info: { provider: 'local', routingKey: 'local:repo', deliveryId: 'd' },
    resolvedOrgId: '__default__',
    decision: { workflowName: 'ci', matched: true, checks: [], summary: '', ...over.decision },
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
  it('defers a dynamic env to the init round and carries no in-process value', async () => {
    const { deferredInitJobs, jobContextData } = await runEvaluateJobContexts({
      lockJob: { _type: 'static', name: 'build', dynamicEnv: true },
      event: { type: 'push' },
    });
    expect(deferredInitJobs).toHaveLength(1);
    expect(jobContextData.get('build')?.pendingInit).toBe(true);
    expect(jobContextData.get('build')?.jobEnv).toBeUndefined();
  });

  it('requests an init job for a non-global workflow that declares a filter', async () => {
    // Fully static: without the filter it dispatches straight through (the control).
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

describe('evaluateJobContexts — deferred paths defer to the init round', () => {
  const staticJob = { _type: 'static' as const, name: 'build' };

  // fails-when: a conservative path match dispatches without asking the agent
  it('requests an init job carrying the deferred paths for a workflow with no filter', async () => {
    const { deferredInitJobs, jobContextData } = await runEvaluateJobContexts({
      lockJob: staticJob,
      event: { type: 'push' },
      decision: { deferredPaths: [['src/**']] },
    });
    expect(deferredInitJobs).toHaveLength(1);
    expect(deferredInitJobs[0].initJobInput.jobConfig.deferredPaths).toEqual([['src/**']]);
    expect('hasFilter' in deferredInitJobs[0].initJobInput.jobConfig).toBe(false);
    expect(jobContextData.get('build')?.pendingInit).toBe(true);
  });

  // breaks-if-wrong: a decision with no deferred paths must dispatch straight through
  it('defers nothing when the decision carries no deferred paths', async () => {
    const { deferredInitJobs } = await runEvaluateJobContexts({
      lockJob: staticJob,
      event: { type: 'push' },
    });
    expect(deferredInitJobs).toHaveLength(0);
  });

  it('gives a held job no init job, as a filter does', async () => {
    const approval = { clauses: [], reason: 'ship it', when: 'always' as const };
    const { deferredInitJobs, jobContextData } = await runEvaluateJobContexts({
      lockJob: { ...staticJob, approval },
      event: { type: 'push' },
      decision: { deferredPaths: [['src/**']] },
      deps: { heldRunStore: { create: vi.fn() } },
    });
    expect(jobContextData.get('build')?.held).toBe(true);
    expect(deferredInitJobs).toHaveLength(0);
  });

  it('carries the deferred paths on an init job a dynamic field created', async () => {
    const { deferredInitJobs } = await runEvaluateJobContexts({
      lockJob: { ...staticJob, dynamicEnv: true },
      event: { type: 'push' },
      decision: { deferredPaths: [['src/**']] },
    });
    expect(deferredInitJobs).toHaveLength(1);
    expect(deferredInitJobs[0].initJobInput.jobConfig.deferredPaths).toEqual([['src/**']]);
  });
});

describe('evaluateJobContexts — a filter defers dispatch, never the evaluation', () => {
  // A workflow-level filter routes EVERY job, static ones too, through an init
  // job. That must not skip the per-job block (as the dynamic-field `continue`
  // does): bound contexts, rejecting context rules and the approval hold must
  // match with and without the filter (the no-filter run is the control).
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

    // Control: the context IS resolvable here.
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
    // A held job gets NO init job, or the flow-back dispatches it past its hold.
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
    // The rejection half: a filter must not erase a disabled context's `rejected` verdict.
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
    // A rejected job gets NO init job, or the flow-back carries it past its rule.
    expect(withFilter.deferredInitJobs).toHaveLength(0);
    expect(withFilter.jobContextData.get('build')?.pendingInit).toBeUndefined();
  });

  it('keeps deferring a dynamic job before its evaluation, as it must', async () => {
    // Dynamic values are unknowable here: the block IS skipped and the init result drives it.
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
  // A context reviewer hold REPLACES what `applyStaticApprovalHolds` would mint
  // (both branches guard on `!jobEnvData.approvalHold`), so it must carry every
  // gating source: the context's reviewers, the job's `requireApproval`, and,
  // for a root job (the only kind a workflow gate holds), the workflow's.
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
    // Control: the harness reaches the reviewer branch.
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
    // The workflow hold is root-only (downstream jobs gate on `needs`), so its
    // clauses in a downstream hold would ADD an approver the job never had.
    const hold = await holdFor({
      lockJob: { needs: ['prev'], approval: jobApproval('job-owner') },
      workflow: { approval: wfApproval('wf-owner') },
    });
    expect(keys(hold)).toEqual([`user:${CTX_REVIEWER}`, 'user:job-owner']);
  });

  it('never shrinks the clause set, for a root or a non-root job', async () => {
    // Additive-only: a workflow gate may ADD approvers to a hold, never remove or replace one.
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
    // `scope` drives resume: job-scoped and context-triggered regardless of clause sources.
    const hold = await holdFor({ workflow: { approval: wfApproval('wf-owner') } });
    expect(hold?.scope).toBe(HoldScope.enum.job);
    expect(hold?.triggerSource).toBe(TriggerSource.enum.context);
    expect(hold?.contextId).toBe('env-prod');
  });
});

describe('evaluateJobContexts — a dynamic field defers dispatch, and the hold follows it', () => {
  // A dynamic-field job's hold is minted in the FLOW-BACK: `held` before init
  // makes `applyContextRulesAndSecrets` skip its `!held` block, so context vars,
  // secrets and registry auth never reach the stored input release dispatches.
  // This seam guarantees DEFERRAL only; holding is covered by "a held job whose
  // dynamic fields defer", secrets by "a held dynamic job keeps its context secrets".
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
      // Init must run: only it resolves dynamic values, else the job is undispatchable.
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
    // Control: the dynamic field drives deferral, not the approval.
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
  // The flow-back's guard: no rejected or held job gets an init job, so the
  // Gated branch is unreachable via dispatchMatchedWorkflow; the predicate is
  // exported to test it directly.
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
    // An older agent reports nothing; reading absence as "suppress" stops every dispatch.
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

describe('initDispatchSuppression — deferred paths', () => {
  const open = { rejected: false, held: false };
  it('suppresses when the agent reports the paths did not match', () => {
    expect(initDispatchSuppression({}, { pathsPassed: false }, open)).toBe(
      InitDispatchSuppression.Paths,
    );
  });
  // breaks-if-wrong: an agent that predates deferred paths reports no verdict
  it('dispatches when no paths verdict was reported', () => {
    expect(initDispatchSuppression({}, {}, open)).toBeNull();
  });
  it('checks paths before the filter', () => {
    expect(
      initDispatchSuppression(
        { hasFilter: true },
        { pathsPassed: false, filterPassed: false },
        open,
      ),
    ).toBe(InitDispatchSuppression.Paths);
  });
  it('a passing paths verdict leaves the filter to decide', () => {
    expect(
      initDispatchSuppression(
        { hasFilter: true },
        { pathsPassed: true, filterPassed: false },
        open,
      ),
    ).toBe(InitDispatchSuppression.Filter);
  });
});

describe('dispatchMatchedWorkflow — a held job whose dynamic fields defer', () => {
  // A job can be BOTH held (approval from the lock file) and pendingInit. The
  // dispatch loop skips it: release dispatches stored input verbatim, so only
  // the flow-back, holding resolved values, may store the hold.
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

  /** Kysely surface for the context upsert, org settings and concurrency count. */
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
      // holdJobForApproval writes row and context in one transaction.
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
    // Positive control without the approval: init runs, the job is dispatched,
    // no hold, so the assertions below are not vacuous.
    const { create, names } = await run({});
    expect(names).toEqual([INIT_JOB_NAME, 'build']);
    expect(create).not.toHaveBeenCalled();
  });

  it('holds a dynamic job with requireApproval instead of dispatching it', async () => {
    const { create, names } = await run({ jobApproval: APPROVAL });
    // Init still runs (only it resolves the dynamic env); the job is not dispatched.
    expect(names).toEqual([INIT_JOB_NAME]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('stores a pending context carrying the values the init round resolved', async () => {
    // `dispatchReadyJob` dispatches STORED input verbatim, so a dispatch-loop
    // hold would run with dynamic env unresolved; only the stored context shows it.
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

  it('marks a dynamic-only local working-tree run as local when it bootstraps the row', async () => {
    // No static job: the run registers through the deferred bootstrap.
    // fails-when: that bootstrap drops localWorkingTree, so no status frame
    // marks a `kici run remote` upload of a dynamic-only workflow
    // breaks-if-wrong: a webhook run (localWorkingTree false) must stay unmarked
    for (const localWorkingTree of [true, false]) {
      const tracker = makeTracker(vi.fn());
      const columnWrites: Record<string, unknown>[] = [];
      const update = {
        set: (cols: Record<string, unknown>) => {
          columnWrites.push(cols);
          return update;
        },
        where: () => update,
        execute: async () => [],
      };
      const { ctx } = makeSingleJobContext({
        bundle: {
          normalizer: { provider: 'local' },
        } as unknown as WorkflowDispatchContext['bundle'],
        fullRepo: true,
        withDynamicEntry: true,
        db: { ...makeDb(), updateTable: () => update },
        localWorkingTree,
        // The same pending-registry shape, tracking a dynamic eval that yields no jobs.
        pendingDynamics: { ...makePendingInits({}), track: vi.fn(async () => []) },
        executionTracker: tracker,
      });
      ctx.workflow = {
        ...ctx.workflow,
        jobs: ctx.workflow.jobs.filter((j) => j._type !== 'static'),
      };

      await dispatchMatchedWorkflow(ctx);
      await new Promise((r) => setTimeout(r, 50));

      expect(tracker.onExecutionStarted).toHaveBeenCalledTimes(1);
      const call = tracker.onExecutionStarted.mock.calls[0] as unknown[];
      expect(call[9]).toEqual([]);
      expect(call[20]).toBe(localWorkingTree);
      // The row is marked too: the bootstrap is its only writer.
      expect(columnWrites.some((c) => c.local_working_tree === true)).toBe(localWorkingTree);
    }
  });

  it('holds every child of a dynamic matrix, not one placeholder', async () => {
    // A static matrix gets one hold PER CHILD. A dynamic one is a placeholder
    // until init, so the hold must fan out after it, or approval resumes one
    // un-expanded job instead of N.
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
    // The id discriminates, not the name: DISPATCHED registers the real job id,
    // HELD the `needs-pending-` placeholder release swaps out.
    expect(build?.jobId.startsWith(NEEDS_PENDING_JOB_ID_PREFIX)).toBe(true);
  });

  it('gates every child of a dynamic matrix against the context concurrency limit', async () => {
    // `dispatchResolvedDynamicMatrix` expands AFTER the placeholder was gated,
    // so each child (`{ ...baseEnvData }`) must be gated again, not dispatched
    // against one checked slot. `queue` with `holdType: 'concurrency'` is not a
    // reviewer hold, so it goes through `heldRunStore.create`, not `createHold`;
    // both are stubbed so a wrong-branch hold still shows.
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

    // Two slots, three combinations: two dispatch, the third gets a hold row.
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
    // The placeholder is gated, then REPLACED by its children; release its
    // reservation first, or N children consume N+1 slots.
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

  it('counts a sibling whose row already landed once, not twice', async () => {
    // Deferred-init double-count: unlike the sync path (gating before any
    // `execution_jobs` row exists), the flow-back gates matrix children one at
    // a time, so the first child has a real row AND sits in the admission
    // tally. Counting both reads 2 against a limit of 2: an OVER-HOLD. Changing
    // what the count counts must be reconciled against the tally.
    const rows: SlotRow[] = [];
    const create = vi.fn().mockResolvedValue({ id: 'held-conc-3' });
    const createHold = vi.fn().mockResolvedValue({ id: 'held-conc-3-approval' });
    const addJobsToRun = vi.fn();
    const tracker = makeTracker(addJobsToRun);
    // Each registered job becomes a visible `running` row before the next gate reads.
    addJobsToRun.mockImplementation(
      async (runId: string, jobs: Array<{ jobId: string; jobName: string }>) => {
        for (const job of jobs) {
          rows.push({
            run_id: runId,
            job_id: job.jobId,
            job_name: job.jobName,
            status: ExecutionJobStatus.enum.running,
            context: 'prod',
            customer_id: '__default__',
          });
        }
      },
    );
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
      db: makeSlotCountingDb(rows),
      executionTracker: tracker,
    });

    await dispatchMatchedWorkflow(ctx);
    await new Promise((r) => setTimeout(r, 50));

    // Two children, two slots: both dispatch and nothing is held.
    const childNames = dispatched.map((d) => d.jobName).filter((n) => n !== INIT_JOB_NAME);
    expect(childNames).toHaveLength(2);
    expect(create).not.toHaveBeenCalled();
    expect(createHold).not.toHaveBeenCalled();
    // Control: the fake saw the first child's row (not an always-zero count).
    expect(rows.map((r) => r.job_name)).toEqual(childNames);
  });

  it('still counts another run occupying the same group', async () => {
    // The exclusion is keyed on (this run, these names): a same-named job in a
    // DIFFERENT run still occupies its slot. A name-only exclusion fails here.
    const create = vi.fn().mockResolvedValue({ id: 'held-conc-4' });
    const createHold = vi.fn().mockResolvedValue({ id: 'held-conc-4-approval' });
    const rows: SlotRow[] = [
      {
        run_id: 'run-other',
        job_id: 'job-other',
        job_name: 'build (a)',
        status: ExecutionJobStatus.enum.running,
        context: 'prod',
        customer_id: '__default__',
      },
    ];
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      withDeferredInit: true,
      jobContext: 'prod',
      contextConcurrencyLimit: 1,
      pendingInits: makePendingInits({ matrixValues: [{ variant: 'a' }] }),
      heldRunStore: { createHold, create },
      db: makeSlotCountingDb(rows),
      executionTracker: makeTracker(vi.fn()),
    });

    await dispatchMatchedWorkflow(ctx);
    await new Promise((r) => setTimeout(r, 50));

    expect(dispatched.map((d) => d.jobName).filter((n) => n !== INIT_JOB_NAME)).toEqual([]);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('dispatchMatchedWorkflow — a STATIC context on a dynamic-field job still applies', () => {
  // `evaluateJobContexts` skips the per-job block for any dynamic field, so the
  // flow-back must also apply a STATIC context when another field (`dynamicEnv`)
  // is dynamic: gates, vars and secrets. The agent cannot help: init-runner
  // emits `contextNames` only under `flags.dynamicContext`; the orchestrator
  // has the names in the lock file.
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
        resolveForContext: async () => ({ DEPLOY_TOKEN: 'sekrit' }),
        resolveNamedInternal: async () => null,
        resolveForContextWithMeta: async () => ({}),
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
    // A disabled context must reject the job, not let it dispatch.
    const dispatched = await run({ enabled: false });
    expect(dispatched.map((d) => d.jobName)).not.toContain('build');
  });
});

describe('applyInitResultContext — the agent-resolved concurrency group is used', () => {
  // `init-runner.ts` reports a dynamicConcurrencyGroup as
  // `initResult.concurrencyGroup`; the job must gate under it, not the CONTEXT
  // name, or it shares a limit with everything bound to the context.
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
                // A limit, so the gate evaluates and the group matters.
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

    // The running count is scoped to the agent-resolved group.
    expect(capturedGroups).toContain('deploy-queue');
    expect(capturedGroups).not.toContain('prod');
  });
});

describe('dispatchMatchedWorkflow — a held job is held on the cluster path too', () => {
  // With a peer connected, `dispatchableJobs` filters out held jobs, so the
  // cluster branch must still write the held_runs row, pending context and
  // placeholder, or the job vanishes, the run succeeds without it, and no
  // approval appears in any queue.
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

describe('dispatchMatchedWorkflow — a held dynamic job stores its context resolution record', () => {
  // The static hold is minted in the flow-back, AFTER init names the context
  // and `applyContextRulesAndSecrets` admits it. Stored input carries the
  // init-resolved env and no context secret; release resolves secrets from
  // the stored context resolution record.
  it('stores the context resolution record for a job held with a dynamic env', async () => {
    const createHold = vi.fn().mockResolvedValue({ id: 'held-sec-1' });
    const { ctx } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      withDynamicEnv: true,
      // DYNAMIC: the only case `applyInitResultContext` delegates to
      // `applyContextRulesAndSecrets`, the ordering under test.
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
        resolveForContext: async () => ({ DEPLOY_TOKEN: 'sekrit' }),
        resolveNamedInternal: async () => null,
        resolveForContextWithMeta: async () => ({}),
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
    // The init-resolved env survives…
    expect(pending?.jobInput.jobConfig.jobEnv).toEqual({ RESOLVED: 'yes' });
    // fails-when: the flow-back stores the held job without running its context rules, so no record exists
    expect(pending?.contextResolution?.contexts).toEqual([{ name: 'prod', id: 'env-prod' }]);
    // …and the context secret stays out of the stored input.
    expect(JSON.stringify(pending?.jobInput)).not.toContain('sekrit');
  });
});

describe('dispatchMatchedWorkflow — a non-reviewer context hold is resumable', () => {
  // A wait-timer gate sets held=true but NO approvalHold. holdJobForApproval
  // must still register the job and store its context, or `isRunComplete`
  // passes and the run succeeds while a gated job never ran.

  /** Kysely surface for the concurrency count, context upsert and their shared transaction. */
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
      // holdJobForApproval writes row and context in one transaction.
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
    // Same handle back, so storePendingJobContext takes `trx` unchanged.
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
        resolveForContext: async () => ({}),
        resolveNamedInternal: async () => null,
        resolveForContextWithMeta: async () => ({}),
      },
      executionTracker: {
        addJobsToRun,
        onExecutionStarted: vi.fn(),
        onJobStatus: vi.fn(),
        holdRunForPendingJobs: vi.fn().mockReturnValue(true),
        releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
        // Reached only if no placeholder is pushed: empty dispatchedJobs takes
        // the init-failure/skip path (`dispatchedJobs.length === 0`); a held
        // job's placeholder leaves this unused.
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
  // `applyContextRulesAndSecrets`, the path's only `evaluateProtectionRules`
  // caller, is in the per-job block the dynamic deferral skips. The flow-back
  // must run every rule for init-resolved contexts: `enabled`, branch
  // restriction, minimum trust, concurrency limit, required reviewers and
  // wait timer, not just the test-run fail-safe.
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
      // holdJobForApproval writes row and context in one transaction.
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
        resolveForContext: async () => ({}),
        resolveNamedInternal: async () => null,
        resolveForContextWithMeta: async () => ({}),
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
    // Positive control: a build dispatching nothing would satisfy both assertions below.
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
    // The static collector cannot record this rejection (init names the context
    // after it ran), so the flow-back records it, not just a `logger.warn`.
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
    // Without the row the run finishes GREEN (`__init__` is its one terminal
    // job). The row must precede finalization, or it attaches a non-terminal job
    // to a completed run.
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
    // Two tokens: the dispatch window (released when sync dispatch returns) and
    // the init round (released in the task's `.finally()`). The row must
    // precede the LAST release, which finalizes.
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
    // The init job ran (the verdict's source); the workflow's job was not dispatched.
    expect(names).toEqual([INIT_JOB_NAME]);
  });

  it('dispatches the job when the filter passes', async () => {
    // Positive control: only the verdict differs, and it dispatches.
    const names = await dispatchWith({ filterPassed: true });
    expect(names).toEqual([INIT_JOB_NAME, 'build']);
  });

  it('carries hasFilter on the dynamic eval job so a generator cannot bypass the filter', async () => {
    // A generator-only workflow has no static job to carry the filter and a
    // mixed one would half-dispatch, so the eval job gates the generator.
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
    // Against a rogue agent: the verdict counts only when the workflow declares a filter.
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
    // An older agent omits `filterPassed`; only an explicit `false` suppresses,
    // or every dispatch it handles stops.
    const names = await dispatchWith({});
    expect(names).toEqual([INIT_JOB_NAME, 'build']);
  });
});

describe('dispatchMatchedWorkflow — deferred paths decided on the agent', () => {
  const INIT_JOB_NAME = '__init__ci__build';

  async function dispatchDeferred(initResult: Record<string, unknown>): Promise<{
    names: string[];
    initConfig: Record<string, unknown> | undefined;
  }> {
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      pendingInits: {
        track: vi.fn(async () => initResult),
        resolve: vi.fn(),
        reject: vi.fn(),
        has: vi.fn().mockReturnValue(false),
        cleanup: vi.fn(),
      },
    });
    ctx.decision = { ...ctx.decision, deferredPaths: [['src/**']] };
    await dispatchMatchedWorkflow(ctx);
    await new Promise((r) => setTimeout(r, 50));
    const init = dispatched.find((d) => d.jobName === INIT_JOB_NAME);
    return { names: dispatched.map((d) => d.jobName), initConfig: init?.jobConfig };
  }

  // fails-when: a paths no-match from the agent still dispatches the workflow's job
  it('dispatches only the __init__ job when the agent reports pathsPassed:false', async () => {
    const { names, initConfig } = await dispatchDeferred({ pathsPassed: false });
    expect(names).toEqual([INIT_JOB_NAME]);
    expect(initConfig?.deferredPaths).toEqual([['src/**']]);
  });

  it('dispatches the job when the paths match', async () => {
    const { names } = await dispatchDeferred({ pathsPassed: true });
    expect(names).toEqual([INIT_JOB_NAME, 'build']);
  });

  // breaks-if-wrong: an agent that ignores deferredPaths returns no verdict and must still dispatch
  it('dispatches when the agent reports no paths verdict (an older agent)', async () => {
    const { names } = await dispatchDeferred({});
    expect(names).toEqual([INIT_JOB_NAME, 'build']);
  });

  it('carries the deferred paths on the dynamic eval job', async () => {
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
    ctx.decision = { ...ctx.decision, deferredPaths: [['src/**']] };
    await dispatchMatchedWorkflow(ctx);
    await new Promise((r) => setTimeout(r, 50));

    const evalJob = dispatched.find((d) => d.jobName.startsWith('__dynamic__'));
    expect(evalJob).toBeDefined();
    expect(evalJob!.jobConfig.deferredPaths).toEqual([['src/**']]);
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
    // The History tab keys off context_id, so the run write carries the env id
    // with the context name (matchContext returns `id: env-<name>`).
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
      // holdJobForApproval writes row and context in one transaction.
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
        resolveForContext: async () => ({}),
        resolveNamedInternal: async () => null,
        resolveForContextWithMeta: async () => ({}),
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
  // ctx.extraJobConfig.checkMode (`--check` / `--check --fail-on-drift`) MUST
  // reach onExecutionStarted's checkMode argument so execution_runs.check_mode
  // persists, or computeRunStatus can never fail a drifted run.
  //
  // Indexed from the FRONT: the distance from the END moves whenever a
  // trailing argument is added.
  //
  // 0 runId · 1 workflowName · 2 provider · 3 repoIdentifier · 4 ref · 5 sha ·
  // 6 deliveryId · 7 providerContext · 8 triggerDecision · 9 jobs ·
  // 10 routingKey · 11 dispatchedContexts · 12 triggerEvent · 13 commitMessage ·
  // 14 parentRunId · 15 triggeredBy · 16 originalRunId · 17 concurrency ·
  // 18 workflowTimeoutMs · 19 checkMode
  const CHECK_MODE_ARG_INDEX = 19;

  function lastCallCheckMode(mock: ReturnType<typeof vi.fn>): unknown {
    return mock.mock.calls.at(-1)?.[CHECK_MODE_ARG_INDEX];
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
    const job = staticJob({
      name: 'deploy',
      steps: [],
      runsOn: [],
      rules: [],
      approval: { clauses: [], timeoutSeconds: -5 },
    });
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
 * RECORDS what the real `ExecutionTracker` writes. The production tracker,
 * not a `vi.fn()` stub: all three fields fail silently when unthreaded, and a
 * call assertion passes against a recorder that drops them.
 */
function makeRecordingRunDb() {
  const runInserts: Array<Record<string, unknown>> = [];
  const runUpdates: Array<{ set: Record<string, unknown>; runId: string | undefined }> = [];
  // Ordered `execution_runs` log, to assert WHEN the chain-depth write landed.
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
          // Pre-dispatch sites put the depth ON the insert, so ordering sees one op kind.
          if ('chain_depth' in v) ops.push('chain-depth-write');
        }
        return {
          onConflict: () => ({
            execute: async () => undefined,
            // `recordInitFailureRun` suppresses its forward unless
            // `guardedWriteApplied` sees the row land.
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
            ops.push(
              'chain_depth' in captured
                ? 'chain-depth-write'
                : 'trust_tier' in captured
                  ? 'trust-tier-write'
                  : 'update',
            );
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
type RunRowOp =
  'insert' | 'update' | 'chain-depth-write' | 'trust-tier-write' | 'dispatch' | 'gate-read';

/** The run row after dispatch (INSERT plus merged UPDATEs), as a later reader sees it. */
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
 * Serves `releaseInvokeGate` the dispatched run row, logging its read in the
 * SAME op log to order it against the chain-depth write.
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

/** Dispatches through the REAL `ExecutionTracker`; returns its writes and forwarded run contexts. */
async function dispatchWithRealTracker(
  over: Partial<
    Pick<
      WorkflowDispatchContext,
      | 'triggerEventOverride'
      | 'chainDepth'
      | 'dispatchedByFailureLifecycle'
      | 'securityDecision'
      | 'runId'
      | 'trustResolution'
      | 'lockFileSource'
    >
  >,
  /** WORKFLOW knobs for the install-gate hold (`installEnv:` plus a context returning `wait`). */
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
    // Same object in `ctx.workflow` and `ctx.fullLockFile.workflows[0]`.
    (ctx.workflow as { installEnv?: readonly string[] }).installEnv = harness.installEnv;
  }
  Object.assign(ctx, over);

  // Log agent dispatch in the SAME stream as run-row writes, or "written
  // before dispatch" is unfalsifiable.
  const inner = ctx.deps.dispatcher.dispatch.bind(ctx.deps.dispatcher);
  (ctx.deps.dispatcher as { dispatch: unknown }).dispatch = async (input: QueuedJobInput) => {
    ops.push('dispatch');
    return inner(input);
  };

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
    // The flag `EventRouter.isFailureLifecycleRun` reads...
    expect(decision.dispatchedByFailureLifecycle).toBe(true);
    // ...merged (not replaced) with the summary, keeping match provenance.
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
    // A blank string is not a value; `??` alone lets it render "what fired this?" empty.
    const { forwarded } = await dispatchWithRealTracker({ triggerEventOverride: ov });

    expect(forwarded.length).toBeGreaterThan(0);
    expect(forwarded[0].triggerEvent).toBe('push');
  });
});

// ---------------------------------------------------------------------------
// Pre-dispatch recording sites (hold / init failure)
// ---------------------------------------------------------------------------

describe('dispatchMatchedWorkflow — a run recorded before dispatch keeps its chain depth', () => {
  // Install-gate hold, trust-policy hold/reject and init-failure skip write
  // their row and RETURN, so nothing later stamps them. A resumed summoned run
  // fires its own invoke gate, and a lost depth reads `0` ("starts a chain"),
  // failing the breaker OPEN. Assert the row payload, not a mock call.

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
    // A summoned run held by the install gate, a different branch from the
    // trust-policy hold (`resolveWorkflowInstallSecrets` → `held`).
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
    // Terminal with no resume, so no gate reads the depth; it is stamped because
    // the row is the run's only record, and 0 would claim it started the chain.
    // Reached only when the build throws before registration (`ensureBuild`
    // never calls its closure).
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
    // HELD is load-bearing: the resumed run completes on this row, and a
    // `workflows_failed_batch` accumulator would fold it into its spawning
    // batch. Reject records it for consistency (it emits no completion event).
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
  /** An inert `releaseInvokeGate` tracker. */
  function gateTrackerStub() {
    return {
      findSyntheticJobId: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as ExecutionTracker;
  }

  it('a gate released after a HELD dispatch reads the stamped depth and refuses to summon', async () => {
    // One chain: the held run's depth arrives on the pre-dispatch INSERT (not
    // `stampChainDepth`), the settled row is read back by the real breaker.
    // Lose the write and the breaker reads 0 and summons (unbounded
    // recursion), so this fails LOUDLY.
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

  it('stamps the trust tier before any job reaches an agent', async () => {
    // The relay gates declared git credentials on `execution_runs.trust_tier`,
    // and NULL reads LENIENTLY. `recordRunStart` is post-dispatch and
    // fire-and-forget, so without this stamp a fork PR gets credentials for the
    // dispatch window, and forever if that write fails.
    const { ops, runUpdates } = await dispatchWithRealTracker({
      trustResolution: {
        tier: 'unknown',
        contributorUsername: 'outside-contributor',
      } as WorkflowDispatchContext['trustResolution'],
    });

    const stamp = ops.indexOf('trust-tier-write');
    const dispatch = ops.indexOf('dispatch');
    // Both markers present, or `indexOf` -1 satisfies the ordering by accident.
    expect(stamp).toBeGreaterThanOrEqual(0);
    expect(dispatch).toBeGreaterThanOrEqual(0);
    // Load-bearing: `recordRunStart` writes this column too, so checking the
    // insert alone would pass on the post-dispatch write this stamp front-runs.
    expect(stamp).toBeLessThan(dispatch);

    // Positive control pinning WHICH write: same columns, so order separates
    // them; the stamp first, `recordRunStart` second, both present.
    const tierWrites = runUpdates.filter((u) => 'trust_tier' in u.set);
    expect(tierWrites.length).toBeGreaterThanOrEqual(2);
    expect(tierWrites[0].set.trust_tier).toBe('unknown');
  });

  it('stamps the lock-file source in that same write, never a tier on its own', async () => {
    // `lock_file_source` records that a fork's own definitions were NOT
    // evaluated; readers render NULL as "no reduced-privilege posture", the
    // same lenient read. Stamped with the tier, or the row shows a resolved
    // `unknown` tier with no lock source, a state a fork PR must never show.
    const { runUpdates, ops } = await dispatchWithRealTracker({
      trustResolution: {
        tier: 'unknown',
        contributorUsername: 'outside-contributor',
      } as WorkflowDispatchContext['trustResolution'],
      lockFileSource: 'base',
    });

    // The FIRST write carrying the tier is the stamp, before any job reaches an agent.
    const stamped = runUpdates.find((u) => 'trust_tier' in u.set);
    expect(stamped).toBeDefined();
    expect(ops.indexOf('trust-tier-write')).toBeLessThan(ops.indexOf('dispatch'));
    expect(ops.indexOf('dispatch')).toBeGreaterThanOrEqual(0);

    expect(stamped!.set.lock_file_source).toBe('base');
    expect(stamped!.set.contributor_username).toBe('outside-contributor');
  });

  it('writes no lock_file_source for a dispatch that selects no lock-file branch', async () => {
    // Control against "always write a constant": internal events and CLI test
    // runs select no lock-file branch (`lockFileSource` undefined), so the
    // column is absent, not a value or explicit NULL.
    const { runUpdates } = await dispatchWithRealTracker({
      trustResolution: {
        tier: 'trusted',
        contributorUsername: 'maintainer',
      } as WorkflowDispatchContext['trustResolution'],
    });

    const stamped = runUpdates.find((u) => 'trust_tier' in u.set);
    expect(stamped).toBeDefined();
    expect(stamped!.set.trust_tier).toBe('trusted');
    expect('lock_file_source' in stamped!.set).toBe(false);
  });

  it('stamps the trust context on the run the BUILD path registers, too', async () => {
    // The sibling site `startRunBeforeDispatch` hands off to (returning false):
    // a source-pack workflow registers with `__build__` alone and awaits it. It
    // must stamp trust context too, or the row has none for the build plus
    // static-dispatch window, which covers the job cloning the repository.
    const { db, runInserts, runUpdates, ops } = makeRecordingRunDb();
    const tracker = new ExecutionTracker({ db: db as unknown as Kysely<Database> });
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: { normalizer: { provider: 'local' } } as unknown as WorkflowDispatchContext['bundle'],
      fullRepo: true,
      withBuildMiss: true,
      db,
      executionTracker: tracker,
    });
    (ctx.deps as { buildCoordinator: unknown }).buildCoordinator = {
      ensureBuild: async (_k: string, fn: () => Promise<unknown>) => fn(),
    };
    ctx.trustResolution = {
      tier: 'unknown',
      contributorUsername: 'outside-contributor',
    } as WorkflowDispatchContext['trustResolution'];
    ctx.lockFileSource = 'base';
    // Only the workflow's OWN jobs: `__build__` dispatches before the row exists.
    const inner = ctx.deps.dispatcher.dispatch.bind(ctx.deps.dispatcher);
    (ctx.deps.dispatcher as { dispatch: unknown }).dispatch = async (input: QueuedJobInput) => {
      if (!input.jobName.startsWith('__build__')) ops.push('dispatch');
      return inner(input);
    };

    await dispatchMatchedWorkflow(ctx);

    // Non-vacuity: build path taken, row inserted, a real job dispatched.
    expect(dispatched.map((d) => d.jobName)).toContain('__build__ci');
    expect(runInserts.find((r) => r.run_id === ctx.runId)).toBeDefined();
    const stamp = ops.indexOf('trust-tier-write');
    const dispatch = ops.indexOf('dispatch');
    expect(stamp).toBeGreaterThanOrEqual(0);
    expect(dispatch).toBeGreaterThanOrEqual(0);
    expect(stamp).toBeLessThan(dispatch);

    const stamped = runUpdates.find((u) => 'trust_tier' in u.set);
    expect(stamped!.set.trust_tier).toBe('unknown');
    expect(stamped!.set.lock_file_source).toBe('base');
  });

  it('stamps the depth immediately after the row exists, before anything reads it back', async () => {
    // `stampChainDepth` runs per recording site, NOT at dispatch end; deferring
    // it still passes "write before gate read" but in-dispatch readers see 0.
    const { ops } = await dispatchWithRealTracker({ chainDepth: 4 });

    const insert = ops.indexOf('insert');
    const write = ops.indexOf('chain-depth-write');
    expect(insert).toBeGreaterThanOrEqual(0);
    expect(write).toBe(insert + 1);
  });
});

describe('a fork-PR hold, held and released end to end', () => {
  /**
   * Joins the fork-hold halves (what the hold STORES, what resume PASSES) with
   * the real `dispatchMatchedWorkflow` on both ends, asserting "approving a
   * fork PR runs the workflow".
   */
  it('dispatches the workflow on approval, still under the untrusted tier', async () => {
    clearPendingWorkflowContextsMap();
    const create = vi.fn().mockResolvedValue({ id: 'held-fork-e2e' });
    // The guarded held → pending flip: only the first release finds the row held.
    let held = true;
    const resumeHeldRun = vi.fn(async () => {
      const claimed = held;
      held = false;
      return claimed;
    });
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

    // 1. The policy holds; nothing dispatches.
    const heldResult = await dispatchMatchedWorkflow(ctx);
    expect(heldResult.held).toBe(true);
    expect(dispatched).toHaveLength(0);

    // 2. Force the JSON round trip (a hold outlives its process, so resume reads
    //    a `pending_workflow_contexts` row), ruling out shared object identity.
    const stored = await loadPendingWorkflowContext(undefined, ctx.runId);
    expect(stored).not.toBeNull();
    await storePendingWorkflowContext(undefined, JSON.parse(JSON.stringify(stored)));

    // 3. `/kici approve`: the real resume rebuilds the context and re-enters dispatch.
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

    // The gated work RAN, and the run row left `held`.
    expect(dispatched.length).toBeGreaterThan(0);
    expect(dispatched[0].jobName).toBe('build');
    expect(resumeHeldRun).toHaveBeenCalledWith(ctx.runId);

    // …UNTRUSTED: approval means "let it run", never "make it trusted". The
    // replay skips the trust gate, keeps the stored tier, and creates no second hold.
    expect(setRunTrustContext).toHaveBeenCalledWith(ctx.runId, 'unknown', 'base');
    expect(create).toHaveBeenCalledTimes(1);

    // The context is consumed: a re-fired release is inert.
    expect(await loadPendingWorkflowContext(undefined, ctx.runId)).toBeNull();
  });

  it('dispatches once when the release signal fires twice at the same time', async () => {
    // Both signals load the stored context before either deletes it, so only
    // the claim on the held row can stop the second dispatch.
    clearPendingWorkflowContextsMap();
    let held = true;
    const resumeHeldRun = vi.fn(async () => {
      const claimed = held;
      held = false;
      return claimed;
    });
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: undefined,
      heldRunStore: { create: vi.fn().mockResolvedValue({ id: 'held-twice' }) },
      executionTracker: {
        recordRunHeld: vi.fn().mockResolvedValue(undefined),
        resumeHeldRun,
        onExecutionStarted: vi.fn().mockResolvedValue(undefined),
        addJobsToRun: vi.fn().mockResolvedValue(undefined),
        onJobStatus: vi.fn().mockResolvedValue(undefined),
        holdRunForPendingJobs: vi.fn(() => true),
        releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
        setRunTrustContext: vi.fn(),
      },
    });
    ctx.securityDecision = holdDecision(SecurityHoldReason.enum.fork_pr);
    ctx.lockFileSource = 'base';
    await dispatchMatchedWorkflow(ctx);
    (ctx.deps as unknown as Record<string, unknown>).providerRegistry = {
      getByRoutingKey: () => ({ normalizer: { provider: 'local' } }),
    };
    const signal = {
      holdId: 'held-twice',
      runId: ctx.runId,
      jobId: SECURITY_HOLD_JOB_IDS.fork_pr,
      scope: HoldScope.enum.workflow,
      stepIndex: null,
      triggerSource: TriggerSource.enum.context,
    };

    await Promise.all([
      resumeWorkflow(signal, ctx.deps, undefined),
      resumeWorkflow(signal, ctx.deps, undefined),
    ]);

    // fails-when: the losing release ignores the claim and dispatches the run again
    expect(resumeHeldRun).toHaveBeenCalledTimes(2);
    expect(dispatched.filter((d) => d.jobName === 'build')).toHaveLength(1);
  });
});

describe('dispatchMatchedWorkflow — the run trust posture reaches its call sites', () => {
  /** The fork tier: the one value the posture note and the hold summary must carry. */
  const UNTRUSTED_TIER = 'unknown';

  it('threads the real tier into the security-hold summary and carries the posture note', async () => {
    // `/kici approve` replays under this trust resolution, so the check
    // describes the posture the resumed run executes under.
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeSingleJobContext({
      bundle: {
        normalizer: { provider: 'github' },
        checkStatusPoster: { provider: 'github', postCheckStatus },
      } as unknown as WorkflowDispatchContext['bundle'],
    });
    ctx.securityDecision = holdDecision(SecurityHoldReason.enum.fork_pr);
    ctx.trustResolution = {
      tier: UNTRUSTED_TIER,
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
    expect(String(holdCall![4])).toContain(`(tier: ${UNTRUSTED_TIER})`);
    expect(String(holdCall![4])).toContain(REDUCED_PRIVILEGE_MARKER);
    // `lockFileSource` is 'base': the base-branch clause can only come from the recorded source.
    expect(String(holdCall![4])).toContain('read from the base branch');
  });

  it('leaves the posture note off the trust-policy rejection check', async () => {
    // Control: same tier and source, reject verdict. A rejected run never
    // dispatches, so no note; this proves the note comes from the hold site.
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeSingleJobContext({
      bundle: {
        normalizer: { provider: 'github' },
        checkStatusPoster: { provider: 'github', postCheckStatus },
      } as unknown as WorkflowDispatchContext['bundle'],
    });
    ctx.securityDecision = rejectDecision(SecurityHoldReason.enum.fork_pr);
    ctx.trustResolution = {
      tier: UNTRUSTED_TIER,
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
    expect(String(rejectCall![4])).toContain(`(tier: ${UNTRUSTED_TIER})`);
    expect(String(rejectCall![4])).not.toContain(REDUCED_PRIVILEGE_MARKER);
  });

  it('stamps the real tier and lock-file source onto the tracked run', async () => {
    // In-memory mirror of this site's two `execution_runs` columns, for completion checks.
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
      tier: UNTRUSTED_TIER,
      contributorUsername: 'octocat',
    } as unknown as WorkflowDispatchContext['trustResolution'];
    ctx.lockFileSource = 'base';

    await dispatchMatchedWorkflow(ctx);

    expect(setRunTrustContext).toHaveBeenCalledWith(ctx.runId, UNTRUSTED_TIER, 'base');
  });

  it('still records the rest of the run when the stamp cannot be applied', async () => {
    // `recordRunStart`'s post-start writes are best-effort (each `.catch()`es):
    // a tracker without the method costs only the note.
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
      tier: UNTRUSTED_TIER,
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

  /** `minimum_trust` no fork satisfies, so the per-env gate raises a security-typed hold. */
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
   * Store, database and tracker: without all three `holdJobForApproval`
   * writes nothing, and the check post must not fire.
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
        // Distinct ids: a job with approval and non-approval holds writes BOTH rows.
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
    // Unlike the trust-policy hold (sentinel job id, no context), this stores a
    // pending context, so release re-dispatches under the same untrusted tier.
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
    // No `heldRunStore`: `holdJobForApproval` returns before the transaction.
    // `KiCI Security` checks terminalize only via that row, so a pending post
    // would permanently block branch protection.
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
    // The write is attempted and throws; the row rolls back, so no check either.
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
    // Setup's queued `kici/<workflow>` and per-job checks (distinct from
    // `KiCI Security`) are on the commit when the transaction throws, and no
    // early exit completes them, so they would block branch protection forever.
    // A real throw, not a helper call, proves the catch is wired.
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
    // The completion needs a splittable owner/repo.
    ctx.repoIdentifier = 'acme/app';
    untrustedFork(ctx);

    await expect(dispatchMatchedWorkflow(ctx)).rejects.toThrow('deadlock detected');

    expect(setPendingAwait).toHaveBeenCalledTimes(1);
    expect(completeUndispatchedCheckRuns).toHaveBeenCalledTimes(1);
    const call = completeUndispatchedCheckRuns.mock.calls[0][0];
    expect(call.conclusion).toBe(CheckRunConclusion.enum.failure);
    // Setup's names: a different name creates a second check instead of closing.
    expect(call.jobNames).toEqual(setPendingAwait.mock.calls[0][0].jobNames);
    expect(call.workflowName).toBe(setPendingAwait.mock.calls[0][0].workflowName);
    expect(String(call.summary)).toContain('deadlock detected');
  });

  it('completes no checks when the throw lands before they are posted', async () => {
    // Negative control: a throw inside `setPendingAwait` means nothing was
    // posted, and concluding would CREATE a fabricated failing check.
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
   * Captures the transaction handle: the row going through THIS handle proves
   * it rolls back with the pending context.
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
    // Kysely has no ambient transaction: an insert on the store's own connection
    // commits even if the context write rolls back, leaving an unresumable hold.
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
    // The other arm: a security-typed context gate uses `create`, same pending context.
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
    // The settle reads this record to decide whether to terminalize a check;
    // the row's SHAPE says only what was MEANT, and terminalizing an unposted
    // check creates one.
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
    // Record SECOND: recording first then dying before the post makes the settle fabricate a check.
    expect(order).toEqual(['post', 'record']);
  });

  it('records nothing when the provider refuses the pending security check', async () => {
    // The post failed, so the record must say so, or the settle fabricates a `KiCI Security` run.
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
    // The record follows the post (the reverse fabricates a check), so a
    // failure between them strands an unswept pending check; a retry covers
    // transient DB errors. Two failures then a success is a literal: a count
    // derived from PENDING_CHECK_MARK_ATTEMPTS would still pass at 1.
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
    // Bounded give-up: the mark is best-effort; throwing would strand the hold too.
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
   * SDK `requireApproval` plus a security-typed context gate: the gate mints
   * `nonApprovalHold`, then `applyStaticApprovalHolds` mints `approvalHold`
   * (guarded on `!approvalHold` alone), so the job carries both.
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
    // Two independent requirements, both required. Writing only the reviewer
    // row leaves the trust gate unenforced: the reviewer hold releases on
    // `contexts:write` plus clause eligibility, not `ci_trust:write`, and the
    // resume skips re-resolving trust.
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const { ctx, stubs } = bothHoldsContext(postCheckStatus);

    await dispatchMatchedWorkflow(ctx);

    const store = stubs.heldRunStore as {
      createHold: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
    expect(store.createHold).toHaveBeenCalledTimes(1);
    expect(store.create).toHaveBeenCalledTimes(1);
    // Its own queue type scopes it to `/kici approve`'s `ci_trust:write` surface.
    expect(store.create.mock.calls[0][1]).toMatchObject({
      holdType: HoldType.enum.security,
      queueType: 'security',
    });
    // Both in the transaction carrying the resume context.
    expect(store.createHold.mock.calls[0][2]).toBe(store.create.mock.calls[0][2]);
    expect(store.create.mock.calls[0][2]).toBeDefined();
  });

  it('posts one pending check for a job carrying both a reviewer and a security hold', async () => {
    // One post into the single `KiCI Security` run (two would race on which
    // summary lands), with the reviewer copy: it names actionable clauses.
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
    // Both holds gate the one `KiCI Security` run. Recording only one lets the
    // first to end terminalize it (`success` on approve) while the other still
    // gates: green branch protection over held work. ONE call: the store's
    // `WHERE id IN (…)` marks the pair atomically, with no partial mark.
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
    // One check run, two holds: naming only the approval clauses hides what is
    // still outstanding after the approver approves.
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
    // Control: the line appears only with a security hold, not on a plain `requireApproval`.
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
    // Every approvable hold needs its own access-log entry.
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
    // Approval re-dispatches under this run's trust resolution (row and context
    // share a transaction); the note says what the resumed job will not have.
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
  // Nothing dispatched in THIS pass is in the DB count yet, so without the
  // in-pass tally every fan-out child (static path included) reads the same
  // number and all N are admitted against one slot.
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

    // Two slots, three children: two admitted, the third queued.
    expect(jobContextData.get('build (a)')?.held).toBeUndefined();
    expect(jobContextData.get('build (b)')?.held).toBeUndefined();
    expect(jobContextData.get('build (c)')?.held).toBe(true);
  });

  it('adds the in-pass tally to the running count rather than replacing it', async () => {
    // One running + limit 2 leaves one slot: only the FIRST child is admitted.
    // Fails with the tally alone or the DB count alone (both admitted).
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
    // Control: the same children against an unlimited context all pass.
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
    // A needs-gated job dispatches later via the needs scheduler, so it reserves
    // no slot. If queued, it takes the hold branch (evaluated BEFORE the needs
    // branch), and the queued-hold release dispatches it with no upstream check,
    // beside a pending or FAILED upstream.
    const deployJob = staticJob({
      name: 'deploy',
      runsOn: [{ kind: 'exact', value: 'default' }],
      steps: [{ name: 'echo', run: 'echo hi' }],
      needs: ['build'],
      rules: [],
      contexts: [{ value: 'prod' }],
    });
    const { jobContextData } = await runEvaluateJobContexts({
      lockJob: MATRIX_JOB,
      event: { type: 'push' },
      mats: [{ expandedName: 'build' }, { expandedName: 'deploy', lockJob: deployJob }],
      deps: { contextStore: contextStore(1), db: makeCountingDb(0) },
    });

    // The root takes the slot; the needs-gated job sees the DB count alone and
    // passes to the needs scheduler.
    expect(jobContextData.get('build')?.held).toBeUndefined();
    expect(jobContextData.get('deploy')?.held).toBeUndefined();

    // Non-vacuity: as a ROOT job the same second job IS held.
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
    // The tally keeps the slot count's `execution_runs.customer_id` tenant
    // scoping. A pass has one org id, so only the key builder shows it.
    expect(concurrencyAdmissionKey('org-a', 'prod')).not.toBe(
      concurrencyAdmissionKey('org-b', 'prod'),
    );
    expect(concurrencyAdmissionKey('org-a', 'prod')).toBe(concurrencyAdmissionKey('org-a', 'prod'));
    // No delimiter collision: ("a", "b:c") and ("a:b", "c") must stay distinct.
    expect(concurrencyAdmissionKey('a', 'b:c')).not.toBe(concurrencyAdmissionKey('a:b', 'c'));
  });

  describe('a dispatched job occupies its slot before it reports running', () => {
    // `execution_jobs.status` defaults to `pending`, so counting only `running`
    // misses jobs between dispatch and agent report (minutes on a cold cloud
    // agent): five pushes into a limit-1 context would admit five jobs.
    const OTHER_RUN = 'run-other';
    const row = (over: Partial<SlotRow>): SlotRow => ({
      run_id: OTHER_RUN,
      job_id: 'job-abc',
      job_name: 'deploy',
      status: ExecutionJobStatus.enum.pending,
      context: 'prod',
      customer_id: '__default__',
      ...over,
    });

    async function gate(rows: SlotRow[], stats?: { slotQueries: number }) {
      const { jobContextData } = await runEvaluateJobContexts({
        lockJob: MATRIX_JOB,
        event: { type: 'push' },
        deps: { contextStore: contextStore(1), db: makeSlotCountingDb(rows, stats) },
      });
      return jobContextData.get('build');
    }

    it('holds a job when another run holds the only slot at status pending', async () => {
      // Dispatched, not yet reported running.
      expect((await gate([row({})]))?.held).toBe(true);
    });

    it('admits the same job when the group is empty', async () => {
      // Control and promptness: one run into an empty limit-1 group dispatches unheld.
      expect((await gate([]))?.held).toBeUndefined();
    });

    it('does not let a needs-pending placeholder occupy a slot', async () => {
      // A held-back job is registered under a `needs-pending-` id; it reached no
      // agent and occupies nothing, or a queued hold occupies its own release slot.
      const placeholder = row({ job_id: `${NEEDS_PENDING_JOB_ID_PREFIX}deploy-abcdef` });
      expect((await gate([placeholder]))?.held).toBeUndefined();
    });

    it('does not let a finished job occupy a slot', async () => {
      expect(
        (await gate([row({ status: ExecutionJobStatus.enum.success })]))?.held,
      ).toBeUndefined();
    });

    it('ignores a job in the same context that belongs to another org', async () => {
      expect((await gate([row({ customer_id: 'other-org' })]))?.held).toBeUndefined();
    });

    it('reads the slot count exactly once per gated job', async () => {
      // No extra round trip per gate: the exclusion rides on the one count query.
      const stats = { slotQueries: 0 };
      expect((await gate([], stats))?.held).toBeUndefined();
      expect(stats.slotQueries).toBe(1);
    });

    it('leaves no second definition of an occupied slot in the dispatch path', async () => {
      // This gate, the ready re-gate and the release sweep read ONE definition;
      // a private copy in the dispatch path lets them fork. The positive
      // control proves the read sees the file.
      const source = await readFile(
        new URL('./dispatch-matched-workflow.ts', import.meta.url),
        'utf8',
      );
      expect(source).toContain('countOccupyingJobs');
      expect(source).not.toContain('countRunningJobsInGroup');
    });
  });
});

describe('resolveGeneratedJobConfigs gitCredentials', () => {
  const DECLARED = {
    default: { kind: 'token', tokenSecret: 'ci:FORGE_PAT' },
  } as const;

  const genLockJob = (name: string, extra: Record<string, unknown> = {}) =>
    ({
      _type: 'static',
      name,
      runsOn: [{ kind: 'exact', value: 'linux' }],
      steps: [],
      needs: [],
      ...extra,
    }) as never;

  async function resolve(args: {
    dynamicEntry: Record<string, unknown>;
    generatedJobs: unknown[];
  }): Promise<GeneratedJobConfig[]> {
    const { dispatchable } = await resolveGeneratedJobConfigs({
      ctx: {
        deps: {} as never,
        runId: 'run-1',
        resolvedOrgId: 'org-1',
        event: {} as never,
        info: { routingKey: 'rk' },
      } as never,
      workflow: { name: 'ci', source: 'ci.ts' } as never,
      fullLockFile: { source: 'ci.ts' } as never,
      runPublicKeyBase64: undefined,
      npmRegistries: undefined,
      installEnvSecrets: undefined,
      generatedJobs: args.generatedJobs as never,
      dynamicEntry: args.dynamicEntry as never,
    });
    return dispatchable;
  }

  it("copies the generator's lock-declared map onto every child", async () => {
    const out = await resolve({
      dynamicEntry: {
        _type: 'dynamic',
        source: { file: 'ci.ts', index: 0 },
        gitCredentials: DECLARED,
      },
      generatedJobs: [genLockJob('shard-a'), genLockJob('shard-b')],
    });
    expect(out).toHaveLength(2);
    for (const cfg of out) {
      expect(cfg.genJobConfig.gitCredentials).toEqual(DECLARED);
      expect(cfg.gitCredentials).toEqual(DECLARED);
    }
  });

  it('carries no map when the generator declared none', async () => {
    const out = await resolve({
      dynamicEntry: { _type: 'dynamic', source: { file: 'ci.ts', index: 0 } },
      generatedJobs: [genLockJob('shard-a')],
    });
    expect(out).toHaveLength(1);
    expect('gitCredentials' in out[0].genJobConfig).toBe(false);
    expect(out[0].gitCredentials).toBeUndefined();
  });

  it('ignores a gitCredentials map arriving on the agent reply', async () => {
    // Load-bearing: `generatedJobs` is unvalidated agent JSON
    // (`msg.data.dynamicJobs`); a map from it would let job code name any org credential.
    const FORGED = { default: { kind: 'token', tokenSecret: 'ci:ROOT_PAT' } };
    const out = await resolve({
      dynamicEntry: {
        _type: 'dynamic',
        source: { file: 'ci.ts', index: 0 },
        gitCredentials: DECLARED,
      },
      generatedJobs: [genLockJob('shard-a', { gitCredentials: FORGED })],
    });
    expect(out[0].genJobConfig.gitCredentials).toEqual(DECLARED);
    expect(out[0].gitCredentials).toEqual(DECLARED);
  });

  it('refuses everything when the agent forges a map onto an undeclared generator', async () => {
    const FORGED = { default: { kind: 'token', tokenSecret: 'ci:ROOT_PAT' } };
    const out = await resolve({
      dynamicEntry: { _type: 'dynamic', source: { file: 'ci.ts', index: 0 } },
      generatedJobs: [genLockJob('shard-a', { gitCredentials: FORGED })],
    });
    // Nothing declared or persisted: the relay refuses every workflow ref (fail-closed).
    expect('gitCredentials' in out[0].genJobConfig).toBe(false);
    expect(out[0].gitCredentials).toBeUndefined();
  });
});

describe('dispatchMatchedWorkflow — a routed job carries the test-run provenance', () => {
  // A coordinator routes through the BASE dispatcher (here or a peer), skipping
  // the wrapper's extraJobConfig merge, so every relayed `kici run remote`
  // needs the bake, or the agent gets no fullRepo / tarballUrl / isTestRun and
  // clones an empty repoUrl instead of unpacking the overlay.
  it('bakes ctx.extraJobConfig into the JobToRoute jobConfig', async () => {
    const routeJobs = vi.fn().mockResolvedValue({
      localJobs: [{ jobName: 'build', jobId: 'routed-1' }],
      remoteJobs: [],
      reroutedJobs: [],
      failedJobs: [],
    });
    const { ctx, dispatched } = makeSingleJobContext({
      bundle: undefined,
      fullRepo: true,
      executionTracker: {
        addJobsToRun: vi.fn().mockResolvedValue(undefined),
        onExecutionStarted: vi.fn(),
        onJobStatus: vi.fn(),
        holdRunForPendingJobs: vi.fn().mockReturnValue(true),
        releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
        recordInitFailureRun: vi.fn().mockResolvedValue(undefined),
      },
    });
    ctx.extraJobConfig = {
      ...ctx.extraJobConfig,
      fullRepo: true,
      tarballUrl: 'https://storage.example/overlay.tgz',
    };
    (ctx.deps as unknown as Record<string, unknown>).coordinator = {
      hasConnectedPeers: () => true,
      routeJobs,
    };

    await dispatchMatchedWorkflow(ctx);

    // fails-when: a JobToRoute is built from buildJobConfig() alone — the
    // shape that shipped — so the routed jobConfig has none of these keys.
    expect(routeJobs).toHaveBeenCalledTimes(1);
    const routed = routeJobs.mock.calls[0][1] as Array<{ jobConfig: Record<string, unknown> }>;
    expect(routed).toHaveLength(1);
    expect(routed[0].jobConfig).toMatchObject({
      isTestRun: true,
      fixtureId: 'fx-1',
      fullRepo: true,
      tarballUrl: 'https://storage.example/overlay.tgz',
    });
    // breaks-if-wrong: the merge must not displace the lock-derived config the
    // agent runs from, and the routed job is the coordinator's, not the
    // wrapper's — nothing reaches the local capturing dispatcher.
    expect(routed[0].jobConfig.name).toBe('build');
    expect(dispatched).toHaveLength(0);
  });
});
