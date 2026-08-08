/**
 * Admin API routes for the org trust policy.
 *
 * Exposes GET / PATCH `/api/v1/admin/trust-policy` so `kici-admin` can read the
 * enforced policy and, on an independent orchestrator, set it.
 *
 * The policy is Platform-owned wherever a Platform is attached: the Platform
 * pushes it on `trust_policy.update` and the next push would clobber a local
 * write. PATCH therefore refuses on any Platform-attached orchestrator, and the
 * refusal is server-side so it cannot be bypassed by calling the API directly.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { createLogger } from '@kici-dev/shared';
import type { ActorPrincipal, OrchestratorMode } from '@kici-dev/engine';
import { PLATFORM_CONNECTED_MODES } from '@kici-dev/engine';
import { handleAdminError } from './admin-errors.js';
import { requireUnscopedToken } from '../secrets/routing-key-scope.js';
import { resolveEffectivePolicy, TrustPolicyEnforcement } from '../security/trust-policy-gate.js';
import type { TrustPolicyStore } from '../security/trust-policy-store.js';
import type { RbacEnforcer, Role } from '../secrets/rbac.js';
import type { AccessLogWriter } from '../audit/access-log.js';

const logger = createLogger({ prefix: 'admin-trust-policy' });

/**
 * Wording for the Platform-managed refusal. Shared with the CLI through the
 * response body — the CLI surfaces this verbatim rather than inventing its own.
 */
export const PLATFORM_MANAGED_MESSAGE =
  'Trust policy is managed by the KiCI Platform for this orchestrator. ' +
  'Change it in the dashboard under Settings > CI trust.';

interface TrustPolicyRouteDeps {
  store: TrustPolicyStore;
  rbac: RbacEnforcer;
  /** This orchestrator's mode; decides whether PATCH is permitted at all. */
  mode: OrchestratorMode;
  /**
   * Audit sink for the PATCH, written inside the policy transaction.
   *
   * REQUIRED, not optional. The guarantee this route makes is that a loosened
   * `forkPolicy` can never land unattributed; an optional sink would leave that
   * resting on every construction site remembering to pass one, and a route
   * built without one would accept the write and silently skip the audit. A
   * required dependency moves the guarantee from convention to the compiler —
   * and `admin.ts` skips mounting the route entirely rather than mounting an
   * unauditable one.
   */
  accessLog: AccessLogWriter;
}

type AdminEnv = {
  Variables: {
    role: Role;
    userId: string;
    routingKey: string | null;
  };
};

const updateSchema = z.object({
  customerId: z.string().min(1),
  forkPolicy: z.enum(['hold', 'reject', 'allow']).optional(),
  unknownContributorPolicy: z.enum(['hold', 'reject']).optional(),
  workflowChangePolicy: z.enum(['hold', 'reject', 'allow']).optional(),
  approvalExpiryHours: z.number().int().min(1).optional(),
});

export function createTrustPolicyRoutes(deps: TrustPolicyRouteDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  // The policy is per-customer (orgId), not per-routing-key; routing-key tokens
  // are refused outright.
  app.use('/trust-policy', async (c, next) => {
    const denied = requireUnscopedToken(c);
    if (denied) return denied;
    await next();
  });

  // GET /api/v1/admin/trust-policy?customerId=...
  app.get('/trust-policy', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'ci_trust.read');
      const customerId = c.req.query('customerId');
      if (!customerId) return c.json({ error: 'customerId query param required' }, 400);

      const stored = await deps.store.get(customerId);
      // Report what the gate would ACTUALLY apply, resolved by the same
      // function the gate uses — a second copy of that logic here would drift
      // and misreport the enforced policy, which is the class of bug this
      // whole feature fixes.
      const effective = resolveEffectivePolicy(stored, deps.mode);
      return c.json({
        policy: {
          customerId,
          // `null` means no policy arm is in force at all: an independent
          // orchestrator with no stored row runs only the legacy
          // workflow-modification rule. Emitting the fail-closed values here
          // would tell a JSON consumer that `forkPolicy: 'hold'` is being
          // enforced when nothing holds a fork PR — the exact false assurance
          // this feature exists to remove. So the policy fields are OMITTED in
          // legacy mode and `enforcement` is the only thing to read.
          ...(effective ?? {}),
          enforcement:
            effective === null
              ? TrustPolicyEnforcement.enum.legacy
              : TrustPolicyEnforcement.enum.policy,
          source: stored?.source ?? null,
          updatedAt: stored?.updatedAt?.toISOString() ?? null,
          /**
           * True when no row is stored. Under `policy` enforcement the values
           * above are then the fail-closed defaults; under `legacy` there are
           * no values above at all, and nothing is being enforced.
           */
          effectiveDefault: stored === null,
          /** True when the Platform owns this policy and PATCH will refuse. */
          platformManaged: PLATFORM_CONNECTED_MODES.includes(deps.mode),
        },
      });
    } catch (err) {
      return handleAdminError(c, err, logger);
    }
  });

  // PATCH /api/v1/admin/trust-policy
  app.patch('/trust-policy', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'ci_trust.admin');
      const body = updateSchema.parse(await c.req.json());

      // Platform-owned policy: the Platform is the authority for a
      // Platform-attached org, and the next push would clobber a local write.
      // Refuse rather than accept a change that silently disappears.
      if (PLATFORM_CONNECTED_MODES.includes(deps.mode)) {
        return c.json({ error: PLATFORM_MANAGED_MESSAGE }, 409);
      }

      const { customerId, ...patch } = body;
      const actor: ActorPrincipal = { type: 'service_account', id: c.get('userId') };
      // The audit row is written through the SAME transaction as the policy
      // row, so a policy that loosens `forkPolicy` can never land without an
      // attributable record of who loosened it.
      const merged = await deps.store.upsertLocal(customerId, patch, async (trx, policy) => {
        await deps.accessLog.recordInTransaction(trx, {
          orgId: customerId,
          routingKey: null,
          actor,
          action: 'trust_policy.updated',
          target: { type: 'org_settings', id: customerId },
          requestId: null,
          source: 'admin_http',
          outcome: 'allowed',
          meta: { patch, policy },
        });
      });
      const stored = await deps.store.get(customerId);
      logger.info('Trust policy updated locally', { customerId, ...patch });
      return c.json({
        policy: {
          customerId,
          ...merged,
          source: stored?.source ?? null,
          updatedAt: stored?.updatedAt?.toISOString() ?? null,
        },
      });
    } catch (err) {
      return handleAdminError(c, err, logger);
    }
  });

  return app;
}
