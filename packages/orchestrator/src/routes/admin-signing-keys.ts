/**
 * Admin API route for reading the orchestrator's provenance signing keys.
 *
 *   GET /api/v1/admin/signing-keys — the trusted keys (every status except
 *                                    `revoked`), oldest first.
 *
 * Returns `{ keys: [...] }` carrying only `SIGNING_KEY_METADATA_COLUMNS`: never
 * the public JWK (served by `/.well-known/jwks.json`) and never the wrapped
 * private key. Backs `kici-admin signing-key list` when the CLI reads over the
 * admin API instead of the database.
 *
 * The keys belong to the whole orchestrator, not to one tenant, so the route
 * requires an unscoped token, and `secret.read`, the permission the other
 * read-only admin inspection routes use.
 */
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { createLogger } from '@kici-dev/shared';
import type { Database } from '../db/types.js';
import { OrchestratorSigningKeyRepo } from '../db/repos/signing-keys-repo.js';
import type { RbacEnforcer } from '../secrets/rbac.js';
import { type AdminEnv, createAdminApp, requireUnscoped } from './admin-env.js';

const logger = createLogger({ prefix: 'admin-signing-keys' });

export interface AdminSigningKeyRoutesDeps {
  db: Kysely<Database>;
  rbac: RbacEnforcer;
}

export function createAdminSigningKeyRoutes(deps: AdminSigningKeyRoutesDeps): Hono<AdminEnv> {
  const app = createAdminApp(logger);
  const repo = new OrchestratorSigningKeyRepo(deps.db);

  // fails-when: a routing-key-scoped token reads the orchestrator-wide list.
  // breaks-if-wrong: an unscoped owner or admin token must still read it.
  app.get('/signing-keys', requireUnscoped, async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'secret.read');
    return c.json({ keys: await repo.listTrustedMetadata() });
  });

  return app;
}
