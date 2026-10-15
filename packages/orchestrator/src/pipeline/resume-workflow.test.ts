import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captured so tests can assert which routing key a failure names and which level a re-fired
// release logs at.
const mockError = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());
const mockInfo = vi.hoisted(() => vi.fn());
vi.mock('@kici-dev/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kici-dev/shared')>();
  return {
    ...actual,
    createLogger: () => ({ info: mockInfo, warn: mockWarn, error: mockError, debug: vi.fn() }),
  };
});

// Mocked so the test covers only the resume wiring (load, rebuild, gated dispatch, delete).
const dispatchMatchedWorkflow = vi.fn().mockResolvedValue({ dispatchedJobCount: 1 });
vi.mock('./dispatch-matched-workflow.js', () => ({
  dispatchMatchedWorkflow: (...args: unknown[]) => dispatchMatchedWorkflow(...args),
}));

import {
  resumeWorkflow,
  rejectWorkflow,
  rebuildWorkflowDispatchContext,
  withWorkflowRepoCredentials,
} from './resume-workflow.js';
import type { WorkflowDispatchContext } from './dispatch-matched-workflow.js';
import {
  toSerializableInputs,
  storePendingWorkflowContext,
  loadPendingWorkflowContext,
  clearPendingWorkflowContextsMap,
  type SerializableWorkflowDispatchInputs,
} from './pending-workflow-context.js';
import type { ReleaseSignal } from '../contexts/held-runs.js';
import {
  CheckRunConclusion,
  ExecutionRunStatus,
  HoldScope,
  HoldType,
  INSTALL_JOB_ID_PREFIX,
  installGateJobId,
  SECURITY_HOLD_JOB_IDS,
  TriggerSource,
} from '@kici-dev/engine';
import { createMockDb } from '../__test-helpers__/mock-db.js';
import type { SecurityCheckHold } from './security-hold-check.js';
import { JobSecretsUnsealError } from '../secrets/job-secret-seal.js';

/** The `held_runs.job_id` a workflow install-gate hold carries. */
const INSTALL_GATE_JOB_ID = installGateJobId('CI');

/** The `execution_runs` row a settled security check is addressed from, as the pending was. */
const RUN_ROW = {
  repo_identifier: 'a/b',
  sha: 'sha1',
  routing_key: 'github:1',
  provider_context: { installationId: 42 },
};

/**
 * The run lookup (`executeTakeFirst`) answers `runRow`; the contention query
 * (`execute`) answers `contenders`, the other holds pending on the same commit.
 */
function makeDb(runRow: unknown = RUN_ROW, contenders: unknown[] = []) {
  return createMockDb({ selectFirstRow: runRow, selectRows: contenders }).db;
}

/** Answers `executeTakeFirst` per table (the shared mock answers every table with one row). */
function makeRunAndJobsDb(runRow: unknown, jobRow: unknown) {
  const byTable: Record<string, unknown> = { execution_runs: runRow, execution_jobs: jobRow };
  return {
    selectFrom: (table: string) => {
      const chain = {
        select: () => chain,
        selectAll: () => chain,
        where: () => chain,
        limit: () => chain,
        executeTakeFirst: async () => byTable[table],
      };
      return chain;
    },
  } as unknown as Parameters<typeof resumeWorkflow>[2];
}

/** A database in which the hold's run row is gone, so no commit can be named. */
function makeDbWithNoRun() {
  return createMockDb({ selectFirstRow: undefined, selectRows: [] }).db;
}

/**
 * The workflow-scoped hold row `rejectWorkflow` is handed. It carries an
 * `approval_requirement`, as `holdWorkflowForInstallGate` writes via
 * `createHold`; that clause would otherwise accept it, so a row without one
 * passes even with the install-gate guard removed from the ownership predicate.
 */
function makeHold(jobId: string, overrides: Partial<SecurityCheckHold> = {}): SecurityCheckHold {
  return {
    id: 'hold1',
    org_id: 'org1',
    run_id: 'run1',
    job_id: jobId,
    hold_scope: HoldScope.enum.workflow,
    hold_type: HoldType.enum.security,
    approval_requirement: jobId.startsWith(INSTALL_JOB_ID_PREFIX)
      ? { clauses: [], expiresAt: 'x', reason: 'r' }
      : null,
    // A row written before the column existed, so these cases keep exercising
    // the shape derivation rather than the recorded fact.
    posted_pending_check: null,
    ...overrides,
  };
}

function makeInputs(): SerializableWorkflowDispatchInputs {
  return {
    runId: 'run1',
    resolvedOrgId: 'org1',
    repoIdentifier: 'a/b',
    info: {
      routingKey: 'github:1',
      deliveryId: 'd1',
      event: 'push',
      action: null,
      provider: 'github',
      payload: {},
    },
    payload: {},
    credentials: {},
    event: { type: 'push', targetBranch: 'main' },
    eventWithFiles: { type: 'push', targetBranch: 'main' },
    ref: 'sha',
    fullLockFile: { workflows: [], source: { file: '.kici/workflows/x.ts' } },
    workflow: { name: 'CI' },
    decision: { matched: true, workflowName: 'CI' },
    trustResolution: { tier: 'trusted' },
    lockFileSource: undefined,
    crossSource: false,
  } as unknown as SerializableWorkflowDispatchInputs;
}

/** Adds what the check-run completion reads, including one dynamic job it must exclude. */
function makeInputsWithJobs(): SerializableWorkflowDispatchInputs {
  return {
    ...makeInputs(),
    credentials: { installationId: 42 },
    ref: 'sha1',
    workflow: {
      name: 'CI',
      jobs: [
        { _type: 'static', name: 'build' },
        { _type: 'dynamic', name: 'gen' },
        { _type: 'static', name: 'test' },
      ],
    },
  } as unknown as SerializableWorkflowDispatchInputs;
}

const bundle = { normalizer: { provider: 'github' } };

/** A bundle with a check poster, for `KiCI Security`; the default `bundle` has none. */
function makeRegistryWithPoster(postCheckStatus: ReturnType<typeof vi.fn>) {
  return {
    getByRoutingKey: vi.fn().mockReturnValue({ ...bundle, checkStatusPoster: { postCheckStatus } }),
  };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    providerRegistry: { getByRoutingKey: vi.fn().mockReturnValue(bundle) },
    executionTracker: {
      failRun: vi.fn().mockResolvedValue(undefined),
      cancelHeldRun: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  } as any;
}

const signal: ReleaseSignal = {
  holdId: 'hold1',
  runId: 'run1',
  jobId: INSTALL_GATE_JOB_ID,
  scope: HoldScope.enum.workflow,
  stepIndex: null,
  triggerSource: TriggerSource.enum.context,
};

/** Routing keys of the global-resume tests: the inbound source and the workflow repository's. */
enum GlobalKey {
  Source = 'github:1',
  Workflow = 'github:ci',
}

/** The identity a global run was held with: the workflow repository at commit `a1`. */
const HELD_GLOBAL = {
  workflowRepoIdentifier: 'org/ci',
  workflowSha: 'a1',
  workflowBranch: 'main',
  workflowRoutingKey: GlobalKey.Workflow,
  workflowProviderContext: { installationId: 7 },
};

/** Stored inputs of a held global run, after the JSON round trip the DB column performs. */
function heldGlobalInputs(base = makeInputs()): SerializableWorkflowDispatchInputs {
  const live = {
    ...base,
    deps: {},
    bundle: {},
    workflowRepoIdentifier: 'org/ci',
    global: {
      ...HELD_GLOBAL,
      // Stripped when stored: a live bundle and a token minted at hold time.
      workflowBundle: { normalizer: { provider: 'github' } },
      workflowCredentials: { installationId: 7, token: 'held-token' },
    },
  };
  return JSON.parse(JSON.stringify(toSerializableInputs(live as never)));
}

/**
 * The workflow bundle mints `fresh-token`; the index reports the live registration at `sha`,
 * which a resume must not read.
 */
function depsWithRegistrationAt(sha: string, mint = vi.fn().mockResolvedValue('fresh-token')) {
  const workflowBundle = {
    normalizer: { provider: 'github' },
    cloneTokenProvider: { createCloneToken: mint },
  };
  const liveReg = { ...HELD_GLOBAL, repoIdentifier: 'org/ci', commitSha: sha };
  return makeDeps({
    providerRegistry: {
      getByRoutingKey: vi.fn((key: string) =>
        key === GlobalKey.Workflow ? workflowBundle : key === GlobalKey.Source ? bundle : undefined,
      ),
    },
    registrationIndex: {
      getByOrgAndRepo: vi.fn().mockReturnValue(liveReg),
      getGlobalByTriggerType: vi.fn().mockReturnValue([liveReg]),
    },
  });
}

describe('resuming a held global run', () => {
  beforeEach(() => {
    clearPendingWorkflowContextsMap();
    dispatchMatchedWorkflow.mockClear();
    mockError.mockClear();
  });

  it('stores the global identity without its bundle or credentials', () => {
    const stored = heldGlobalInputs();
    // fails-when: the stored identity carries the live bundle or the hold-time token
    expect(stored.global).toEqual(HELD_GLOBAL);
  });

  it('resume after hold dispatches the held workflow_sha, not the current registration', () => {
    // fails-when: resume rebuilds ctx.global from the live registration (new sha 'b2')
    // breaks-if-wrong: a held same-repo run must resume exactly as today (no global)
    const deps = depsWithRegistrationAt('b2');
    const ctx = rebuildWorkflowDispatchContext(heldGlobalInputs(), deps);
    expect(ctx!.global!.workflowSha).toBe('a1');
    expect(ctx!.global!.workflowBranch).toBe('main');
    expect(ctx!.workflowRepoIdentifier).toBe('org/ci');
    expect(ctx!.global!.workflowBundle).toBe(
      deps.providerRegistry.getByRoutingKey(GlobalKey.Workflow),
    );
    expect(ctx!.bundle).toBe(bundle);
  });

  it('rebuilds a held global run as a context the dispatch cannot take before the mint', async () => {
    const deps = depsWithRegistrationAt('b2', vi.fn().mockResolvedValue('fresh-token'));
    const rebuilt = rebuildWorkflowDispatchContext(heldGlobalInputs(), deps)!;
    // fails-when: the rebuilt context is a WorkflowDispatchContext, so this assignment typechecks
    // and a caller can dispatch a global run with no clone token
    // @ts-expect-error -- a rebuilt global identity carries no workflow-repository credentials
    const unminted: WorkflowDispatchContext = rebuilt;
    expect(unminted.global).not.toHaveProperty('workflowCredentials');
    // breaks-if-wrong: the mint turns the same context into one the dispatch takes
    const minted: WorkflowDispatchContext = await withWorkflowRepoCredentials(rebuilt);
    expect(minted.global?.workflowCredentials).toEqual({ installationId: 7, token: 'fresh-token' });
  });

  it('rebuilds a held same-repo run with no global identity', () => {
    // breaks-if-wrong: the same-repo control — nothing global appears on a per-repo resume
    const ctx = rebuildWorkflowDispatchContext(makeInputs(), depsWithRegistrationAt('b2'));
    expect(ctx!.global).toBeUndefined();
    expect(ctx!.workflowRepoIdentifier).toBe('a/b');
  });

  it('re-mints the workflow repository credentials before the resumed dispatch', async () => {
    await storePendingWorkflowContext(undefined, heldGlobalInputs());
    const mint = vi.fn().mockResolvedValue('fresh-token');
    const deps = depsWithRegistrationAt('b2', mint);

    await resumeWorkflow(signal, deps, undefined);

    expect(dispatchMatchedWorkflow).toHaveBeenCalledTimes(1);
    const [ctx] = dispatchMatchedWorkflow.mock.calls[0];
    expect(mint).toHaveBeenCalledWith('org/ci', { installationId: 7 });
    // fails-when: the resumed dispatch carries no token, or the one stored at hold time
    expect(ctx.global.workflowCredentials).toEqual({ installationId: 7, token: 'fresh-token' });
    expect(ctx.global.workflowSha).toBe('a1');
  });

  it("fails the run when the workflow repository's source is gone", async () => {
    await storePendingWorkflowContext(undefined, heldGlobalInputs());
    const deps = makeDeps({
      providerRegistry: {
        getByRoutingKey: vi.fn((key: string) => (key === GlobalKey.Source ? bundle : undefined)),
      },
    });

    await resumeWorkflow(signal, deps, undefined);

    expect(dispatchMatchedWorkflow).not.toHaveBeenCalled();
    expect(deps.executionTracker.failRun).toHaveBeenCalledWith(
      'run1',
      expect.stringContaining('provider bundle unresolvable'),
      expect.anything(),
    );
    const unresolvable = mockError.mock.calls.find(
      (c) => c[0] === 'Workflow hold resume: provider bundle unresolvable',
    );
    expect(unresolvable?.[1]).toMatchObject({ workflowRoutingKey: GlobalKey.Workflow });
    expect(await loadPendingWorkflowContext(undefined, 'run1')).toBeNull();
  });

  it('fails the run and closes its checks when the credential mint fails', async () => {
    await storePendingWorkflowContext(undefined, heldGlobalInputs(makeInputsWithJobs()));
    const completeUndispatchedCheckRuns = vi.fn().mockResolvedValue(undefined);
    const deps = depsWithRegistrationAt('b2', vi.fn().mockRejectedValue(new Error('revoked')));
    deps.checkRunReporter = { completeUndispatchedCheckRuns };

    await resumeWorkflow(signal, deps, undefined);

    expect(dispatchMatchedWorkflow).not.toHaveBeenCalled();
    expect(deps.executionTracker.failRun).toHaveBeenCalledWith(
      'run1',
      expect.stringContaining('workflow repository credentials unavailable'),
      expect.anything(),
    );
    expect(completeUndispatchedCheckRuns).toHaveBeenCalledTimes(1);
    expect(await loadPendingWorkflowContext(undefined, 'run1')).toBeNull();
  });
});

describe('resumeWorkflow', () => {
  beforeEach(() => {
    clearPendingWorkflowContextsMap();
    dispatchMatchedWorkflow.mockClear();
  });

  it('rebuilds + re-dispatches with skipInstallProtectionGate and deletes the context', async () => {
    await storePendingWorkflowContext(undefined, makeInputs());
    const deps = makeDeps();
    await resumeWorkflow(signal, deps, undefined);

    expect(dispatchMatchedWorkflow).toHaveBeenCalledTimes(1);
    const [ctx, opts] = dispatchMatchedWorkflow.mock.calls[0];
    expect(ctx.deps).toBe(deps);
    expect(ctx.bundle).toBe(bundle);
    expect(ctx.runId).toBe('run1');
    expect(opts).toMatchObject({
      skipInstallProtectionGate: true,
      reuseRunId: 'run1',
    });
    // Context consumed after the resume dispatch is kicked off.
    expect(await loadPendingWorkflowContext(undefined, 'run1')).toBeNull();
  });

  it('resolves the bundle from the post-overlay routing key on a cross-source resume', async () => {
    // A cross-source dispatch runs a REGISTRATION's workflow on its own repo for
    // an event from another source. `setupDispatchContext` overlays
    // `effectiveRoutingKey` onto `setup.info`, but `toSerializableInputs` spreads
    // `ctx` verbatim, so the stored `info.routingKey` names the INBOUND source:
    // rebuilding from it gives the wrong credentials and check poster.
    const inboundBundle = { normalizer: { provider: 'generic' } };
    const registrationBundle = { normalizer: { provider: 'github' } };
    await storePendingWorkflowContext(undefined, {
      ...makeInputs(),
      info: { ...makeInputs().info, routingKey: 'generic:inbound', provider: 'generic' },
      effectiveRoutingKey: 'github:1',
      effectiveProvider: 'github',
      crossSource: true,
    } as unknown as SerializableWorkflowDispatchInputs);
    const deps = makeDeps({
      providerRegistry: {
        getByRoutingKey: vi.fn((key: string) =>
          key === 'github:1' ? registrationBundle : inboundBundle,
        ),
      },
    });

    await resumeWorkflow(signal, deps, undefined);

    expect(deps.providerRegistry.getByRoutingKey).toHaveBeenCalledWith('github:1');
    expect(deps.providerRegistry.getByRoutingKey).not.toHaveBeenCalledWith('generic:inbound');
    expect(dispatchMatchedWorkflow.mock.calls[0][0].bundle).toBe(registrationBundle);
  });

  it('abandons a held run whose stored secrets cannot be decrypted', async () => {
    await storePendingWorkflowContext(undefined, {
      ...makeInputsWithJobs(),
      secretsUnavailable: new JobSecretsUnsealError('run1', 'bad key').message,
    } as SerializableWorkflowDispatchInputs);
    const deps = makeDeps();

    await resumeWorkflow(signal, deps, undefined);

    // fails-when: the run resumes without the CLI and test-run secrets it was held with
    expect(dispatchMatchedWorkflow).not.toHaveBeenCalled();
    expect(deps.executionTracker.failRun).toHaveBeenCalledWith(
      'run1',
      expect.stringContaining('finish the key rotation on every coordinator'),
      expect.anything(),
    );
    expect(await loadPendingWorkflowContext(undefined, 'run1')).toBeNull();
  });

  it('fails the run loudly when the pending context is lost', async () => {
    const deps = makeDeps();
    await resumeWorkflow(signal, deps, undefined);
    expect(dispatchMatchedWorkflow).not.toHaveBeenCalled();
    expect(deps.executionTracker.failRun).toHaveBeenCalledWith(
      'run1',
      expect.stringContaining('pending context lost'),
      expect.objectContaining({ scope: 'run', category: 'install_secrets' }),
    );
  });

  it('leaves a run another release already resumed alone when its context is gone', async () => {
    // fails-when: a re-fired release fails the run the first release resumed
    const deps = makeDeps();
    await resumeWorkflow(
      signal,
      deps,
      makeDb({ ...RUN_ROW, status: ExecutionRunStatus.enum.pending }),
    );
    expect(dispatchMatchedWorkflow).not.toHaveBeenCalled();
    expect(deps.executionTracker.failRun).not.toHaveBeenCalled();
  });

  it('warns when the run another release claimed has no jobs', async () => {
    mockWarn.mockClear();
    mockInfo.mockClear();
    const deps = makeDeps();
    await resumeWorkflow(
      signal,
      deps,
      makeRunAndJobsDb({ ...RUN_ROW, status: ExecutionRunStatus.enum.pending }, undefined),
    );
    // fails-when: a pending row with no job rows (a stranded claim) is logged at info
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('has no jobs'),
      expect.objectContaining({ runId: 'run1', status: ExecutionRunStatus.enum.pending }),
    );
    expect(deps.executionTracker.failRun).not.toHaveBeenCalled();
  });

  it('logs at info when the run another release claimed already has jobs', async () => {
    // breaks-if-wrong: a re-fired release racing a live resume is routine, not a warning
    mockWarn.mockClear();
    mockInfo.mockClear();
    const deps = makeDeps();
    await resumeWorkflow(
      signal,
      deps,
      makeRunAndJobsDb({ ...RUN_ROW, status: ExecutionRunStatus.enum.pending }, { job_id: 'j1' }),
    );
    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith(
      expect.stringContaining('already resumed by another release'),
      expect.objectContaining({ runId: 'run1' }),
    );
  });

  it('still fails a run that is held and lost its context', async () => {
    // breaks-if-wrong: a genuinely lost context on a held run must still fail the run
    const deps = makeDeps();
    await resumeWorkflow(
      signal,
      deps,
      makeDb({ ...RUN_ROW, status: ExecutionRunStatus.enum.held }),
    );
    expect(deps.executionTracker.failRun).toHaveBeenCalledWith(
      'run1',
      expect.stringContaining('pending context lost'),
      expect.anything(),
    );
  });

  it('fails the run when the provider bundle is unresolvable', async () => {
    await storePendingWorkflowContext(undefined, makeInputs());
    const deps = makeDeps({
      providerRegistry: { getByRoutingKey: vi.fn().mockReturnValue(undefined) },
    });
    await resumeWorkflow(signal, deps, undefined);
    expect(dispatchMatchedWorkflow).not.toHaveBeenCalled();
    expect(deps.executionTracker.failRun).toHaveBeenCalledWith(
      'run1',
      expect.stringContaining('provider bundle unresolvable'),
      expect.anything(),
    );
  });

  it('names the post-overlay routing key when the provider bundle is unresolvable', async () => {
    // The lookup uses `effectiveRoutingKey ?? info.routingKey`; naming the
    // inbound key would point the operator at the source that resolved fine.
    mockError.mockClear();
    await storePendingWorkflowContext(undefined, {
      ...makeInputs(),
      info: { ...makeInputs().info, routingKey: 'generic:inbound', provider: 'generic' },
      effectiveRoutingKey: 'github:1',
      crossSource: true,
    } as unknown as SerializableWorkflowDispatchInputs);
    const deps = makeDeps({
      providerRegistry: { getByRoutingKey: vi.fn().mockReturnValue(undefined) },
    });

    await resumeWorkflow(signal, deps, undefined);

    const unresolvable = mockError.mock.calls.find(
      (c) => c[0] === 'Workflow hold resume: provider bundle unresolvable',
    );
    expect(unresolvable?.[1]).toMatchObject({ routingKey: 'github:1' });
  });

  it('completes the queued check runs when the provider bundle is unresolvable', async () => {
    // The run is terminal and the release is not retried, so nothing else
    // completes the held dispatch's checks; this branch has their names from the context.
    await storePendingWorkflowContext(undefined, makeInputsWithJobs());
    const completeUndispatchedCheckRuns = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      providerRegistry: { getByRoutingKey: vi.fn().mockReturnValue(undefined) },
      checkRunReporter: { completeUndispatchedCheckRuns },
    });

    await resumeWorkflow(signal, deps, undefined);

    expect(completeUndispatchedCheckRuns).toHaveBeenCalledTimes(1);
    expect(completeUndispatchedCheckRuns.mock.calls[0][0]).toMatchObject({
      owner: 'a',
      repo: 'b',
      sha: 'sha1',
      workflowName: 'CI',
      jobNames: ['build', 'test'],
      conclusion: CheckRunConclusion.enum.failure,
    });
    // Closed before the context it derives from is dropped.
    expect(await loadPendingWorkflowContext(undefined, 'run1')).toBeNull();
  });

  it('leaves the check runs alone on a resume that actually dispatches', async () => {
    // Control: a replaying dispatch must NOT terminalize the checks its jobs report on.
    await storePendingWorkflowContext(undefined, makeInputsWithJobs());
    const completeUndispatchedCheckRuns = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ checkRunReporter: { completeUndispatchedCheckRuns } });

    await resumeWorkflow(signal, deps, undefined);

    expect(dispatchMatchedWorkflow).toHaveBeenCalledTimes(1);
    expect(completeUndispatchedCheckRuns).not.toHaveBeenCalled();
  });

  describe('a trust-policy hold resumes into the gates it never reached', () => {
    /**
     * `applyTrustPolicyGate` runs BEFORE `resolveWorkflowInstallSecrets`, so a
     * trust-policy hold's replay never satisfied the install gate.
     *
     * This pins the derivation, NOT a withheld secret: here the flag changes
     * nothing, since `resolveInstallSecrets` strips an untrusted contributor's
     * secrets and returns before the install gate, and a trust-policy hold
     * always carries a non-trusted tier. The derivation matters for a run with
     * NO tier, which `isUntrustedTier` reads leniently — see `skipsInstallGate`.
     */
    const forkSignal: ReleaseSignal = {
      ...signal,
      holdId: 'hold-fork',
      jobId: SECURITY_HOLD_JOB_IDS.fork_pr,
    };

    it('does NOT skip the install protection gate', async () => {
      await storePendingWorkflowContext(undefined, makeInputs());
      await resumeWorkflow(forkSignal, makeDeps(), undefined);

      const [, opts] = dispatchMatchedWorkflow.mock.calls[0];
      expect(opts).toMatchObject({
        skipInstallProtectionGate: false,
        reuseRunId: 'run1',
      });
    });

    it('replays the stored trust resolution rather than re-resolving trust', async () => {
      // Approval means "let it run", never "make it trusted". `reuseRunId` is
      // set above, which short-circuits the gate, so the tier the resumed
      // dispatch runs under is exactly the one the hold stored.
      const inputs = makeInputs();
      (inputs as unknown as Record<string, unknown>).trustResolution = {
        tier: 'unknown',
        contributorUsername: 'octocat',
      };
      (inputs as unknown as Record<string, unknown>).lockFileSource = 'base';
      await storePendingWorkflowContext(undefined, inputs);
      await resumeWorkflow(forkSignal, makeDeps(), undefined);

      const [ctx] = dispatchMatchedWorkflow.mock.calls[0];
      expect(ctx.trustResolution).toMatchObject({ tier: 'unknown' });
      expect(ctx.lockFileSource).toBe('base');
    });

    it('fails a lost resume under the trust_policy category, not install_secrets', async () => {
      const deps = makeDeps();
      await resumeWorkflow(forkSignal, deps, undefined);
      expect(dispatchMatchedWorkflow).not.toHaveBeenCalled();
      expect(deps.executionTracker.failRun).toHaveBeenCalledWith(
        'run1',
        expect.stringContaining('workflow-hold resume: pending context lost'),
        expect.objectContaining({ scope: 'run', category: 'trust_policy' }),
      );
    });
  });
});

describe('rejectWorkflow', () => {
  beforeEach(() => clearPendingWorkflowContextsMap());

  it('cancels the held run and drops the pending context', async () => {
    await storePendingWorkflowContext(undefined, makeInputs());
    const deps = makeDeps();
    await rejectWorkflow(makeHold(INSTALL_GATE_JOB_ID), deps, makeDb(), 'install gate rejected');
    expect(deps.executionTracker.cancelHeldRun).toHaveBeenCalledWith(
      'run1',
      'install gate rejected',
    );
    expect(await loadPendingWorkflowContext(undefined, 'run1')).toBeNull();
  });

  /**
   * `setupDispatchContext` posts the queued `kici/<workflow>` and per-job checks
   * before either gate decides; left alone they sit `queued` forever and block
   * branch protection.
   */
  describe('completes the check runs the dispatch already posted', () => {
    it('closes them as cancelled, naming only the static jobs, before the context is dropped', async () => {
      await storePendingWorkflowContext(undefined, makeInputsWithJobs());
      const completeUndispatchedCheckRuns = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({ checkRunReporter: { completeUndispatchedCheckRuns } });

      await rejectWorkflow(
        makeHold(INSTALL_GATE_JOB_ID),
        deps,
        makeDb(),
        'Rejected by alice via /kici reject',
      );

      expect(completeUndispatchedCheckRuns).toHaveBeenCalledTimes(1);
      expect(completeUndispatchedCheckRuns.mock.calls[0][0]).toMatchObject({
        provider: 'github',
        routingKey: 'github:1',
        owner: 'a',
        repo: 'b',
        sha: 'sha1',
        workflowName: 'CI',
        // Only the static jobs — the ones `setPendingAwait` created checks for.
        jobNames: ['build', 'test'],
        installationId: 42,
        runId: 'run1',
        conclusion: CheckRunConclusion.enum.cancelled,
      });
      expect(completeUndispatchedCheckRuns.mock.calls[0][0].summary).toContain(
        'Rejected by alice via /kici reject',
      );
      // The names come from the context, so the close precedes the delete, which still ran.
      expect(await loadPendingWorkflowContext(undefined, 'run1')).toBeNull();
    });

    it('closes nothing for a run that has no stored context', async () => {
      const completeUndispatchedCheckRuns = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({ checkRunReporter: { completeUndispatchedCheckRuns } });
      await rejectWorkflow(
        makeHold(INSTALL_GATE_JOB_ID, { run_id: 'run-never-held' }),
        deps,
        makeDbWithNoRun(),
        'rejected',
      );
      expect(completeUndispatchedCheckRuns).not.toHaveBeenCalled();
    });

    it('still cancels the run when completing the checks throws', async () => {
      await storePendingWorkflowContext(undefined, makeInputsWithJobs());
      const deps = makeDeps({
        checkRunReporter: {
          completeUndispatchedCheckRuns: vi.fn().mockRejectedValue(new Error('GitHub 500')),
        },
      });
      await rejectWorkflow(makeHold(INSTALL_GATE_JOB_ID), deps, makeDb(), 'rejected');
      expect(deps.executionTracker.cancelHeldRun).toHaveBeenCalledWith('run1', 'rejected');
      expect(await loadPendingWorkflowContext(undefined, 'run1')).toBeNull();
    });
  });

  /**
   * The trust policy's PR-wide hold posts `KiCI Security` as `pending`, and
   * nothing else completes it (`cancelHeldRun` writes a run row, not a check
   * run), so without this it stays `in_progress` forever.
   */
  describe('completes the security check the hold posted', () => {
    it('closes it as cancelled, under the same summary the kici/ checks carry', async () => {
      await storePendingWorkflowContext(undefined, makeInputsWithJobs());
      const postCheckStatus = vi.fn().mockResolvedValue(undefined);
      const completeUndispatchedCheckRuns = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({
        providerRegistry: makeRegistryWithPoster(postCheckStatus),
        checkRunReporter: { completeUndispatchedCheckRuns },
      });

      const posted = await rejectWorkflow(
        makeHold(SECURITY_HOLD_JOB_IDS.fork_pr),
        deps,
        makeDb(),
        'Rejected by alice via /kici reject',
      );

      expect(posted).toBe(true);
      expect(postCheckStatus).toHaveBeenCalledTimes(1);
      const [repoIdentifier, sha, status, title, summary, credentials] =
        postCheckStatus.mock.calls[0];
      expect(repoIdentifier).toBe('a/b');
      expect(sha).toBe('sha1');
      expect(status).toBe(CheckRunConclusion.enum.cancelled);
      expect(title).toBe('Rejected');
      expect(summary).toContain('Rejected by alice via /kici reject');
      // The next step a contributor can actually take.
      expect(summary).toContain('Push a new commit');
      // The pending check's app credentials, via the effective routing key.
      expect(credentials).toEqual({ installationId: 42 });
      expect(deps.providerRegistry.getByRoutingKey).toHaveBeenCalledWith('github:1');
      // Both check families carry the same summary.
      expect(completeUndispatchedCheckRuns.mock.calls[0][0].summary).toBe(summary);
      // Posted before the context is dropped.
      expect(await loadPendingWorkflowContext(undefined, 'run1')).toBeNull();
    });

    it('does NOT post one for a rejected install-gate hold', async () => {
      // `postCheckStatus` CREATES a missing run, and an install-gate hold posts
      // no pending security check, so posting would add a failing `KiCI Security`
      // check. The `kici/…` completion still runs, proving only that post was withheld.
      await storePendingWorkflowContext(undefined, makeInputsWithJobs());
      const postCheckStatus = vi.fn().mockResolvedValue(undefined);
      const completeUndispatchedCheckRuns = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({
        providerRegistry: makeRegistryWithPoster(postCheckStatus),
        checkRunReporter: { completeUndispatchedCheckRuns },
      });

      const posted = await rejectWorkflow(
        makeHold(INSTALL_GATE_JOB_ID),
        deps,
        makeDb(),
        'install gate rejected',
      );

      expect(posted).toBe(false);
      expect(postCheckStatus).not.toHaveBeenCalled();
      expect(completeUndispatchedCheckRuns).toHaveBeenCalledTimes(1);
    });

    it('posts nothing for a hold whose execution_runs row is gone', async () => {
      // A check run is addressed from the run row's repo, sha and credentials.
      const postCheckStatus = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({ providerRegistry: makeRegistryWithPoster(postCheckStatus) });

      const posted = await rejectWorkflow(
        makeHold(SECURITY_HOLD_JOB_IDS.fork_pr, { run_id: 'run-never-held' }),
        deps,
        makeDbWithNoRun(),
        'rejected',
      );

      expect(posted).toBe(false);
      expect(postCheckStatus).not.toHaveBeenCalled();
    });

    it('still cancels the run when the security post throws', async () => {
      await storePendingWorkflowContext(undefined, makeInputsWithJobs());
      const postCheckStatus = vi.fn().mockRejectedValue(new Error('GitHub 500'));
      const deps = makeDeps({ providerRegistry: makeRegistryWithPoster(postCheckStatus) });

      const posted = await rejectWorkflow(
        makeHold(SECURITY_HOLD_JOB_IDS.fork_pr),
        deps,
        makeDb(),
        'rejected',
      );

      expect(posted).toBe(false);
      expect(postCheckStatus).toHaveBeenCalledTimes(1);
      expect(deps.executionTracker.cancelHeldRun).toHaveBeenCalledWith('run1', 'rejected');
      expect(await loadPendingWorkflowContext(undefined, 'run1')).toBeNull();
    });
  });
});
