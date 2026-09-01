/**
 * Admin API routes for reading and answering held runs.
 *
 * Exposes GET `/api/v1/admin/held-runs` and POST
 * `/api/v1/admin/held-runs/decision` so `kici-admin held-run list|approve|reject`
 * can release a hold locally, without a Platform.
 *
 * **Independent orchestrators only.** Wherever a Platform is attached it owns
 * who may answer a hold: the Platform's held-run trust gate resolves the hold's
 * type and requires `ci_trust:write` for a security hold and `contexts:write` /
 * `contexts:admin` for the rest, against the acting member's org RBAC. This
 * route authenticates with an orchestrator admin token, which carries
 * orchestrator RBAC and no Platform membership at all — so answering a hold here
 * on a Platform-attached deployment would land a release the Platform's own gate
 * never authorized. Both write and read therefore refuse with 409 in
 * `platform` / `hybrid` / `observed`, mirroring the trust-policy write verbs.
 *
 * On an independent orchestrator there is no upstream authority, and until this
 * route existed an approval-queue hold there had no answer at all: `/kici
 * approve` releases the `security` queue only, and the dashboard, `kici
 * approve` and the MCP tools all reach the applier over the Platform relay.
 *
 * Answering goes through the shared `applyDecision` applier, not through a
 * direct row flip, so an approve here obeys the hold's own
 * `approval_requirement` clauses, records a `held_run_approvals` row, and — this
 * is the part a row flip silently skips — resumes the held element through
 * `routeRelease`, which re-dispatches the job or replays the workflow dispatch.
 *
 * The resume runs AFTER this route answers. The decision is durable at the
 * applier's own transaction, and the resume it triggers is unbounded work whose
 * latency has no business being the operator's — see
 * `ApplyDecisionResult.consequence`. The access-log entry is written when that
 * consequence settles, so a resume that failed is recorded as `error` with its
 * message rather than being lost behind a successful-looking answer.
 *
 * Releasing a hold lets the held work RUN; it does not make its contributor
 * trusted. The resumed dispatch replays the trust resolution the hold was
 * created under, so an untrusted fork PR still runs with the base-branch lock
 * file, no install/registry secrets, and an isolated cache write scope.
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
  normalizePersistedHoldType,
} from '@kici-dev/engine';
import { handleAdminError } from './admin-errors.js';
import { requireUnscopedToken } from '../secrets/routing-key-scope.js';
import { HeldRunStore, HeldRunStatus, type ReleaseSignal } from '../contexts/held-runs.js';
import { TrustDirectoryStore } from '../security/trust-directory-store.js';
import { applyDecision } from '../approvals/apply-decision.js';
import { adminActorSub, triggererSubjectFor } from '../approvals/triggerer-subject.js';
import {
  HoldOutcome,
  settleSecurityCheckForOutcome,
  type ResolveCheckStatusPoster,
} from '../pipeline/security-hold-check.js';
import type { RbacEnforcer, Role } from '../secrets/rbac.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import type { Database, HeldRun } from '../db/types.js';

const logger = createLogger({ prefix: 'admin-held-runs' });

/**
 * Wording for the Platform-managed refusal, surfaced verbatim by the CLI.
 *
 * It names the surfaces that DO answer a hold on a Platform-attached
 * orchestrator, because "not here" without "there instead" is the refusal an
 * operator reads as a broken build.
 */
export const PLATFORM_MANAGED_HELD_RUN_MESSAGE =
  'Held runs are answered through the KiCI Platform for this orchestrator, which ' +
  "authorizes each decision against the acting member's org RBAC. Approve or " +
  'reject in the dashboard approval queue, with `kici approve` / `kici reject`, or ' +
  'with a `/kici approve` pull-request comment.';

/**
 * Wording for the step-scope refusal.
 *
 * A step-scoped hold is answered by notifying the waiting agent through the
 * step-approval bridge, which an independent orchestrator does not wire — so
 * this route has no way to tell the agent. Flipping the row anyway would be
 * strictly worse than refusing: the agent would keep waiting while the row left
 * `pending`, putting it beyond the stale detector's expiry sweep, so the step
 * would block with nothing left to release OR expire it.
 */
export const STEP_SCOPE_UNSUPPORTED_MESSAGE =
  'A step-scoped hold is answered by notifying the waiting agent, which this ' +
  'orchestrator has no bridge for. Approving it here would leave the agent waiting ' +
  'with nothing left to release or expire it.';

/** How the terminal `KiCI Security` check summary names this surface. */
const VIA_APPROVE = 'kici-admin held-run approve';
const VIA_REJECT = 'kici-admin held-run reject';

/** The release wiring the applier needs to actually resume a released element. */
export interface HeldRunReleaseWiring {
  /**
   * Re-dispatch a job-scoped release.
   *
   * REQUIRED, and the mount is conditional on it. A release path that flips the
   * row without dispatching looks like it works and does nothing — the hold
   * reads `approved`, the job never starts, and no sweep will ever look at the
   * row again.
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
  /** The held-run store the decision is applied through. */
  store: HeldRunStore;
  /**
   * The org approval directory — the only place an independent orchestrator
   * holds team membership, and therefore the only thing that can satisfy a
   * `{team}` clause on a hold's requirement.
   */
  directory: TrustDirectoryStore;
  /**
   * Orchestrator database, for the two per-decision reads the applier needs
   * that no store owns: `org_settings.allow_self_approval` and the run's
   * triggerer.
   */
  db: Kysely<Database>;
  rbac: RbacEnforcer;
  /** This orchestrator's mode; decides whether either verb is permitted at all. */
  mode: OrchestratorMode;
  /**
   * Audit sink, REQUIRED for the same reason the trust-policy route's is: the
   * guarantee this route makes is that a locally-answered hold is always
   * attributable, and an optional sink would leave that resting on every
   * construction site remembering to pass one.
   */
  accessLog: AccessLogWriter;
  release: HeldRunReleaseWiring;
}

type AdminEnv = {
  Variables: {
    role: Role;
    userId: string;
    routingKey: string | null;
  };
};

const decisionSchema = z.object({
  customerId: z.string().min(1),
  heldRunId: z.string().min(1),
  decision: ApprovalDecision,
  reason: z.string().min(1).optional(),
});

/**
 * The principal a locally-answered hold is attributed to.
 *
 * A `service_account` bearing the admin token's own user id — the same shape
 * the trust-policy directory writes use, so both operator surfaces attribute
 * the same way.
 */
function heldRunActor(c: Context<AdminEnv>): ActorPrincipal {
  return { type: 'service_account', id: c.get('userId') };
}

/**
 * The approval subject for a decision taken through an admin token.
 *
 * Namespaced `service:<token user id>`, matching how the dashboard applier
 * derives a subject for a service-account actor. The namespace is what keeps it
 * from ever colliding with a Keycloak sub named by an `approvers:` clause: an
 * operator token answers as itself, never as a person it typed the name of.
 * `held_run_approvals.approver_user_id` is the record of who approved, and a
 * subject the operator merely asserted would make that record false.
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
    // Normalized so a row an un-upgraded orchestrator wrote as `approval` /
    // `wait_timer` answers to the same `--hold-type` the CLI documents.
    holdType: normalizePersistedHoldType(row.hold_type),
    queueType: row.queue_type ?? HeldRunQueueType.enum.context,
    status: row.status,
    holdScope: row.hold_scope ?? HoldScope.enum.job,
    stepIndex: row.step_index ?? null,
    reason: row.reason,
    expiresAt:
      row.expires_at instanceof Date ? row.expires_at.toISOString() : (row.expires_at ?? null),
    // The clauses an approve must satisfy. Printed by the CLI so an operator
    // can see, before trying, that a hold naming `approvers:` cannot be
    // answered by an operator token.
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

/**
 * Build the team lookup from the stored approval directory — the same document
 * `/kici approve` is resolved against, and the only place an independent
 * orchestrator holds team membership at all.
 */
async function loadTeamLookup(
  directory: TrustDirectoryStore,
  orgId: string,
): Promise<(team: string) => Set<string>> {
  const stored = await directory.load(orgId);
  const byTeam = new Map<string, Set<string>>();
  for (const team of stored?.teamMemberships ?? []) {
    byTeam.set(team.teamName, new Set(team.memberUserIds));
  }
  return (team: string) => byTeam.get(team) ?? new Set<string>();
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
 * Terminalize the `KiCI Security` check of a hold this route just ended.
 *
 * `via` names the surface and NO actor is passed. The summary is published
 * verbatim on a public commit check, and the only identity this route holds is
 * an admin token's opaque user id — so it reads "Approved by an approver via
 * kici-admin held-run approve" rather than leaking that id onto a pull request.
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
  const app = new Hono<AdminEnv>();
  const store = deps.store;
  const platformManaged = PLATFORM_CONNECTED_MODES.includes(deps.mode);

  // Held runs are per-customer (orgId), not per-routing-key; routing-key tokens
  // are refused outright. One registration per exact path — a bare Hono path
  // matches only itself.
  for (const path of ['/held-runs', '/held-runs/decision']) {
    app.use(path, async (c, next) => {
      const denied = requireUnscopedToken(c);
      if (denied) return denied;
      await next();
    });
  }

  // GET /api/v1/admin/held-runs?customerId=...&runId=...
  //
  // Refuses on a Platform-attached orchestrator alongside the decision verb.
  // The listing exists to feed a local decision, and offering it where no local
  // decision can be taken would read as a surface that half works.
  app.get('/held-runs', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'ci_trust.read');
      const customerId = c.req.query('customerId');
      const runId = c.req.query('runId');
      if (!customerId) return c.json({ error: 'customerId query param required' }, 400);
      if (!runId) return c.json({ error: 'runId query param required' }, 400);
      if (platformManaged) {
        return c.json({ error: PLATFORM_MANAGED_HELD_RUN_MESSAGE }, 409);
      }

      const rows = (await store.listPending(customerId)).filter((r) => r.run_id === runId);
      void deps.accessLog.record({
        orgId: customerId,
        routingKey: null,
        actor: heldRunActor(c),
        action: 'held_run.list.read',
        target: { type: 'held_run', id: runId },
        requestId: null,
        source: 'admin_http',
        outcome: 'allowed',
        meta: { runId, pending: rows.length },
      });
      return c.json({ heldRuns: rows.map(toSummary) });
    } catch (err) {
      return handleAdminError(c, err, logger);
    }
  });

  // POST /api/v1/admin/held-runs/decision
  app.post('/held-runs/decision', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'ci_trust.admin');
      const body = decisionSchema.parse(await c.req.json());
      if (platformManaged) {
        return c.json({ error: PLATFORM_MANAGED_HELD_RUN_MESSAGE }, 409);
      }
      return await applyAdminDecision(c, deps, store, body);
    } catch (err) {
      return handleAdminError(c, err, logger);
    }
  });

  return app;
}

/**
 * Answer one hold and report the applier's own outcome.
 *
 * Split out of the registration so the route factory stays a registry, and so
 * the pre-flight refusals below sit next to the applier call they guard.
 */
async function applyAdminDecision(
  c: Context<AdminEnv>,
  deps: HeldRunRouteDeps,
  store: HeldRunStore,
  body: z.infer<typeof decisionSchema>,
): Promise<Response> {
  const { customerId, heldRunId, decision, reason } = body;
  const hold = await store.getById(customerId, heldRunId);
  if (!hold || hold.status !== HeldRunStatus.Pending) {
    return c.json({ error: 'held run not found or already resolved' }, 404);
  }
  if (hold.hold_scope === HoldScope.enum.step) {
    return c.json({ error: STEP_SCOPE_UNSUPPORTED_MESSAGE }, 409);
  }

  const actorSub = adminActorSub(c.get('userId'));
  const result = await applyDecision(
    {
      orgId: customerId,
      store,
      teamMembershipLookup: await loadTeamLookup(deps.directory, customerId),
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
      action: decision === ApprovalDecision.enum.approve ? 'held_run.approve' : 'held_run.reject',
      target: { type: 'held_run', id: heldRunId },
      requestId: null,
      source: 'admin_http',
      outcome,
      ...(errorMessage !== undefined && { errorMessage }),
      meta: { runId: hold.run_id, jobId: hold.job_id, status: result.status },
    });

  if (result.consequence) {
    // The decision is durable, so this route answers now and audits when the
    // consequence settles — the resume replay of a workflow-scoped hold is
    // unbounded work, and an answer that waits for it is an answer whose
    // latency is the dispatch's. One entry per decision either way; a failed
    // consequence records `error` with its message, which is where an operator
    // reading `kici-admin access-log` learns the resume did not land.
    void result.consequence.then((outcome) =>
      recordDecisionAccess(
        outcome.ok ? AccessLogOutcome.enum.allowed : AccessLogOutcome.enum.error,
        outcome.error,
      ),
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
