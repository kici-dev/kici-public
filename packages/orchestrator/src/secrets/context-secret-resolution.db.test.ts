import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { ContextType, type SecretStore } from '@kici-dev/engine';
import type { Logger } from '@kici-dev/shared';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { ContextStore, toContext } from '../contexts/context-store.js';
import { resolveMultiEnvMergedData } from '../pipeline/job-contexts.js';
import { buildContextSecretResolver } from './context-secret-resolver.js';
import type { AuditLogger } from './audit-logger.js';
import type { PgSecretStore } from './pg-secret-store.js';
import { resolveJobQualifiedSecret } from './job-secret-gate.js';
import { terminateTestDbBackends } from '../__test-helpers__/test-db.js';

/**
 * Real-Postgres test for the secret chain a dispatched job runs: match the
 * declared context name, then resolve secrets through the matched row's
 * bindings.
 *
 * A glob context (`deploy-*`) matches a declared name (`deploy-stage`) that no
 * row carries, so the chain delivers its secrets only when the resolver reads
 * the matched row's bindings rather than looking the declared name up again.
 * The mocked suites pin each hop; this one runs the real match query and the
 * real bindings query together. A job's qualified `<context>:<key>` reference
 * takes the same path. Gated on KICI_TEST_ADMIN_DATABASE_URL.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_ctx_secret_resolution_test_${process.pid}_${Date.now()}`;
const ORG = 'org-ctx-secrets';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

/**
 * One `DEPLOY_TOKEN` secret per scope; values are stored and returned as
 * plaintext. The last four scopes share a context name, and no context binds
 * them.
 */
const SECRETS_BY_SCOPE: Record<string, string> = {
  'deploy/fixed': 'from-fixed-context',
  'deploy/glob': 'from-glob-context',
  'deploy-stage': 'from-same-named-scope',
  'legacy-ci': 'from-unbound-context-scope',
  'preview-7': 'from-unbound-glob-scope',
  'bound-ci': 'from-bound-context-same-named-scope',
};

/** Secrets under another key: the scope `bound-ci` binds carries no `DEPLOY_TOKEN`. */
const OTHER_KEY_SECRETS = [{ scope: 'bound-ci/other', key: 'OTHER_KEY', value: 'other-value' }];

/** A PG secret store stand-in holding the plaintext secrets above. */
const pgSecretStore = {
  getAllSecrets: async () => [
    ...Object.entries(SECRETS_BY_SCOPE).map(([scope, value]) => ({
      scope,
      key: 'DEPLOY_TOKEN',
      encryptedValue: value,
      keyVersion: 1,
    })),
    ...OTHER_KEY_SECRETS.map(({ scope, key, value }) => ({
      scope,
      key,
      encryptedValue: value,
      keyVersion: 1,
    })),
  ],
  decryptValue: (_org: string, _scope: string, _key: string, value: string) => value,
  // The system-scoped direct lookup by scope name: a job reference reaches it only
  // through the deprecated same-named-scope fallback.
  getSecrets: async (_org: string, scope: string) =>
    scope in SECRETS_BY_SCOPE ? { DEPLOY_TOKEN: SECRETS_BY_SCOPE[scope] } : {},
} as unknown as PgSecretStore;

describeDb('context secret resolution through the matched row (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Kysely<Database>;
  const adminUrl = ADMIN_URL!;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await new Migrator({
      db,
      provider: createMigrationProvider(),
    }).migrateToLatest();
    if (error) throw error;

    const store = new ContextStore(db);
    const fixed = await store.create(ORG, { name: 'deploy-prod', type: ContextType.enum.fixed });
    const glob = await store.create(ORG, {
      name: 'deploy-any',
      type: ContextType.enum.glob,
      globPattern: 'deploy-*',
    });
    // Binds a scope that carries only OTHER_KEY.
    const boundCi = await store.create(ORG, { name: 'bound-ci', type: ContextType.enum.fixed });
    // Neither of these binds a scope.
    await store.create(ORG, { name: 'legacy-ci', type: ContextType.enum.fixed });
    await store.create(ORG, {
      name: 'preview-any',
      type: ContextType.enum.glob,
      globPattern: 'preview-*',
    });
    await db
      .insertInto('context_bindings')
      .values([
        { org_id: ORG, context_id: fixed.id, scope_pattern: 'deploy/fixed', host_pattern: '**' },
        { org_id: ORG, context_id: glob.id, scope_pattern: 'deploy/glob', host_pattern: '**' },
        {
          org_id: ORG,
          context_id: boundCi.id,
          scope_pattern: 'bound-ci/other',
          host_pattern: '**',
        },
      ])
      .execute();
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await terminateTestDbBackends(admin, TEST_DB);
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  function realResolver() {
    return buildContextSecretResolver({
      pgSecretStore,
      backendStores: new Map([['pg', {} as SecretStore]]),
      db,
      auditLogger: { log: async () => undefined } as unknown as AuditLogger,
      logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger,
    });
  }

  /** Match `declared` the way dispatch does, then resolve its secrets. */
  async function secretsFor(declared: string): Promise<Record<string, string> | undefined> {
    const row = await new ContextStore(db).matchContext(ORG, declared);
    expect(row, `no context matched '${declared}'`).not.toBeNull();
    const secretResolver = realResolver();
    const merged = await resolveMultiEnvMergedData({
      deps: { secretResolver },
      orgId: ORG,
      entries: [{ name: declared, env: toContext(row!) }],
    });
    return merged.jobSecrets;
  }

  it('delivers a glob context secret to a job declaring a name only its pattern matches', async () => {
    // fails-when: the resolver looks 'deploy-stage' up by exact name, which no row carries
    expect(await secretsFor('deploy-stage')).toEqual({ DEPLOY_TOKEN: 'from-glob-context' });
  });

  it('resolves an exact fixed context through its own bindings, not the glob that also matches', async () => {
    // breaks-if-wrong: 'deploy-prod' is a fixed context and must keep winning over 'deploy-*'
    expect(await secretsFor('deploy-prod')).toEqual({ DEPLOY_TOKEN: 'from-fixed-context' });
  });

  /** Resolve a job's `<declared>:DEPLOY_TOKEN` reference through the job secret gate. */
  function qualifiedSecret(declared: string): Promise<string> {
    return resolveJobQualifiedSecret({
      resolver: realResolver(),
      contextStore: new ContextStore(db),
      orgId: ORG,
      context: declared,
      key: 'DEPLOY_TOKEN',
      dispatchCtx: {
        branch: 'main',
        triggerType: 'push',
        repository: 'acme/app',
        runId: 'run-1',
        jobId: 'build',
      },
      trustTier: 'trusted',
    });
  }

  it("reads a qualified reference through the glob row's bindings, not a same-named scope", async () => {
    // fails-when: the reference reads scope 'deploy-stage', which no context binds
    expect(await qualifiedSecret('deploy-stage')).toBe('from-glob-context');
  });

  it('reads a qualified reference to a fixed context through its own bindings', async () => {
    // breaks-if-wrong: an exact fixed context must still deliver its bound secret
    expect(await qualifiedSecret('deploy-prod')).toBe('from-fixed-context');
  });

  it('still reads the same-named scope of an exact context that binds nothing (deprecated)', async () => {
    // breaks-if-wrong: a reference whose secret sits in an unbound same-named scope stops resolving
    expect(await qualifiedSecret('legacy-ci')).toBe('from-unbound-context-scope');
  });

  it('reads the same-named scope of an exact context whose bound scopes lack the key (deprecated)', async () => {
    // fails-when: the fallback is limited to a context that binds no scope at all
    expect(await qualifiedSecret('bound-ci')).toBe('from-bound-context-same-named-scope');
  });

  it('never reads the same-named scope for a glob-matched context that binds nothing', async () => {
    // fails-when: the fallback's name check is dropped — the matched row is 'preview-any', not
    // 'preview-7', so that check alone refuses it here; the glob-type check is pinned by the
    // job-secret-gate unit test for a glob row whose own name equals the reference
    await expect(qualifiedSecret('preview-7')).rejects.toThrow(/Secret not found/);
  });
});
