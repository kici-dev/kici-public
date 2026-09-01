/**
 * Admin API routes for the org trust policy and the approval directory it
 * arrives with.
 *
 * Exposes GET / PATCH `/api/v1/admin/trust-policy` so `kici-admin` can read the
 * enforced policy and, on an independent orchestrator, set it, plus
 * GET / PATCH / DELETE `/api/v1/admin/trust-policy/directory` for the approval
 * directory that arrives with it.
 *
 * Both are Platform-owned wherever a Platform is attached: the Platform pushes
 * them together on `trust_policy.update` and the next push would clobber a
 * local write. Every write verb therefore refuses on any Platform-attached
 * orchestrator, and the refusal is server-side so it cannot be bypassed by
 * calling the API directly. On an independent orchestrator there is no upstream
 * authority at all, so the operator is the only possible one — which is what
 * the directory's PATCH and DELETE are for. Without them nobody can ever be
 * registered as an approver there, and `/kici approve` can release no hold.
 *
 * GET stays available in every mode: reading the cache is what lets an operator
 * tell a stale directory from an absent one.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { createLogger } from '@kici-dev/shared';
import type { ActorPrincipal, OrchestratorMode } from '@kici-dev/engine';
import {
  CiTrustLevel,
  ForkPolicy,
  MIN_APPROVAL_EXPIRY_SECONDS,
  PLATFORM_CONNECTED_MODES,
} from '@kici-dev/engine';
import { handleAdminError } from './admin-errors.js';
import { requireUnscopedToken } from '../secrets/routing-key-scope.js';
import { resolveEffectivePolicy, TrustPolicyEnforcement } from '../security/trust-policy-gate.js';
import type { TrustPolicyStore } from '../security/trust-policy-store.js';
import type { TrustDirectory, TrustDirectoryStore } from '../security/trust-directory-store.js';
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

/**
 * Wording for the directory's own Platform-managed refusal. Separate from
 * {@link PLATFORM_MANAGED_MESSAGE} because it names a different thing to change
 * and a different place to change it: identity links and member CI trust levels
 * are org membership, not a policy switch.
 */
export const PLATFORM_MANAGED_DIRECTORY_MESSAGE =
  'The approval directory is managed by the KiCI Platform for this orchestrator. ' +
  'Link provider accounts and set member CI trust in the dashboard under ' +
  'Settings > Members; this orchestrator receives them on the next push.';

interface TrustPolicyRouteDeps {
  store: TrustPolicyStore;
  /**
   * The org approval directory — the Platform's cache where one is attached,
   * the operator's own registrations where none is.
   *
   * REQUIRED for the same reason `accessLog` is: an optional store would let an
   * orchestrator mount a `directory` endpoint that reports "nothing cached" on
   * every call, which reads identically to a genuinely empty cache and is
   * exactly the wrong answer to give an operator debugging a refused approval.
   */
  directory: TrustDirectoryStore;
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
  // The wire enum itself, so the route accepts every value the gate honours —
  // including `ignore`, which is what an orchestrator with no stored row
  // already applies and therefore has to be expressible.
  forkPolicy: ForkPolicy.optional(),
  /** @deprecated Accepted and stored; no dispatch decision reads it. */
  unknownContributorPolicy: z.enum(['hold', 'reject']).optional(),
  /** @deprecated Accepted and stored; no dispatch decision reads it. */
  workflowChangePolicy: z.enum(['hold', 'reject', 'allow']).optional(),
  /** The coarse spelling of the hold window; still fully supported on its own. */
  approvalExpiryHours: z.number().int().min(1).optional(),
  /**
   * The authoritative hold window, and the only spelling that can express a
   * sub-hour hold. When a PATCH carries both, this one wins — it is the more
   * specific of the two — and the store rewrites the hours column to match, so
   * the two can never be left disagreeing.
   */
  approvalExpirySeconds: z.number().int().min(MIN_APPROVAL_EXPIRY_SECONDS).optional(),
});

/**
 * One member's approval registration.
 *
 * `providerUserId` is required and non-empty, unlike the nullish field on a
 * pushed link. `findIdentityLink` matches on `(provider, providerUserId)` and
 * never falls back to the mutable username, so a link registered without one
 * would be accepted, stored, and unable to authorize anybody — a refusal an
 * operator would only discover from a failed `/kici approve`. Reject it here
 * instead.
 */
const directoryMemberSchema = z.object({
  customerId: z.string().min(1),
  userId: z.string().min(1),
  provider: z.string().min(1),
  providerUsername: z.string().min(1),
  providerUserId: z.string().min(1),
  ciTrust: CiTrustLevel,
});

/** The principal an audited directory write is attributed to. */
function directoryActor(c: Context<AdminEnv>): ActorPrincipal {
  return { type: 'service_account', id: c.get('userId') };
}

/**
 * The body every directory verb returns.
 *
 * The three lists are the ones THIS call produced, so a caller sees the effect
 * of its own write rather than whatever a concurrent one left behind.
 * `updatedAt` is re-read, because the store returns the merged document without
 * the row's write timestamp — matching how the policy PATCH re-reads for its
 * own `source` / `updatedAt`.
 */
async function directoryResponse(
  deps: TrustPolicyRouteDeps,
  customerId: string,
  directory: TrustDirectory,
): Promise<{ directory: Record<string, unknown>; platformManaged: boolean }> {
  const stored = await deps.directory.load(customerId);
  return {
    directory: {
      customerId,
      identityLinks: directory.identityLinks,
      memberCiTrustLevels: directory.memberCiTrustLevels,
      teamMemberships: directory.teamMemberships,
      updatedAt: (stored?.updatedAt ?? new Date()).toISOString(),
    },
    platformManaged: PLATFORM_CONNECTED_MODES.includes(deps.mode),
  };
}

export function createTrustPolicyRoutes(deps: TrustPolicyRouteDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  // The policy and the directory are per-customer (orgId), not per-routing-key;
  // routing-key tokens are refused outright. One registration per exact path: a
  // bare Hono path matches only itself, so the single `/trust-policy`
  // registration this list replaced did not reach the nested directory path.
  for (const path of ['/trust-policy', '/trust-policy/directory']) {
    app.use(path, async (c, next) => {
      const denied = requireUnscopedToken(c);
      if (denied) return denied;
      await next();
    });
  }

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
          ...effective,
          /**
           * @deprecated Always `policy`: `resolveEffectivePolicy` returns a
           * policy for every input, so the values above are always the ones
           * being applied. Emitted so an older `kici-admin` binary, which reads
           * this field to decide whether to render them, keeps working.
           */
          enforcement: TrustPolicyEnforcement.enum.policy,
          source: stored?.source ?? null,
          updatedAt: stored?.updatedAt?.toISOString() ?? null,
          /**
           * True when no row is stored, so the values above are the fail-closed
           * defaults rather than an operator's or the Platform's own choice.
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

  // GET /api/v1/admin/trust-policy/directory?customerId=...
  //
  // Available in every mode, unlike the two write verbs below. Reading the
  // directory is what lets an operator tell a stale one (an approval refused
  // because it predates a membership change) from an absent one (an approval
  // refused because nobody is registered at all) — two failures that look
  // identical from the pull request.
  app.get('/trust-policy/directory', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'ci_trust.read');
      const customerId = c.req.query('customerId');
      if (!customerId) return c.json({ error: 'customerId query param required' }, 400);

      const stored = await deps.directory.load(customerId);
      return c.json({
        directory:
          stored === null
            ? null
            : {
                customerId,
                identityLinks: stored.identityLinks,
                memberCiTrustLevels: stored.memberCiTrustLevels,
                teamMemberships: stored.teamMemberships,
                updatedAt: stored.updatedAt.toISOString(),
              },
        /**
         * True when the Platform owns this directory and is its only writer,
         * so the PATCH and DELETE below refuse. False on an independent
         * orchestrator, where the operator is the only writer there is.
         */
        platformManaged: PLATFORM_CONNECTED_MODES.includes(deps.mode),
      });
    } catch (err) {
      return handleAdminError(c, err, logger);
    }
  });

  // PATCH /api/v1/admin/trust-policy/directory
  //
  // Register (or re-register) one member as an approver. Independent
  // orchestrators only — see the module docstring.
  app.patch('/trust-policy/directory', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'ci_trust.admin');
      const body = directoryMemberSchema.parse(await c.req.json());
      if (PLATFORM_CONNECTED_MODES.includes(deps.mode)) {
        return c.json({ error: PLATFORM_MANAGED_DIRECTORY_MESSAGE }, 409);
      }

      const { customerId, ...registration } = body;
      const merged = await deps.directory.upsertLocalMember(
        customerId,
        registration,
        // Same transaction as the directory row, for the same reason the policy
        // PATCH audits inside its own: an operator granting themselves `write`
        // CI trust — which is all it takes to release a security hold — can
        // never land unattributed.
        (trx, directory) =>
          deps.accessLog.recordInTransaction(trx, {
            orgId: customerId,
            routingKey: null,
            actor: directoryActor(c),
            action: 'trust_directory.updated',
            target: { type: 'org_settings', id: customerId },
            requestId: null,
            source: 'admin_http',
            outcome: 'allowed',
            // The registration, not the whole merged document: a directory can
            // hold every member of the org, and the audit row is about the one
            // that changed.
            meta: { operation: 'register', registration, links: directory.identityLinks.length },
          }),
      );
      logger.info('Approval directory member registered locally', {
        customerId,
        userId: registration.userId,
        provider: registration.provider,
        ciTrust: registration.ciTrust,
      });
      return c.json(await directoryResponse(deps, customerId, merged));
    } catch (err) {
      return handleAdminError(c, err, logger);
    }
  });

  // DELETE /api/v1/admin/trust-policy/directory?customerId=...&userId=...
  //
  // Query params rather than a body: a DELETE body is ignored by enough HTTP
  // stacks that a revocation could silently target the wrong member.
  app.delete('/trust-policy/directory', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'ci_trust.admin');
      const customerId = c.req.query('customerId');
      const userId = c.req.query('userId');
      if (!customerId) return c.json({ error: 'customerId query param required' }, 400);
      if (!userId) return c.json({ error: 'userId query param required' }, 400);
      if (PLATFORM_CONNECTED_MODES.includes(deps.mode)) {
        return c.json({ error: PLATFORM_MANAGED_DIRECTORY_MESSAGE }, 409);
      }

      const { directory, removed } = await deps.directory.removeLocalMember(
        customerId,
        userId,
        // `didRemove` comes from the store rather than the destructured
        // `removed` above: the audit row is written inside the transaction,
        // before this call has returned anything to destructure.
        (trx, _merged, didRemove) =>
          deps.accessLog.recordInTransaction(trx, {
            orgId: customerId,
            routingKey: null,
            actor: directoryActor(c),
            action: 'trust_directory.updated',
            target: { type: 'org_settings', id: customerId },
            requestId: null,
            source: 'admin_http',
            outcome: 'allowed',
            meta: { operation: 'revoke', userId, removed: didRemove },
          }),
      );
      logger.info('Approval directory member removed locally', { customerId, userId, removed });
      return c.json({ ...(await directoryResponse(deps, customerId, directory)), removed });
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
