/**
 * Admin API for the org trust policy and its approval directory.
 *
 * GET / PATCH `/api/v1/admin/trust-policy` let `kici-admin` read the enforced
 * policy and, on an independent orchestrator, set it; GET / PATCH / DELETE
 * `/api/v1/admin/trust-policy/directory` cover the approval directory.
 *
 * Both are Platform-owned wherever a Platform is attached: it pushes them
 * together on `trust_policy.update`, and the next push would clobber a local
 * write. So every write verb refuses on a Platform-attached orchestrator,
 * server-side so a direct API call cannot bypass it. On an independent
 * orchestrator the operator is the only authority, hence the directory's PATCH
 * and DELETE: without them nobody can be registered as an approver there, and
 * `/kici approve` can release no hold.
 *
 * GET works in every mode: reading the cache lets an operator tell a stale
 * directory from an absent one.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { createLogger } from '@kici-dev/shared';
import type { ActorPrincipal, OrchestratorMode } from '@kici-dev/engine';
import {
  CiTrustLevel,
  ForkPolicy,
  MAX_APPROVAL_EXPIRY_SECONDS,
  MIN_APPROVAL_EXPIRY_SECONDS,
  PLATFORM_CONNECTED_MODES,
} from '@kici-dev/engine';
import { resolveEffectivePolicy } from '../security/trust-policy-gate.js';
import type { TrustPolicyStore } from '../security/trust-policy-store.js';
import type { TrustDirectory, TrustDirectoryStore } from '../security/trust-directory-store.js';
import type { RbacEnforcer } from '../secrets/rbac.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import { type AdminEnv, createAdminApp, requireUnscoped } from './admin-env.js';

const logger = createLogger({ prefix: 'admin-trust-policy' });

/** Platform-managed refusal; the CLI shows it verbatim from the response body. */
export const PLATFORM_MANAGED_MESSAGE =
  'Trust policy is managed by the KiCI Platform for this orchestrator. ' +
  'Change it in the dashboard under Settings > CI trust.';

/**
 * The directory's Platform-managed refusal. Separate from
 * {@link PLATFORM_MANAGED_MESSAGE}: identity links and member CI trust levels are
 * org membership, changed elsewhere, not a policy switch.
 */
export const PLATFORM_MANAGED_DIRECTORY_MESSAGE =
  'The approval directory is managed by the KiCI Platform for this orchestrator. ' +
  'Link provider accounts and set member CI trust in the dashboard under ' +
  'Settings > Members; this orchestrator receives them on the next push.';

interface TrustPolicyRouteDeps {
  store: TrustPolicyStore;
  /**
   * The Platform's cache where one is attached, the operator's own
   * registrations where none is. REQUIRED: an optional store would let a
   * `directory` endpoint report "nothing cached" on every call, identical to a
   * genuinely empty cache — the wrong answer for an operator debugging a
   * refused approval.
   */
  directory: TrustDirectoryStore;
  rbac: RbacEnforcer;
  /** This orchestrator's mode; decides whether PATCH is permitted at all. */
  mode: OrchestratorMode;
  /**
   * Whether the Platform connection is up right now. `mode` says a Platform is
   * configured, not reachable, and the two differ during exactly the outage
   * that freezes the directory. Read per request so a reconnect shows without
   * re-mounting. Absent on an independent orchestrator.
   */
  platformConnected?: () => boolean;
  /**
   * Audit sink for the PATCH, written inside the policy transaction. REQUIRED
   * so a loosened `forkPolicy` can never land unattributed: an optional sink
   * would rely on every construction site passing one, and a route built
   * without it would skip the audit silently. `admin.ts` skips mounting the
   * route rather than mounting an unauditable one.
   */
  accessLog: AccessLogWriter;
}

/**
 * Strict, like the Platform route: an unknown field (a removed policy arm from
 * an older `kici-admin`) gets a structured 400 rather than a silent no-op.
 */
const updateSchema = z
  .object({
    customerId: z.string().min(1),
    // The wire enum, so every value the gate honours is accepted — including
    // `ignore`, which an orchestrator with no stored row already applies.
    forkPolicy: ForkPolicy.optional(),
    /** The hold window, in seconds, up to one year. */
    approvalExpirySeconds: z
      .number()
      .int()
      .min(MIN_APPROVAL_EXPIRY_SECONDS)
      .max(MAX_APPROVAL_EXPIRY_SECONDS)
      .optional(),
  })
  .strict();

/**
 * One member's approval registration. `providerUserId` is required, unlike on
 * a pushed link: `findIdentityLink` matches `(provider, providerUserId)` and
 * never falls back to the mutable username, so a link without one would be
 * stored yet authorize nobody, found only via a failed `/kici approve`.
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
 * The body every directory verb returns. The lists are the ones THIS call
 * produced, so a caller sees its own write, not a concurrent one's.
 * `updatedAt` is re-read because the store returns the merged document without
 * the write timestamp, as the policy PATCH re-reads `source` / `updatedAt`.
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
  const app = createAdminApp(logger);

  // Per-customer (orgId), not per-routing-key; routing-key tokens are refused.
  // One registration per exact path: a bare Hono path matches only itself, so
  // `/trust-policy` alone does not reach the nested directory path.
  for (const path of ['/trust-policy', '/trust-policy/directory']) {
    app.use(path, requireUnscoped);
  }

  // GET /api/v1/admin/trust-policy?customerId=...
  app.get('/trust-policy', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'ci_trust.read');
    const customerId = c.req.query('customerId');
    if (!customerId) return c.json({ error: 'customerId query param required' }, 400);

    const stored = await deps.store.get(customerId);
    // Report what the gate ACTUALLY applies, via the gate's own resolver: a
    // second copy of that logic would drift and misreport the enforced policy.
    const { policy: effective } = resolveEffectivePolicy(stored, deps.mode);
    return c.json({
      policy: {
        customerId,
        ...effective,
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
  });

  // GET /api/v1/admin/trust-policy/directory?customerId=...
  //
  // Every mode, unlike the write verbs: it lets an operator tell a stale
  // directory (predates a membership change) from an absent one (nobody
  // registered), two refusals that look identical from the pull request.
  app.get('/trust-policy/directory', async (c) => {
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
      /** True when the Platform is the only writer, so PATCH and DELETE refuse. */
      platformManaged: PLATFORM_CONNECTED_MODES.includes(deps.mode),
      /**
       * True when a refreshing push could arrive now. Omitted with no connection
       * to report, so absence reads as "unknown", not "down".
       */
      ...(deps.platformConnected && { platformConnected: deps.platformConnected() }),
    });
  });

  // PATCH /api/v1/admin/trust-policy/directory — register (or re-register) one
  // approver. Independent orchestrators only.
  app.patch('/trust-policy/directory', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'ci_trust.admin');
    const body = directoryMemberSchema.parse(await c.req.json());
    if (PLATFORM_CONNECTED_MODES.includes(deps.mode)) {
      return c.json({ error: PLATFORM_MANAGED_DIRECTORY_MESSAGE }, 409);
    }

    const { customerId, ...registration } = body;
    const merged = await deps.directory.upsertLocalMember(
      customerId,
      registration,
      // Same transaction as the directory row, so an operator granting
      // themselves `write` CI trust (enough to release a security hold) can
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
          // Only the changed registration: the directory can hold every member.
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
  });

  // DELETE /api/v1/admin/trust-policy/directory?customerId=...&userId=...
  // Query params, not a body: enough HTTP stacks ignore a DELETE body that a
  // revocation could silently target the wrong member.
  app.delete('/trust-policy/directory', async (c) => {
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
      // `didRemove`, not `removed`: the audit row is written inside the
      // transaction, before this call returns anything to destructure.
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
  });

  app.patch('/trust-policy', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'ci_trust.admin');
    const body = updateSchema.parse(await c.req.json());

    // Platform-owned: the next push would clobber a local write, so refuse
    // rather than accept a change that silently disappears.
    if (PLATFORM_CONNECTED_MODES.includes(deps.mode)) {
      return c.json({ error: PLATFORM_MANAGED_MESSAGE }, 409);
    }

    const { customerId, ...patch } = body;
    const actor: ActorPrincipal = { type: 'service_account', id: c.get('userId') };
    // Audit row in the SAME transaction, so a loosened `forkPolicy` never
    // lands without a record of who loosened it.
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
  });

  return app;
}
