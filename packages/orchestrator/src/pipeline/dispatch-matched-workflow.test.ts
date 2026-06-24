import { describe, it, expect, vi } from 'vitest';
import {
  runsOnSelectorsForLockJob,
  partitionGeneratedConfigsByPin,
  materializeStaticJobsSafe,
  resolveHostFanoutTargets,
  dispatchMatchedWorkflow,
  type GeneratedJobConfig,
  type WorkflowDispatchContext,
} from './dispatch-matched-workflow.js';
import { ExecutionJobStatus, FanoutError, FanoutCause, HostTargetSelector } from '@kici-dev/engine';
import { HostStatus, type MatchedHost } from '../agent/host-roster.js';
import type { ProcessingDeps } from './processor.js';
import type { QueuedJobInput } from '../queue/job-queue.js';
import type { LockWorkflow, SimulatedEvent, WorkflowDecision } from '@kici-dev/engine';
import type { WebhookInfo } from '../webhook/handler.js';
import { consumePendingJobContext } from './processor.js';

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
 * fired (environment, trust, test-run).
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
  runWideFlatSecrets?: Record<string, string>;
  jobEnvironment?: string;
  secretResolver?: unknown;
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
        ...(over.jobEnvironment ? { environment: over.jobEnvironment } : {}),
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
    // An env-declaring job needs an environment store so the core resolves its
    // per-job secrets (matchEnvironment returns a no-rules config).
    ...(over.jobEnvironment
      ? {
          environmentStore: {
            matchEnvironment: async (_org: string, n: string) =>
              n === over.jobEnvironment
                ? {
                    id: `env-${n}`,
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
    extraJobConfig: { isTestRun: true, fixtureId: 'fx-1' },
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
    extraJobConfig: { isTestRun: true, fixtureId: 'fx-needs' },
    testRun: { fixtureId: 'fx-needs' },
  };
  return { ctx, dispatched };
}

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
    // `kici run --secret FOO=bar` on a job with no `environment:` must still
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
    // An env-declaring job gets its environment secrets AND the run-wide CLI
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
      jobEnvironment: 'staging',
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
});

describe('dispatchMatchedWorkflow — testRun run-row stamp', () => {
  it('stamps is_test_run + fixture_id when ctx.testRun is present', async () => {
    const { db, updates } = makeUpdateRecordingDb();
    const executionTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
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
