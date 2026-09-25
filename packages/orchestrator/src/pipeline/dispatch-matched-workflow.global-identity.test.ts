import { describe, expect, it, vi } from 'vitest';
import { ContextGateRejectReason, type ProviderType } from '@kici-dev/engine';
import { SecurityHoldReason } from '../contexts/held-runs.js';
import {
  dispatchMatchedWorkflow,
  type WorkflowDispatchContext,
} from './dispatch-matched-workflow.js';
import {
  makeGateTracker,
  makeJobContextRow,
  makeSingleJobContext,
  TEST_INBOUND_PROVIDER,
  type SingleJobContextOptions,
} from './dispatch-matched-workflow.test-helpers.js';
import type { GlobalDispatchIdentity } from './global-dispatch-identity.js';

const SOURCE_REPO = 'org/app';
const WORKFLOW_REPO = 'org/ci';
const CONTEXT_NAME = 'deploy';
/** Provider of the inbound event (the fixture's `info.provider`). */
const INBOUND_PROVIDER = TEST_INBOUND_PROVIDER;
/** Provider of the workflow repository, distinct from the inbound one. */
const WORKFLOW_PROVIDER: ProviderType = 'github';

const bundle = {
  normalizer: { provider: INBOUND_PROVIDER },
  repoUrlBuilder: { buildCloneUrl: (repo: string) => `https://git.example/${repo}.git` },
} as unknown as WorkflowDispatchContext['bundle'];

function globalIdentity(over: Partial<GlobalDispatchIdentity> = {}): GlobalDispatchIdentity {
  return {
    workflowRepoIdentifier: WORKFLOW_REPO,
    workflowSha: 'a1',
    workflowBranch: 'main',
    workflowRoutingKey: 'rk-ci',
    workflowProviderContext: { installationId: 7 },
    workflowBundle: bundle,
    workflowCredentials: {},
    ...over,
  };
}

function makeTracker() {
  return {
    addJobsToRun: vi.fn().mockResolvedValue(undefined),
    onExecutionStarted: vi.fn().mockResolvedValue(undefined),
    onJobStatus: vi.fn().mockResolvedValue(undefined),
    holdRunForPendingJobs: vi.fn().mockReturnValue(true),
    releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
  };
}

/** Turn a same-repo fixture context into a global one. */
function makeGlobal(ctx: WorkflowDispatchContext, global: GlobalDispatchIdentity): void {
  ctx.global = global;
  ctx.workflowRepoIdentifier = global.workflowRepoIdentifier;
}

/**
 * A single-job dispatch from `org/app` on `eventBranch`, whose job binds the
 * `deploy` context. The context admits only `org/ci` on `main`.
 */
async function run(args: {
  eventBranch: string;
  global?: GlobalDispatchIdentity;
  variableStore?: unknown;
}) {
  const tracker = makeTracker();
  const opts: SingleJobContextOptions = {
    bundle,
    fullRepo: true,
    jobContext: CONTEXT_NAME,
    executionTracker: tracker,
    secretResolver: {
      resolveForContext: async () => ({ TOKEN: 'v' }),
      resolveNamedInternal: async () => null,
      resolveForContextWithMeta: async () => ({ TOKEN: 'v' }),
    },
  };
  opts.contextStore = {
    matchContext: async (_org: string, n: string) =>
      n === CONTEXT_NAME
        ? makeJobContextRow(n, opts, {
            repo_patterns: [WORKFLOW_REPO],
            branch_restrictions: ['main'],
          })
        : null,
  };
  const { ctx, dispatched } = makeSingleJobContext(opts);
  const event = { ...ctx.event, targetBranch: args.eventBranch };
  ctx.repoIdentifier = SOURCE_REPO;
  ctx.event = event;
  ctx.eventWithFiles = event;
  if (args.variableStore) {
    (ctx.deps as unknown as Record<string, unknown>).variableStore = args.variableStore;
  }
  if (args.global) makeGlobal(ctx, args.global);
  // Static jobs are dispatched before dispatchMatchedWorkflow resolves.
  await dispatchMatchedWorkflow(ctx);
  return { tracker, dispatched };
}

/** The init-failure message a context-gate rejection recorded, if any. */
function rejectionMessage(tracker: ReturnType<typeof makeTracker>): string | undefined {
  const call = tracker.onJobStatus.mock.calls.find(
    (args: unknown[]) => typeof args[1] === 'string' && (args[1] as string).startsWith('rejected-'),
  );
  const data = call?.[5] as { initFailure?: { message: string } } | undefined;
  return data?.initFailure?.message;
}

/**
 * The `workflowRepo` provenance argument of an `onExecutionStarted` call: the
 * one argument shaped `{ identifier, sha, branch }`. Located by shape so the
 * lookup survives parameters being added.
 */
function provenanceArg(args: unknown[]): unknown {
  return args.find(
    (a) => typeof a === 'object' && a !== null && 'identifier' in a && 'branch' in a,
  );
}

/** A pendingDynamics stub whose eval returns `generated`. */
function makePendingDynamics(generated: unknown[]) {
  return {
    track: vi.fn(async () => generated),
    resolve: vi.fn(),
    reject: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    cleanup: vi.fn(),
  };
}

/** A pendingInits stub whose init job resolves nothing new. */
function makePendingInits() {
  return {
    track: vi.fn(async () => ({})),
    resolve: vi.fn(),
    reject: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    cleanup: vi.fn(),
  };
}

const GLOBAL_JOB_FIELDS = {
  isGlobalWorkflow: true,
  workflowRepoIdentifier: WORKFLOW_REPO,
  workflowSha: 'a1',
  workflowRepoUrl: `https://git.example/${WORKFLOW_REPO}.git`,
};

describe('dispatchMatchedWorkflow — global dispatch identity', () => {
  it('a global job checks context rules against the workflow repo and its registered branch', async () => {
    // fails-when: dispatchCtx.repository is the event repo — a context with repoPatterns ['org/ci'] would refuse
    const { dispatched, tracker } = await run({ eventBranch: 'feature', global: globalIdentity() });
    expect(rejectionMessage(tracker)).toBeUndefined();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].jobConfig.secrets).toBeDefined();
  });

  it('the same dispatch without a global identity checks the event repo', async () => {
    // breaks-if-wrong: a same-repo run must still be gated on its own repository
    const { dispatched, tracker } = await run({ eventBranch: 'main' });
    expect(dispatched).toHaveLength(0);
    expect(rejectionMessage(tracker)).toContain(ContextGateRejectReason.enum.repo_unmatched);
  });

  it("B's main does not satisfy a branch rule guarding A's main", async () => {
    // fails-when: policyBranch presents the event's branch for a global run
    const { dispatched, tracker } = await run({
      eventBranch: 'main',
      global: globalIdentity({ workflowBranch: 'dev' }),
    });
    expect(dispatched).toHaveLength(0);
    expect(rejectionMessage(tracker)).toContain(ContextGateRejectReason.enum.branch_restricted);
  });

  it('a global job carries the dual-checkout fields and a (A,B) user-cache namespace', async () => {
    // fails-when: the job config omits the workflow checkout or shares the source repo's cache namespace
    const { dispatched } = await run({ eventBranch: 'feature', global: globalIdentity() });
    expect(dispatched[0].jobConfig).toMatchObject({
      isGlobalWorkflow: true,
      workflowRepoIdentifier: WORKFLOW_REPO,
      workflowRepoUrl: `https://git.example/${WORKFLOW_REPO}.git`,
      workflowSha: 'a1',
      workflowRef: 'main',
      workflowRoutingKey: 'rk-ci',
      cacheRepoId: `${WORKFLOW_REPO}::${SOURCE_REPO}`,
    });
    // The checkout is the source repository.
    expect(dispatched[0].repoUrl).toContain(SOURCE_REPO);
  });

  it('records workflow provenance on the run row', async () => {
    // fails-when: the run row is started with no workflow-repo provenance
    const { tracker } = await run({ eventBranch: 'feature', global: globalIdentity() });
    expect(tracker.onExecutionStarted).toHaveBeenCalled();
    const args = tracker.onExecutionStarted.mock.calls[0] as unknown[];
    expect(args[3]).toBe(SOURCE_REPO);
    expect(provenanceArg(args)).toEqual({
      identifier: WORKFLOW_REPO,
      sha: 'a1',
      branch: 'main',
    });
  });

  it('records no provenance for a same-repo run', async () => {
    // breaks-if-wrong: a same-repo run must keep passing no provenance
    const tracker = makeTracker();
    const { ctx } = makeSingleJobContext({ bundle, fullRepo: true, executionTracker: tracker });
    await dispatchMatchedWorkflow(ctx);
    const args = tracker.onExecutionStarted.mock.calls[0] as unknown[];
    expect(provenanceArg(args)).toBeUndefined();
  });

  it('a held global run records the workflow commit and branch', async () => {
    // fails-when: recordRunHeld is not handed the registration sha / branch for a global run
    // breaks-if-wrong: a same-repo hold must record null for both
    async function hold(global?: GlobalDispatchIdentity) {
      const recordRunHeld = vi.fn().mockResolvedValue(undefined);
      const { ctx } = makeSingleJobContext({ bundle });
      ctx.securityDecision = {
        action: 'hold',
        reason: SecurityHoldReason.enum.workflow_modification,
        message: 'held',
        approvalExpirySeconds: 3600,
      } as unknown as WorkflowDispatchContext['securityDecision'];
      (ctx.deps as unknown as Record<string, unknown>).heldRunStore = {
        create: vi.fn().mockResolvedValue({ id: 'held-1' }),
      };
      (ctx.deps as unknown as Record<string, unknown>).executionTracker = {
        recordRunHeld,
        releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
      };
      if (global) makeGlobal(ctx, global);
      await dispatchMatchedWorkflow(ctx);
      expect(recordRunHeld).toHaveBeenCalledTimes(1);
      return recordRunHeld.mock.calls[0][0] as Record<string, unknown>;
    }
    expect(await hold(globalIdentity())).toMatchObject({
      workflowRepoIdentifier: WORKFLOW_REPO,
      workflowSha: 'a1',
      workflowBranch: 'main',
    });
    expect(await hold()).toMatchObject({ workflowSha: null, workflowBranch: null });
  });

  it('a re-run records its lineage on the started run row', async () => {
    // fails-when: the pipeline drops ctx.rerunLineage, so a re-run's row has no parent
    // breaks-if-wrong: a first run must still start with no lineage
    async function lineageOf(rerunLineage?: WorkflowDispatchContext['rerunLineage']) {
      const tracker = makeTracker();
      const { ctx } = makeSingleJobContext({ bundle, fullRepo: true, executionTracker: tracker });
      makeGlobal(ctx, globalIdentity());
      if (rerunLineage) ctx.rerunLineage = rerunLineage;
      await dispatchMatchedWorkflow(ctx);
      const args = tracker.onExecutionStarted.mock.calls[0] as unknown[];
      // The positions of `parentRunId` and `originalRunId` in onExecutionStarted.
      return { parent: args[14], root: args[16] };
    }
    expect(await lineageOf({ parentRunId: 'run-parent', originalRunId: 'run-root' })).toEqual({
      parent: 'run-parent',
      root: 'run-root',
    });
    expect(await lineageOf()).toEqual({ parent: undefined, root: undefined });
  });

  it('a re-run records the subject event it states on the started run row', async () => {
    // fails-when: the pipeline drops ctx.subjectTriggerEvent, so subject_trigger_event stays NULL
    // breaks-if-wrong: a first run must still state no subject event
    async function eventContextOf(subjectTriggerEvent?: string) {
      const tracker = makeTracker();
      const { ctx } = makeSingleJobContext({ bundle, fullRepo: true, executionTracker: tracker });
      if (subjectTriggerEvent) ctx.subjectTriggerEvent = subjectTriggerEvent;
      await dispatchMatchedWorkflow(ctx);
      const args = tracker.onExecutionStarted.mock.calls[0] as unknown[];
      return args.find(
        (a) => typeof a === 'object' && a !== null && 'headRef' in a && 'isFork' in a,
      ) as Record<string, unknown>;
    }
    expect((await eventContextOf('pull_request')).subjectTriggerEvent).toBe('pull_request');
    expect(await eventContextOf()).not.toHaveProperty('subjectTriggerEvent');
  });

  it('posts the pending checks under the workflow-qualified name for a global run', async () => {
    // fails-when: setPendingAwait is not told the defining repository, so the checks collide with B's own
    // breaks-if-wrong: a same-repo run must post under the unqualified name (no workflowRepoIdentifier)
    async function pendingArgs(global?: GlobalDispatchIdentity) {
      const setPendingAwait = vi.fn().mockResolvedValue(undefined);
      const reporter = new Proxy(
        { setPendingAwait },
        { get: (t, k) => (k in t ? t[k as keyof typeof t] : vi.fn().mockResolvedValue(undefined)) },
      );
      const { ctx } = makeSingleJobContext({ bundle, fullRepo: true, checkRunReporter: reporter });
      if (global) makeGlobal(ctx, global);
      await dispatchMatchedWorkflow(ctx);
      expect(setPendingAwait).toHaveBeenCalledTimes(1);
      return setPendingAwait.mock.calls[0][0] as Record<string, unknown>;
    }
    expect((await pendingArgs(globalIdentity())).workflowRepoIdentifier).toBe(WORKFLOW_REPO);
    expect(await pendingArgs()).not.toHaveProperty('workflowRepoIdentifier');
  });

  it('the deferred init job of a global run carries the dual-checkout fields', async () => {
    // fails-when: buildDeferredInitJob omits the workflow checkout, so the init runs B's tree
    // breaks-if-wrong: a same-repo init job must carry none of the global fields
    async function initJob(global?: GlobalDispatchIdentity) {
      const { ctx, dispatched } = makeSingleJobContext({
        bundle,
        fullRepo: true,
        withDeferredInit: true,
        pendingInits: makePendingInits(),
      });
      if (global) makeGlobal(ctx, global);
      await dispatchMatchedWorkflow(ctx);
      const job = dispatched.find((d) => d.jobName.startsWith('__init__'));
      expect(job).toBeDefined();
      return job!.jobConfig;
    }
    expect(await initJob(globalIdentity())).toMatchObject(GLOBAL_JOB_FIELDS);
    expect(await initJob()).not.toHaveProperty('isGlobalWorkflow');
  });

  it('the dynamic eval job and its generated jobs of a global run carry the dual-checkout fields', async () => {
    // fails-when: dispatchEvalJob or genJobConfig omits the workflow checkout
    // breaks-if-wrong: a same-repo eval and generated job must carry none of the global fields
    const generated = [
      {
        name: 'gen',
        runsOn: [{ kind: 'exact', value: 'default' }],
        steps: [{ name: 'echo', run: 'echo gen' }],
        needs: [],
      },
    ];
    async function jobs(global?: GlobalDispatchIdentity) {
      const { ctx, dispatched } = makeSingleJobContext({
        bundle,
        fullRepo: true,
        withDynamicEntry: true,
        pendingDynamics: makePendingDynamics(generated),
      });
      if (global) makeGlobal(ctx, global);
      await dispatchMatchedWorkflow(ctx);
      // The eval and its generated jobs dispatch from a task dispatch does not await.
      await vi.waitFor(() => expect(dispatched.some((d) => d.jobName === 'gen')).toBe(true));
      const byName = (n: (name: string) => boolean) => dispatched.find((d) => n(d.jobName))!;
      return {
        evalConfig: byName((n) => n.startsWith('__dynamic__')).jobConfig,
        genConfig: byName((n) => n === 'gen').jobConfig,
      };
    }
    const global = await jobs(globalIdentity());
    expect(global.evalConfig).toMatchObject(GLOBAL_JOB_FIELDS);
    expect(global.genConfig).toMatchObject(GLOBAL_JOB_FIELDS);
    const same = await jobs();
    expect(same.evalConfig).not.toHaveProperty('isGlobalWorkflow');
    expect(same.genConfig).not.toHaveProperty('isGlobalWorkflow');
  });

  it("a global job's context variables use the workflow repository's source overrides", async () => {
    // fails-when: resolveMultiEnvMergedData receives the event's routing key for a global run
    const variableStore = {
      getResolvedVars: vi.fn(async (_org: string, _envId: string, routingKey?: string) => ({
        SOURCE: routingKey ?? 'none',
      })),
    };
    const { dispatched } = await run({
      eventBranch: 'feature',
      global: globalIdentity(),
      variableStore,
    });
    expect(dispatched[0].jobConfig.contextVars).toEqual({ SOURCE: 'rk-ci' });
  });

  it("a same-repo job's context variables use the event's source overrides", async () => {
    // breaks-if-wrong: a same-repo run must keep layering its own source's overrides
    const variableStore = {
      getResolvedVars: vi.fn(async (_org: string, _envId: string, routingKey?: string) => ({
        SOURCE: routingKey ?? 'none',
      })),
    };
    const { ctx, dispatched } = makeSingleJobContext({
      bundle,
      fullRepo: true,
      jobContext: CONTEXT_NAME,
    });
    (ctx.deps as unknown as Record<string, unknown>).variableStore = variableStore;
    await dispatchMatchedWorkflow(ctx);
    expect(dispatched[0].jobConfig.contextVars).toEqual({ SOURCE: ctx.info.routingKey });
  });

  it('refuses a global run whose workflow bundle cannot build a clone URL', async () => {
    // fails-when: the job is dispatched with isGlobalWorkflow and an empty workflowRepoUrl
    const { ctx, dispatched } = makeSingleJobContext({ bundle, fullRepo: true });
    makeGlobal(ctx, globalIdentity({ workflowBundle: undefined }));
    await expect(dispatchMatchedWorkflow(ctx)).rejects.toThrow(/cannot build a clone URL/);
    expect(dispatched).toHaveLength(0);
  });

  describe('the __build__ job', () => {
    /** Dispatch a single job whose caches miss; returns the dispatched inputs and the source-cache probe spy. */
    async function buildRun(global?: GlobalDispatchIdentity) {
      const { ctx, dispatched } = makeSingleJobContext({
        bundle,
        fullRepo: true,
        withBuildMiss: true,
      });
      const sourceCache = (ctx.deps as unknown as { sourceCache: { has: () => Promise<boolean> } })
        .sourceCache;
      const has = vi.spyOn(sourceCache, 'has');
      ctx.repoIdentifier = SOURCE_REPO;
      ctx.workflowRepoIdentifier = SOURCE_REPO;
      if (global) makeGlobal(ctx, global);
      await dispatchMatchedWorkflow(ctx);
      return { dispatched, has, build: dispatched.find((d) => d.jobConfig.buildSourceNeeded) };
    }

    it('a global run builds its source pack from the workflow repo at the registered commit', async () => {
      // fails-when: the __build__ job clones the event repo, so it packs the source repo's .kici
      const { build } = await buildRun(globalIdentity({ workflowCredentials: { token: 'wf' } }));
      expect(build).toBeDefined();
      expect(build!.repoUrl).toBe(`https://git.example/${WORKFLOW_REPO}.git`);
      expect(build!.sha).toBe('a1');
      expect(build!.ref).toBe('main');
      expect(build!.providerContext).toEqual({ token: 'wf' });
      expect(build!.routingKey).toBe('rk-ci');
    });

    it.each([
      ['null', null],
      ['empty', ''],
    ])(
      'a global run whose registration commit is %s skips the build and never keys a cache on it',
      async (_label, workflowSha) => {
        // fails-when: a build is dispatched at sha '' or the source cache is probed for it
        // breaks-if-wrong: the run must still dispatch its job, installing agent-side
        const { dispatched, has, build } = await buildRun(globalIdentity({ workflowSha }));
        expect(build).toBeUndefined();
        expect(has).not.toHaveBeenCalled();
        expect(dispatched.map((d) => d.jobName)).toEqual(['build']);
      },
    );

    it("a global build carries the workflow repository's provider", async () => {
      // fails-when: the build input takes the inbound provider when the workflow bundle names another
      const workflowBundle = {
        normalizer: { provider: WORKFLOW_PROVIDER },
        repoUrlBuilder: bundle!.repoUrlBuilder,
      } as unknown as GlobalDispatchIdentity['workflowBundle'];
      const { build } = await buildRun(globalIdentity({ workflowBundle }));
      expect(build!.provider).toBe(WORKFLOW_PROVIDER);
      expect(build!.provider).not.toBe(INBOUND_PROVIDER);
    });

    it('a same-repo run still builds from its own repo', async () => {
      // breaks-if-wrong: a same-repo build must keep cloning the event repository at the event ref
      const { build, has } = await buildRun();
      expect(build).toBeDefined();
      expect(build!.repoUrl).toBe(`https://git.example/${SOURCE_REPO}.git`);
      expect(build!.sha).toBe('main');
      expect(build!.routingKey).toBe('local:repo');
      expect(has).toHaveBeenCalled();
    });
  });
});

describe('dispatchMatchedWorkflow — clone tokens of a rerouted job', () => {
  /** A bundle whose clone-token provider mints `${label}:${repo}`. */
  function tokenBundle(label: string) {
    const createCloneToken = vi.fn(async (repo: string) => `${label}:${repo}`);
    return {
      createCloneToken,
      bundle: {
        normalizer: { provider: INBOUND_PROVIDER },
        repoUrlBuilder: bundle!.repoUrlBuilder,
        cloneTokenProvider: { createCloneToken },
      } as unknown as WorkflowDispatchContext['bundle'],
    };
  }

  /** Route one dispatch through a connected coordinator; returns every RunContext it received. */
  async function routedRunContexts(
    over: Partial<SingleJobContextOptions>,
    global?: (workflowBundle: WorkflowDispatchContext['bundle']) => GlobalDispatchIdentity,
  ) {
    const source = tokenBundle('src');
    const workflow = tokenBundle('wf');
    const routeJobs = vi.fn(async (_ctx: unknown, jobs: Array<{ jobName: string }>) => ({
      localJobs: jobs.map((j, i) => ({ jobName: j.jobName, jobId: `routed-${i}` })),
      remoteJobs: [],
      reroutedJobs: [],
      failedJobs: [],
    }));
    const { ctx } = makeSingleJobContext({
      bundle: source.bundle,
      executionTracker: makeGateTracker(),
      ...over,
    });
    ctx.repoIdentifier = SOURCE_REPO;
    ctx.credentials = { installationId: 3 };
    (ctx.deps as unknown as Record<string, unknown>).coordinator = {
      hasConnectedPeers: () => true,
      routeJobs,
    };
    if (global) makeGlobal(ctx, global(workflow.bundle));
    await dispatchMatchedWorkflow(ctx);
    return {
      source,
      workflow,
      runContexts: () => routeJobs.mock.calls.map((c) => c[0] as Record<string, unknown>),
      routedJobNames: () => routeJobs.mock.calls.map((c) => c[1].map((j) => j.jobName)),
    };
  }

  const WF_CREDENTIALS = { installationId: 9 };
  const globalWith = (workflowBundle: WorkflowDispatchContext['bundle']) =>
    globalIdentity({ workflowBundle, workflowCredentials: WF_CREDENTIALS });

  it("a rerouted global job carries the workflow repo's clone token minted with its credentials", async () => {
    const { source, workflow, runContexts } = await routedRunContexts({}, globalWith);
    expect(runContexts()).toHaveLength(1);
    // fails-when: the reroute mints only the source token, so the peer clones A with B's token
    expect(workflow.createCloneToken).toHaveBeenCalledWith(WORKFLOW_REPO, WF_CREDENTIALS);
    expect(runContexts()[0].workflowCloneToken).toBe(`wf:${WORKFLOW_REPO}`);
    // The source token is still minted from B's bundle with B's credentials.
    expect(source.createCloneToken).toHaveBeenCalledWith(SOURCE_REPO, { installationId: 3 });
    expect(runContexts()[0].cloneToken).toBe(`src:${SOURCE_REPO}`);
  });

  it('a rerouted same-repo job carries no workflow clone token', async () => {
    // breaks-if-wrong: a same-repo reroute must keep today's single source token
    const { workflow, runContexts } = await routedRunContexts({});
    expect(runContexts()).toHaveLength(1);
    expect(runContexts()[0]).not.toHaveProperty('workflowCloneToken');
    expect(runContexts()[0].cloneToken).toBe(`src:${SOURCE_REPO}`);
    expect(workflow.createCloneToken).not.toHaveBeenCalled();
  });

  it("the rerouted generated jobs of a global run carry the workflow repo's clone token", async () => {
    // fails-when: routeRootGeneratedJobs mints only the source token
    const generated = [
      {
        name: 'gen',
        runsOn: [{ kind: 'exact', value: 'default' }],
        steps: [{ name: 'echo', run: 'echo gen' }],
        needs: [],
      },
    ];
    const { runContexts, routedJobNames } = await routedRunContexts(
      { withDynamicEntry: true, pendingDynamics: makePendingDynamics(generated) },
      globalWith,
    );
    await vi.waitFor(() => expect(routedJobNames().flat()).toContain('gen'));
    for (const rc of runContexts()) {
      expect(rc.workflowCloneToken).toBe(`wf:${WORKFLOW_REPO}`);
      expect(rc.cloneToken).toBe(`src:${SOURCE_REPO}`);
    }
  });

  it("the rerouted deferred-init job of a global run carries the workflow repo's clone token", async () => {
    // fails-when: dispatchExecutionAfterInit mints only the source token
    // The init job goes through the local dispatcher; only the execution job
    // it resolves is routed, after the init round completes.
    const pendingInits = makePendingInits();
    const { runContexts } = await routedRunContexts(
      { withDeferredInit: true, pendingInits },
      globalWith,
    );
    await vi.waitFor(() => expect(runContexts()).toHaveLength(1));
    expect(pendingInits.track).toHaveBeenCalledTimes(1);
    expect(runContexts()[0].workflowCloneToken).toBe(`wf:${WORKFLOW_REPO}`);
    expect(runContexts()[0].cloneToken).toBe(`src:${SOURCE_REPO}`);
  });
});
