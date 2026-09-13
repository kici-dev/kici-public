/**
 * A hold released by `kici-admin held-run approve` RUNS, and runs untrusted.
 *
 * Two claims that only hold together, and that this file proves as one chain
 * rather than as two adjacent stories:
 *
 * 1. **It actually dispatches.** The approve is driven through the real admin
 *    route → the real `applyDecision` → the real `routeRelease` → the real
 *    `resumeWorkflow`, and the assertion is on `dispatchMatchedWorkflow` being
 *    called with the held run's own id. Task 11b's lesson is that a release
 *    which flips the row and never dispatches is indistinguishable from a
 *    working one if you assert on the row.
 * 2. **The dispatch it produces is still degraded.** The context the replay
 *    hands `dispatchMatchedWorkflow` is fed to the REAL install-secret resolver
 *    and the REAL cache-scope decider, each with a trusted positive control so
 *    a decider that answered the same way regardless fails rather than passes.
 *
 * `released-hold-stays-untrusted.test.ts` proves the degradations survive the
 * stored row. This file proves the surface added here lands on that same
 * replay — the two are not interchangeable, because a local release that took a
 * shortcut past `resumeWorkflow` would leave that file green and this one red.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  CacheRefScope,
  HoldScope,
  HoldType,
  OrchestratorMode,
  TriggerSource,
} from '@kici-dev/engine';
import type { Kysely } from 'kysely';
import { createHeldRunRoutes } from '../routes/admin-held-runs.js';
import { HeldRunStatus, type HeldRunStore, type ReleaseSignal } from '../contexts/held-runs.js';
import { RbacEnforcer } from '../secrets/rbac.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import type { TrustDirectoryStore } from '../security/trust-directory-store.js';
import type { Database, HeldRun, HeldRunApproval } from '../db/types.js';
import type { ProcessingDeps } from '../pipeline/processor.js';
import type { TrustResolution } from '../security/trust-resolver.js';
import {
  clearPendingWorkflowContextsMap,
  storePendingWorkflowContext,
  type SerializableWorkflowDispatchInputs,
} from '../pipeline/pending-workflow-context.js';
import { resumeWorkflow } from '../pipeline/resume-workflow.js';
import { resolveInstallSecrets } from '../pipeline/install-secrets-resolver.js';
import {
  deriveCacheRefScope,
  type WorkflowDispatchContext,
} from '../pipeline/dispatch-matched-workflow.js';

/**
 * Only the dispatch itself is stubbed. `deriveCacheRefScope` comes from the same
 * module and stays REAL, so the degradation assertions below run the shipped
 * decider rather than a fixture.
 */
const dispatchMatchedWorkflow = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../pipeline/dispatch-matched-workflow.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pipeline/dispatch-matched-workflow.js')>()),
  dispatchMatchedWorkflow,
}));

const ORG = 'org-1';
const RUN = 'run-fork-pr';

const UNTRUSTED = { tier: 'unknown', contributorUsername: 'mallory' } as unknown as TrustResolution;
const TRUSTED = { tier: 'trusted', contributorUsername: 'alice' } as unknown as TrustResolution;

/** The live deps a resume re-attaches; its registry resolves the stored key. */
const LIVE_DEPS = {
  providerRegistry: {
    getByRoutingKey: (key: string) => (key === 'rk-1' ? { hasForkModel: true } : undefined),
  },
} as unknown as ProcessingDeps;

/** The serializable dispatch inputs `holdRunForSecurityPolicy` stores. */
function storedInputs(trustResolution: TrustResolution): SerializableWorkflowDispatchInputs {
  return {
    runId: RUN,
    resolvedOrgId: ORG,
    repoIdentifier: 'acme/app',
    ref: 'deadbeef',
    lockFileSource: 'base',
    trustResolution,
    info: { routingKey: 'rk-1' },
    workflow: { name: 'ci' },
    event: {},
    credentials: {},
  } as unknown as SerializableWorkflowDispatchInputs;
}

/** The org trust policy's PR-wide hold: workflow scope, context trigger. */
function forkPolicyHold(): HeldRun {
  return {
    id: 'hold-fork',
    org_id: ORG,
    run_id: RUN,
    job_id: '__security__fork_pr',
    context_id: null,
    hold_type: HoldType.enum.security,
    status: HeldRunStatus.Pending,
    queue_type: 'security',
    reason: 'fork_pr',
    approved_by: null,
    created_at: new Date(),
    expires_at: new Date(Date.now() + 3_600_000),
    resolved_at: null,
    hold_scope: HoldScope.enum.workflow,
    step_index: null,
    trigger_source: TriggerSource.enum.context,
    approval_requirement: null,
    payload: null,
    // No pending check was posted in this fixture, so the settle declines and
    // cannot fabricate one — the claim here is the dispatch, not the check.
    posted_pending_check: false,
  } as HeldRun;
}

/** A minimal store that really transitions the row, so the release arm runs. */
function makeStore(hold: HeldRun) {
  const decisions: HeldRunApproval[] = [];
  const store = {
    getById: async () => hold,
    listDecisions: async () => decisions,
    recordDecision: async () => ({}) as HeldRunApproval,
    recordAndRelease: async (): Promise<ReleaseSignal> => {
      if (hold.status !== HeldRunStatus.Pending) throw new Error('not pending');
      hold.status = HeldRunStatus.Approved;
      return {
        holdId: hold.id,
        runId: hold.run_id,
        jobId: hold.job_id,
        scope: hold.hold_scope as ReleaseSignal['scope'],
        stepIndex: null,
        triggerSource: hold.trigger_source as ReleaseSignal['triggerSource'],
      };
    },
  };
  return store as unknown as HeldRunStore;
}

/** Predicate-blind reads for `allow_self_approval` and the run triggerer. */
function makeDb(): Kysely<Database> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'selectAll', 'where', 'innerJoin', 'orderBy', 'limit']) {
    chain[m] = () => chain;
  }
  chain.executeTakeFirst = async () => undefined;
  chain.execute = async () => [];
  return { selectFrom: () => chain } as unknown as Kysely<Database>;
}

/**
 * Approve the fork-policy hold through the real route, with the REAL
 * `resumeWorkflow` behind the workflow-release arm.
 */
async function approveThroughTheRoute(): Promise<Response> {
  const inner = createHeldRunRoutes({
    store: makeStore(forkPolicyHold()),
    directory: { load: async () => null } as unknown as TrustDirectoryStore,
    db: makeDb(),
    rbac: new RbacEnforcer(),
    mode: OrchestratorMode.enum.independent,
    accessLog: { record: async () => {} } as unknown as AccessLogWriter,
    release: {
      onJobRelease: async () => {
        throw new Error('a workflow-scoped hold must not take the job path');
      },
      // The wiring `createApp` builds, verbatim: the release replays the stored
      // dispatch context through the shipped resume.
      onWorkflowRelease: (signal) => resumeWorkflow(signal, LIVE_DEPS, undefined),
    },
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('role' as never, 'admin' as never);
    c.set('userId' as never, 'ops-token' as never);
    c.set('routingKey' as never, null as never);
    await next();
  });
  app.route('/', inner);
  return app.request('/held-runs/decision', {
    method: 'POST',
    body: JSON.stringify({ customerId: ORG, heldRunId: 'hold-fork', decision: 'approve' }),
  });
}

/** The dispatch context the replay handed `dispatchMatchedWorkflow`. */
function dispatchedContext(): WorkflowDispatchContext {
  expect(dispatchMatchedWorkflow).toHaveBeenCalledTimes(1);
  return (dispatchMatchedWorkflow.mock.calls[0] as unknown[])[0] as WorkflowDispatchContext;
}

describe('a hold released through kici-admin runs, and runs untrusted', () => {
  beforeEach(async () => {
    dispatchMatchedWorkflow.mockClear();
    clearPendingWorkflowContextsMap();
    await storePendingWorkflowContext(undefined, storedInputs(UNTRUSTED));
  });

  it('re-dispatches the held workflow under its own run id', async () => {
    const res = await approveThroughTheRoute();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'released' });
    // The claim is the dispatch, not the row.
    expect(dispatchMatchedWorkflow).toHaveBeenCalledTimes(1);
    expect((dispatchMatchedWorkflow.mock.calls[0] as unknown[])[1]).toMatchObject({
      reuseRunId: RUN,
      // The fork-policy hold is not the install gate, so its replay re-evaluates
      // that gate rather than skipping it.
      skipInstallProtectionGate: false,
    });
  });

  it('replays with the untrusted tier the held dispatch resolved', async () => {
    await approveThroughTheRoute();
    expect(dispatchedContext().trustResolution).toMatchObject({ tier: 'unknown' });
  });

  it('keeps the base-branch lock file', async () => {
    await approveThroughTheRoute();
    expect(dispatchedContext().lockFileSource).toBe('base');
  });

  it('keeps the isolated cache write scope', async () => {
    await approveThroughTheRoute();
    expect(deriveCacheRefScope(dispatchedContext().trustResolution)).toBe(
      CacheRefScope.enum.isolated,
    );
  });

  it('would give a trusted replay the shared scope, so that assertion discriminates', async () => {
    clearPendingWorkflowContextsMap();
    await storePendingWorkflowContext(undefined, storedInputs(TRUSTED));
    await approveThroughTheRoute();
    expect(deriveCacheRefScope(dispatchedContext().trustResolution)).toBe(
      CacheRefScope.enum.shared,
    );
  });

  it('still strips the install and registry secrets', async () => {
    await approveThroughTheRoute();
    const resolved = await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com', tokenSecret: 'prod:NPM_TOKEN' }] as never,
      installEnv: ['prod:BUILD_TOKEN'],
      allowHttpNpmRegistries: false,
      resolvedOrgId: ORG,
      trustResolution: dispatchedContext().trustResolution,
      contextStore: undefined,
      // Absent on purpose: reaching a resolver at all would mean the strip did
      // not happen, since the strip returns before any lookup.
      secretResolver: undefined,
      protectionContext: {} as never,
      skipProtectionGate: true,
    });
    expect(resolved).toMatchObject({
      contributorStripped: true,
      npmRegistries: undefined,
      installEnvSecrets: undefined,
    });
  });

  it('would not report a strip for a trusted replay, so that assertion discriminates', async () => {
    clearPendingWorkflowContextsMap();
    await storePendingWorkflowContext(undefined, storedInputs(TRUSTED));
    await approveThroughTheRoute();
    const resolved = await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com', tokenSecret: 'prod:NPM_TOKEN' }] as never,
      installEnv: ['prod:BUILD_TOKEN'],
      allowHttpNpmRegistries: false,
      resolvedOrgId: ORG,
      trustResolution: dispatchedContext().trustResolution,
      contextStore: undefined,
      secretResolver: undefined,
      protectionContext: {} as never,
      skipProtectionGate: true,
    });
    expect(resolved).not.toMatchObject({ contributorStripped: true });
  });
});
