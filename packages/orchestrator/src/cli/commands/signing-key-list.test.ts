import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { createMigrationProvider } from '../../db/migration-provider.js';
import type { Database } from '../../db/types.js';
import {
  OrchestratorSigningKeyRepo,
  type UpsertActiveInput,
} from '../../db/repos/signing-keys-repo.js';
import { RbacEnforcer } from '../../secrets/rbac.js';
import { createAdminSigningKeyRoutes } from '../../routes/admin-signing-keys.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';
import { AdminApiClient } from '../api-client.js';
import { registerSigningKeyCommands } from './signing-key.js';

const ORCH_URL = 'http://orchestrator.test';

function key(kid: string, over: Partial<UpsertActiveInput> = {}): UpsertActiveInput {
  return {
    kid,
    public_jwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b', kid },
    encrypted_private_jwk: `enc-${kid}`,
    alg: 'ES256',
    signer_kind: 'db',
    key_ref: null,
    ...over,
  };
}

/**
 * `kici-admin signing-key list` prints the same output whether it reads the
 * orchestrator database or the admin API: both modes run here against one real
 * database, the admin-API mode through the real route and the real client.
 */
describeWithTestDb<Database>(
  'kici-admin signing-key list',
  { prefix: 'kici_skl_test', provider: createMigrationProvider() },
  (getDb) => {
    let db: Kysely<Database>;
    let databaseUrl: string;
    const savedDatabaseUrl = process.env.KICI_DATABASE_URL;

    beforeAll(async () => {
      ({ db, url: databaseUrl } = getDb());

      const repo = new OrchestratorSigningKeyRepo(db);
      await repo.upsertActive(key('kid-first'));
      await repo.upsertActive(
        key('kid-kms', { encrypted_private_jwk: null, signer_kind: 'aws-kms', key_ref: 'arn:k' }),
      );
      await repo.upsertActive(key('kid-revoked'));
      await repo.upsertActive(key('kid-current'));
      await repo.revoke('kid-revoked', 'compromised');
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      if (savedDatabaseUrl === undefined) delete process.env.KICI_DATABASE_URL;
      else process.env.KICI_DATABASE_URL = savedDatabaseUrl;
    });

    /** Route the real admin client's fetch into the real route, as an admin token. */
    function stubAdminApi(): ReturnType<typeof vi.fn> {
      const root = new Hono();
      root.use('*', async (c, next) => {
        c.set('role' as never, 'admin' as never);
        c.set('userId' as never, 'tester' as never);
        c.set('routingKey' as never, null as never);
        await next();
      });
      root.route('/api/v1/admin', createAdminSigningKeyRoutes({ db, rbac: new RbacEnforcer() }));
      const fetchStub = vi.fn((url: string | URL | Request, init?: RequestInit) =>
        root.request(url as string, init),
      );
      vi.stubGlobal('fetch', fetchStub);
      return fetchStub;
    }

    async function runList(args: string[]): Promise<string[]> {
      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
        lines.push(String(line));
      });
      const program = new Command();
      program.exitOverride();
      registerSigningKeyCommands(program, () => new AdminApiClient(ORCH_URL, 'kici_admin_token'));
      await program.parseAsync(['node', 'kici-admin', 'signing-key', 'list', ...args]);
      vi.mocked(console.log).mockRestore();
      return lines;
    }

    it('prints the same table over the admin API as from the database', async () => {
      delete process.env.KICI_DATABASE_URL;
      const fromDb = await runList(['--database-url', databaseUrl]);
      expect(fromDb).toHaveLength(3);
      expect(fromDb.map((l) => l.split(/\s+/)[0])).toEqual(['kid-first', 'kid-kms', 'kid-current']);

      const fetchStub = stubAdminApi();
      const fromHttp = await runList([]);
      // fails-when: the command ignores the missing database URL and never
      // reaches the admin API — or reaches it and formats the rows differently.
      expect(fetchStub).toHaveBeenCalledWith(
        `${ORCH_URL}/api/v1/admin/signing-keys`,
        expect.objectContaining({ method: 'GET' }),
      );
      expect(fromHttp).toEqual(fromDb);
    });

    it('prints the same JSON over the admin API as from the database', async () => {
      delete process.env.KICI_DATABASE_URL;
      const fromDb = await runList(['--database-url', databaseUrl, '--json']);
      stubAdminApi();
      const fromHttp = await runList(['--json']);
      expect(JSON.parse(fromHttp.join('\n'))).toEqual(JSON.parse(fromDb.join('\n')));
      expect(JSON.parse(fromDb.join('\n'))).toHaveLength(3);
    });

    it('reads the database when KICI_DATABASE_URL is set, without calling the admin API', async () => {
      // breaks-if-wrong: an operator relying on KICI_DATABASE_URL keeps the
      // direct-database read.
      process.env.KICI_DATABASE_URL = databaseUrl;
      const fetchStub = stubAdminApi();
      const lines = await runList([]);
      expect(lines).toHaveLength(3);
      expect(fetchStub).not.toHaveBeenCalled();
    });
  },
);
