import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the module logger so the unresolvable-bundle test can assert WHICH
// routing key the failure names. No other test in this file inspects logging.
const mockError = vi.hoisted(() => vi.fn());
vi.mock('@kici-dev/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kici-dev/shared')>();
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: mockError, debug: vi.fn() }),
  };
});

// Mock the heavy dispatch giant so the round-trip test stays focused on the
// resume wiring (load context → rebuild → dispatch with gate skipped → delete).
const dispatchMatchedWorkflow = vi.fn().mockResolvedValue({ dispatchedJobCount: 1 });
vi.mock('./dispatch-matched-workflow.js', () => ({
  dispatchMatchedWorkflow: (...args: unknown[]) => dispatchMatchedWorkflow(...args),
}));

import { resumeWorkflow, rejectWorkflow } from './resume-workflow.js';
import {
  storePendingWorkflowContext,
  loadPendingWorkflowContext,
  clearPendingWorkflowContextsMap,
  type SerializableWorkflowDispatchInputs,
} from './pending-workflow-context.js';
import type { ReleaseSignal } from '../contexts/held-runs.js';
import {
  CheckRunConclusion,
  HoldScope,
  HoldType,
  INSTALL_JOB_ID_PREFIX,
  installGateJobId,
  SECURITY_HOLD_JOB_IDS,
  TriggerSource,
} from '@kici-dev/engine';
import { createMockDb } from '../__test-helpers__/mock-db.js';
import type { SecurityCheckHold } from './security-hold-check.js';

/** The `held_runs.job_id` a workflow install-gate hold carries. */
const INSTALL_GATE_JOB_ID = installGateJobId('CI');

/**
 * The `execution_runs` row every settled security check is addressed from: the
 * same repo, sha, effective routing key and credentials the pending check was
 * posted under.
 */
const RUN_ROW = {
  repo_identifier: 'a/b',
  sha: 'sha1',
  routing_key: 'github:1',
  provider_context: { installationId: 42 },
};

/**
 * A database whose `execution_runs` lookup answers with `runRow` and whose
 * contention query answers with `contenders` — the other holds still pending on
 * the same commit. The two are told apart by their terminal: the run lookup ends
 * in `executeTakeFirst`, the contention query in `execute`.
 */
function makeDb(runRow: unknown = RUN_ROW, contenders: unknown[] = []) {
  return createMockDb({ selectFirstRow: runRow, selectRows: contenders }).db;
}

/** A database in which the hold's run row is gone, so no commit can be named. */
function makeDbWithNoRun() {
  return createMockDb({ selectFirstRow: undefined, selectRows: [] }).db;
}

/**
 * The workflow-scoped hold row `rejectWorkflow` is handed. An install-gate row
 * carries an `approval_requirement`, because `holdWorkflowForInstallGate`
 * writes it through `createHold` — and that is the clause which would otherwise
 * accept it, so a row without one would pass even with the install-gate guard
 * removed from the ownership predicate.
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

/**
 * The same inputs with everything the check-run completion reads: a full static
 * job list (plus one dynamic job it must exclude), an installation id, and a
 * commit sha.
 */
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

/**
 * A registry whose bundle carries a check poster, for the `KiCI Security` half.
 * The default `bundle` deliberately has none, so the tests that do not care
 * about that check keep exercising the poster-less shape.
 */
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
    // A cross-source dispatch runs a REGISTRATION's workflow against the
    // registration's own repository, triggered by an event that arrived on a
    // different source. `dispatchMatchedWorkflow` is handed the registration's
    // bundle alongside `effectiveRoutingKey: reg.routingKey`, and
    // `setupDispatchContext` overlays that key onto `setup.info` — but
    // `toSerializableInputs` spreads `ctx` verbatim, so `info.routingKey` still
    // names the INBOUND source. Rebuilding from it hands the resumed run the
    // inbound source's app: wrong credentials, wrong check poster.
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
    // The lookup uses `effectiveRoutingKey ?? info.routingKey`, so the failure
    // must name that key too. Logging the inbound one points an operator at the
    // source that resolved fine — on exactly the cross-source case where the two
    // differ, which is the case most likely to produce this failure.
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
    // The run is terminal and this release will not be retried, so the checks
    // the held dispatch posted have nothing left to complete them. This branch
    // loaded the context, so their names are in hand — unlike its sibling
    // above, which fails precisely because the context is gone.
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
    // The control: the completion is bound to the failure branch, not to every
    // resume. A released hold whose dispatch replays must NOT terminalize the
    // checks its own jobs are about to report on.
    await storePendingWorkflowContext(undefined, makeInputsWithJobs());
    const completeUndispatchedCheckRuns = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ checkRunReporter: { completeUndispatchedCheckRuns } });

    await resumeWorkflow(signal, deps, undefined);

    expect(dispatchMatchedWorkflow).toHaveBeenCalledTimes(1);
    expect(completeUndispatchedCheckRuns).not.toHaveBeenCalled();
  });

  describe('a trust-policy hold resumes into the gates it never reached', () => {
    /**
     * The org trust policy's PR-wide hold is decided by `applyTrustPolicyGate`,
     * which runs BEFORE `resolveWorkflowInstallSecrets`, so its replay has not
     * satisfied the install gate and has no claim to skip it.
     *
     * This pins the derivation, NOT a withheld secret. On this path the flag
     * changes nothing: `resolveInstallSecrets` strips an untrusted
     * contributor's secrets and returns before `fireProtectionRulesPerEnv`, the
     * only reader of `skipProtectionGate`, and a trust-policy hold always
     * carries a non-trusted tier. The case the derivation actually covers is a
     * run with NO tier, which `isUntrustedTier` reads leniently — see
     * `skipsInstallGate`.
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
   * `setupDispatchContext` posts the queued `kici/<workflow>` + per-job checks
   * before either gate decides, so a rejected hold has them on the commit with
   * nothing left to complete them — the checks would sit `queued` forever and
   * block branch protection.
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
      // The names are derived from the context, so the close must precede the
      // delete. Reading the context back as null proves the delete still ran.
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
   * The `KiCI Security` check the org trust policy's PR-wide hold posted as
   * `pending`. Nothing else completes it — `cancelHeldRun` writes a run row, not
   * a check run — so it sat `in_progress` on the commit forever.
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
      // Authenticated with the stored credentials of the app the pending check
      // was posted through, resolved through the effective routing key.
      expect(credentials).toEqual({ installationId: 42 });
      expect(deps.providerRegistry.getByRoutingKey).toHaveBeenCalledWith('github:1');
      // One event, one story: the two check families say the same thing.
      expect(completeUndispatchedCheckRuns.mock.calls[0][0].summary).toBe(summary);
      // Posted before the context its repo, sha and credentials come from is
      // dropped.
      expect(await loadPendingWorkflowContext(undefined, 'run1')).toBeNull();
    });

    it('does NOT post one for a rejected install-gate hold', async () => {
      // `postCheckStatus` CREATES the named run when it finds none, and an
      // install-gate hold posts no pending security check — so posting here
      // would put a failing `KiCI Security` check on a commit that never had
      // one. The `kici/…` completion still runs, which is what proves the
      // rejection took the same path and only the security post was withheld.
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
      // The repo, sha and credentials all come from the run row; without one
      // there is nothing to address a check run to.
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
