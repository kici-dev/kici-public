/**
 * Tests for the `/api/v1/admin/held-runs` admin routes — the local
 * (`kici-admin`) answer to a held run.
 *
 * Four load-bearing properties, each asserted against the REAL `applyDecision`
 * applier and the REAL `RbacEnforcer` rather than a stub:
 *
 * 1. **The Platform-attached refusal.** It is server-side and covers BOTH the
 *    read and the decision, so a caller hitting the API directly cannot answer
 *    a hold the Platform's own held-run trust gate never authorized.
 * 2. **A release actually dispatches.** The assertions are on the resume
 *    callback firing with the hold's own run and job, never on the row having
 *    changed — a release path that flips the row and dispatches nothing looks
 *    identical from the row.
 * 3. **The approver subject is the token's, namespaced.** No request field can
 *    name who the approval is attributed to, so `held_run_approvals` cannot
 *    record a person the operator merely typed.
 * 4. **A step-scoped hold is refused**, because approving one here would leave
 *    its agent waiting with the row out of the stale detector's reach.
 *
 * The harness mounts the routes under an OUTER Hono app whose middleware seeds
 * `role` BEFORE the handlers run, matching `admin-trust-policy.test.ts`:
 * seeding on the same instance the handlers are registered on runs the
 * middleware too late, and stubbing the enforcer would make every permission
 * check a no-op.
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  ApprovalDecision,
  HoldScope,
  HoldType,
  OrchestratorMode,
  TriggerSource,
  stringifyActor,
  type ApproverClause,
} from '@kici-dev/engine';
import {
  createHeldRunRoutes,
  adminActorSub,
  triggererSubjectFor,
  PLATFORM_MANAGED_HELD_RUN_MESSAGE,
  STEP_SCOPE_UNSUPPORTED_MESSAGE,
  type HeldRunReleaseWiring,
} from './admin-held-runs.js';
import { HeldRunStatus, type HeldRunStore, type ReleaseSignal } from '../contexts/held-runs.js';
import type {
  TrustDirectoryStore,
  StoredTrustDirectory,
} from '../security/trust-directory-store.js';
import { RbacEnforcer, type Role } from '../secrets/rbac.js';
import type { AccessLogRecord, AccessLogWriter } from '../audit/access-log.js';
import type { Database, HeldRun, HeldRunApproval } from '../db/types.js';
import type { Kysely } from 'kysely';

const ORG = 'org-1';
const RUN = 'run-abc';

function makeHold(over: Partial<HeldRun> = {}): HeldRun {
  return {
    id: 'hold-1',
    org_id: ORG,
    run_id: RUN,
    job_id: 'build',
    context_id: null,
    hold_type: HoldType.enum.reviewer,
    status: HeldRunStatus.Pending,
    queue_type: 'context',
    reason: 'Held for approval',
    approved_by: null,
    created_at: new Date('2026-08-28T00:00:00Z'),
    expires_at: new Date('2026-08-29T00:00:00Z'),
    resolved_at: null,
    hold_scope: HoldScope.enum.job,
    step_index: null,
    trigger_source: TriggerSource.enum.explicit,
    approval_requirement: { clauses: [], expiresAt: '2026-08-29T00:00:00Z', reason: 'x' },
    payload: null,
    posted_pending_check: false,
    ...over,
  } as HeldRun;
}

/**
 * An in-memory held-run store that runs the real applier against real state.
 *
 * A `vi.fn()`-per-method stub would let every assertion below pass while the
 * hold stayed pending — the transition from `pending` is what makes the
 * applier's release arm run at all.
 */
function makeStore(holds: HeldRun[]) {
  const decisions: HeldRunApproval[] = [];
  const flip = (id: string, status: HeldRunStatus, reason?: string) => {
    const row = holds.find((h) => h.id === id && h.status === HeldRunStatus.Pending);
    if (!row) throw new Error(`Held run '${id}' not found or not pending`);
    row.status = status;
    if (reason !== undefined) row.reason = reason;
    return row;
  };
  const toSignal = (row: HeldRun): ReleaseSignal => ({
    holdId: row.id,
    runId: row.run_id,
    jobId: row.job_id,
    scope: row.hold_scope as ReleaseSignal['scope'],
    stepIndex: row.step_index,
    triggerSource: row.trigger_source as ReleaseSignal['triggerSource'],
  });
  const store = {
    listPending: vi.fn(async (orgId: string) =>
      holds.filter((h) => h.org_id === orgId && h.status === HeldRunStatus.Pending),
    ),
    getById: vi.fn(
      async (orgId: string, id: string) =>
        holds.find((h) => h.org_id === orgId && h.id === id) ?? null,
    ),
    listDecisions: vi.fn(async (id: string) => decisions.filter((d) => d.held_run_id === id)),
    recordDecision: vi.fn(async (id: string, data: { approverSub: string; decision: string }) => {
      const row = {
        id: `dec-${decisions.length}`,
        held_run_id: id,
        approver_user_id: data.approverSub,
        decision: data.decision,
        clauses_satisfied: null,
        created_at: new Date(),
      } as unknown as HeldRunApproval;
      decisions.push(row);
      return row;
    }),
    recordAndRelease: vi.fn(
      async (orgId: string, id: string, data: { approverSub: string; decision: string }) => {
        await store.recordDecision(id, data);
        return toSignal(flip(id, HeldRunStatus.Approved));
      },
    ),
    recordAndReject: vi.fn(
      async (
        orgId: string,
        id: string,
        data: { approverSub: string; decision: string },
        reason?: string,
      ) => {
        await store.recordDecision(id, data);
        return flip(id, HeldRunStatus.Rejected, reason);
      },
    ),
  };
  return { store: store as unknown as HeldRunStore, decisions, holds };
}

/** Rows a query on this table resolves to, keyed by table name. */
interface DbRows {
  org_settings?: Record<string, unknown>;
  execution_runs?: Record<string, unknown>;
}

/**
 * A query-builder fake that answers per TABLE rather than per predicate.
 *
 * Deliberately predicate-blind: the org / run scoping of these two reads lives
 * in SQL the real Kysely builder emits, so a fake that pretended to apply
 * `.where(...)` would assert its own filtering rather than the route's.
 */
function makeDb(rows: DbRows): Kysely<Database> {
  const builder = (table: keyof DbRows) => {
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'selectAll', 'where', 'innerJoin', 'orderBy', 'limit']) {
      chain[method] = () => chain;
    }
    chain.executeTakeFirst = async () => rows[table];
    chain.execute = async () => [];
    return chain;
  };
  return {
    selectFrom: (table: string) => builder(table as keyof DbRows),
  } as unknown as Kysely<Database>;
}

function makeApp(opts: {
  mode?: (typeof OrchestratorMode.options)[number];
  holds?: HeldRun[];
  role?: Role;
  userId?: string;
  routingKey?: string | null;
  release?: Partial<HeldRunReleaseWiring>;
  teams?: StoredTrustDirectory['teamMemberships'];
  dbRows?: DbRows;
}) {
  const { store, decisions, holds } = makeStore(opts.holds ?? [makeHold()]);
  const onJobRelease = vi.fn(async (_signal: ReleaseSignal) => {});
  const onWorkflowRelease = vi.fn(async (_signal: ReleaseSignal) => {});
  const onWorkflowReject = vi.fn(async (_hold: HeldRun, _reason?: string) => false);
  const postCheckStatus = vi.fn(async () => {});
  const resolveCheckStatusPoster = vi.fn(() => ({ postCheckStatus }));
  const auditRows: AccessLogRecord[] = [];
  const accessLog = {
    record: vi.fn(async (entry: AccessLogRecord) => {
      auditRows.push(entry);
    }),
  } as unknown as AccessLogWriter;
  const directory = {
    load: vi.fn(async () =>
      opts.teams
        ? ({
            identityLinks: [],
            memberCiTrustLevels: {},
            teamMemberships: opts.teams,
            updatedAt: new Date(),
          } as StoredTrustDirectory)
        : null,
    ),
  } as unknown as TrustDirectoryStore;

  const inner = createHeldRunRoutes({
    store,
    directory,
    db: makeDb(opts.dbRows ?? {}),
    rbac: new RbacEnforcer(),
    mode: opts.mode ?? OrchestratorMode.enum.independent,
    accessLog,
    release: {
      onJobRelease,
      onWorkflowRelease,
      onWorkflowReject,
      resolveCheckStatusPoster,
      ...opts.release,
    } as unknown as HeldRunReleaseWiring,
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('role' as never, (opts.role ?? 'admin') as never);
    c.set('userId' as never, (opts.userId ?? 'token-7') as never);
    c.set('routingKey' as never, (opts.routingKey ?? null) as never);
    await next();
  });
  app.route('/', inner);
  return {
    app,
    /**
     * POST a decision AND let its post-commit consequence run.
     *
     * The route answers at the durable record and runs the resume / reject
     * delegate afterwards (see `ApplyDecisionResult.consequence`), so a
     * side-effect assertion cannot read the effect off the answer. Every mock in
     * this harness settles on the microtask queue with no timer or I/O in it, so
     * yielding one macrotask turn drains the whole chain — deterministically,
     * not by racing it.
     */
    request: async (body: Record<string, unknown>): Promise<Response> => {
      const res = await app.request('/held-runs/decision', decide(body));
      await new Promise((resolve) => setImmediate(resolve));
      return res;
    },
    holds,
    decisions,
    onJobRelease,
    onWorkflowRelease,
    onWorkflowReject,
    resolveCheckStatusPoster,
    postCheckStatus,
    auditRows,
  };
}

const listUrl = (runId = RUN) => `/held-runs?customerId=${ORG}&runId=${runId}`;

function decide(body: Record<string, unknown>): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) };
}

const approveBody = {
  customerId: ORG,
  heldRunId: 'hold-1',
  decision: ApprovalDecision.enum.approve,
};

describe('admin held-run routes', () => {
  describe('mode gating', () => {
    for (const mode of ['platform', 'hybrid', 'observed'] as const) {
      it(`refuses the decision with 409 in ${mode} mode`, async () => {
        const h = makeApp({ mode });
        const res = await h.request(approveBody);
        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe(PLATFORM_MANAGED_HELD_RUN_MESSAGE);
        // The refusal is BEFORE the applier, so nothing was recorded and — the
        // part that matters — nothing was dispatched.
        expect(h.holds[0].status).toBe(HeldRunStatus.Pending);
        expect(h.decisions).toHaveLength(0);
        expect(h.onJobRelease).not.toHaveBeenCalled();
      });

      it(`refuses the listing with 409 in ${mode} mode`, async () => {
        const h = makeApp({ mode });
        const res = await h.app.request(listUrl());
        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe(PLATFORM_MANAGED_HELD_RUN_MESSAGE);
      });
    }

    it('allows both verbs on an independent orchestrator', async () => {
      const h = makeApp({ mode: 'independent' });
      expect((await h.app.request(listUrl())).status).toBe(200);
      const res = await h.request(approveBody);
      expect(res.status).toBe(200);
    });
  });

  describe('rbac', () => {
    it('refuses a listing from an auditor (no ci_trust.read)', async () => {
      const h = makeApp({ role: 'auditor' });
      expect((await h.app.request(listUrl())).status).toBe(403);
    });

    it('refuses a decision from an auditor (no ci_trust.admin)', async () => {
      const h = makeApp({ role: 'auditor' });
      const res = await h.request(approveBody);
      expect(res.status).toBe(403);
      expect(h.onJobRelease).not.toHaveBeenCalled();
    });

    it('refuses a routing-key-scoped token outright', async () => {
      const h = makeApp({ routingKey: 'github:1' });
      expect((await h.app.request(listUrl())).status).toBe(403);
      expect((await h.request(approveBody)).status).toBe(403);
    });
  });

  describe('listing', () => {
    it('returns only the named run’s pending holds, with their approver clauses', async () => {
      const clauses: ApproverClause[] = [{ team: 'platform' }];
      const h = makeApp({
        holds: [
          makeHold({
            approval_requirement: { clauses, expiresAt: '2026-08-29T00:00:00Z', reason: 'r' },
          }),
          makeHold({ id: 'hold-other', run_id: 'run-other' }),
          makeHold({ id: 'hold-done', status: HeldRunStatus.Approved }),
        ],
      });
      const body = await (await h.app.request(listUrl())).json();
      expect(body.heldRuns.map((r: { id: string }) => r.id)).toEqual(['hold-1']);
      expect(body.heldRuns[0]).toMatchObject({
        runId: RUN,
        jobId: 'build',
        holdScope: HoldScope.enum.job,
        queueType: 'context',
        clauses,
      });
    });

    it('requires both customerId and runId', async () => {
      const h = makeApp({});
      expect((await h.app.request(`/held-runs?runId=${RUN}`)).status).toBe(400);
      expect((await h.app.request(`/held-runs?customerId=${ORG}`)).status).toBe(400);
    });
  });

  describe('approve', () => {
    it('releases the hold AND re-dispatches the job it was holding', async () => {
      const h = makeApp({});
      const res = await h.request(approveBody);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'released' });
      // The row moving is not the claim; the dispatch is.
      expect(h.onJobRelease).toHaveBeenCalledTimes(1);
      expect(h.onJobRelease.mock.calls[0][0]).toMatchObject({
        holdId: 'hold-1',
        runId: RUN,
        jobId: 'build',
      });
      expect(h.holds[0].status).toBe(HeldRunStatus.Approved);
    });

    it('routes a context-triggered workflow hold to the workflow replay, not the job path', async () => {
      const h = makeApp({
        holds: [
          makeHold({
            hold_scope: HoldScope.enum.workflow,
            trigger_source: TriggerSource.enum.context,
          }),
        ],
      });
      await h.request(approveBody);
      expect(h.onWorkflowRelease).toHaveBeenCalledTimes(1);
      expect(h.onJobRelease).not.toHaveBeenCalled();
    });

    it('records the approval under the token’s own namespaced subject', async () => {
      const h = makeApp({ userId: 'ops-token' });
      // A caller-supplied identity is not a field the schema has, so it is
      // dropped: the recorded approver can only ever be the token.
      await h.request({ ...approveBody, actorSub: 'alice', approverSub: 'alice' });
      expect(h.decisions).toHaveLength(1);
      expect(h.decisions[0].approver_user_id).toBe(adminActorSub('ops-token'));
      expect(h.decisions[0].approver_user_id).not.toBe('alice');
    });

    it('refuses a hold whose clauses the operator token cannot satisfy, and dispatches nothing', async () => {
      const h = makeApp({
        holds: [
          makeHold({
            approval_requirement: {
              clauses: [{ user: 'alice' }],
              expiresAt: '2026-08-29T00:00:00Z',
              reason: 'r',
            },
          }),
        ],
      });
      const res = await h.request(approveBody);
      expect(res.status).toBe(409);
      expect((await res.json()).status).toBe('ineligible');
      expect(h.onJobRelease).not.toHaveBeenCalled();
      expect(h.holds[0].status).toBe(HeldRunStatus.Pending);
    });

    it('satisfies a {team} clause the stored approval directory places the token in', async () => {
      const h = makeApp({
        userId: 'ops-token',
        teams: [{ teamName: 'platform', memberUserIds: [adminActorSub('ops-token')] }],
        holds: [
          makeHold({
            approval_requirement: {
              clauses: [{ team: 'platform' }],
              expiresAt: '2026-08-29T00:00:00Z',
              reason: 'r',
            },
          }),
        ],
      });
      const res = await h.request(approveBody);
      expect(res.status).toBe(200);
      expect(h.onJobRelease).toHaveBeenCalledTimes(1);
    });

    it('terminalizes the KiCI Security check of a security hold, naming the surface not the token', async () => {
      const h = makeApp({
        holds: [
          makeHold({
            queue_type: 'security',
            hold_type: HoldType.enum.security,
            posted_pending_check: true,
          }),
        ],
        dbRows: {
          execution_runs: {
            repo_identifier: 'acme/app',
            sha: 'deadbeef',
            routing_key: 'github:1',
            provider_context: {},
            triggered_by: 'user:someone-else',
          },
        },
      });
      await h.request(approveBody);
      expect(h.postCheckStatus).toHaveBeenCalledTimes(1);
      const [repo, sha, status, title, summary] = h.postCheckStatus.mock.calls[0];
      expect([repo, sha, status]).toEqual(['acme/app', 'deadbeef', 'success']);
      expect(title).toBeTruthy();
      // The token id must never reach a public commit check.
      expect(summary).toContain('via kici-admin held-run approve');
      expect(summary).not.toContain('token-7');
    });

    it('writes an attributed held_run.approve audit row', async () => {
      const h = makeApp({ userId: 'ops-token' });
      await h.request(approveBody);
      const row = h.auditRows.find((r) => r.action === 'held_run.approve');
      expect(row).toMatchObject({
        orgId: ORG,
        actor: { type: 'service_account', id: 'ops-token' },
        target: { type: 'held_run', id: 'hold-1' },
        source: 'admin_http',
        outcome: 'allowed',
      });
    });
  });

  describe('reject', () => {
    const rejectBody = {
      customerId: ORG,
      heldRunId: 'hold-1',
      decision: ApprovalDecision.enum.reject,
      reason: 'not this one',
    };

    it('rejects the hold and never dispatches', async () => {
      const h = makeApp({});
      const res = await h.request(rejectBody);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'rejected' });
      expect(h.holds[0].status).toBe(HeldRunStatus.Rejected);
      expect(h.onJobRelease).not.toHaveBeenCalled();
    });

    it('cancels the run behind a workflow-scoped hold rather than only flipping the row', async () => {
      const h = makeApp({ holds: [makeHold({ hold_scope: HoldScope.enum.workflow })] });
      await h.request(rejectBody);
      expect(h.onWorkflowReject).toHaveBeenCalledTimes(1);
      expect(h.onWorkflowReject.mock.calls[0][0]).toMatchObject({ id: 'hold-1' });
      expect(h.onWorkflowReject.mock.calls[0][1]).toBe('not this one');
    });

    it('audits a reject as held_run.reject, not as the approve action', async () => {
      const h = makeApp({ userId: 'ops-token' });
      await h.request(rejectBody);
      expect(h.auditRows.map((r) => r.action)).toContain('held_run.reject');
      expect(h.auditRows.map((r) => r.action)).not.toContain('held_run.approve');
    });

    it('answers before a slow resume finishes, then audits what the resume did', async () => {
      // The defect this closes lives one surface over — the Platform relay's
      // ten-second budget — but the shape is this route's too: an answer that
      // waits for the resume is an answer whose latency is the dispatch's.
      let releaseResume: (() => void) | undefined;
      const h = makeApp({
        userId: 'ops-token',
        release: {
          onJobRelease: vi.fn(
            () =>
              new Promise<void>((resolve) => {
                releaseResume = resolve;
              }),
          ),
        },
      });

      const res = await h.request(approveBody);
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe('released');
      // Answered while the resume is still in flight, and nothing was audited
      // yet — the entry belongs to the outcome, not to the answer.
      expect(releaseResume).toBeDefined();
      expect(h.auditRows.find((r) => r.action === 'held_run.approve')).toBeUndefined();

      releaseResume!();
      await vi.waitFor(() =>
        expect(h.auditRows.find((r) => r.action === 'held_run.approve')).toMatchObject({
          outcome: 'allowed',
        }),
      );
    });

    it('audits a resume that FAILED as an error, so a stranded release is not silent', async () => {
      // Where a failed resume surfaces for an operator: one `held_run.approve`
      // row, outcome `error`, carrying the failure message — readable with
      // `kici-admin access-log`. The approval itself still landed, because it
      // was durable before the resume was ever attempted.
      const h = makeApp({
        userId: 'ops-token',
        release: { onJobRelease: vi.fn().mockRejectedValue(new Error('dispatcher exploded')) },
      });

      const res = await h.request(approveBody);
      expect(res.status).toBe(200);
      expect(h.holds[0].status).toBe(HeldRunStatus.Approved);

      const row = h.auditRows.find((r) => r.action === 'held_run.approve');
      expect(row).toMatchObject({ outcome: 'error' });
      expect(row?.errorMessage).toContain('dispatcher exploded');
      // The control: a resume that works is audited `allowed`, so `error` above
      // is the failure and not this route's only rendering.
      const ok = makeApp({ userId: 'ops-token' });
      await ok.request(approveBody);
      expect(ok.auditRows.find((r) => r.action === 'held_run.approve')).toMatchObject({
        outcome: 'allowed',
      });
    });

    it('audits a refused decision as denied, so an ineligible attempt is still recorded', async () => {
      const h = makeApp({
        holds: [
          makeHold({
            approval_requirement: {
              clauses: [{ user: 'alice' }],
              expiresAt: '2026-08-29T00:00:00Z',
              reason: 'r',
            },
          }),
        ],
      });
      await h.request(approveBody);
      const row = h.auditRows.find((r) => r.action === 'held_run.approve');
      expect(row).toMatchObject({ outcome: 'denied' });
      expect(row?.errorMessage).toBeTruthy();
    });
  });

  describe('refusals that protect the hold', () => {
    it('refuses a step-scoped hold, leaving it pending so its expiry still works', async () => {
      const h = makeApp({ holds: [makeHold({ hold_scope: HoldScope.enum.step, step_index: 2 })] });
      const res = await h.request(approveBody);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(STEP_SCOPE_UNSUPPORTED_MESSAGE);
      expect(h.holds[0].status).toBe(HeldRunStatus.Pending);
      expect(h.decisions).toHaveLength(0);
    });

    it('404s an unknown or already-resolved hold', async () => {
      const h = makeApp({ holds: [makeHold({ status: HeldRunStatus.Approved })] });
      expect((await h.request(approveBody)).status).toBe(404);
      const missing = makeApp({ holds: [] });
      expect((await missing.request(approveBody)).status).toBe(404);
    });

    it('rejects a body naming neither a decision nor a hold', async () => {
      const h = makeApp({});
      const res = await h.request({ customerId: ORG });
      expect(res.status).toBe(400);
    });
  });
});

describe('the self-approval gate is live on this surface', () => {
  it('writes the triggerer subject in the same vocabulary the approver subject uses', () => {
    // The property, stated against the REAL producer of `triggered_by`: a
    // service-account trigger and this route's own subject must compare equal.
    // The bare-strip transform every other caller applies yields `ops-token`,
    // which never equals `service:ops-token` — so the gate would be inert.
    const triggeredBy = stringifyActor({ type: 'service_account', id: 'ops-token' });
    expect(triggererSubjectFor(triggeredBy)).toBe(adminActorSub('ops-token'));
    expect(triggererSubjectFor(triggeredBy)).not.toBe('ops-token');
  });

  it('keeps the bare strip for a user trigger, which is what a {user} clause names', () => {
    expect(triggererSubjectFor(stringifyActor({ type: 'user', sub: 'kc-sub-1' }))).toBe('kc-sub-1');
    expect(triggererSubjectFor(null)).toBeUndefined();
    expect(triggererSubjectFor('no-colon')).toBe('no-colon');
  });

  it('refuses the token that triggered the run when self-approval is off', async () => {
    const h = makeApp({
      userId: 'ops-token',
      dbRows: {
        org_settings: { allow_self_approval: false },
        execution_runs: {
          triggered_by: stringifyActor({ type: 'service_account', id: 'ops-token' }),
        },
      },
    });
    const res = await h.request(approveBody);
    expect(res.status).toBe(409);
    expect((await res.json()).status).toBe('ineligible');
    expect(h.onJobRelease).not.toHaveBeenCalled();
    expect(h.holds[0].status).toBe(HeldRunStatus.Pending);
  });

  it('allows the same token when the org left self-approval on, so the refusal is the setting', async () => {
    // The positive control: identical fixture, only `allow_self_approval`
    // differs. Without it the refusal above could come from anything.
    const h = makeApp({
      userId: 'ops-token',
      dbRows: {
        org_settings: { allow_self_approval: true },
        execution_runs: {
          triggered_by: stringifyActor({ type: 'service_account', id: 'ops-token' }),
        },
      },
    });
    expect((await h.request(approveBody)).status).toBe(200);
    expect(h.onJobRelease).toHaveBeenCalledTimes(1);
  });

  it('allows a different token even with self-approval off', async () => {
    const h = makeApp({
      userId: 'other-token',
      dbRows: {
        org_settings: { allow_self_approval: false },
        execution_runs: {
          triggered_by: stringifyActor({ type: 'service_account', id: 'ops-token' }),
        },
      },
    });
    expect((await h.request(approveBody)).status).toBe(200);
  });
});
