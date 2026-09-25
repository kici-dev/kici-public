/**
 * A job a context protection gate holds (required reviewers, wait timer,
 * minimum trust, concurrency limit) is stored without its context secrets. When
 * the hold is released, `dispatchReadyJob` resolves the context's variables and
 * secrets and dispatches the job with them — never without them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionJobStatus } from '@kici-dev/engine';
import {
  dispatchMatchedWorkflow,
  type WorkflowDispatchContext,
} from './dispatch-matched-workflow.js';
import {
  makeGateTracker,
  makeHoldDb,
  makeJobContextRow,
  makeSingleJobContext,
  type SingleJobContextOptions,
} from './dispatch-matched-workflow.test-helpers.js';
import type { GlobalDispatchIdentity } from './global-dispatch-identity.js';
import {
  clearPendingJobContextsMap,
  consumePendingJobContext,
  dispatchReadyJob,
  storePendingJobContext,
  type ReadyDispatchGateDeps,
} from './processor.js';
import type { LockWorkflow } from '@kici-dev/engine';
import type { QueuedJobInput } from '../queue/job-queue.js';
import { JobSecretsUnsealError } from '../secrets/job-secret-seal.js';
import type { Dispatcher } from '../agent/dispatcher.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';

const CONTEXT = 'prod';
const SECRET = { PROD_TOKEN: 'sekrit' };
const VARS = { REGION: 'eu' };
const STATIC_JOB = 'build';
const GEN = 'gen';
const RUN_ID = 'run-1';
const REVIEWERS = { required_reviewers: '["alice"]' };
const WAIT_TIMER = { wait_timer_seconds: 60 };
/** A container pulling a private image with credentials from `prod`. */
const PROD_AUTH_CONTAINER = {
  image: 'reg.internal:5000/acme/ci:1.2',
  auth: { usernameSecret: 'prod:REGISTRY_USER', tokenSecret: 'prod:REGISTRY_TOKEN' },
};
const REGISTRY_VALUES: Record<string, string> = {
  REGISTRY_USER: 'robot',
  REGISTRY_TOKEN: 'reg-tok',
};

const bundle = {
  normalizer: { provider: 'local' },
  repoUrlBuilder: { buildCloneUrl: (repo: string) => `https://git.example/${repo}.git` },
} as unknown as WorkflowDispatchContext['bundle'];

interface Scenario {
  /** Columns overriding the `prod` context row. */
  row?: Record<string, unknown>;
  /** Hold a generated job bound to `prod` rather than the static job. */
  generated?: boolean;
  global?: GlobalDispatchIdentity;
  /** The job's lock `container` field. */
  container?: unknown;
}

/** Dispatch a workflow whose job binds `prod`, and return what it held. */
async function holdJob(s: Scenario) {
  const heldRunStore = {
    createHold: vi.fn().mockResolvedValue({ id: 'held-approval' }),
    create: vi.fn().mockResolvedValue({ id: 'held-gate' }),
  };
  const matchContext = vi.fn(async (_org: string, n: string) =>
    n === CONTEXT ? makeJobContextRow(n, opts, s.row ?? {}) : null,
  );
  const resolveForContext = vi.fn(async () => SECRET);
  const opts: SingleJobContextOptions = {
    bundle,
    fullRepo: true,
    executionTracker: makeGateTracker(),
    heldRunStore,
    db: makeHoldDb(),
    contextStore: { matchContext },
    ...(!s.generated && { jobContext: CONTEXT }),
    ...(s.container !== undefined && { jobContainer: s.container }),
    ...(s.generated && {
      withDynamicEntry: true,
      pendingDynamics: {
        track: vi.fn(async () => [
          {
            name: GEN,
            runsOn: [{ kind: 'exact', value: 'default' }],
            steps: [{ name: 'echo', run: 'echo gen' }],
            needs: [],
            contexts: [{ value: CONTEXT, dynamic: false }],
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
  if (s.global) {
    ctx.global = s.global;
    ctx.workflowRepoIdentifier = s.global.workflowRepoIdentifier;
  }
  await dispatchMatchedWorkflow(ctx);
  const jobName = s.generated ? GEN : STATIC_JOB;
  await vi.waitFor(() =>
    expect(
      [...heldRunStore.createHold.mock.calls, ...heldRunStore.create.mock.calls].map(
        (c) => (c[1] as { jobId: string }).jobId,
      ),
    ).toContain(jobName),
  );
  expect(dispatched.find((d) => d.jobName === jobName)).toBeUndefined();
  return { jobName, matchContext, resolveForContext };
}

interface ReleaseOptions {
  resolveForContext?: (...args: unknown[]) => Promise<Record<string, string>>;
  /**
   * Context rows the store holds at release, by name; `prod` with no
   * overrides when omitted. The held job's own rules still hold, as in a real
   * store — its protection rules are not cleared by the approval.
   */
  rows?: Record<string, Record<string, unknown>>;
  resolveNamedInternal?: (org: string, ctx: string, key: string) => Promise<string | null>;
  withoutSecretResolver?: boolean;
}

/** The stores release-time resolution reads, observable per call. */
function releaseStores(opts: ReleaseOptions = {}) {
  const rows = opts.rows ?? { [CONTEXT]: {} };
  const matchContext = vi.fn(async (_org: string, n: string) =>
    rows[n] ? makeJobContextRow(n, { bundle }, rows[n]) : null,
  );
  const resolveForContext = vi.fn(opts.resolveForContext ?? (async () => SECRET));
  const resolveNamedInternal = vi.fn(opts.resolveNamedInternal ?? (async () => null));
  const getResolvedVars = vi.fn(async () => VARS);
  const contextData = {
    contextStore: { matchContext },
    variableStore: { getResolvedVars },
    ...(!opts.withoutSecretResolver && {
      secretResolver: {
        resolveForContext,
        resolveNamedInternal,
        resolveForContextWithMeta: resolveForContext,
      },
    }),
  };
  const gateDeps = {
    matchContext: vi.fn(),
    heldRunStore: { create: vi.fn() },
    contextData: () => contextData,
  } as unknown as ReadyDispatchGateDeps;
  return { gateDeps, matchContext, resolveForContext, resolveNamedInternal, getResolvedVars };
}

/** A dispatcher that records what it is handed. */
function capturingDispatcher() {
  const dispatched: QueuedJobInput[] = [];
  const dispatcher = {
    dispatch: vi.fn(async (input: QueuedJobInput) => {
      dispatched.push(input);
      return { status: 'dispatched' as const, agentId: 'a1', jobId: 'job-real' };
    }),
  } as unknown as Dispatcher & { dispatch: ReturnType<typeof vi.fn> };
  return { dispatcher, dispatched };
}

/** Release `jobName` the way every release route does. */
async function release(
  jobName: string,
  gateDeps: ReadyDispatchGateDeps | undefined,
  tracker?: ExecutionTracker,
) {
  const { dispatcher, dispatched } = capturingDispatcher();
  await dispatchReadyJob(
    RUN_ID,
    jobName,
    dispatcher,
    tracker,
    undefined,
    undefined,
    undefined,
    gateDeps,
  );
  return { dispatcher, dispatched };
}

beforeEach(() => {
  clearPendingJobContextsMap();
});

describe('dispatchReadyJob — a context-held job gets its context data on release', () => {
  it('gives an approved reviewer-held static job its context secret and variables', async () => {
    const { jobName, resolveForContext } = await holdJob({ row: REVIEWERS });
    // Nothing was resolved while the job waited.
    expect(resolveForContext).not.toHaveBeenCalled();
    const stores = releaseStores({ rows: { [CONTEXT]: REVIEWERS } });
    const { dispatched } = await release(jobName, stores.gateDeps);
    // fails-when: dispatchReadyJob dispatches the stored input unchanged, so the job has no secrets
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].jobConfig.secrets).toMatchObject(SECRET);
    expect(dispatched[0].jobConfig.namespacedSecrets).toEqual({ [CONTEXT]: SECRET });
    expect(dispatched[0].jobConfig.contextVars).toEqual(VARS);
    expect(stores.getResolvedVars).toHaveBeenCalledWith(
      '__default__',
      `env-${CONTEXT}`,
      'local:repo',
    );
  });

  it('gives a wait-timer-held job its context secret when the timer releases it', async () => {
    const { jobName } = await holdJob({ row: WAIT_TIMER });
    const stores = releaseStores({ rows: { [CONTEXT]: WAIT_TIMER } });
    const { dispatched } = await release(jobName, stores.gateDeps);
    // fails-when: the non-reviewer hold persists no resolution record, so the timer release is secretless
    expect(dispatched[0].jobConfig.secrets).toMatchObject(SECRET);
  });

  it('gives a reviewer-held generated job its context secret on release', async () => {
    const { jobName } = await holdJob({
      row: REVIEWERS,
      generated: true,
    });
    const stores = releaseStores({ rows: { [CONTEXT]: REVIEWERS } });
    const { dispatched } = await release(jobName, stores.gateDeps);
    // fails-when: holdGeneratedJobs stores the generated job without its resolution record
    expect(dispatched[0].jobName).toBe(GEN);
    expect(dispatched[0].jobConfig.secrets).toMatchObject(SECRET);
    expect(dispatched[0].jobConfig.dynamicSource).toBeDefined();
  });

  it("resolves a global run's variables under the workflow repository's routing key", async () => {
    const global: GlobalDispatchIdentity = {
      workflowRepoIdentifier: 'org/ci',
      workflowSha: 'a1',
      workflowBranch: 'main',
      workflowRoutingKey: 'rk-ci',
      workflowProviderContext: { installationId: 7 },
      workflowBundle: bundle,
      workflowCredentials: {},
    };
    const { jobName } = await holdJob({ row: REVIEWERS, global });
    const stores = releaseStores({ rows: { [CONTEXT]: REVIEWERS } });
    await release(jobName, stores.gateDeps);
    // fails-when: the record stores the event's routing key instead of policyRoutingKey(ctx)
    expect(stores.getResolvedVars).toHaveBeenCalledWith('__default__', `env-${CONTEXT}`, 'rk-ci');
  });

  it("gives a job held through a glob context that context's secret on release", async () => {
    // The job declares 'prod'; the only row that matches it is the glob
    // context 'pro*', whose id is not 'env-prod'.
    const GLOB_ROW = {
      ...REVIEWERS,
      id: 'env-pro-glob',
      name: 'pro*',
      type: 'glob',
      glob_pattern: 'pro*',
    };
    const { jobName } = await holdJob({ row: GLOB_ROW });
    const stores = releaseStores({
      rows: { [CONTEXT]: GLOB_ROW },
      resolveForContext: async (...args: unknown[]) =>
        (args[1] as { id: string }).id === 'env-pro-glob' ? SECRET : {},
    });
    const { dispatched } = await release(jobName, stores.gateDeps);
    // fails-when: release resolves the held job's secrets by the declared name
    expect(dispatched[0].jobConfig.secrets).toMatchObject(SECRET);
    expect(stores.resolveForContext).toHaveBeenCalledWith(
      '__default__',
      { id: 'env-pro-glob', name: CONTEXT },
      undefined,
    );
  });

  it('fails the job and never dispatches it when resolution throws on release', async () => {
    const { jobName } = await holdJob({ row: REVIEWERS });
    const stores = releaseStores({
      rows: { [CONTEXT]: REVIEWERS },
      resolveForContext: async () => {
        throw new Error('vault unreachable');
      },
    });
    const tracker = {
      onJobStatus: vi.fn().mockResolvedValue(undefined),
      findSyntheticJobId: vi.fn().mockResolvedValue('needs-pending-build-1'),
    } as unknown as ExecutionTracker & {
      onJobStatus: ReturnType<typeof vi.fn>;
    };
    const { dispatcher } = await release(jobName, stores.gateDeps, tracker);
    // fails-when: a resolution failure falls through to dispatching the secretless input
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(tracker.onJobStatus).toHaveBeenCalledTimes(1);
    const [runId, jobId, status, , , data] = tracker.onJobStatus.mock.calls[0];
    expect([runId, jobId, status]).toEqual([
      RUN_ID,
      'needs-pending-build-1',
      ExecutionJobStatus.enum.failed,
    ]);
    expect((data as { error: string }).error).toContain('vault unreachable');
  });

  it('fails the job when the release path supplies no context stores', async () => {
    const { jobName } = await holdJob({ row: REVIEWERS });
    const { dispatcher } = await release(jobName, undefined);
    // fails-when: a missing store is treated as "no context data" and the job dispatches secretless
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('fails the job when the release path has a context store but no secret resolver', async () => {
    const { jobName } = await holdJob({ row: REVIEWERS });
    const stores = releaseStores({ rows: { [CONTEXT]: REVIEWERS }, withoutSecretResolver: true });
    const { dispatcher } = await release(jobName, stores.gateDeps);
    // fails-when: only the context store is checked, so the job dispatches with vars and no secrets
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('fails the job when its context was recreated under the same name while held', async () => {
    const { jobName } = await holdJob({ row: REVIEWERS });
    const stores = releaseStores({ rows: { [CONTEXT]: { ...REVIEWERS, id: 'env-prod-new' } } });
    const { dispatcher } = await release(jobName, stores.gateDeps);
    // fails-when: release re-matches by name only and resolves the new context's secrets
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(stores.resolveForContext).not.toHaveBeenCalled();
  });

  it('fails the job when its context was deleted while held', async () => {
    const { jobName } = await holdJob({ row: REVIEWERS });
    const stores = releaseStores({ rows: {} });
    const { dispatcher } = await release(jobName, stores.gateDeps);
    // fails-when: a vanished context is skipped and the job dispatches without its secrets
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });
});

describe('dispatchReadyJob — registry credentials of a released job', () => {
  /** `prod` is bound to the scope holding both its job secret and the registry pair. */
  const registryLookup = async () => ({ ...SECRET, ...REGISTRY_VALUES });

  it('gives an approved reviewer-held job registry credentials from its own context', async () => {
    const { jobName } = await holdJob({ row: REVIEWERS, container: PROD_AUTH_CONTAINER });
    const stores = releaseStores({
      rows: { [CONTEXT]: REVIEWERS },
      resolveForContext: registryLookup,
    });
    const { dispatched } = await release(jobName, stores.gateDeps);
    // fails-when: the approved context's stateless reviewer gate is re-run and holds the ref again
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].jobConfig.containerRegistryAuth).toEqual({
      username: 'robot',
      password: 'reg-tok',
      serveraddress: 'reg.internal:5000',
    });
    expect(dispatched[0].jobConfig.secrets).toMatchObject(SECRET);
  });

  it('gives a wait-timer-released job registry credentials from its own context', async () => {
    const { jobName } = await holdJob({ row: WAIT_TIMER, container: PROD_AUTH_CONTAINER });
    const stores = releaseStores({
      rows: { [CONTEXT]: WAIT_TIMER },
      resolveForContext: registryLookup,
    });
    const { dispatched } = await release(jobName, stores.gateDeps);
    // fails-when: the wait timer is re-evaluated on release and returns wait again
    expect(dispatched[0].jobConfig.containerRegistryAuth).toMatchObject({ password: 'reg-tok' });
  });

  it('dispatches without registry auth when the ref names an unbound context that refuses', async () => {
    const container = {
      image: 'reg.internal:5000/acme/ci:1.2',
      auth: { tokenSecret: 'release:REGISTRY_TOKEN' },
    };
    const { jobName } = await holdJob({ row: REVIEWERS, container });
    const stores = releaseStores({
      rows: { [CONTEXT]: REVIEWERS, release: { branch_restrictions: ['release/*'] } },
      resolveForContext: registryLookup,
    });
    const tracker = {
      onJobStatus: vi.fn().mockResolvedValue(undefined),
      findSyntheticJobId: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as ExecutionTracker & { onJobStatus: ReturnType<typeof vi.fn> };
    const { dispatched } = await release(jobName, stores.gateDeps, tracker);
    // breaks-if-wrong: dispatch omits registry auth on a gate refusal, and release must match it
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].jobConfig).not.toHaveProperty('containerRegistryAuth');
    expect(dispatched[0].jobConfig.secrets).toMatchObject(SECRET);
    expect(tracker.onJobStatus).not.toHaveBeenCalled();
    // The unbound context stayed gated: its secret was never read.
    const contextsRead = stores.resolveForContext.mock.calls.map(
      (call) => (call[1] as { name: string }).name,
    );
    expect(contextsRead).not.toContain('release');
    expect(stores.resolveNamedInternal).not.toHaveBeenCalled();
  });

  it("gives a released job registry credentials from the context's same-named scope when no bound scope carries them (deprecated)", async () => {
    const { jobName } = await holdJob({ row: REVIEWERS, container: PROD_AUTH_CONTAINER });
    const stores = releaseStores({
      rows: { [CONTEXT]: REVIEWERS },
      // No scope bound to `prod` carries the registry pair; it sits in the scope named `prod`.
      resolveForContext: async () => ({}),
      resolveNamedInternal: async (_org, _scope, key) => REGISTRY_VALUES[key] ?? null,
    });
    const { dispatched } = await release(jobName, stores.gateDeps);
    // breaks-if-wrong: registry auth stored only in the same-named scope stops resolving on release
    expect(dispatched[0].jobConfig.containerRegistryAuth).toMatchObject({
      username: 'robot',
      password: 'reg-tok',
    });
  });

  it('fails the job when the registry secret lookup itself fails', async () => {
    const { jobName } = await holdJob({ row: REVIEWERS, container: PROD_AUTH_CONTAINER });
    const stores = releaseStores({
      rows: { [CONTEXT]: REVIEWERS },
      // Only the registry reference's read fails: it is the one attributed to
      // the job, while the context-secret resolution before it succeeds.
      resolveForContext: async (...args: unknown[]) => {
        if (args[3] !== undefined) throw new Error('secret backend unreachable');
        return SECRET;
      },
    });
    const { dispatcher } = await release(jobName, stores.gateDeps);
    // fails-when: a store failure is treated as a refusal and the job pulls with no credentials
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });
});

describe('dispatchReadyJob — a pending context with no resolution record', () => {
  const jobInput = {
    runId: RUN_ID,
    workflowName: 'ci',
    jobName: STATIC_JOB,
    runsOnLabels: ['default'],
    jobConfig: { name: STATIC_JOB, secrets: { RUN_WIDE: 'x' } },
    repoUrl: '',
    ref: 'main',
    sha: 'abc',
  } as unknown as QueuedJobInput;

  it('dispatches a needs-gated job with no hold exactly as stored, resolving nothing', async () => {
    await storePendingJobContext(undefined, RUN_ID, STATIC_JOB, {
      jobInput,
      runsOnLabels: ['default'],
    });
    const stores = releaseStores();
    const { dispatched } = await release(STATIC_JOB, stores.gateDeps);
    // breaks-if-wrong: a job no context gate held must dispatch its stored input untouched
    expect(dispatched).toEqual([jobInput]);
    expect(stores.matchContext).not.toHaveBeenCalled();
    expect(stores.resolveForContext).not.toHaveBeenCalled();
  });

  it('fails a job whose stored secrets could not be decrypted, and never dispatches it', async () => {
    await storePendingJobContext(undefined, RUN_ID, STATIC_JOB, {
      jobInput,
      runsOnLabels: ['default'],
      secretsUnavailable: new JobSecretsUnsealError(RUN_ID, 'bad key').message,
    });
    const tracker = {
      onJobStatus: vi.fn().mockResolvedValue(undefined),
      findSyntheticJobId: vi.fn().mockResolvedValue('needs-pending-build-1'),
    } as unknown as ExecutionTracker & { onJobStatus: ReturnType<typeof vi.fn> };
    const { dispatcher } = await release(STATIC_JOB, releaseStores().gateDeps, tracker);
    // fails-when: a job whose sealed secrets did not open dispatches with the plain fields only
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(tracker.onJobStatus.mock.calls[0][2]).toBe(ExecutionJobStatus.enum.failed);
    const error = (tracker.onJobStatus.mock.calls[0][5] as { error: string }).error;
    // A pending context cannot be handed to a coordinator holding the key, so the message names the fix.
    expect(error).toContain('finish the key rotation on every coordinator');
    expect(error).not.toContain('context data could not be resolved');
  });

  it('reads a row stored before the column existed as having no record', async () => {
    // A row from before the column existed comes back without it.
    const returning = vi.fn().mockReturnValue({
      execute: async () => [
        { job_input: jobInput, runs_on_labels: ['default'], invoke_config: null },
      ],
    });
    const chain: Record<string, unknown> = { returning };
    chain.where = () => chain;
    const db = { deleteFrom: () => chain } as never;
    const ctx = await consumePendingJobContext(db, RUN_ID, STATIC_JOB);
    // breaks-if-wrong: an old row must consume as an ordinary context, with no resolution record
    expect(ctx).toEqual({ jobInput, runsOnLabels: ['default'] });
    expect(returning.mock.calls[0][0]).toContain('context_resolution');
  });

  it('round-trips the resolution record through the pending-context row', async () => {
    const record = {
      contexts: [{ name: CONTEXT, id: 'env-prod' }],
      orgId: 'org-1',
      routingKey: 'rk',
    };
    const inserted: Record<string, unknown>[] = [];
    const insertDb = {
      insertInto: () => ({
        values: (v: Record<string, unknown>) => {
          inserted.push(v);
          return { onConflict: () => ({ execute: async () => undefined }) };
        },
      }),
    } as never;
    await storePendingJobContext(insertDb, RUN_ID, STATIC_JOB, {
      jobInput,
      runsOnLabels: ['default'],
      contextResolution: record,
    });
    // fails-when: storePendingJobContext drops the record, so a peer consuming from the DB loses it
    expect(JSON.parse(inserted[0].context_resolution as string)).toEqual(record);

    clearPendingJobContextsMap();
    const chain: Record<string, unknown> = {
      returning: () => ({
        execute: async () => [
          {
            job_input: jobInput,
            runs_on_labels: ['default'],
            invoke_config: null,
            context_resolution: record,
          },
        ],
      }),
    };
    chain.where = () => chain;
    const ctx = await consumePendingJobContext(
      { deleteFrom: () => chain } as never,
      RUN_ID,
      STATIC_JOB,
    );
    expect(ctx?.contextResolution).toEqual(record);
  });
});

const DEPLOY = 'deploy';
const RUN_WIDE = { RUN_WIDE: 'from-cli' };
const APPROVAL = { clauses: [{ user: 'alice' }] };

interface StoreScenario {
  /** Hold the bound job under its own SDK `requireApproval`. */
  jobApproval?: boolean;
  /** Hold the bound job under the workflow-level `requireApproval`. */
  workflowApproval?: boolean;
  /** Bind `prod` to a `deploy` job that needs `build`, instead of to `build`. */
  needsGated?: boolean;
  /** Bind `prod` to a generated job that needs `build`. */
  generatedNeedsGated?: boolean;
  runWideFlatSecrets?: Record<string, string>;
  /** Dispatch with no secret resolver, as a deployment without one does. */
  withoutSecretResolver?: boolean;
  /** Route through the cluster coordinator, as an orchestrator with connected peers does. */
  cluster?: boolean;
}

/** A hold db that also records every `pending_job_contexts` row it is asked to write. */
function capturingHoldDb() {
  const db = makeHoldDb() as Record<string, unknown>;
  const rows: Array<Record<string, unknown>> = [];
  const insertInto = db.insertInto as (table: string) => { values: (v: unknown) => unknown };
  db.insertInto = (table: string) => ({
    values: (v: Record<string, unknown>) => {
      if (table === 'pending_job_contexts') rows.push(v);
      return insertInto(table).values(v);
    },
  });
  return { db, rows };
}

/**
 * Dispatch a workflow whose context-bound job is admitted by its context and
 * then stored rather than dispatched, and return the rows written for it.
 */
async function storeAdmittedJob(s: StoreScenario) {
  const { db, rows } = capturingHoldDb();
  const heldRunStore = {
    createHold: vi.fn().mockResolvedValue({ id: 'held-approval' }),
    create: vi.fn().mockResolvedValue({ id: 'held-gate' }),
  };
  const resolveForContext = vi.fn(async () => SECRET);
  const getResolvedVars = vi.fn(async () => VARS);
  const matchContext = vi.fn(async (_org: string, n: string) =>
    n === CONTEXT ? makeJobContextRow(n, { bundle }) : null,
  );
  const opts: SingleJobContextOptions = {
    bundle,
    fullRepo: true,
    executionTracker: makeGateTracker(),
    heldRunStore,
    db,
    contextStore: { matchContext },
    ...(!s.needsGated && !s.generatedNeedsGated && { jobContext: CONTEXT }),
    ...(s.jobApproval && { jobApproval: APPROVAL }),
    ...(s.runWideFlatSecrets && { runWideFlatSecrets: s.runWideFlatSecrets }),
    ...(s.generatedNeedsGated && {
      withDynamicEntry: true,
      pendingDynamics: {
        track: vi.fn(async () => [
          {
            name: GEN,
            runsOn: [{ kind: 'exact', value: 'default' }],
            steps: [{ name: 'echo', run: 'echo gen' }],
            needs: [STATIC_JOB],
            contexts: [{ value: CONTEXT, dynamic: false }],
          },
        ]),
        resolve: vi.fn(),
        reject: vi.fn(),
        has: vi.fn().mockReturnValue(false),
        cleanup: vi.fn(),
      },
    }),
    ...(!s.withoutSecretResolver && {
      secretResolver: {
        resolveForContext,
        resolveNamedInternal: async () => null,
        resolveForContextWithMeta: resolveForContext,
      },
    }),
  };
  const { ctx, dispatched } = makeSingleJobContext(opts);
  (ctx.deps as { variableStore?: unknown }).variableStore = { getResolvedVars };
  const routeJobs = vi.fn(async () => ({ localJobs: [], reroutedJobs: [], failedJobs: [] }));
  if (s.cluster) {
    (ctx.deps as { coordinator?: unknown }).coordinator = {
      hasConnectedPeers: () => true,
      routeJobs,
    };
  }
  const deploy = {
    _type: 'static',
    name: DEPLOY,
    runsOn: [{ kind: 'exact', value: 'default' }],
    steps: [{ name: 'echo', run: 'echo deploy' }],
    needs: [STATIC_JOB],
    rules: [],
    contexts: [{ value: CONTEXT, dynamic: false }],
  } as unknown as LockWorkflow['jobs'][number];
  ctx.workflow = {
    ...ctx.workflow,
    ...(s.workflowApproval && { approval: APPROVAL as unknown as LockWorkflow['approval'] }),
    jobs: [...ctx.workflow.jobs, ...(s.needsGated ? [deploy] : [])],
  };
  ctx.fullLockFile = { ...ctx.fullLockFile, workflows: [ctx.workflow] };
  await dispatchMatchedWorkflow(ctx);
  const jobName = s.needsGated ? DEPLOY : s.generatedNeedsGated ? GEN : STATIC_JOB;
  await vi.waitFor(() => expect(rows.map((r) => r.job_name)).toContain(jobName));
  const row = rows.filter((r) => r.job_name === jobName).at(-1)!;
  return { jobName, row, dispatched, resolveForContext, routeJobs };
}

describe('a stored job keeps no context secret at rest', () => {
  const cases: Array<[string, StoreScenario]> = [
    ['held by its own requireApproval after its context admitted it', { jobApproval: true }],
    ['held by the workflow-level requireApproval', { workflowApproval: true }],
    ['waiting on an upstream job', { needsGated: true }],
    ['waiting on an upstream job on the cluster path', { needsGated: true, cluster: true }],
    ['generated and waiting on an upstream job', { generatedNeedsGated: true }],
  ];

  for (const [label, scenario] of cases) {
    it(`stores a job ${label} without its context data, and resolves it on dispatch`, async () => {
      const { jobName, row, routeJobs } = await storeAdmittedJob(scenario);
      // The cluster case really took the coordinator path: its root job was routed there.
      expect(routeJobs.mock.calls.length > 0).toBe(scenario.cluster === true);
      // fails-when: the stored row carries the secret value dispatch resolved for the admitted job
      expect(String(row.job_input)).not.toContain(SECRET.PROD_TOKEN);
      const stored = JSON.parse(String(row.job_input)) as QueuedJobInput;
      expect(stored.jobConfig).not.toHaveProperty('secrets');
      expect(stored.jobConfig).not.toHaveProperty('namespacedSecrets');
      expect(stored.jobConfig).not.toHaveProperty('contextVars');
      expect(JSON.parse(String(row.context_resolution))).toMatchObject({
        contexts: [{ name: CONTEXT, id: `env-${CONTEXT}` }],
        resolvesSecrets: true,
      });

      const stores = releaseStores();
      const { dispatched } = await release(jobName, stores.gateDeps);
      // breaks-if-wrong: the stored job must still reach its agent with the context's data
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0].jobConfig.secrets).toEqual(SECRET);
      expect(dispatched[0].jobConfig.namespacedSecrets).toEqual({ [CONTEXT]: SECRET });
      expect(dispatched[0].jobConfig.contextVars).toEqual(VARS);
    });
  }

  it('keeps the run-wide secrets on the stored input, and they still win a collision', async () => {
    const { jobName, row } = await storeAdmittedJob({
      needsGated: true,
      runWideFlatSecrets: { ...RUN_WIDE, PROD_TOKEN: 'cli-wins' },
    });
    const stored = JSON.parse(String(row.job_input)) as QueuedJobInput;
    // breaks-if-wrong: stripping context data must not drop the run's own CLI secrets
    expect(stored.jobConfig.secrets).toEqual({ ...RUN_WIDE, PROD_TOKEN: 'cli-wins' });
    const { dispatched } = await release(jobName, releaseStores().gateDeps);
    expect(dispatched[0].jobConfig.secrets).toEqual({ ...RUN_WIDE, PROD_TOKEN: 'cli-wins' });
    expect(dispatched[0].jobConfig.namespacedSecrets).toEqual({ [CONTEXT]: SECRET });
  });

  it('dispatches a job stored with no secret resolver with its variables only', async () => {
    const { jobName, row } = await storeAdmittedJob({
      needsGated: true,
      withoutSecretResolver: true,
    });
    expect(JSON.parse(String(row.context_resolution))).toMatchObject({ resolvesSecrets: false });
    const stores = releaseStores({ withoutSecretResolver: true });
    const { dispatched } = await release(jobName, stores.gateDeps);
    // breaks-if-wrong: a deployment with no secret resolver must keep dispatching bound jobs
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].jobConfig.contextVars).toEqual(VARS);
    expect(dispatched[0].jobConfig).not.toHaveProperty('secrets');
  });

  it('dispatches a bound job that is not stored with its context data resolved on the spot', async () => {
    const { db, rows } = capturingHoldDb();
    const resolveForContext = vi.fn(async () => SECRET);
    const { ctx, dispatched } = makeSingleJobContext({
      bundle,
      fullRepo: true,
      executionTracker: makeGateTracker(),
      db,
      jobContext: CONTEXT,
      secretResolver: {
        resolveForContext,
        resolveNamedInternal: async () => null,
        resolveForContextWithMeta: resolveForContext,
      },
    });
    await dispatchMatchedWorkflow(ctx);
    // breaks-if-wrong: a job dispatching in the same pass still gets its secrets at dispatch
    expect(dispatched.find((d) => d.jobName === STATIC_JOB)?.jobConfig.secrets).toEqual(SECRET);
    expect(rows.map((r) => r.job_name)).not.toContain(STATIC_JOB);
  });
});
