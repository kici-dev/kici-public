import { beforeAll, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import {
  OrchestratorSigningKeyRepo,
  SIGNING_KEY_METADATA_COLUMNS,
  type UpsertActiveInput,
} from '../db/repos/signing-keys-repo.js';
import { SigningKeyStatus } from '../oidc/signing-key-status.js';
import { RbacEnforcer, type Role } from '../secrets/rbac.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';
import { createAdminSigningKeyRoutes } from './admin-signing-keys.js';

const PRIVATE_MATERIAL = 'enc-private-material-never-served';

function key(kid: string, over: Partial<UpsertActiveInput> = {}): UpsertActiveInput {
  return {
    kid,
    public_jwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b', kid },
    encrypted_private_jwk: PRIVATE_MATERIAL,
    alg: 'ES256',
    signer_kind: 'db',
    key_ref: null,
    ...over,
  };
}

/**
 * `GET /api/v1/admin/signing-keys` — the read-only key listing behind
 * `kici-admin signing-key list` in admin-API mode.
 *
 * Surface ids exercised here (needled by the coverage gate):
 *   route:GET /signing-keys
 */
describeWithTestDb<Database>(
  'admin signing-keys routes',
  { prefix: 'kici_ask_test', provider: createMigrationProvider() },
  (getDb) => {
    let db: Kysely<Database>;

    beforeAll(async () => {
      ({ db } = getDb());
      const repo = new OrchestratorSigningKeyRepo(db);
      await repo.upsertActive(key('kid-old'));
      await repo.upsertActive(
        key('kid-kms', {
          encrypted_private_jwk: null,
          signer_kind: 'aws-kms',
          key_ref: 'arn:aws:kms:eu-west-1:1:key/k',
        }),
      );
      await repo.upsertActive(key('kid-revoked'));
      await repo.upsertActive(key('kid-current'));
      await repo.revoke('kid-revoked', 'compromised');
    });

    function app(opts: { role: Role; routingKey?: string | null }) {
      const root = new Hono();
      root.use('*', async (c, next) => {
        c.set('role' as never, opts.role as never);
        c.set('userId' as never, 'tester' as never);
        c.set('routingKey' as never, (opts.routingKey ?? null) as never);
        await next();
      });
      root.route('/', createAdminSigningKeyRoutes({ db, rbac: new RbacEnforcer() }));
      return root;
    }

    it('lists the trusted keys oldest first, with public metadata only', async () => {
      const res = await app({ role: 'admin' }).request('/signing-keys');
      expect(res.status).toBe(200);
      const text = await res.text();
      // fails-when: the route selects the whole row — the wrapped private key and
      // the public JWK ride out with the listing.
      expect(text).not.toContain(PRIVATE_MATERIAL);
      const body = JSON.parse(text) as { keys: Record<string, unknown>[] };
      expect(body.keys.map((k) => k.kid)).toEqual(['kid-old', 'kid-kms', 'kid-current']);
      for (const row of body.keys) {
        expect(Object.keys(row).sort()).toEqual([...SIGNING_KEY_METADATA_COLUMNS].sort());
      }
      expect(body.keys.find((k) => k.kid === 'kid-kms')).toMatchObject({
        status: SigningKeyStatus.enum.retiring,
        alg: 'ES256',
        signer_kind: 'aws-kms',
        key_ref: 'arn:aws:kms:eu-west-1:1:key/k',
      });
      expect(body.keys.find((k) => k.kid === 'kid-current')?.status).toBe(
        SigningKeyStatus.enum.active,
      );
    });

    it('refuses a role without the read permission', async () => {
      // fails-when: the route skips the permission check — the auditor role
      // (no secret.read) would read the key list.
      const res = await app({ role: 'auditor' }).request('/signing-keys');
      expect(res.status).toBe(403);
    });

    it('refuses a token scoped to one routing key', async () => {
      // fails-when: the route skips the unscoped-token guard — a tenant-scoped
      // token would read the orchestrator-wide key list.
      const res = await app({ role: 'owner', routingKey: 'github:1' }).request('/signing-keys');
      expect(res.status).toBe(403);
      // breaks-if-wrong: the same role with an unscoped token still reads it.
      expect((await app({ role: 'owner' }).request('/signing-keys')).status).toBe(200);
    });
  },
);
