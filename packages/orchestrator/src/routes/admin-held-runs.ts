/**
 * Admin API routes for reading and answering held runs.
 *
 * GET `/api/v1/admin/held-runs` and POST `/api/v1/admin/held-runs/decision` let
 * `kici-admin held-run list|approve|reject` release a hold locally, without a Platform.
 *
 * **Independent orchestrators only.** With a Platform attached, the Platform's
 * held-run trust gate owns who may answer a hold: `ci_trust:write` for a security
 * hold, `contexts:write` / `contexts:admin` for the rest, against the acting
 * member's org RBAC. An orchestrator admin token carries no Platform membership,
 * so answering here would land a release that gate never authorized. Both verbs
 * therefore refuse with 409 in `platform` / `hybrid` / `observed`, mirroring the
 * trust-policy write verbs.
 *
 * On an independent orchestrator this route is the only answer to an
 * approval-queue hold: `/kici approve` releases the `security` queue only, and the
 * dashboard, `kici approve` and the MCP tools reach the applier over the Platform relay.
 *
 * Answering goes through the shared `applyDecision` applier, not a direct row
 * flip, so an approve obeys the hold's `approval_requirement` clauses, records a
 * `held_run_approvals` row, and resumes the held element through `routeRelease`
 * (re-dispatch the job or replay the workflow dispatch) — the part a row flip skips.
 *
 * The resume runs AFTER this route answers: the decision is durable at the
 * applier's transaction, and the resume is unbounded work whose latency must not
 * be the operator's (see `ApplyDecisionResult.consequence`). The access-log entry
 * is written when that consequence settles, so a failed resume is recorded as
 * `error` with its message, not hidden behind a successful-looking answer.
 *
 * Releasing a hold lets the held work RUN; it does not make its contributor
 * trusted. The resumed dispatch replays the hold's trust resolution, so an
 * untrusted fork PR still runs with the base-branch lock file, no
 * install/registry secrets, and an isolated cache write scope.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Kysely } from 'kysely';
import { createLogger } from '@kici-dev/shared';
import type { ActorPrincipal, OrchestratorMode } from '@kici-dev/engine';
import {
  AccessLogOutcome,
  ApprovalDecision,
  HeldRunQueueType,
  HoldScope,
  PLATFORM_CONNECTED_MODES,
} from '@kici-dev/engine';
import { HeldRunStore, HeldRunStatus, type ReleaseSignal } from '../contexts/held-runs.js';
import type {
  StoredTrustDirectory,
  TrustDirectoryStore,
} from '../security/trust-directory-store.js';
import { applyDecision, heldRunDecisionAction } from '../approvals/apply-decision.js';
import { adminActorSub, triggererSubjectFor } from '../approvals/triggerer-subject.js';
import {
  HoldOutcome,
  settleSecurityCheckForOutcome,
  type ResolveCheckStatusPoster,
} from '../pipeline/security-hold-check.js';
import type { RbacEnforcer } from '../secrets/rbac.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import type { Database, HeldRun } from '../db/types.js';
import { runDetached } from '../helpers/run-detached.js';
import { type AdminEnv, createAdminApp, requireUnscoped } from './admin-env.js';

const logger = createLogger({ prefix: 'admin-held-runs' });

/**
 * Platform-managed refusal, surfaced verbatim by the CLI. It names the surfaces
 * that DO answer the hold, because "not here" without "there instead" reads as a
 * broken build.
 */
export const PLATFORM_MANAGED_HELD_RUN_MESSAGE =
  'Held runs are answered through the KiCI Platform for this orchestrator, which ' +
  "authorizes each decision against the acting member's org RBAC. Approve or " +
  'reject in the dashboard approval queue, with `kici approve` / `kici reject`, or ' +
  'with a `/kici approve` pull-request comment.';

/**
 * Step-scope refusal. A step-scoped hold is answered through the step-approval
 * bridge, which an independent orchestrator does not wire. Flipping the row
 * anyway is worse than refusing: the agent keeps waiting while the row leaves
 * `pending`, beyond the stale detector's expiry sweep, so nothing can release
 * OR expire the step.
 */
export const STEP_SCOPE_UNSUPPORTED_MESSAGE =
  'A step-scoped hold is answered by notifying the waiting agent, which this ' +
  'orchestrator has no bridge for. Approving it here would leave the agent waiting ' +
  'with nothing left to release or expire it.';

/**
 * Refusal for an `--as` id the approval directory does not hold. The directory is
 * the enumerable set of subjects this route answers as; an unvalidated subject is
 * free text that would let an operator token write any string into
 * `held_run_approvals.approver_user_id` and satisfy any `{user}` clause by naming it.
 */
export function unregisteredApproverMessage(userId: string): string {
  return (
    `"${userId}" is not a registered member of this orchestrator's approval directory, ` +
    'so a decision cannot be attributed to them. Register them first with ' +
    '`kici-admin trust-policy directory-set`, or omit --as to answer as the admin token.'
  );
}

/** How the terminal `KiCI Security` check summary names this surface. */
const VIA_APPROVE = 'kici-admin held-run approve';
const VIA_REJECT = 'kici-admin held-run reject';

/** The release wiring the applier needs to actually resume a released element. */
export interface HeldRunReleaseWiring {
  /**
   * Re-dispatch a job-scoped release. REQUIRED, and the mount is conditional on
   * it: flipping the row without dispatching leaves the hold `approved`, the job
   * never started, and no sweep ever looking at the row again.
   */
  onJobRelease: (signal: ReleaseSignal) => Promise<void>;
  /** Replay the stored dispatch context of a released workflow-scoped hold. */
  onWorkflowRelease?: (signal: ReleaseSignal) => Promise<void>;
  /**
   * Cancel the run and drop the pending dispatch context of a REJECTED
   * workflow-scoped hold, resolving to whether it wrote the hold's terminal
   * security check itself.
   */
  onWorkflowReject?: (hold: HeldRun, reason?: string) => Promise<boolean>;
  /** Resolve the check poster of the provider bundle serving a routing key. */
  resolveCheckStatusPoster?: ResolveCheckStatusPoster;
}

export interface HeldRunRouteDeps {
  store: HeldRunStore;
  /**
   * The org approval directory — the only team membership an independent
   * orchestrator holds, so the only thing that can satisfy a `{team}` clause.
   */
  directory: TrustDirectoryStore;
  /**
   * For the per-decision reads no store owns: `org_settings.allow_self_approval`
   * and the run's triggerer.
   */
  db: Kysely<Database>;
  rbac: RbacEnforcer;
  /** Decides whether either verb is permitted at all. */
  mode: OrchestratorMode;
  /**
   * REQUIRED, as on the trust-policy route: a locally-answered hold is always
   * attributable, and an optional sink would rest that on every construction
   * site remembering to pass one.
   */
  accessLog: AccessLogWriter;
  release: HeldRunReleaseWiring;
}

const decisionSchema = z.object({
  customerId: z.string().min(1),
  heldRunId: z.string().min(1),
  decision: ApprovalDecision,
  reason: z.string().min(1).optional(),
  /**
   * Answer as a registered directory member rather than as the admin token —
   * `kici-admin held-run approve --as <user-id>`.
   *
   * Without it the subject is `service:<token user id>`, which
   * `isActorEligibleForClause` matches against neither a `{user}` clause nor a
   * `{team}` membership, so a clause-bearing hold on an independent orchestrator
   * can only expire. With it the subject is the member's own id, in the clauses'
   * vocabulary. Validated against the stored approval directory first: see
   * {@link unregisteredApproverMessage}.
   */
  asUserId: z.string().min(1).optional(),
  /**
   * Marks an approve as a `kici run --approve-all` breakglass approval, so the
   * access log records `held_run.auto_approve` (as a Platform-relayed
   * `--approve-all` does) instead of `held_run.approve`. Audit record only:
   * eligibility is enforced as for any approve, and a reject ignores it.
   * `kici-admin held-run approve` never sends it.
   */
  autoApprove: z.boolean().optional(),
});

/**
 * A locally-answered hold is attributed to a `service_account` bearing the admin
 * token's user id — the shape the trust-policy directory writes use, so both
 * operator surfaces attribute the same way.
 */
function heldRunActor(c: Context<AdminEnv>): ActorPrincipal {
  return { type: 'service_account', id: c.get('userId') };
}

/**
 * Approval subject for an admin-token decision: `service:<token user id>`, as the
 * dashboard applier derives for a service-account actor. The namespace keeps it
 * from colliding with a Keycloak sub named by an `approvers:` clause: an operator
 * token answers as itself, never as a person it typed, so
 * `held_run_approvals.approver_user_id` stays a true record of who approved.
 *
 * Re-exported from the shared subject module so this route and the dashboard
 * handler cannot drift into two `service:` namespaces.
 */
export { adminActorSub };

/** One pending hold, in the shape `resolveHeldRunId` reads. */
function toSummary(row: HeldRun): Record<string, unknown> {
  const requirement = row.approval_requirement;
  const clauses =
    requirement && typeof requirement === 'object' && 'clauses' in requirement
      ? ((requirement as { clauses?: unknown[] }).clauses ?? [])
      : [];
  return {
    id: row.id,
    runId: row.run_id,
    jobId: row.job_id,
    holdType: row.hold_type,
    queueType: row.queue_type ?? HeldRunQueueType.enum.context,
    status: row.status,
    holdScope: row.hold_scope ?? HoldScope.enum.job,
    stepIndex: row.step_index ?? null,
    reason: row.reason,
    expiresAt:
      row.expires_at instanceof Date ? row.expires_at.toISOString() : (row.expires_at ?? null),
    // Printed by the CLI so an operator sees, before trying, that a hold naming
    // `approvers:` cannot be answered by an operator token.
    clauses,
  };
}

/** Read `org_settings.allow_self_approval` (default true), matching the dashboard applier. */
async function readAllowSelfApproval(db: Kysely<Database>, orgId: string): Promise<boolean> {
  try {
    const row = await db
      .selectFrom('org_settings')
      .select('allow_self_approval')
      .where('customer_id', '=', orgId)
      .executeTakeFirst();
    return row?.allow_self_approval ?? true;
  } catch {
    return true;
  }
}

/** Team lookup from the stored approval directory (what `/kici approve` resolves against). */
function buildTeamLookup(stored: StoredTrustDirectory | null): (team: string) => Set<string> {
  const byTeam = new Map<string, Set<string>>();
  for (const team of stored?.teamMemberships ?? []) {
    byTeam.set(team.teamName, new Set(team.memberUserIds));
  }
  return (team: string) => byTeam.get(team) ?? new Set<string>();
}

/**
 * A key in `memberCiTrustLevels` (written by `upsertLocalMember`) means exactly
 * "somebody ran `trust-policy directory-set` for this id". The trust LEVEL is
 * deliberately not read: it gates the `/kici approve` comment channel, while the
 * hold's `approval_requirement` clauses decide who may answer this one.
 */
function isRegisteredMember(stored: StoredTrustDirectory | null, userId: string): boolean {
  return stored !== null && Object.hasOwn(stored.memberCiTrustLevels, userId);
}

export { triggererSubjectFor };

/** Resolve the run triggerer's subject for the self-approval gate. */
async function resolveTriggererSub(
  db: Kysely<Database>,
  runId: string,
): Promise<string | undefined> {
  const row = await db
    .selectFrom('execution_runs')
    .select('triggered_by')
    .where('run_id', '=', runId)
    .executeTakeFirst();
  return triggererSubjectFor(row?.triggered_by);
}

/**
 * Terminalize the `KiCI Security` check of a hold this route just ended. `via`
 * names the surface and NO actor is passed: the summary is public on the commit
 * check, and the only identity here is an admin token's opaque user id, so it
 * reads "Approved by an approver via kici-admin held-run approve" instead.
 */
function buildSettleSecurityCheck(
  deps: HeldRunRouteDeps,
  decision: ApprovalDecision,
): (args: {
  hold: HeldRun;
  outcome: HoldOutcome;
  reason?: string | undefined;
}) => Promise<boolean> {
  return async ({ hold, outcome, reason }) =>
    (
      await settleSecurityCheckForOutcome({
        db: deps.db,
        resolvePoster: deps.release.resolveCheckStatusPoster,
        hold,
        outcome,
        reason,
        via: decision === ApprovalDecision.enum.approve ? VIA_APPROVE : VIA_REJECT,
      })
    ).posted;
}

export function createHeldRunRoutes(deps: HeldRunRouteDeps): Hono<AdminEnv> {
  const app = createAdminApp(logger);
  const store = deps.store;
  const platformManaged = PLATFORM_CONNECTED_MODES.includes(deps.mode);

  // Held runs are per-customer (orgId), not per-routing-key; routing-key tokens
  // are refused outright. One registration per exact path — a bare Hono path
  // matches only itself.
  for (const path of ['/held-runs', '/held-runs/decision']) {
    app.use(path, requireUnscoped);
  }

  // GET /api/v1/admin/held-runs?customerId=...&runId=...
  // Refuses on a Platform-attached orchestrator like the decision verb: the
  // listing feeds a local decision, and offering it there would half work.
  app.get('/held-runs', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'ci_trust.read');
    const customerId = c.req.query('customerId');
    const runId = c.req.query('runId');
    if (!customerId) return c.json({ error: 'customerId query param required' }, 400);
    if (!runId) return c.json({ error: 'runId query param required' }, 400);
    if (platformManaged) {
      return c.json({ error: PLATFORM_MANAGED_HELD_RUN_MESSAGE }, 409);
    }

    const rows = (await store.listPending(customerId)).filter((r) => r.run_id === runId);
    runDetached(
      logger,
      'Access log write',
      () =>
        deps.accessLog.record({
          orgId: customerId,
          routingKey: null,
          actor: heldRunActor(c),
          action: 'held_run.list.read',
          target: { type: 'held_run', id: runId },
          requestId: null,
          source: 'admin_http',
          outcome: 'allowed',
          meta: { runId, pending: rows.length },
        }),
      { runId },
    );
    return c.json({ heldRuns: rows.map(toSummary) });
  });

  app.post('/held-runs/decision', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'ci_trust.admin');
    const body = decisionSchema.parse(await c.req.json());
    if (platformManaged) {
      return c.json({ error: PLATFORM_MANAGED_HELD_RUN_MESSAGE }, 409);
    }
    return await applyAdminDecision(c, deps, store, body);
  });

  return app;
}

/**
 * Answer one hold. Split out of the registration so the route factory stays a
 * registry, and so the pre-flight refusals sit next to the applier call they guard.
 */
async function applyAdminDecision(
  c: Context<AdminEnv>,
  deps: HeldRunRouteDeps,
  store: HeldRunStore,
  body: z.infer<typeof decisionSchema>,
): Promise<Response> {
  const { customerId, heldRunId, decision, reason, asUserId, autoApprove = false } = body;
  const hold = await store.getById(customerId, heldRunId);
  if (!hold || hold.status !== HeldRunStatus.Pending) {
    return c.json({ error: 'held run not found or already resolved' }, 404);
  }
  if (hold.hold_scope === HoldScope.enum.step) {
    return c.json({ error: STEP_SCOPE_UNSUPPORTED_MESSAGE }, 409);
  }

  // One read serves both the `--as` membership check and the team lookup, so
  // the id is validated against the same document the clauses are matched in.
  const directory = await deps.directory.load(customerId);
  if (asUserId !== undefined && !isRegisteredMember(directory, asUserId)) {
    return c.json({ error: unregisteredApproverMessage(asUserId) }, 400);
  }

  const actorSub = asUserId ?? adminActorSub(c.get('userId'));
  const result = await applyDecision(
    {
      orgId: customerId,
      store,
      teamMembershipLookup: buildTeamLookup(directory),
      allowSelfApproval: await readAllowSelfApproval(deps.db, customerId),
      resolveTriggererSub: (runId) => resolveTriggererSub(deps.db, runId),
      onJobRelease: deps.release.onJobRelease,
      ...(deps.release.onWorkflowRelease && {
        onWorkflowRelease: deps.release.onWorkflowRelease,
      }),
      ...(deps.release.onWorkflowReject && { onWorkflowReject: deps.release.onWorkflowReject }),
      settleSecurityCheck: buildSettleSecurityCheck(deps, decision),
    },
    { heldRunId, actorSub, decision, ...(reason !== undefined && { reason }) },
  );

  const recordDecisionAccess = (outcome: AccessLogOutcome, errorMessage?: string) =>
    deps.accessLog.record({
      orgId: customerId,
      routingKey: null,
      actor: heldRunActor(c),
      action: heldRunDecisionAction(decision, autoApprove),
      target: { type: 'held_run', id: heldRunId },
      requestId: null,
      source: 'admin_http',
      outcome,
      ...(errorMessage !== undefined && { errorMessage }),
      meta: {
        runId: hold.run_id,
        jobId: hold.job_id,
        status: result.status,
        // Both facts: the admin token authenticated, the member is the attributed
        // subject. Replacing the actor would claim a person authenticated who did not.
        ...(asUserId !== undefined && { approvedAsUserId: asUserId }),
      },
    });

  const consequence = result.consequence;
  if (consequence) {
    // The decision is durable: answer now, audit when the (unbounded) resume
    // settles. One entry per decision either way; a failed consequence records
    // `error` with its message, which is how `kici-admin access-log` shows a
    // resume that did not land.
    runDetached(
      logger,
      'Held-run decision audit',
      () =>
        consequence.then((outcome) =>
          recordDecisionAccess(
            outcome.ok ? AccessLogOutcome.enum.allowed : AccessLogOutcome.enum.error,
            outcome.error,
          ),
        ),
      { heldRunId },
    );
  } else {
    await recordDecisionAccess(
      result.accepted
        ? AccessLogOutcome.enum.allowed
        : result.status === 'ineligible'
          ? AccessLogOutcome.enum.denied
          : AccessLogOutcome.enum.error,
      result.reason,
    );
  }

  if (!result.accepted) {
    logger.info('Local held-run decision refused', {
      customerId,
      heldRunId,
      decision,
      status: result.status,
    });
    return c.json({ error: result.reason ?? result.status, status: result.status }, 409);
  }
  logger.info('Held-run decision applied locally', {
    customerId,
    heldRunId,
    runId: hold.run_id,
    decision,
    status: result.status,
  });
  return c.json({
    status: result.status,
    ...(result.remainingClauses !== undefined && { remainingClauses: result.remainingClauses }),
  });
}
