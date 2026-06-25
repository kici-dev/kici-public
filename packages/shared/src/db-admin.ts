import { createHash } from 'node:crypto';
import pg from 'pg';
import type { MigrationProvider } from 'kysely/migration';
import { createPool } from './db.js';

/**
 * Admin/DB-operations helpers shared between `kici-admin` (orchestrator DB)
 * and `kici-platform-admin` (Platform DB). Each CLI wraps these with its own
 * bundled migration provider and audit-log pattern.
 *
 * All destructive ops require the caller to pass a fully-formed database URL
 * — no parsing of environment variables here. The CLI layer handles that.
 */

export const MIGRATION_HASH_TABLE = '_migration_content_hash';

interface ParsedDatabaseUrl {
  adminUrl: string;
  dbName: string;
  dbOwner: string;
}

/**
 * Parse a libpq-style URL into (adminUrl, dbName, dbOwner).
 *
 * `adminUrl` connects to the `postgres` maintenance DB so callers can run
 * `CREATE DATABASE` / `DROP DATABASE` on `dbName`. `dbOwner` is the URL's
 * username, which becomes the new DB owner when we create it.
 */
export function parseDatabaseUrl(databaseUrl: string): ParsedDatabaseUrl {
  const url = new URL(databaseUrl);
  const dbName = url.pathname.replace(/^\//, '');
  if (!dbName) {
    throw new Error(`Database URL missing /dbname path component: ${maskDatabaseUrl(databaseUrl)}`);
  }
  const dbOwner = decodeURIComponent(url.username);
  if (!dbOwner) {
    throw new Error(`Database URL missing username: ${maskDatabaseUrl(databaseUrl)}`);
  }
  url.pathname = '/postgres';
  return { adminUrl: url.toString(), dbName, dbOwner };
}

/**
 * Redact the password from a libpq URL for safe logging.
 */
export function maskDatabaseUrl(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '<unparseable database-url>';
  }
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function assertValidIdentifier(name: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid ${label} identifier: ${name}`);
  }
}

async function withAdminPool<T>(adminUrl: string, fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: adminUrl, max: 1 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

/**
 * DROP `dbName` (if it exists). Terminates existing backend connections
 * so the DROP doesn't block. Idempotent — drops are IF EXISTS.
 *
 * Used by e2e cleanup after a full-lifecycle service-deploy test tears
 * down its isolated database. Shares the same admin-URL + identifier-
 * validation + backend-termination scaffolding as dropAndCreateDatabase
 * so the two helpers cannot drift.
 */
export async function dropDatabaseDirect(databaseUrl: string): Promise<void> {
  const { adminUrl, dbName } = parseDatabaseUrl(databaseUrl);
  assertValidIdentifier(dbName, 'database name');
  await withAdminPool(adminUrl, async (pool) => {
    await pool.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity ' +
        'WHERE datname = $1 AND pid <> pg_backend_pid()',
      [dbName],
    );
    await pool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  });
}

/**
 * Drop `dbName` (if it exists), then recreate it owned by `owner`. Terminates
 * existing backend connections so the DROP doesn't block.
 */
export async function dropAndCreateDatabase(databaseUrl: string): Promise<void> {
  const { adminUrl, dbName, dbOwner } = parseDatabaseUrl(databaseUrl);
  assertValidIdentifier(dbName, 'database name');
  assertValidIdentifier(dbOwner, 'database owner');
  await withAdminPool(adminUrl, async (pool) => {
    await pool.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity ' +
        'WHERE datname = $1 AND pid <> pg_backend_pid()',
      [dbName],
    );
    await pool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await pool.query(`CREATE DATABASE "${dbName}" OWNER "${dbOwner}"`);
  });
}

export interface EnsureDatabaseOpts {
  /**
   * DB owner role. Defaults to the URL's username. Pass when the admin
   * connection user is privileged (e.g. Patroni superuser) but the new
   * database should be owned by a separate, non-privileged role — the
   * cross-owner case for provisioning shared-cluster databases like
   * Keycloak's on the Platform Patroni cluster.
   */
  owner?: string;
  /**
   * After creating (or finding) the database, run
   * `REVOKE CONNECT ON DATABASE "<name>" FROM PUBLIC`. Recommended for
   * shared Patroni clusters where multiple unrelated databases coexist
   * (Platform + Keycloak today, more tomorrow) — the default `PUBLIC`
   * CONNECT grant otherwise lets any role with LOGIN on the cluster
   * reach the new database. Idempotent (REVOKE on an already-revoked
   * grant is a no-op).
   */
  revokeConnectFromPublic?: boolean;
  /**
   * After creating (or finding) the database — and after the optional
   * `REVOKE CONNECT … FROM PUBLIC` — `GRANT CONNECT ON DATABASE "<name>"
   * TO "<role>"` for each role here. Pairs with `revokeConnectFromPublic`
   * to re-grant CONNECT to the specific non-PUBLIC roles that legitimately
   * need it once the default PUBLIC grant is revoked. Idempotent (GRANT on
   * an already-present grant is a no-op). Each name is validated as a SQL
   * identifier before interpolation.
   */
  grantConnectToRoles?: string[];
}

/**
 * CREATE DATABASE IF NOT EXISTS (idempotent). With no `opts`, the URL's
 * username is the owner. Pass `owner` to override and
 * `revokeConnectFromPublic` to lock down the default CONNECT grant.
 */
export async function ensureDatabase(
  databaseUrl: string,
  opts: EnsureDatabaseOpts = {},
): Promise<'created' | 'exists'> {
  const { adminUrl, dbName, dbOwner } = parseDatabaseUrl(databaseUrl);
  const finalOwner = opts.owner ?? dbOwner;
  assertValidIdentifier(dbName, 'database name');
  assertValidIdentifier(finalOwner, 'database owner');
  return withAdminPool(adminUrl, async (pool) => {
    const check = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    let outcome: 'created' | 'exists';
    if (check.rows.length > 0) {
      outcome = 'exists';
    } else {
      await pool.query(`CREATE DATABASE "${dbName}" OWNER "${finalOwner}"`);
      outcome = 'created';
    }
    if (opts.revokeConnectFromPublic) {
      await pool.query(`REVOKE CONNECT ON DATABASE "${dbName}" FROM PUBLIC`);
    }
    for (const role of opts.grantConnectToRoles ?? []) {
      assertValidIdentifier(role, 'grant-connect role');
      await pool.query(`GRANT CONNECT ON DATABASE "${dbName}" TO "${role}"`);
    }
    return outcome;
  });
}

/**
 * CREATE ROLE ... LOGIN [CREATEDB] (idempotent — updates password if role
 * already exists).
 */
export async function createDbRole(
  adminUrl: string,
  opts: { username: string; password: string; createDb?: boolean },
): Promise<'created' | 'updated'> {
  assertValidIdentifier(opts.username, 'role name');
  return withAdminPool(adminUrl, async (pool) => {
    const exists = await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [opts.username]);
    const pw = escapeSqlLiteral(opts.password);
    if (exists.rows.length === 0) {
      const createDbClause = opts.createDb ? ' CREATEDB' : '';
      await pool.query(`CREATE ROLE "${opts.username}" LOGIN${createDbClause} PASSWORD '${pw}'`);
      return 'created';
    }
    await pool.query(`ALTER ROLE "${opts.username}" PASSWORD '${pw}'`);
    return 'updated';
  });
}

/**
 * Create a read-only role and grant SELECT on all tables in the public schema
 * (plus default privileges for tables created later).
 *
 * `databaseUrl` must connect as the DB owner (or superuser) since we need to
 * ALTER DEFAULT PRIVILEGES.
 */
export async function createReadOnlyDbUser(
  databaseUrl: string,
  opts: { username: string; password: string },
): Promise<'created' | 'updated'> {
  assertValidIdentifier(opts.username, 'role name');
  const { dbName } = parseDatabaseUrl(databaseUrl);
  assertValidIdentifier(dbName, 'database name');
  const pool = createPool(databaseUrl);
  try {
    const exists = await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [opts.username]);
    const pw = escapeSqlLiteral(opts.password);
    let outcome: 'created' | 'updated';
    if (exists.rows.length === 0) {
      await pool.query(`CREATE ROLE "${opts.username}" LOGIN PASSWORD '${pw}'`);
      outcome = 'created';
    } else {
      await pool.query(`ALTER ROLE "${opts.username}" PASSWORD '${pw}'`);
      outcome = 'updated';
    }
    await pool.query(`GRANT CONNECT ON DATABASE "${dbName}" TO "${opts.username}"`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO "${opts.username}"`);
    await pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${opts.username}"`);
    await pool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO "${opts.username}"`,
    );
    return outcome;
  } finally {
    await pool.end();
  }
}

/**
 * Compute a stable content hash over all migrations the provider exposes.
 * Uses migration name + the string representation of `up`/`down` (via
 * `Function.toString()`), so brute-force rewrites of a migration body invalidate
 * the hash even when the filename stays the same.
 *
 * Works with any `MigrationProvider` — file-based or the orchestrator /
 * Platform bundled ones.
 */
export async function computeMigrationsHash(provider: MigrationProvider): Promise<string> {
  const migrations = await provider.getMigrations();
  const names = Object.keys(migrations).sort();
  const hash = createHash('sha256');
  for (const name of names) {
    const migration = migrations[name];
    hash.update(name);
    hash.update('\0');
    hash.update(migration.up.toString());
    hash.update('\0');
    if (migration.down) {
      hash.update(migration.down.toString());
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Marker row key used by the bundled-provider hash (`computeMigrationsHash`).
 *
 * Kept distinct from the legacy e2e file-based hash (which still writes to
 * the row keyed `'kysely_migration'`) so the two algorithms can coexist in
 * the same `_migration_content_hash` table without clobbering each other.
 * `kici-admin db check-schema` / `kici-platform-admin db check-schema` read
 * this row; the e2e `isSchemaCurrent` helper reads the other.
 */
export const PROVIDER_HASH_KEY = 'kysely_migration_provider';

/**
 * Ensure the content-hash marker table exists, then upsert `hash` keyed by
 * `PROVIDER_HASH_KEY`. Paired with `readStoredMigrationContentHash` +
 * `isSchemaCurrent`.
 */
export async function storeMigrationContentHash(pool: pg.Pool, hash: string): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_HASH_TABLE} (
      table_name text PRIMARY KEY,
      hash text NOT NULL
    )
  `);
  await pool.query(
    `INSERT INTO ${MIGRATION_HASH_TABLE} (table_name, hash) VALUES ($1, $2) ` +
      `ON CONFLICT (table_name) DO UPDATE SET hash = EXCLUDED.hash`,
    [PROVIDER_HASH_KEY, hash],
  );
}

/**
 * Read the provider-based content hash, or `null` if the marker table / row
 * doesn't exist.
 */
export async function readStoredMigrationContentHash(pool: pg.Pool): Promise<string | null> {
  try {
    const result = await pool.query<{ hash: string }>(
      `SELECT hash FROM ${MIGRATION_HASH_TABLE} WHERE table_name = $1`,
      [PROVIDER_HASH_KEY],
    );
    return result.rows[0]?.hash ?? null;
  } catch {
    return null;
  }
}

export interface PurgeStaleExecutionResult {
  runsDeleted: number;
  jobsDeleted: number;
  concurrencyGroupsDeleted: number;
}

/**
 * TRUNCATE dispatch_queue on the orchestrator DB (direct SQL). Used by the
 * `kici-admin queue clear --database-url ...` direct-DB fallback when the
 * orchestrator isn't reachable over HTTP (e.g. warm-start cleanup before the
 * service restarts).
 */
export async function clearDispatchQueueDirect(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await pool.query('TRUNCATE dispatch_queue');
  } finally {
    await pool.end();
  }
}

/**
 * DELETE orphan execution_runs + execution_jobs for routing keys other than
 * `routingKey` (and rows with NULL routing_key). Returns row counts.
 */
export async function purgeStaleExecutionDirect(
  databaseUrl: string,
  routingKey: string,
): Promise<PurgeStaleExecutionResult> {
  const pool = createPool(databaseUrl);
  try {
    // Wipe stale concurrency_groups rows. Two reasons to delete:
    // 1. routing_key from a different deployment (mirrors execution_runs).
    // 2. run_id refers to an execution_run we're about to delete (orphans).
    // 3. (E2E warm cleanup) any non-terminal status under THIS routing key
    //    whose owning run is no longer 'running'/'pending'/'queued' — agents
    //    from the previous test invocation are gone and the slot-release
    //    path would otherwise pick the orphan first by created_at ASC.
    // The table has no FK on run_id so we have to clean it explicitly.
    const concurrencyGroupsResult = await pool.query(
      `DELETE FROM concurrency_groups
        WHERE routing_key != $1
           OR routing_key IS NULL
           OR run_id NOT IN (
             SELECT run_id FROM execution_runs
              WHERE status IN ('pending', 'running', 'cancelling')
           )`,
      [routingKey],
    );
    const jobs = await pool.query(
      `DELETE FROM execution_jobs
        WHERE run_id IN (
          SELECT run_id FROM execution_runs
           WHERE routing_key != $1 OR routing_key IS NULL
        )`,
      [routingKey],
    );
    const runs = await pool.query(
      `DELETE FROM execution_runs WHERE routing_key != $1 OR routing_key IS NULL`,
      [routingKey],
    );
    return {
      jobsDeleted: jobs.rowCount ?? 0,
      runsDeleted: runs.rowCount ?? 0,
      concurrencyGroupsDeleted: concurrencyGroupsResult.rowCount ?? 0,
    };
  } finally {
    await pool.end();
  }
}

export interface PurgeStaleSourcesResult {
  dryRun: boolean;
  secretsDeleted?: number;
  sourcesDeleted?: number;
  genericDeleted?: number;
  registrationsDeleted?: number;
  staleSecrets?: number;
  staleSources?: number;
  genericSources?: number;
  orphanRegistrations?: number;
}

/**
 * DELETE orphan sources + their `__system__`-scoped webhook/private-key
 * secrets, all `generic_webhook_sources` (the table is single-tenant per
 * deployment), and any `workflow_registrations` rows whose routing_key no
 * longer points at an existing source. When `dryRun` is true, only count
 * the rows that would be deleted.
 *
 * Orphan registration cleanup is critical: generic_webhook_sources is wiped
 * wholesale, but workflow_registrations rows previously persisted under those
 * routing keys would otherwise survive and pollute the cross-source dispatch
 * fan-out on the next test run (causing clone attempts against long-dead
 * repo identifiers from earlier tests).
 */
export async function purgeStaleSourcesDirect(
  databaseUrl: string,
  routingKey: string,
  dryRun: boolean,
): Promise<PurgeStaleSourcesResult> {
  const pool = createPool(databaseUrl);
  try {
    if (dryRun) {
      const staleSources = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM sources WHERE routing_key != $1`,
        [routingKey],
      );
      const staleSecrets = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM scoped_secrets
          WHERE org_id = '__system__'
            AND scope LIKE '__source__/%'
            AND scope NOT IN (
              SELECT '__source__/' || id::text FROM sources WHERE routing_key = $1
            )`,
        [routingKey],
      );
      const genericSources = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM generic_webhook_sources`,
      );
      // After source cleanup, a registration is orphan when its routing_key
      // isn't the current test's routing_key and isn't a generic_webhook_sources
      // row (which gets wiped wholesale below).
      const orphanRegistrations = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM workflow_registrations
          WHERE routing_key != $1
            AND routing_key NOT IN (SELECT routing_key FROM generic_webhook_sources)`,
        [routingKey],
      );
      return {
        dryRun: true,
        staleSecrets: staleSecrets.rows[0]?.count ?? 0,
        staleSources: staleSources.rows[0]?.count ?? 0,
        genericSources: genericSources.rows[0]?.count ?? 0,
        orphanRegistrations: orphanRegistrations.rows[0]?.count ?? 0,
      };
    }
    const secrets = await pool.query(
      `DELETE FROM scoped_secrets
        WHERE org_id = '__system__'
          AND scope LIKE '__source__/%'
          AND scope NOT IN (
            SELECT '__source__/' || id::text FROM sources WHERE routing_key = $1
          )`,
      [routingKey],
    );
    const sources = await pool.query(`DELETE FROM sources WHERE routing_key != $1`, [routingKey]);
    const generic = await pool.query(`DELETE FROM generic_webhook_sources`);
    // Wipe registrations whose routing_key no longer resolves — generic rows
    // are all gone above, real-provider rows survive in `sources` (if any).
    const registrations = await pool.query(
      `DELETE FROM workflow_registrations
        WHERE routing_key != $1
          AND routing_key NOT IN (SELECT routing_key FROM sources)`,
      [routingKey],
    );
    return {
      dryRun: false,
      secretsDeleted: secrets.rowCount ?? 0,
      sourcesDeleted: sources.rowCount ?? 0,
      genericDeleted: generic.rowCount ?? 0,
      registrationsDeleted: registrations.rowCount ?? 0,
    };
  } finally {
    await pool.end();
  }
}

/**
 * Bulk-delete scoped_secrets. Scoped to one org when `orgId` is provided,
 * else all orgs. Returns the number of rows deleted.
 */
export async function purgeScopedSecretsDirect(
  databaseUrl: string,
  orgId?: string,
): Promise<{ deleted: number }> {
  const pool = createPool(databaseUrl);
  try {
    const result = orgId
      ? await pool.query(`DELETE FROM scoped_secrets WHERE org_id = $1`, [orgId])
      : await pool.query(`DELETE FROM scoped_secrets`);
    return { deleted: result.rowCount ?? 0 };
  } finally {
    await pool.end();
  }
}

// ── environment ops ────────────────────────────────────────────────────
//
// Direct-DB helpers backing `kici-admin environment` (Stage 5a #1). These
// abstract the `ON CONFLICT (org_id, name) DO UPDATE` upsert pattern that
// the e2e setup helpers previously open-coded against `new pg.Pool`. Every
// helper owns its own pool (max=1) and awaits `pool.end()` in finally —
// callers pass a database URL, not a pool.

/**
 * Allowed policy field names for `setEnvironmentPolicyDirect`. Kept as an
 * explicit allowlist so the column-name interpolation in the UPDATE string
 * can never be driven by unsanitised caller input.
 */
const ENV_POLICY_COLUMNS = new Set<string>([
  'branch_restrictions',
  'required_reviewers',
  'wait_timer_seconds',
  'hold_expiry_seconds',
  'minimum_trust',
  'enabled',
  'allow_local_execution',
]);

export interface SeedEnvironmentOpts {
  orgId: string;
  name: string;
  type?: string;
  enabled?: boolean;
  branchRestrictions?: unknown;
  requiredReviewers?: unknown;
  waitTimerSeconds?: number | null;
  holdExpirySeconds?: number | null;
  minimumTrust?: string | null;
  globPattern?: string | null;
}

export interface SeedEnvironmentResult {
  envId: string;
  created: boolean;
}

/**
 * Upsert an environment row keyed by (org_id, name). Returns the env id and
 * whether the row was newly inserted. `branchRestrictions` / `requiredReviewers`
 * are JSON-serialised server-side; pass them as plain arrays or objects.
 */
export async function seedEnvironmentDirect(
  databaseUrl: string,
  opts: SeedEnvironmentOpts,
): Promise<SeedEnvironmentResult> {
  if (opts.waitTimerSeconds != null && opts.waitTimerSeconds < 0) {
    throw new Error(`environment: waitTimerSeconds must be >= 0 (got ${opts.waitTimerSeconds})`);
  }
  if (opts.holdExpirySeconds != null && opts.holdExpirySeconds < 0) {
    throw new Error(`environment: holdExpirySeconds must be >= 0 (got ${opts.holdExpirySeconds})`);
  }
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const branchJson = JSON.stringify(opts.branchRestrictions ?? []);
    const reviewersJson =
      opts.requiredReviewers === undefined ? null : JSON.stringify(opts.requiredReviewers);
    const result = await pool.query<{ id: string; inserted: boolean }>(
      `INSERT INTO environments
          (org_id, name, type, enabled, branch_restrictions, required_reviewers,
           wait_timer_seconds, hold_expiry_seconds, minimum_trust, glob_pattern)
        VALUES ($1, $2, COALESCE($3, 'fixed'), COALESCE($4, true), $5::jsonb, $6::jsonb,
                $7, COALESCE($8, 86400), $9, $10)
        ON CONFLICT (org_id, name) DO UPDATE SET
          type = COALESCE(EXCLUDED.type, environments.type),
          enabled = EXCLUDED.enabled,
          branch_restrictions = EXCLUDED.branch_restrictions,
          required_reviewers = EXCLUDED.required_reviewers,
          wait_timer_seconds = EXCLUDED.wait_timer_seconds,
          hold_expiry_seconds = EXCLUDED.hold_expiry_seconds,
          minimum_trust = EXCLUDED.minimum_trust,
          glob_pattern = COALESCE(EXCLUDED.glob_pattern, environments.glob_pattern),
          updated_at = now()
        RETURNING id, (xmax = 0) AS inserted`,
      [
        opts.orgId,
        opts.name,
        opts.type ?? null,
        opts.enabled ?? null,
        branchJson,
        reviewersJson,
        opts.waitTimerSeconds ?? null,
        opts.holdExpirySeconds ?? null,
        opts.minimumTrust ?? null,
        opts.globPattern ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`environment: upsert returned no row for ${opts.name}`);
    return { envId: row.id, created: row.inserted };
  } finally {
    await pool.end();
  }
}

export interface DeleteEnvironmentOpts {
  orgId: string;
  name: string;
}

/**
 * Delete an environment keyed by (org_id, name). Returns whether a row was
 * removed. The `environment_bindings`, `environment_variables`, and
 * `environment_source_overrides` children all carry
 * `FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE`,
 * so a single DELETE on `environments` cascades to those children. The
 * `held_runs` FK uses `ON DELETE SET NULL`, so terminal held-run history
 * survives the delete with a null environment reference. Pending held runs
 * still reference the environment, so this helper pre-checks their count and
 * throws before issuing the DELETE — approve or reject them first.
 */
export async function deleteEnvironmentDirect(
  databaseUrl: string,
  opts: DeleteEnvironmentOpts,
): Promise<{ deleted: boolean }> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    // The `'pending'` literal mirrors HeldRunStatus.Pending
    // (orchestrator environments/held-runs.ts) — the source of truth for the
    // value. @kici-dev/shared cannot import the orchestrator enum (dependency
    // direction), so the string is embedded here like other status literals in
    // this module.
    const pending = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM held_runs hr
         JOIN environments e ON e.id = hr.environment_id
        WHERE e.org_id = $1 AND e.name = $2 AND hr.status = 'pending'`,
      [opts.orgId, opts.name],
    );
    const pendingCount = Number(pending.rows[0]?.count ?? 0);
    if (pendingCount > 0) {
      throw new Error(
        `environment has ${pendingCount} pending held run(s) — approve or reject them first`,
      );
    }
    const result = await pool.query<{ id: string }>(
      `DELETE FROM environments WHERE org_id = $1 AND name = $2 RETURNING id`,
      [opts.orgId, opts.name],
    );
    return { deleted: result.rows.length > 0 };
  } finally {
    await pool.end();
  }
}

export interface SeedEnvironmentBindingOpts {
  orgId: string;
  envName: string;
  scopePattern: string;
  /** Host selector; defaults to `'**'` (all hosts). */
  hostPattern?: string;
}

/**
 * Upsert an `environment_bindings` row connecting `envName` to `scopePattern`
 * (scoped to `hostPattern`, default `'**'`). Throws if the environment does
 * not exist.
 */
export async function seedEnvironmentBindingDirect(
  databaseUrl: string,
  opts: SeedEnvironmentBindingOpts,
): Promise<{ created: boolean }> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const envRow = await pool.query<{ id: string }>(
      `SELECT id FROM environments WHERE org_id = $1 AND name = $2`,
      [opts.orgId, opts.envName],
    );
    if (envRow.rows.length === 0) {
      throw new Error(`environment: not found (org=${opts.orgId}, name=${opts.envName})`);
    }
    const envId = envRow.rows[0].id;
    const result = await pool.query<{ inserted: boolean }>(
      `INSERT INTO environment_bindings (org_id, environment_id, scope_pattern, host_pattern)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING
         RETURNING (xmax = 0) AS inserted`,
      [opts.orgId, envId, opts.scopePattern, opts.hostPattern ?? '**'],
    );
    return { created: result.rows[0]?.inserted ?? false };
  } finally {
    await pool.end();
  }
}

export interface SetEnvironmentPolicyOpts {
  orgId: string;
  envName: string;
  branchRestrictions?: unknown;
  requiredReviewers?: unknown;
  waitTimerSeconds?: number | null;
  holdExpirySeconds?: number | null;
  minimumTrust?: string | null;
  enabled?: boolean;
  allowLocalExecution?: boolean;
}

/**
 * UPDATE only the policy fields that were explicitly provided. Columns that
 * were NOT in `opts` are left untouched. Throws if the environment is missing.
 */
export async function setEnvironmentPolicyDirect(
  databaseUrl: string,
  opts: SetEnvironmentPolicyOpts,
): Promise<void> {
  if (opts.waitTimerSeconds != null && opts.waitTimerSeconds < 0) {
    throw new Error(`environment: waitTimerSeconds must be >= 0 (got ${opts.waitTimerSeconds})`);
  }
  if (opts.holdExpirySeconds != null && opts.holdExpirySeconds < 0) {
    throw new Error(`environment: holdExpirySeconds must be >= 0 (got ${opts.holdExpirySeconds})`);
  }

  const setClauses: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  const addSet = (column: string, value: unknown, cast?: string): void => {
    if (!ENV_POLICY_COLUMNS.has(column)) {
      throw new Error(`environment: unknown policy column ${column}`);
    }
    setClauses.push(`${column} = $${idx}${cast ? `::${cast}` : ''}`);
    params.push(value);
    idx += 1;
  };

  if (opts.branchRestrictions !== undefined) {
    addSet('branch_restrictions', JSON.stringify(opts.branchRestrictions), 'jsonb');
  }
  if (opts.requiredReviewers !== undefined) {
    addSet(
      'required_reviewers',
      opts.requiredReviewers === null ? null : JSON.stringify(opts.requiredReviewers),
      'jsonb',
    );
  }
  if (opts.waitTimerSeconds !== undefined) addSet('wait_timer_seconds', opts.waitTimerSeconds);
  if (opts.holdExpirySeconds !== undefined) addSet('hold_expiry_seconds', opts.holdExpirySeconds);
  if (opts.minimumTrust !== undefined) addSet('minimum_trust', opts.minimumTrust);
  if (opts.enabled !== undefined) addSet('enabled', opts.enabled);
  if (opts.allowLocalExecution !== undefined)
    addSet('allow_local_execution', opts.allowLocalExecution);

  if (setClauses.length === 0) {
    throw new Error('environment: setEnvironmentPolicy requires at least one policy field');
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    params.push(opts.orgId, opts.envName);
    const orgParam = `$${idx}`;
    const nameParam = `$${idx + 1}`;
    const sql = `UPDATE environments
                    SET ${setClauses.join(', ')}, updated_at = now()
                    WHERE org_id = ${orgParam} AND name = ${nameParam}`;
    const result = await pool.query(sql, params);
    if ((result.rowCount ?? 0) === 0) {
      throw new Error(`environment: not found (org=${opts.orgId}, name=${opts.envName})`);
    }
  } finally {
    await pool.end();
  }
}

export interface EnvironmentRow {
  id: string;
  org_id: string;
  name: string;
  type: string;
  enabled: boolean;
  branch_restrictions: unknown;
  required_reviewers: unknown;
  wait_timer_seconds: number | null;
  hold_expiry_seconds: number | null;
  minimum_trust: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * SELECT * FROM environments WHERE org_id = $1, ordered by name.
 */
export async function listEnvironmentsDirect(
  databaseUrl: string,
  opts: { orgId: string },
): Promise<{ environments: EnvironmentRow[] }> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await pool.query<EnvironmentRow>(
      `SELECT id, org_id, name, type, enabled, branch_restrictions, required_reviewers,
              wait_timer_seconds, hold_expiry_seconds, minimum_trust,
              created_at, updated_at
         FROM environments
        WHERE org_id = $1
        ORDER BY name`,
      [opts.orgId],
    );
    return { environments: result.rows };
  } finally {
    await pool.end();
  }
}

export interface EnvironmentVariableRow {
  key: string;
  value: string;
  locked: boolean;
  updated_at: string;
}

export interface EnvironmentBindingRow {
  scope_pattern: string;
  host_pattern: string;
  created_at: string;
}

export interface ShowEnvironmentResult {
  environment: EnvironmentRow;
  variables: EnvironmentVariableRow[];
  bindings: EnvironmentBindingRow[];
}

/**
 * Fetch a single environment row joined with its variables and bindings.
 * Throws if the environment does not exist.
 */
export async function showEnvironmentDirect(
  databaseUrl: string,
  opts: { orgId: string; name: string },
): Promise<ShowEnvironmentResult> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const envResult = await pool.query<EnvironmentRow>(
      `SELECT id, org_id, name, type, enabled, branch_restrictions, required_reviewers,
              wait_timer_seconds, hold_expiry_seconds, minimum_trust,
              created_at, updated_at
         FROM environments
        WHERE org_id = $1 AND name = $2`,
      [opts.orgId, opts.name],
    );
    if (envResult.rows.length === 0) {
      throw new Error(`environment: not found (org=${opts.orgId}, name=${opts.name})`);
    }
    const env = envResult.rows[0];
    const variables = await pool.query<EnvironmentVariableRow>(
      `SELECT key, value, locked, updated_at
         FROM environment_variables
        WHERE environment_id = $1
        ORDER BY key`,
      [env.id],
    );
    const bindings = await pool.query<EnvironmentBindingRow>(
      `SELECT scope_pattern, host_pattern, created_at
         FROM environment_bindings
        WHERE environment_id = $1
        ORDER BY scope_pattern, host_pattern`,
      [env.id],
    );
    return {
      environment: env,
      variables: variables.rows,
      bindings: bindings.rows,
    };
  } finally {
    await pool.end();
  }
}

export interface CreateEnvironmentTemplateOpts {
  orgId: string;
  templateName: string;
  type?: string;
  branchRestrictions?: unknown;
  requiredReviewers?: unknown;
  waitTimerSeconds?: number | null;
  holdExpirySeconds?: number | null;
  minimumTrust?: string | null;
  variables?: Record<string, string>;
}

/**
 * Create (or update) an environment template + its seed variables in one
 * transaction. Templates are represented as environments with `type='template'`
 * by convention. Returns `{ envId, variablesSet }`.
 */
export async function createEnvironmentTemplateDirect(
  databaseUrl: string,
  opts: CreateEnvironmentTemplateOpts,
): Promise<{ envId: string; created: boolean; variablesSet: number }> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const envResult = await client.query<{ id: string; inserted: boolean }>(
      `INSERT INTO environments
          (org_id, name, type, enabled, branch_restrictions, required_reviewers,
           wait_timer_seconds, hold_expiry_seconds, minimum_trust)
        VALUES ($1, $2, COALESCE($3, 'template'), true, $4::jsonb, $5::jsonb, $6, COALESCE($7, 86400), $8)
        ON CONFLICT (org_id, name) DO UPDATE SET
          type = COALESCE(EXCLUDED.type, environments.type),
          branch_restrictions = EXCLUDED.branch_restrictions,
          required_reviewers = EXCLUDED.required_reviewers,
          wait_timer_seconds = EXCLUDED.wait_timer_seconds,
          hold_expiry_seconds = EXCLUDED.hold_expiry_seconds,
          minimum_trust = EXCLUDED.minimum_trust,
          updated_at = now()
        RETURNING id, (xmax = 0) AS inserted`,
      [
        opts.orgId,
        opts.templateName,
        opts.type ?? null,
        JSON.stringify(opts.branchRestrictions ?? []),
        opts.requiredReviewers === undefined ? null : JSON.stringify(opts.requiredReviewers),
        opts.waitTimerSeconds ?? null,
        opts.holdExpirySeconds ?? null,
        opts.minimumTrust ?? null,
      ],
    );
    const row = envResult.rows[0];
    if (!row) throw new Error(`environment: template upsert returned no row`);
    let variablesSet = 0;
    if (opts.variables) {
      for (const [key, value] of Object.entries(opts.variables)) {
        await client.query(
          `INSERT INTO environment_variables (org_id, environment_id, key, value, locked)
             VALUES ($1, $2, $3, $4, false)
             ON CONFLICT (org_id, environment_id, key) DO UPDATE SET
               value = EXCLUDED.value,
               updated_at = now()`,
          [opts.orgId, row.id, key, value],
        );
        variablesSet += 1;
      }
    }
    await client.query('COMMIT');
    return { envId: row.id, created: row.inserted, variablesSet };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

export interface SetEnvironmentSecretOpts {
  orgId: string;
  environment: string;
  key: string;
  encryptedValue: string;
}

/**
 * UPSERT a scoped_secrets row keyed by (org_id, scope=environment, key).
 * Writes the value verbatim — the caller is responsible for encryption
 * (matches the stage-4 deferral noted in the plan).
 */
export async function setEnvironmentSecretDirect(
  databaseUrl: string,
  opts: SetEnvironmentSecretOpts,
): Promise<{ inserted: boolean }> {
  if (!opts.orgId) throw new Error('environment: orgId required');
  if (!opts.environment) throw new Error('environment: environment name required');
  if (!opts.key) throw new Error('environment: key required');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await pool.query<{ inserted: boolean }>(
      `INSERT INTO scoped_secrets (org_id, scope, key, encrypted_value)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, scope, key) DO UPDATE SET
           encrypted_value = EXCLUDED.encrypted_value,
           updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
      [opts.orgId, opts.environment, opts.key, opts.encryptedValue],
    );
    return { inserted: result.rows[0]?.inserted ?? false };
  } finally {
    await pool.end();
  }
}

// ── queue + execution read ops (stage-5a #3 /) ─────────────────────────

export interface DispatchQueueRow {
  id: string;
  run_id: string;
  workflow_name: string;
  job_name: string;
  status: string;
  routing_key: string;
  provider: string;
  created_at: string;
  expires_at: string | null;
  delivery_id: string;
  source_tar_url: string | null;
  deps_url: string | null;
  job_config: string | null;
}

export interface ListQueueOpts {
  status?: string;
  /** Status NOT IN list (e.g., to find non-terminal rows). */
  statusNotIn?: readonly string[];
  jobNamePrefix?: string;
  /** Exact job_name match (e.g., `__build__e2e-test`). */
  jobName?: string;
  /** job_name NOT LIKE (e.g., `__build__%` to exclude build jobs). */
  jobNameNotLike?: string;
  workflowName?: string;
  /** ISO timestamp or Date; matches rows with created_at > this. */
  createdAfter?: string | Date;
  limit?: number;
}

/**
 * READ-ONLY: SELECT from `dispatch_queue` with optional status + job-name
 * filters and a bounded limit (defaults to 100). Includes source_tar_url,
 * deps_url, and job_config so E2E tests can assert on cache metadata
 * without a second round-trip.
 */
export async function listQueueDirect(
  databaseUrl: string,
  opts: ListQueueOpts = {},
): Promise<{ entries: DispatchQueueRow[] }> {
  const pool = createPool(databaseUrl);
  try {
    const clauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (opts.status !== undefined) {
      clauses.push(`status = $${idx}`);
      params.push(opts.status);
      idx += 1;
    }
    if (opts.statusNotIn !== undefined && opts.statusNotIn.length > 0) {
      const placeholders = opts.statusNotIn.map(() => {
        const p = `$${idx}`;
        idx += 1;
        return p;
      });
      clauses.push(`status NOT IN (${placeholders.join(',')})`);
      params.push(...opts.statusNotIn);
    }
    if (opts.jobNamePrefix !== undefined) {
      clauses.push(`job_name LIKE $${idx}`);
      params.push(`${opts.jobNamePrefix}%`);
      idx += 1;
    }
    if (opts.jobName !== undefined) {
      clauses.push(`job_name = $${idx}`);
      params.push(opts.jobName);
      idx += 1;
    }
    if (opts.jobNameNotLike !== undefined) {
      clauses.push(`job_name NOT LIKE $${idx}`);
      params.push(opts.jobNameNotLike);
      idx += 1;
    }
    if (opts.workflowName !== undefined) {
      clauses.push(`workflow_name = $${idx}`);
      params.push(opts.workflowName);
      idx += 1;
    }
    if (opts.createdAfter !== undefined) {
      clauses.push(`created_at > $${idx}`);
      params.push(
        opts.createdAfter instanceof Date ? opts.createdAfter : new Date(opts.createdAfter),
      );
      idx += 1;
    }
    const limit = Math.max(1, Math.min(1000, opts.limit ?? 100));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await pool.query<DispatchQueueRow>(
      `SELECT id, run_id, workflow_name, job_name, status, routing_key,
              provider, created_at, expires_at, delivery_id,
              source_tar_url, deps_url, job_config
         FROM dispatch_queue
         ${where}
         ORDER BY created_at DESC
         LIMIT ${limit}`,
      params,
    );
    return { entries: result.rows };
  } finally {
    await pool.end();
  }
}

/**
 * READ-ONLY: SELECT a single dispatch_queue row by id. Throws with a
 * clear message when no row matches.
 */
export async function showQueueEntryDirect(
  databaseUrl: string,
  opts: { id: string },
): Promise<DispatchQueueRow> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query<DispatchQueueRow>(
      `SELECT id, run_id, workflow_name, job_name, status, routing_key,
              provider, created_at, expires_at, delivery_id,
              source_tar_url, deps_url, job_config
         FROM dispatch_queue
        WHERE id = $1`,
      [opts.id],
    );
    if (result.rows.length === 0) {
      throw new Error(`queue: entry not found (id=${opts.id})`);
    }
    return result.rows[0];
  } finally {
    await pool.end();
  }
}

export interface ExecutionRunRow {
  id: string;
  run_id: string;
  workflow_name: string;
  status: string;
  provider: string;
  repo_identifier: string;
  ref: string;
  sha: string;
  routing_key: string | null;
  environment: string | null;
  trust_tier: string | null;
  created_at: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
}

export interface ExecutionJobRow {
  id: string;
  run_id: string;
  job_id: string;
  job_name: string;
  status: string;
  agent_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  created_at: string;
  error_message: string | null;
}

export interface ListExecutionRunsOpts {
  routingKey?: string;
  status?: string;
  workflowName?: string;
  limit?: number;
}

/**
 * READ-ONLY: SELECT execution_runs with optional filters. Ordered by
 * created_at DESC, capped at a sensible limit.
 */
export async function listExecutionRunsDirect(
  databaseUrl: string,
  opts: ListExecutionRunsOpts = {},
): Promise<{ runs: ExecutionRunRow[] }> {
  const pool = createPool(databaseUrl);
  try {
    const clauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (opts.routingKey !== undefined) {
      clauses.push(`routing_key = $${idx}`);
      params.push(opts.routingKey);
      idx += 1;
    }
    if (opts.status !== undefined) {
      clauses.push(`status = $${idx}`);
      params.push(opts.status);
      idx += 1;
    }
    if (opts.workflowName !== undefined) {
      clauses.push(`workflow_name = $${idx}`);
      params.push(opts.workflowName);
      idx += 1;
    }
    const limit = Math.max(1, Math.min(1000, opts.limit ?? 100));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await pool.query<ExecutionRunRow>(
      `SELECT id, run_id, workflow_name, status, provider, repo_identifier,
              ref, sha, routing_key, environment, trust_tier, created_at,
              started_at, completed_at, duration_ms
         FROM execution_runs
         ${where}
         ORDER BY created_at DESC
         LIMIT ${limit}`,
      params,
    );
    return { runs: result.rows };
  } finally {
    await pool.end();
  }
}

/**
 * READ-ONLY: fetch a single run by run_id AND its jobs. Throws if no run
 * matches the run_id. Jobs list may be empty for pending runs.
 */
export async function showExecutionRunDirect(
  databaseUrl: string,
  opts: { runId: string },
): Promise<{ run: ExecutionRunRow; jobs: ExecutionJobRow[] }> {
  const pool = createPool(databaseUrl);
  try {
    const runResult = await pool.query<ExecutionRunRow>(
      `SELECT id, run_id, workflow_name, status, provider, repo_identifier,
              ref, sha, routing_key, environment, trust_tier, created_at,
              started_at, completed_at, duration_ms
         FROM execution_runs
        WHERE run_id = $1`,
      [opts.runId],
    );
    if (runResult.rows.length === 0) {
      throw new Error(`execution: run not found (run_id=${opts.runId})`);
    }
    const run = runResult.rows[0];
    const jobsResult = await pool.query<ExecutionJobRow>(
      `SELECT id, run_id, job_id, job_name, status, agent_id,
              started_at, completed_at, duration_ms, created_at, error_message
         FROM execution_jobs
        WHERE run_id = $1
        ORDER BY created_at ASC`,
      [run.run_id],
    );
    return { run, jobs: jobsResult.rows };
  } finally {
    await pool.end();
  }
}

/**
 * READ-ONLY: list execution_jobs for a given execution_runs.id. Ordered by
 * created_at ASC so downstream diffs show timeline order.
 */
export async function listExecutionJobsDirect(
  databaseUrl: string,
  opts: { runId: string },
): Promise<{ jobs: ExecutionJobRow[] }> {
  const pool = createPool(databaseUrl);
  try {
    // Accept either the uuid id OR the run_id (FK value).
    // execution_jobs.run_id has a FK to execution_runs.run_id, so the JOIN
    // must be r.run_id = j.run_id (not r.id = j.run_id).
    const result = await pool.query<ExecutionJobRow>(
      `SELECT j.id, j.run_id, j.job_id, j.job_name, j.status, j.agent_id,
              j.started_at, j.completed_at, j.duration_ms, j.created_at, j.error_message
         FROM execution_jobs j
         INNER JOIN execution_runs r ON r.run_id = j.run_id
        WHERE r.run_id::text = $1 OR r.id::text = $1
        ORDER BY j.created_at ASC`,
      [opts.runId],
    );
    return { jobs: result.rows };
  } finally {
    await pool.end();
  }
}

// ── workflow_registrations read ops (stage-5a #4) ──────────────────────────

export interface WorkflowRegistrationRow {
  id: string;
  repo_identifier: string;
  workflow_name: string;
  routing_key: string;
  customer_id: string;
  trigger_types: string[];
  disabled: boolean;
  is_global: boolean;
  commit_sha: string | null;
  source_file: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListRegistrationsOpts {
  customerId?: string;
  routingKey?: string;
  repoIdentifier?: string;
  /** Include rows where this trigger type is in trigger_types[]. */
  triggerType?: string;
  limit?: number;
}

export interface ListRegistrationsResult {
  registrations: WorkflowRegistrationRow[];
  /** Latest `registry_versions.version`, or null if the table has no row. */
  registryVersion: number | null;
}

/**
 * READ-ONLY: list workflow_registrations with optional filters. Also returns
 * the latest registry_versions.version so callers can assert registry bumps
 * without a second round trip.
 */
export async function listRegistrationsDirect(
  databaseUrl: string,
  opts: ListRegistrationsOpts = {},
): Promise<ListRegistrationsResult> {
  const pool = createPool(databaseUrl);
  try {
    const clauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (opts.customerId !== undefined) {
      clauses.push(`customer_id = $${idx}`);
      params.push(opts.customerId);
      idx += 1;
    }
    if (opts.routingKey !== undefined) {
      clauses.push(`routing_key = $${idx}`);
      params.push(opts.routingKey);
      idx += 1;
    }
    if (opts.repoIdentifier !== undefined) {
      clauses.push(`repo_identifier = $${idx}`);
      params.push(opts.repoIdentifier);
      idx += 1;
    }
    if (opts.triggerType !== undefined) {
      clauses.push(`$${idx} = ANY(trigger_types)`);
      params.push(opts.triggerType);
      idx += 1;
    }
    const limit = Math.max(1, Math.min(1000, opts.limit ?? 100));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await pool.query<WorkflowRegistrationRow>(
      `SELECT id, repo_identifier, workflow_name, routing_key, customer_id,
              trigger_types, disabled, is_global, commit_sha, source_file,
              created_at, updated_at
         FROM workflow_registrations
         ${where}
         ORDER BY updated_at DESC
         LIMIT ${limit}`,
      params,
    );
    const versionResult = await pool.query<{ version: number }>(
      `SELECT version FROM registry_versions ORDER BY version DESC LIMIT 1`,
    );
    return {
      registrations: result.rows,
      registryVersion: versionResult.rows[0]?.version ?? null,
    };
  } finally {
    await pool.end();
  }
}

export interface ShowRegistrationResult {
  registration: WorkflowRegistrationRow & { lock_entry: unknown; provider_context: unknown };
  registryVersion: number | null;
}

/**
 * READ-ONLY: show one workflow_registrations row by id, plus the latest
 * registry_versions row (the monotonic version bumped on every registration
 * insert/delete). Throws if the registration id is unknown.
 */
export async function showRegistrationDirect(
  databaseUrl: string,
  opts: { id: string },
): Promise<ShowRegistrationResult> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query<
      WorkflowRegistrationRow & { lock_entry: unknown; provider_context: unknown }
    >(
      `SELECT id, repo_identifier, workflow_name, routing_key, customer_id,
              trigger_types, disabled, is_global, commit_sha, source_file,
              created_at, updated_at, lock_entry, provider_context
         FROM workflow_registrations
        WHERE id = $1`,
      [opts.id],
    );
    if (result.rows.length === 0) {
      throw new Error(`registration: not found (id=${opts.id})`);
    }
    const versionResult = await pool.query<{ version: number }>(
      `SELECT version FROM registry_versions ORDER BY version DESC LIMIT 1`,
    );
    const registryVersion = versionResult.rows[0]?.version ?? null;
    return { registration: result.rows[0], registryVersion };
  } finally {
    await pool.end();
  }
}

// ── workflow register-manual (stage-5a #6) ─────────────────────────────────

/**
 * Registerable trigger types. Kept in sync with
 * packages/orchestrator/src/registration/extractor.ts — any trigger whose type
 * is in this set (or which pins `repos: [...]` patterns) produces a
 * workflow_registrations row on default-branch push extraction.
 *
 * Duplicated here intentionally so the helper has no runtime dependency on
 * the engine package.
 */
export const REGISTERABLE_TRIGGER_TYPES: ReadonlySet<string> = new Set([
  'push',
  'pr',
  'pull_request',
  'tag',
  'release',
  'schedule',
  'kici_event',
  'webhook',
  'repository_dispatch',
  'issue_comment',
  'pull_request_review',
]);

interface MinimalLockEntry {
  name: string;
  triggers: ReadonlyArray<{ _type: string; repos?: unknown[]; [k: string]: unknown }>;
  [k: string]: unknown;
}

interface MinimalLockFileShape {
  workflows: readonly MinimalLockEntry[];
}

export interface RegisterWorkflowManualOpts {
  /** Either `lockFileContents` (raw JSON string) OR `lockFile` (parsed object). */
  lockFileContents?: string;
  lockFile?: MinimalLockFileShape;
  repoIdentifier: string;
  routingKey: string;
  customerId: string;
  providerContext: Record<string, unknown>;
  commitSha?: string;
}

export interface RegisterWorkflowManualResult {
  workflowCount: number;
  registryVersion: number;
}

/**
 * Transactionally upsert `workflow_registrations` rows from a lock file and
 * bump `registry_versions.version`. Mirrors the orchestrator's
 * RegistrationStore.replaceAll() path but runs offline — the E2E test helpers
 * `seedWorkflowRegistrationsFromLockFile` called this pattern via raw pg.Pool
 * before this helper existed.
 *
 * Writes one row per registerable workflow (UPSERT by
 * (routing_key, repo_identifier, workflow_name)), then bumps
 * `registry_versions` in the same transaction so orchestrator processes
 * watching that row refresh their in-memory index.
 */
export async function registerWorkflowManualDirect(
  databaseUrl: string,
  opts: RegisterWorkflowManualOpts,
): Promise<RegisterWorkflowManualResult> {
  let lockFile: MinimalLockFileShape;
  if (opts.lockFile !== undefined) {
    lockFile = opts.lockFile;
  } else if (opts.lockFileContents !== undefined) {
    try {
      lockFile = JSON.parse(opts.lockFileContents) as MinimalLockFileShape;
    } catch (err) {
      throw new Error(
        `registration: lockFileContents is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    throw new Error('registration: either lockFileContents or lockFile must be provided');
  }
  if (!Array.isArray(lockFile.workflows)) {
    throw new Error('registration: lock file missing workflows[] array');
  }

  const hasRepoPatterns = (t: { repos?: unknown[] }) =>
    Array.isArray(t.repos) && t.repos.length > 0;

  const registerable = lockFile.workflows.filter((w: MinimalLockEntry) =>
    w.triggers.some(
      (t: { _type: string; repos?: unknown[] }) =>
        REGISTERABLE_TRIGGER_TYPES.has(t._type) || hasRepoPatterns(t),
    ),
  );

  const pool = createPool(databaseUrl);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const workflow of registerable) {
      const triggerTypes = [...new Set(workflow.triggers.map((t: { _type: string }) => t._type))];
      await client.query(
        `INSERT INTO workflow_registrations (
          repo_identifier, workflow_name, lock_entry, trigger_types,
          routing_key, provider_context, customer_id, commit_sha, source_file
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (routing_key, repo_identifier, workflow_name) DO UPDATE SET
          lock_entry = EXCLUDED.lock_entry,
          trigger_types = EXCLUDED.trigger_types,
          provider_context = EXCLUDED.provider_context,
          customer_id = EXCLUDED.customer_id,
          commit_sha = EXCLUDED.commit_sha,
          source_file = EXCLUDED.source_file,
          updated_at = NOW()`,
        [
          opts.repoIdentifier,
          workflow.name,
          JSON.stringify(workflow),
          triggerTypes,
          opts.routingKey,
          JSON.stringify(opts.providerContext),
          opts.customerId,
          opts.commitSha ?? null,
          `.kici/workflows/${workflow.name}.ts`,
        ],
      );
    }

    const bumped = await client.query<{ version: number }>(
      `INSERT INTO registry_versions (id, version) VALUES ('default', 1)
       ON CONFLICT (id) DO UPDATE SET version = registry_versions.version + 1, updated_at = NOW()
       RETURNING version`,
    );
    const registryVersion = bumped.rows[0].version;

    await client.query('COMMIT');

    return { workflowCount: registerable.length, registryVersion };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      // ignore rollback errors — the original error wins
    });
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * DELETE all rows from `raft_state` so a freshly-started orchestrator
 * self-elects with a clean term. Used after swapping the running
 * orchestrator process (warm-mode deploys) — without this, the new
 * process loads a high term and takes 60+ seconds cycling through
 * failed election rounds. Returns the number of rows deleted.
 *
 * Safe for repeated calls — if the table is empty, returns 0.
 */
export async function resetRaftStateDirect(databaseUrl: string): Promise<{ rowsDeleted: number }> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query('DELETE FROM raft_state');
    return { rowsDeleted: result.rowCount ?? 0 };
  } finally {
    await pool.end();
  }
}

export interface EmitKiciEventOpts {
  eventName: string;
  payload: Record<string, unknown>;
  sourceRoutingKey?: string;
  sourceRepo?: string;
}

/**
 * INSERT a row into `kici_events` and fire `pg_notify('kici_event_channel', <id>)`
 * so the orchestrator EventRouter picks it up immediately. Used by Bucket B/C
 * e2e helpers to simulate what `agent ctx.emit()` does from inside a step
 * execution — but without needing an actual running step. Returns the event id.
 *
 * Fixed `chain_depth=0` and `expires_at=NOW() + 1h` match emitLocalEvent()
 * in e2e/helpers/local-webhook.ts, which this helper supersedes.
 */
export async function emitKiciEventDirect(
  databaseUrl: string,
  opts: EmitKiciEventOpts,
): Promise<{ eventId: string }> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO kici_events (
        event_name, payload, source_routing_key, source_repo,
        chain_depth, expires_at
      )
      VALUES ($1, $2, $3, $4, 0, NOW() + INTERVAL '1 hour')
      RETURNING id`,
      [
        opts.eventName,
        JSON.stringify(opts.payload),
        opts.sourceRoutingKey ?? '',
        opts.sourceRepo ?? '',
      ],
    );
    const eventId = result.rows[0].id;
    await pool.query(`SELECT pg_notify('kici_event_channel', $1)`, [eventId]);
    return { eventId };
  } finally {
    await pool.end();
  }
}

export interface SeedGenericWebhookSourceOpts {
  orgId: string;
  name: string;
  /** Pre-computed deterministic UUID (caller derives via sha256(orgId:name)) */
  sourceId: string;
  /** Pre-computed routing key (caller uses `generic:${orgId}:${name}`) */
  routingKey: string;
  verificationMethod?: string;
  /** 'generic' (Stripe-shaped) or 'local' (github-shaped via LocalWebhookNormalizer,
   *  a git repo present on the agent filesystem cloned via file://). */
  providerType?: 'generic' | 'local';
  /** For `providerType='local'`: the per-source `{ repoBasePath, cloneUrlBase? }`
   *  stored in `git_config`. The orchestrator reads `repoBasePath` from this row
   *  at registration time to build the local provider bundle. */
  gitConfig?: Record<string, unknown>;
}

/**
 * Upsert a row into `generic_webhook_sources`. Uses
 * `ON CONFLICT (routing_key) DO UPDATE` so warm-start mode (where the source
 * may already exist from a prior run) is idempotent.
 *
 * IMPORTANT: callers must invoke this BEFORE the orchestrator starts, because
 * GenericSourceManager caches sources at boot and does not reload them later.
 * This helper supersedes seedGenericWebhookSource() in
 * e2e/helpers/local-webhook.ts.
 */
export async function seedGenericWebhookSourceDirect(
  databaseUrl: string,
  opts: SeedGenericWebhookSourceOpts,
): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await pool.query(
      `INSERT INTO generic_webhook_sources (
        id, customer_id, name, routing_key,
        verification_method, verification_config,
        event_type_header, dedup_window_seconds,
        max_payload_bytes, rate_limit_rpm, enabled,
        provider_type, git_config
      ) VALUES ($1, $2, $3, $4, $5, '{}', 'x-event-type', 300, 10485760, 600, true, $6, $7::jsonb)
      ON CONFLICT (routing_key) DO UPDATE SET
        customer_id = EXCLUDED.customer_id,
        name = EXCLUDED.name,
        verification_method = EXCLUDED.verification_method,
        verification_config = EXCLUDED.verification_config,
        provider_type = EXCLUDED.provider_type,
        git_config = EXCLUDED.git_config,
        enabled = true,
        deleted_at = NULL,
        updated_at = NOW()`,
      [
        opts.sourceId,
        opts.orgId,
        opts.name,
        opts.routingKey,
        opts.verificationMethod ?? 'none',
        opts.providerType ?? 'generic',
        opts.gitConfig ? JSON.stringify(opts.gitConfig) : null,
      ],
    );
  } finally {
    await pool.end();
  }
}

/**
 * Return `{ current: true }` if the applied migration count matches the
 * provider's migration count AND the content hash in `_migration_content_hash`
 * matches the provider's current hash. Otherwise return `{ current: false,
 * reason }` with a human-readable reason.
 *
 * Callers use this as a warm-start freshness gate — if not current, do a cold
 * start (`db fresh`).
 */
export async function isSchemaCurrent(
  pool: pg.Pool,
  provider: MigrationProvider,
): Promise<{ current: boolean; reason?: string }> {
  const migrations = await provider.getMigrations();
  const expectedCount = Object.keys(migrations).length;

  let appliedCount: number;
  try {
    const result = await pool.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM "kysely_migration"',
    );
    appliedCount = result.rows[0]?.count ?? 0;
  } catch {
    return { current: false, reason: 'kysely_migration table missing' };
  }

  if (appliedCount !== expectedCount) {
    return {
      current: false,
      reason: `migration count mismatch (applied=${appliedCount}, expected=${expectedCount})`,
    };
  }

  const expectedHash = await computeMigrationsHash(provider);
  const storedHash = await readStoredMigrationContentHash(pool);
  if (storedHash !== expectedHash) {
    return {
      current: false,
      reason: storedHash === null ? 'content hash missing' : 'content hash mismatch',
    };
  }

  return { current: true };
}

// ── Orchestrator DB direct helpers for e2e pg.Pool elimination (phase 28.10-03) ──

/**
 * Purge backends whose encrypted `config` column can no longer be decrypted
 * (e.g. warm-start E2E where KICI_SECRET_KEY rotated between categories).
 *
 * Only rows with a non-empty `config_encrypted` are affected — the default
 * `pg` backend is seeded by the initial migration with `config_encrypted = ''`
 * as a sentinel (loadAllStores() skips decryption for it), so it is never the
 * source of the decryption failure and must be preserved. Deleting it breaks
 * downstream tests that rely on the default backend being registered.
 */
export async function purgeSecretBackendsDirect(databaseUrl: string): Promise<{ deleted: number }> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query(
      "DELETE FROM secret_backends WHERE config_encrypted IS NOT NULL AND config_encrypted <> ''",
    );
    return { deleted: result.rowCount ?? 0 };
  } finally {
    await pool.end();
  }
}

/**
 * Check if an API key exists in the Platform DB (api_keys table — orchestrator-
 * managed, NOT user_api_keys). Returns true when a row matches the hashed key.
 */
export async function apiKeyExistsDirect(databaseUrl: string, apiKey: string): Promise<boolean> {
  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query('SELECT 1 FROM api_keys WHERE key_hash = $1', [keyHash]);
    return result.rows.length > 0;
  } finally {
    await pool.end();
  }
}

/**
 * Insert an api_keys row (Platform-side orchestrator credential). Used by
 * e2e setup to seed an orchestrator authentication token. Returns the id.
 */
export async function seedApiKeyInlineDirect(
  databaseUrl: string,
  opts: {
    keyName: string;
    orgId: string;
    fullKey: string;
  },
): Promise<{ keyId: string }> {
  const keyHash = createHash('sha256').update(opts.fullKey).digest('hex');
  const keyPrefix = opts.fullKey.slice(0, 16);

  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query(
      `INSERT INTO api_keys (key_hash, key_prefix, name, org_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [keyHash, keyPrefix, opts.keyName, opts.orgId],
    );
    return { keyId: result.rows[0].id as string };
  } finally {
    await pool.end();
  }
}

/**
 * Lookup a `platform_connections` row by connection_id. Returns true when
 * present. Used by the orphan-sweeper e2e test.
 */
export async function platformConnectionExistsDirect(
  databaseUrl: string,
  connectionId: string,
): Promise<boolean> {
  const pool = createPool(databaseUrl);
  try {
    const res = await pool.query(
      `SELECT 1 FROM platform_connections WHERE connection_id = $1 LIMIT 1`,
      [connectionId],
    );
    return res.rowCount !== null && res.rowCount > 0;
  } finally {
    await pool.end();
  }
}

/**
 * Count `webhook_sources` rows for a given orchestrator_connection_id.
 * Used by the orphan-sweeper e2e test to assert the FK CASCADE introduced
 * by Platform migration 017 actually fires when the parent
 * `platform_connections` row is deleted.
 */
/**
 * Look up a Platform-side `webhook_sources` row by routing key. Returns the
 * row (org_id + provider + connection) or null. Used by E2E to assert that a
 * source added at runtime on the orchestrator propagated to the Platform's
 * `webhook_sources` table (the dashboard-visible source list) without a
 * restart.
 */
export async function getWebhookSourceByRoutingKeyDirect(
  databaseUrl: string,
  routingKey: string,
): Promise<{ routing_key: string; org_id: string; provider: string } | null> {
  const pool = createPool(databaseUrl);
  try {
    const res = await pool.query(
      `SELECT routing_key, org_id, provider
         FROM webhook_sources
         WHERE routing_key = $1
         LIMIT 1`,
      [routingKey],
    );
    const row = res.rows[0];
    return row
      ? {
          routing_key: String(row.routing_key),
          org_id: String(row.org_id),
          provider: String(row.provider),
        }
      : null;
  } finally {
    await pool.end();
  }
}

export async function countWebhookSourcesByConnectionIdDirect(
  databaseUrl: string,
  connectionId: string,
): Promise<number> {
  const pool = createPool(databaseUrl);
  try {
    const res = await pool.query(
      `SELECT COUNT(*)::int AS cnt
         FROM webhook_sources
         WHERE orchestrator_connection_id = $1`,
      [connectionId],
    );
    return Number(res.rows[0]?.cnt ?? 0);
  } finally {
    await pool.end();
  }
}

/**
 * Find a `user_api_keys.id` preferring rows scoped to `preferredOrgId`, else
 * any row in the table. Used by orphan-sweeper test to get a realistic
 * `key_id` for platform_connections seeding.
 */
export async function findAnyUserApiKeyIdDirect(
  databaseUrl: string,
  preferredOrgId: string,
): Promise<string | null> {
  const pool = createPool(databaseUrl);
  try {
    const scoped = await pool.query(`SELECT id FROM user_api_keys WHERE org_id = $1 LIMIT 1`, [
      preferredOrgId,
    ]);
    if (scoped.rows.length > 0) return String(scoped.rows[0].id);
    const any = await pool.query(`SELECT id FROM user_api_keys LIMIT 1`);
    return any.rows.length > 0 ? String(any.rows[0].id) : null;
  } finally {
    await pool.end();
  }
}

/**
 * Seed or refresh a synthetic GitHub webhook source on the Platform DB.
 * Used by HMAC E2E tests that post to `/webhook/:orgId/github`.
 * Idempotent — refreshes the secret/org_id via ON CONFLICT DO UPDATE,
 * and clears stale rows with a different routing_key under the same
 * (org_id, provider, connection_id) triple.
 */
export async function seedSyntheticGithubSourceDirect(
  databaseUrl: string,
  opts: {
    routingKey: string;
    orgId: string;
    /** Display name pushed by the orchestrator on register. Optional. */
    name?: string;
    /** Fine-grained subtype (e.g. 'github_app'). Optional. */
    subtype?: string;
    /** GitHub App slug. Optional. */
    slug?: string;
  },
): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    // Migration 017 added an `ON DELETE CASCADE` FK from
    // `webhook_sources.orchestrator_connection_id` to
    // `platform_connections.connection_id`, so the synthetic parent row
    // MUST exist before the child insert below. We upsert a fresh parent
    // (heartbeat = now()) keyed by the well-known synthetic id so the
    // orphan sweeper doesn't reap it between this seed and the test that
    // depends on it.
    await pool.query(
      `INSERT INTO platform_connections (
         org_id, instance_id, connection_id, key_id, routing_keys
       )
       VALUES ($1, 'e2e-synthetic-instance', 'e2e-synthetic',
               '00000000-0000-4000-8000-000000000000', $2::text)
       ON CONFLICT (connection_id) DO UPDATE
         SET org_id = $1,
             routing_keys = $2::text,
             last_heartbeat_at = NOW()`,
      [opts.orgId, JSON.stringify([opts.routingKey])],
    );

    await pool.query(
      `DELETE FROM webhook_sources
       WHERE org_id = $1 AND provider = 'github'
         AND orchestrator_connection_id = 'e2e-synthetic'
         AND routing_key != $2`,
      [opts.orgId, opts.routingKey],
    );

    await pool.query(
      `INSERT INTO webhook_sources (routing_key, provider, orchestrator_connection_id, org_id, name, subtype, slug)
       VALUES ($1, 'github', 'e2e-synthetic', $2, $3, $4, $5)
       ON CONFLICT (routing_key, orchestrator_connection_id)
         DO UPDATE SET org_id = $2, name = $3, subtype = $4, slug = $5`,
      [opts.routingKey, opts.orgId, opts.name ?? null, opts.subtype ?? null, opts.slug ?? null],
    );
  } finally {
    await pool.end();
  }
}

/**
 * Seed a webhook secret into the orchestrator's `scoped_secrets` table,
 * encrypted with the caller-supplied key. Ensures a `sources` row exists
 * for the routing_key. Used by e2e setup on the orchestrator DB side.
 *
 * encryptFn takes plaintext + AAD and returns ciphertext bytes. The
 * caller owns the crypto primitive so this helper stays decoupled from
 * the orchestrator's PgSecretStore crypto module.
 */
export async function seedWebhookSecretDirect(
  databaseUrl: string,
  opts: {
    routingKey: string;
    webhookSecret: string;
    encryptFn: (plaintext: string, aad: string) => string | Buffer;
  },
): Promise<{ sourceId: string }> {
  const { randomBytes } = await import('node:crypto');
  const pool = createPool(databaseUrl);
  try {
    let sourceId: string;
    const sourceResult = await pool.query('SELECT id FROM sources WHERE routing_key = $1', [
      opts.routingKey,
    ]);
    if (sourceResult.rows.length > 0) {
      sourceId = sourceResult.rows[0].id as string;
    } else {
      sourceId = randomBytes(16).toString('hex');
      const [provider, appId] = opts.routingKey.split(':');
      await pool.query(
        `INSERT INTO sources (id, provider, name, routing_key, config)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (routing_key) DO NOTHING`,
        [
          sourceId,
          provider || 'github',
          `e2e-${appId}`,
          opts.routingKey,
          JSON.stringify({ appId: appId || '' }),
        ],
      );
      const refetch = await pool.query('SELECT id FROM sources WHERE routing_key = $1', [
        opts.routingKey,
      ]);
      sourceId = refetch.rows[0].id as string;
    }

    const scope = `__source__/${sourceId}`;
    const orgId = '__system__';
    const aad = `${orgId}:${scope}:webhookSecret`;
    const encrypted = opts.encryptFn(opts.webhookSecret, aad);

    await pool.query(
      `INSERT INTO scoped_secrets (org_id, scope, key, encrypted_value, backend_type, key_version)
       VALUES ($1, $2, 'webhookSecret', $3, 'pg', 1)
       ON CONFLICT (org_id, scope, key) DO UPDATE SET encrypted_value = $3, updated_at = now()`,
      [orgId, scope, encrypted],
    );

    return { sourceId };
  } finally {
    await pool.end();
  }
}

/**
 * Seed a source private key into the orchestrator's `scoped_secrets` table.
 * encryptFn signature matches seedWebhookSecretDirect. Returns null if the
 * sources row is missing (matches legacy warning-and-skip behaviour).
 */
export async function seedSourcePrivateKeyDirect(
  databaseUrl: string,
  opts: {
    routingKey: string;
    privateKey: string;
    encryptFn: (plaintext: string, aad: string) => string | Buffer;
  },
): Promise<{ sourceId: string } | null> {
  const pool = createPool(databaseUrl);
  try {
    const sourceResult = await pool.query('SELECT id FROM sources WHERE routing_key = $1', [
      opts.routingKey,
    ]);
    if (sourceResult.rows.length === 0) return null;

    const sourceId = sourceResult.rows[0].id as string;
    const scope = `__source__/${sourceId}`;
    const orgId = '__system__';
    const aad = `${orgId}:${scope}:privateKey`;
    const encrypted = opts.encryptFn(opts.privateKey, aad);

    await pool.query(
      `INSERT INTO scoped_secrets (org_id, scope, key, encrypted_value, backend_type, key_version)
       VALUES ($1, $2, 'privateKey', $3, 'pg', 1)
       ON CONFLICT (org_id, scope, key) DO UPDATE SET encrypted_value = $3, updated_at = now()`,
      [orgId, scope, encrypted],
    );

    return { sourceId };
  } finally {
    await pool.end();
  }
}

/**
 * Bump `registry_versions.version` for the default registry and return the
 * new value. Used by cron-scheduler e2e to retrigger index after a manual
 * workflow change.
 */
export async function bumpRegistryVersionDirect(databaseUrl: string): Promise<number> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query(
      `UPDATE registry_versions
       SET version = version + 1, updated_at = NOW()
       WHERE id = 'default'
       RETURNING version`,
    );
    return result.rows[0].version as number;
  } finally {
    await pool.end();
  }
}

/**
 * Poll `kici_events` for an event matching `eventName` created after `since`.
 * Returns the newest match, or throws on timeout. Used by e2e event-routing tests.
 */
export async function pollKiciEventsDirect(
  databaseUrl: string,
  opts: {
    eventName: string;
    since: Date;
    timeoutMs?: number;
    pollIntervalMs?: number;
    payloadFilter?: { key: string; value: string };
  },
): Promise<Record<string, unknown>> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollInterval = opts.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  const pool = createPool(databaseUrl);
  try {
    while (Date.now() < deadline) {
      const filter = opts.payloadFilter;
      const result = filter
        ? await pool.query(
            `SELECT * FROM kici_events
             WHERE event_name = $1 AND created_at > $2 AND payload->>$3 = $4
             ORDER BY created_at DESC
             LIMIT 1`,
            [opts.eventName, opts.since.toISOString(), filter.key, filter.value],
          )
        : await pool.query(
            `SELECT * FROM kici_events
             WHERE event_name = $1 AND created_at > $2
             ORDER BY created_at DESC
             LIMIT 1`,
            [opts.eventName, opts.since.toISOString()],
          );

      if (result.rows.length > 0) {
        return result.rows[0] as Record<string, unknown>;
      }

      await new Promise((r) => setTimeout(r, pollInterval));
    }

    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for kici_event '${opts.eventName}' since ${opts.since.toISOString()}`,
    );
  } finally {
    await pool.end();
  }
}

/**
 * Ping a PostgreSQL database; retries until `SELECT 1` succeeds or the
 * timeout expires. Used by e2e startup to wait for Postgres readiness.
 */
export async function waitForPostgresDirect(
  databaseUrl: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeout = opts?.timeoutMs ?? 30_000;
  const interval = opts?.intervalMs ?? 2_000;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const pool = createPool(databaseUrl);
    try {
      await pool.query('SELECT 1');
      await pool.end();
      return;
    } catch {
      await pool.end();
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error(`PostgreSQL at ${databaseUrl} did not become available within ${timeout}ms`);
}

/**
 * Wait for a specific execution_runs row to reach a terminal status.
 * Used by test-pipeline e2e to gate on run completion. Terminal statuses
 * are success / failed / cancelled / timed_out_stale.
 */
export async function waitForRunCompletionDirect(
  databaseUrl: string,
  runId: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<{ status: string }> {
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const intervalMs = opts?.intervalMs ?? 2_000;
  const terminalStatuses = ['success', 'failed', 'cancelled', 'timed_out_stale'];
  const deadline = Date.now() + timeoutMs;

  const pool = createPool(databaseUrl);
  try {
    while (Date.now() < deadline) {
      const result = await pool.query(
        `SELECT status FROM execution_runs WHERE run_id = $1 LIMIT 1`,
        [runId],
      );
      if (result.rows.length > 0) {
        const status = result.rows[0].status as string;
        if (terminalStatuses.includes(status)) {
          return { status };
        }
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Run ${runId} did not complete within ${timeoutMs}ms`);
  } finally {
    await pool.end();
  }
}

/**
 * DELETE from execution_jobs + execution_runs where started_at > since.
 * Used by e2e cleanup for tests that want explicit post-test row cleanup.
 */
export async function cleanupExecutionRowsDirect(
  databaseUrl: string,
  since: Date,
): Promise<{ runs: number; jobs: number }> {
  const pool = createPool(databaseUrl);
  try {
    const jobsResult = await pool.query(
      `DELETE FROM execution_jobs WHERE run_id IN (
        SELECT run_id FROM execution_runs WHERE started_at > $1
      )`,
      [since],
    );
    const runsResult = await pool.query(`DELETE FROM execution_runs WHERE started_at > $1`, [
      since,
    ]);
    return {
      runs: runsResult.rowCount ?? 0,
      jobs: jobsResult.rowCount ?? 0,
    };
  } finally {
    await pool.end();
  }
}

/**
 * Check whether the schema is "current" by comparing applied migration count
 * and content hash against a caller-supplied set of migration files.
 * Returns false if the migration table is missing, counts mismatch, or the
 * stored hash differs from the caller-supplied hash. Used by e2e warm-start.
 */
export async function isSchemaCurrentFromFilesDirect(
  databaseUrl: string,
  opts: {
    tableName?: string;
    expectedCount: number;
    expectedContentHash: string;
  },
): Promise<boolean> {
  const tableName = opts.tableName ?? 'kysely_migration';
  const pool = createPool(databaseUrl);
  try {
    try {
      const result = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM "${tableName}"`,
      );
      const appliedCount = result.rows[0]?.count ?? 0;
      if (appliedCount !== opts.expectedCount) {
        return false;
      }
      const hashResult = await pool.query<{ hash: string }>(
        `SELECT hash FROM ${MIGRATION_HASH_TABLE} WHERE table_name = $1`,
        [tableName],
      );
      if (hashResult.rows.length === 0 || hashResult.rows[0].hash !== opts.expectedContentHash) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  } finally {
    await pool.end();
  }
}

/**
 * Store a migration content hash in the `_migration_content_hash` marker
 * table. Creates the table if missing. Used by e2e freshDatabase() after
 * migrations run so warm-start detection can compare on next run.
 */
export async function storeMigrationContentHashInTableDirect(
  databaseUrl: string,
  opts: { tableName?: string; contentHash: string },
): Promise<void> {
  const tableName = opts.tableName ?? 'kysely_migration';
  const pool = createPool(databaseUrl);
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${MIGRATION_HASH_TABLE} (
        table_name text PRIMARY KEY,
        hash text NOT NULL
      )
    `);
    await pool.query(
      `INSERT INTO ${MIGRATION_HASH_TABLE} (table_name, hash) VALUES ($1, $2)
       ON CONFLICT (table_name) DO UPDATE SET hash = $2`,
      [tableName, opts.contentHash],
    );
  } finally {
    await pool.end();
  }
}

/**
 * Insert a join_tokens row (orchestrator DB) for cluster peer auth.
 * Used by cluster e2e helpers to provision a shared secret the second
 * orchestrator will use when joining the cluster.
 */
export async function createJoinTokenDirect(
  databaseUrl: string,
  opts: {
    id: string;
    tokenHash: string;
    routingInfo: Record<string, unknown>;
    role: string;
    createdBy: string;
    expiresAt: Date;
  },
): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await pool.query(
      `INSERT INTO join_tokens (id, token_hash, routing_info, role, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        opts.id,
        opts.tokenHash,
        JSON.stringify(opts.routingInfo),
        opts.role,
        opts.createdBy,
        opts.expiresAt,
      ],
    );
  } finally {
    await pool.end();
  }
}

/**
 * Delete join_tokens rows by `created_by` (orchestrator DB). Used by cluster
 * E2E tests to clean up test-provisioned tokens between runs.
 */
export async function deleteJoinTokensByCreatedByDirect(
  databaseUrl: string,
  opts: { createdBy: string },
): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await pool.query(`DELETE FROM join_tokens WHERE created_by = $1`, [opts.createdBy]);
  } finally {
    await pool.end();
  }
}

/**
 * Update the routing_key on `sources` rows for a given provider. Used by
 * cluster e2e to swap the staging routing key for an isolated test key
 * (and to restore it on teardown).
 *
 * `whereRoutingKey`: optional filter on the current routing_key. When
 * present only rows matching it are updated; when absent the provider
 * filter alone is used (with an implicit `!= newRoutingKey` guard so the
 * update is idempotent).
 */
export async function updateSourceRoutingKeyDirect(
  databaseUrl: string,
  opts: {
    provider: string;
    newRoutingKey: string;
    whereRoutingKey?: string;
  },
): Promise<{ updated: number }> {
  const pool = createPool(databaseUrl);
  try {
    const result = opts.whereRoutingKey
      ? await pool.query(
          `UPDATE sources SET routing_key = $1 WHERE provider = $2 AND routing_key = $3`,
          [opts.newRoutingKey, opts.provider, opts.whereRoutingKey],
        )
      : await pool.query(
          `UPDATE sources SET routing_key = $1 WHERE provider = $2 AND routing_key != $1`,
          [opts.newRoutingKey, opts.provider],
        );
    return { updated: result.rowCount ?? 0 };
  } finally {
    await pool.end();
  }
}

/**
 * Delete peer_credentials rows whose instance_id does NOT match a pattern.
 * Used by cluster e2e to wipe stale staging peer credentials while leaving
 * e2e-* peers intact.
 */
export async function prunePeerCredentialsDirect(
  databaseUrl: string,
  opts: { keepInstanceIdPattern: string },
): Promise<{ deleted: number }> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query(`DELETE FROM peer_credentials WHERE instance_id NOT LIKE $1`, [
      opts.keepInstanceIdPattern,
    ]);
    return { deleted: result.rowCount ?? 0 };
  } finally {
    await pool.end();
  }
}

/**
 * Poll Platform until at least `minRegistrations` distinct orchestrator
 * connections are BOTH registered for the routing key (row in webhook_sources)
 * AND live (row in platform_connections with status='connected'). The live-
 * connection join is critical — Platform's webhook_sources rows persist after
 * a connection disconnects (the orphan sweeper eventually reaps them), so a
 * naive COUNT(DISTINCT) on webhook_sources alone would inflate the number
 * and mask a missing coordinator registration.
 */
export async function waitForPlatformRegistrationsDirect(
  platformDbUrl: string,
  routingKey: string,
  opts?: { minRegistrations?: number; timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const minRegistrations = opts?.minRegistrations ?? 1;
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const intervalMs = opts?.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  const pool = createPool(platformDbUrl);
  try {
    while (Date.now() < deadline) {
      const result = await pool.query<{ cnt: number }>(
        `SELECT COUNT(DISTINCT ws.orchestrator_connection_id)::int AS cnt
           FROM webhook_sources ws
           JOIN platform_connections pc
             ON pc.connection_id = ws.orchestrator_connection_id
            AND pc.status = 'connected'
          WHERE ws.routing_key = $1
            AND ws.orchestrator_connection_id != 'e2e-synthetic'`,
        [routingKey],
      );
      const count = result.rows[0]?.cnt ?? 0;
      if (count >= minRegistrations) return;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(
      `Timed out waiting for ${minRegistrations} orchestrator registration(s) ` +
        `for routing key ${routingKey} (waited ${timeoutMs}ms)`,
    );
  } finally {
    await pool.end();
  }
}

/**
 * Seed a generic_webhook_sources row with a custom `event_type_header` and
 * `git_config` payload. Used by universal-git e2e (Forgejo) to register
 * an ingest endpoint that extracts the event type from Gitea-style headers.
 */
export interface SeedUniversalGitSourceOpts {
  orgId: string;
  sourceId: string;
  sourceName: string;
  routingKey: string;
  gitConfig: Record<string, unknown>;
  eventTypeHeader?: string;
}

export async function seedUniversalGitSourceDirect(
  databaseUrl: string,
  opts: SeedUniversalGitSourceOpts,
): Promise<void> {
  const eventTypeHeader = opts.eventTypeHeader ?? 'x-gitea-event';
  const pool = createPool(databaseUrl);
  try {
    await pool.query(
      `INSERT INTO generic_webhook_sources (
        id, customer_id, name, routing_key,
        verification_method, verification_config,
        event_type_header, dedup_window_seconds,
        max_payload_bytes, rate_limit_rpm, enabled,
        provider_type, git_config
      ) VALUES ($1, $2, $3, $4, 'none', '{}', $6, 300, 10485760, 600, true,
                'generic', $5::jsonb)
      ON CONFLICT (routing_key) DO UPDATE SET
        customer_id = EXCLUDED.customer_id,
        name = EXCLUDED.name,
        event_type_header = EXCLUDED.event_type_header,
        git_config = EXCLUDED.git_config,
        enabled = true,
        deleted_at = NULL,
        updated_at = NOW()`,
      [
        opts.sourceId,
        opts.orgId,
        opts.sourceName,
        opts.routingKey,
        JSON.stringify(opts.gitConfig),
        eventTypeHeader,
      ],
    );
  } finally {
    await pool.end();
  }
}

/**
 * Seed the ci-security orchestrator fixtures expected by the security
 * pipeline e2e: sources row for dashboard orgId resolution, environment,
 * two execution_runs (unknown + trusted), two execution_jobs, and a
 * security held_run for the unknown contributor.
 *
 * Returns the ids so the caller can assert downstream.
 */
export interface SeedCiSecurityFixturesOpts {
  orgId: string;
  envName?: string;
  sourceName?: string;
  sourceRoutingKey?: string;
  runsRoutingKey: string;
  unknownRunId: string;
  unknownDeliveryId: string;
  unknownJobId: string;
  trustedRunId: string;
  trustedDeliveryId: string;
  trustedJobId: string;
}

export interface SeedCiSecurityFixturesResult {
  envId: string;
  heldRunId: string;
}

export async function seedCiSecurityFixturesDirect(
  databaseUrl: string,
  opts: SeedCiSecurityFixturesOpts,
): Promise<SeedCiSecurityFixturesResult> {
  const envName = opts.envName ?? 'ci-security-env';
  const sourceName = opts.sourceName ?? 'ci-security-dashboard-resolver';
  const sourceRoutingKey = opts.sourceRoutingKey ?? `generic:${opts.orgId}:ci-security-dashboard`;
  const pool = createPool(databaseUrl);
  try {
    await pool.query(
      `INSERT INTO sources (id, provider, name, routing_key, config, customer_id)
       VALUES (gen_random_uuid(), \'generic\', $1, $2, \'{}\', $3)
       ON CONFLICT (routing_key) DO UPDATE SET customer_id = EXCLUDED.customer_id`,
      [sourceName, sourceRoutingKey, opts.orgId],
    );
    const envResult = await pool.query<{ id: string }>(
      `INSERT INTO environments (org_id, name, type, enabled)
       VALUES ($1, $2, \'fixed\', true)
       ON CONFLICT (org_id, name) DO UPDATE SET enabled = true
       RETURNING id`,
      [opts.orgId, envName],
    );
    const envId = envResult.rows[0].id;
    await pool.query(
      `INSERT INTO execution_runs (
        run_id, workflow_name, provider, repo_identifier,
        ref, sha, delivery_id, status, trust_tier, lock_file_source,
        contributor_username, routing_key
      ) VALUES ($1, \'e2e-security-wf\', \'internal\', \'.\', \'refs/heads/feature\',
        \'abc123\', $2, \'pending\', \'unknown\', \'base\', \'unknown-dev\', $3)`,
      [opts.unknownRunId, opts.unknownDeliveryId, opts.runsRoutingKey],
    );
    await pool.query(
      `INSERT INTO execution_jobs (job_id, run_id, job_name, status)
       VALUES ($1, $2, \'security-test-job\', \'pending\')`,
      [opts.unknownJobId, opts.unknownRunId],
    );
    const heldResult = await pool.query<{ id: string }>(
      `INSERT INTO held_runs (org_id, run_id, job_id, environment_id, hold_type, queue_type, reason, expires_at)
       VALUES ($1, $2, $3, $4, \'unknown_contributor\', \'security\',
        \'Unknown contributor requires approval\', NOW() + INTERVAL \'72 hours\')
       RETURNING id`,
      [opts.orgId, opts.unknownRunId, opts.unknownJobId, envId],
    );
    const heldRunId = heldResult.rows[0].id;
    await pool.query(
      `INSERT INTO execution_runs (
        run_id, workflow_name, provider, repo_identifier,
        ref, sha, delivery_id, status, trust_tier, lock_file_source,
        contributor_username, routing_key
      ) VALUES ($1, \'e2e-security-wf\', \'internal\', \'.\', \'refs/heads/feature\',
        \'def456\', $2, \'running\', \'trusted\', \'head\', \'trusted-dev\', $3)`,
      [opts.trustedRunId, opts.trustedDeliveryId, opts.runsRoutingKey],
    );
    await pool.query(
      `INSERT INTO execution_jobs (job_id, run_id, job_name, status)
       VALUES ($1, $2, \'security-test-job\', \'running\')`,
      [opts.trustedJobId, opts.trustedRunId],
    );
    return { envId, heldRunId };
  } finally {
    await pool.end();
  }
}

// ── Stage 5c remainder: Direct helpers for remaining e2e pg.Pool sites ──

/**
 * Poll `execution_runs` for at least one row matching `status` whose
 * `started_at > since`. Used by cluster/job-reroute tests to gate on
 * a workflow reaching the terminal state after a webhook trigger.
 */
export async function waitForExecutionRunStatusSinceDirect(
  databaseUrl: string,
  opts: {
    status: string;
    since: Date;
    timeoutMs?: number;
    intervalMs?: number;
  },
): Promise<{ found: boolean }> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  const pool = createPool(databaseUrl);
  try {
    while (Date.now() < deadline) {
      const result = await pool.query(
        `SELECT 1 FROM execution_runs
         WHERE started_at > $1 AND status = $2
         LIMIT 1`,
        [opts.since, opts.status],
      );
      if (result.rows.length > 0) return { found: true };
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return { found: false };
  } finally {
    await pool.end();
  }
}

/**
 * Fetch the most recent `execution_runs` row matching `status`, plus its
 * `execution_jobs`. Used by cluster reroute tests to confirm the run +
 * its jobs completed successfully.
 */
export interface LatestExecutionRunResult {
  run: {
    run_id: string;
    workflow_name: string;
    status: string;
  };
  jobs: Array<{ job_id: string; job_name: string; status: string }>;
}

export async function latestExecutionRunByStatusDirect(
  databaseUrl: string,
  opts: { status: string },
): Promise<LatestExecutionRunResult | null> {
  const pool = createPool(databaseUrl);
  try {
    const runResult = await pool.query<{
      run_id: string;
      workflow_name: string;
      status: string;
    }>(
      `SELECT run_id, workflow_name, status FROM execution_runs
       WHERE status = $1
       ORDER BY started_at DESC LIMIT 1`,
      [opts.status],
    );
    if (runResult.rows.length === 0) return null;
    const run = runResult.rows[0];
    const jobsResult = await pool.query<{
      job_id: string;
      job_name: string;
      status: string;
    }>(`SELECT job_id, job_name, status FROM execution_jobs WHERE run_id = $1`, [run.run_id]);
    return { run, jobs: jobsResult.rows };
  } finally {
    await pool.end();
  }
}

/**
 * Wait for a `execution_jobs` row joined against the most recent
 * `execution_runs` for a given workflow name with started_at >= since,
 * returning the job's status + error + run_id. Used by secrets-pipeline
 * to gate on terminal job status.
 */
export interface WaitForLatestJobResult {
  status: string | null;
  errorMessage: string | null;
  runId: string | null;
}

export async function waitForLatestExecutionJobStatusDirect(
  databaseUrl: string,
  opts: {
    workflowName: string;
    since: Date;
    terminalStatuses?: readonly string[];
    timeoutMs?: number;
    intervalMs?: number;
  },
): Promise<WaitForLatestJobResult> {
  const terminal = opts.terminalStatuses ?? (['success', 'completed', 'failed'] as const);
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;
  const pool = createPool(databaseUrl);
  try {
    let status: string | null = null;
    let errorMessage: string | null = null;
    let runId: string | null = null;
    while (Date.now() < deadline) {
      const result = await pool.query<{
        status: string;
        error_message: string | null;
        run_id: string;
      }>(
        `SELECT j.status, j.error_message, r.run_id
           FROM execution_jobs j
           JOIN execution_runs r ON r.run_id = j.run_id
          WHERE r.workflow_name = $1
            AND r.started_at >= $2
          ORDER BY r.started_at DESC
          LIMIT 1`,
        [opts.workflowName, opts.since],
      );
      if (result.rows.length > 0) {
        status = result.rows[0].status;
        errorMessage = result.rows[0].error_message;
        runId = result.rows[0].run_id;
        if (status && terminal.includes(status)) break;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return { status, errorMessage, runId };
  } finally {
    await pool.end();
  }
}

/**
 * READ-ONLY: return information_schema column names for `tableName`,
 * ordered by ordinal_position. Used by e2e tests to verify migrations
 * produced expected schema shape. Returns empty array if the table
 * doesn't exist.
 */
export interface ColumnInfo {
  name: string;
  dataType: string;
}

export async function describeTableColumnsDirect(
  databaseUrl: string,
  opts: { tableName: string },
): Promise<ColumnInfo[]> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = $1
        ORDER BY ordinal_position`,
      [opts.tableName],
    );
    return result.rows.map((r) => ({ name: r.column_name, dataType: r.data_type }));
  } finally {
    await pool.end();
  }
}

/**
 * READ-ONLY: return true if a table exists in the public schema.
 */
export async function tableExistsDirect(
  databaseUrl: string,
  opts: { tableName: string; schema?: string },
): Promise<boolean> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = $2`,
      [opts.schema ?? 'public', opts.tableName],
    );
    return result.rows.length > 0;
  } finally {
    await pool.end();
  }
}

/**
 * Raw INSERT into kici_events with custom chain_depth + expiry window.
 * Used by event-routing e2e to test circuit-breaker + TTL behavior
 * beyond what `emitKiciEventDirect` exposes (which hardcodes depth=0
 * and 1h expiry). Returns the inserted id.
 */
export interface InsertKiciEventRawOpts {
  eventName: string;
  payload: Record<string, unknown>;
  sourceRoutingKey?: string;
  chainDepth?: number;
  /** ISO string or relative '1 hour' / '-1 hour'. Use negative for expired. */
  expiresIn?: string;
}

export async function insertKiciEventRawDirect(
  databaseUrl: string,
  opts: InsertKiciEventRawOpts,
): Promise<{ id: string }> {
  const expiresIn = opts.expiresIn ?? '1 hour';
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO kici_events (event_name, payload, source_routing_key, chain_depth, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + ($5)::interval)
       RETURNING id`,
      [
        opts.eventName,
        JSON.stringify(opts.payload),
        opts.sourceRoutingKey ?? null,
        opts.chainDepth ?? 0,
        expiresIn,
      ],
    );
    return { id: result.rows[0].id };
  } finally {
    await pool.end();
  }
}

/**
 * READ-ONLY: return a kici_events row by id, or null. Callers decode
 * `payload` as they need. Used by event-routing e2e after an INSERT.
 */
export interface KiciEventRow {
  id: string;
  event_name: string;
  payload: Record<string, unknown>;
  chain_depth: number;
  source_routing_key: string | null;
  source_repo: string | null;
  processed: boolean | null;
  expires_at: string;
  created_at: string;
}

export async function showKiciEventDirect(
  databaseUrl: string,
  opts: { id: string },
): Promise<KiciEventRow | null> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query<KiciEventRow>(
      `SELECT id, event_name, payload, chain_depth, source_routing_key,
              source_repo, processed, expires_at, created_at
         FROM kici_events WHERE id = $1`,
      [opts.id],
    );
    return result.rows[0] ?? null;
  } finally {
    await pool.end();
  }
}

/**
 * READ-ONLY: list kici_events with filter hooks used by e2e tests:
 * by `event_name`, minimum `chain_depth`, expiry window. Returns the
 * rows with chain_depth ordered ascending. Callers apply assertions.
 */
export async function listKiciEventsDirect(
  databaseUrl: string,
  opts: {
    eventName?: string;
    minChainDepth?: number;
    /** When true, return only rows past their expires_at. */
    onlyExpired?: boolean;
    /** When set, cap to this many rows. */
    limit?: number;
  } = {},
): Promise<KiciEventRow[]> {
  const pool = createPool(databaseUrl);
  try {
    const clauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (opts.eventName !== undefined) {
      clauses.push(`event_name = $${idx}`);
      params.push(opts.eventName);
      idx += 1;
    }
    if (opts.minChainDepth !== undefined) {
      clauses.push(`chain_depth > $${idx}`);
      params.push(opts.minChainDepth);
      idx += 1;
    }
    if (opts.onlyExpired) {
      clauses.push(`expires_at < NOW()`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(10_000, opts.limit ?? 1000));
    const result = await pool.query<KiciEventRow>(
      `SELECT id, event_name, payload, chain_depth, source_routing_key,
              source_repo, processed, expires_at, created_at
         FROM kici_events
         ${where}
         ORDER BY chain_depth ASC, created_at ASC
         LIMIT ${limit}`,
      params,
    );
    return result.rows;
  } finally {
    await pool.end();
  }
}

/**
 * DELETE kici_events by id or event_name. Returns the number of rows
 * deleted. Used by event-routing teardown.
 */
export async function deleteKiciEventsDirect(
  databaseUrl: string,
  opts: { id?: string; eventName?: string },
): Promise<{ deleted: number }> {
  if (!opts.id && !opts.eventName) {
    throw new Error('deleteKiciEventsDirect: one of {id, eventName} is required');
  }
  const pool = createPool(databaseUrl);
  try {
    const result = opts.id
      ? await pool.query(`DELETE FROM kici_events WHERE id = $1`, [opts.id])
      : await pool.query(`DELETE FROM kici_events WHERE event_name = $1`, [opts.eventName]);
    return { deleted: result.rowCount ?? 0 };
  } finally {
    await pool.end();
  }
}

/**
 * Simulate a NOTIFY on `kici_event_channel` and verify a LISTEN client
 * receives it. Used by event-routing e2e to prove the infrastructure
 * the EventRouter uses for real-time delivery is functional. Owns the
 * pool for the full test to keep the listen/notify correlated.
 */
export async function verifyKiciEventNotifyDirect(
  databaseUrl: string,
  opts: { payload: string; waitMs?: number },
): Promise<{ received: string[] }> {
  const waitMs = opts.waitMs ?? 1_000;
  const pool = createPool(databaseUrl);
  const client = await pool.connect();
  try {
    const notifications: string[] = [];
    client.on('notification', (msg) => {
      if (msg.channel === 'kici_event_channel') {
        notifications.push(msg.payload ?? '');
      }
    });
    await client.query('LISTEN kici_event_channel');
    await pool.query(`SELECT pg_notify('kici_event_channel', $1)`, [opts.payload]);
    await new Promise((r) => setTimeout(r, waitMs));
    await client.query('UNLISTEN kici_event_channel');
    return { received: notifications };
  } finally {
    client.release();
    await pool.end();
  }
}

// ── cross_repo_trust ─────────────────────────────────────────────────

export interface CrossRepoTrustRow {
  id: string;
  source_repo: string;
  source_routing_key: string;
  target_repo: string;
  target_routing_key: string;
  allowed_events: string[] | null;
}

/**
 * INSERT a cross_repo_trust row. Returns the new id and allowed_events
 * array. Used by generic-webhook + event-routing e2e until a proper
 * `kici-admin trust` CLI ships.
 */
export async function seedCrossRepoTrustDirect(
  databaseUrl: string,
  opts: {
    sourceRepo: string;
    sourceRoutingKey: string;
    targetRepo: string;
    targetRoutingKey: string;
    allowedEvents?: string[];
  },
): Promise<{ id: string; allowedEvents: string[] | null }> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query<{ id: string; allowed_events: string[] | null }>(
      `INSERT INTO cross_repo_trust
         (source_repo, source_routing_key, target_repo, target_routing_key, allowed_events)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, allowed_events`,
      [
        opts.sourceRepo,
        opts.sourceRoutingKey,
        opts.targetRepo,
        opts.targetRoutingKey,
        opts.allowedEvents ? JSON.stringify(opts.allowedEvents) : null,
      ],
    );
    return {
      id: result.rows[0].id,
      allowedEvents: result.rows[0].allowed_events,
    };
  } finally {
    await pool.end();
  }
}

/**
 * READ-ONLY: list cross_repo_trust rows by source_routing_key. Used by
 * generic-webhook e2e to find a trust row it just inserted.
 */
export async function listCrossRepoTrustBySourceRoutingKeyDirect(
  databaseUrl: string,
  opts: { sourceRoutingKey: string },
): Promise<CrossRepoTrustRow[]> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query<CrossRepoTrustRow>(
      `SELECT id, source_repo, source_routing_key, target_repo, target_routing_key, allowed_events
         FROM cross_repo_trust WHERE source_routing_key = $1`,
      [opts.sourceRoutingKey],
    );
    return result.rows;
  } finally {
    await pool.end();
  }
}

/**
 * DELETE cross_repo_trust rows. Deletes by id, or asserts uniqueness
 * check error on duplicate INSERT (handled by caller). Returns row count.
 */
export async function deleteCrossRepoTrustDirect(
  databaseUrl: string,
  opts: { id: string },
): Promise<{ deleted: number }> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query(`DELETE FROM cross_repo_trust WHERE id = $1`, [opts.id]);
    return { deleted: result.rowCount ?? 0 };
  } finally {
    await pool.end();
  }
}

/**
 * Direct INSERT with duplicate-key detection. Used by event-routing
 * e2e to verify the unique constraint enforces. Throws on duplicate;
 * caller asserts the error message matches /unique/i.
 */
export async function insertCrossRepoTrustStrictDirect(
  databaseUrl: string,
  opts: {
    sourceRepo: string;
    sourceRoutingKey: string;
    targetRepo: string;
    targetRoutingKey: string;
  },
): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await pool.query(
      `INSERT INTO cross_repo_trust (source_repo, source_routing_key, target_repo, target_routing_key)
       VALUES ($1, $2, $3, $4)`,
      [opts.sourceRepo, opts.sourceRoutingKey, opts.targetRepo, opts.targetRoutingKey],
    );
  } finally {
    await pool.end();
  }
}

// ── workflow_registrations helpers ──────────────────────────────────────

/**
 * Cleanup helper for workflow_registrations. Accepts id, routingKey,
 * or repoIdentifier filter (exactly one). Returns delete count.
 */
export async function deleteWorkflowRegistrationsDirect(
  databaseUrl: string,
  opts: { id?: string; routingKey?: string; repoIdentifier?: string },
): Promise<{ deleted: number }> {
  const filters = [opts.id, opts.routingKey, opts.repoIdentifier].filter((v) => v !== undefined);
  if (filters.length !== 1) {
    throw new Error(
      'deleteWorkflowRegistrationsDirect: exactly one of {id, routingKey, repoIdentifier} required',
    );
  }
  const pool = createPool(databaseUrl);
  try {
    let result;
    if (opts.id) {
      result = await pool.query(`DELETE FROM workflow_registrations WHERE id = $1`, [opts.id]);
    } else if (opts.routingKey) {
      result = await pool.query(`DELETE FROM workflow_registrations WHERE routing_key = $1`, [
        opts.routingKey,
      ]);
    } else {
      result = await pool.query(`DELETE FROM workflow_registrations WHERE repo_identifier = $1`, [
        opts.repoIdentifier,
      ]);
    }
    return { deleted: result.rowCount ?? 0 };
  } finally {
    await pool.end();
  }
}

/**
 * READ-ONLY: workflow_registrations by id — returns null when missing.
 * Pulls the full row so tests can assert lock_entry contents + trigger_types.
 */
export interface WorkflowRegistrationFullRow extends WorkflowRegistrationRow {
  lock_entry: unknown;
}

export async function getWorkflowRegistrationByIdDirect(
  databaseUrl: string,
  opts: { id: string },
): Promise<WorkflowRegistrationFullRow | null> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query<WorkflowRegistrationFullRow>(
      `SELECT id, repo_identifier, workflow_name, routing_key, customer_id,
              trigger_types, disabled, is_global, commit_sha, source_file,
              created_at, updated_at, lock_entry
         FROM workflow_registrations
        WHERE id = $1`,
      [opts.id],
    );
    return result.rows[0] ?? null;
  } finally {
    await pool.end();
  }
}

/**
 * READ-ONLY: return the count + optional rows + latest updated_at for
 * workflow_registrations scoped to a routing key. Used by forgejo e2e
 * to wait for extraction + verify re-extraction bumped updated_at.
 */
export interface RegistrationsScopedResult {
  count: number;
  latestUpdatedAt: Date | null;
  rows: Array<{ workflow_name: string; is_global: boolean }>;
}

export async function listRegistrationsByRoutingKeyDirect(
  databaseUrl: string,
  opts: { routingKey: string; onlyGlobal?: boolean },
): Promise<RegistrationsScopedResult> {
  const pool = createPool(databaseUrl);
  try {
    const globalFilter = opts.onlyGlobal ? `AND is_global = TRUE` : '';
    const result = await pool.query<{
      workflow_name: string;
      is_global: boolean;
      updated_at: Date;
    }>(
      `SELECT workflow_name, is_global, updated_at
         FROM workflow_registrations
        WHERE routing_key = $1 ${globalFilter}`,
      [opts.routingKey],
    );
    let latest: Date | null = null;
    for (const r of result.rows) {
      const d = r.updated_at ? new Date(r.updated_at) : null;
      if (d && (!latest || d.getTime() > latest.getTime())) latest = d;
    }
    return {
      count: result.rows.length,
      latestUpdatedAt: latest,
      rows: result.rows.map((r) => ({
        workflow_name: r.workflow_name,
        is_global: r.is_global,
      })),
    };
  } finally {
    await pool.end();
  }
}

/**
 * Poll `workflow_registrations` for at least `minCount` rows for a
 * routing key. Returns the rows or throws on timeout (keeps parity with
 * the forgejo helper pattern it replaces).
 */
export async function waitForRegistrationsByRoutingKeyDirect(
  databaseUrl: string,
  opts: {
    routingKey: string;
    minCount?: number;
    onlyGlobal?: boolean;
    timeoutMs?: number;
    intervalMs?: number;
  },
): Promise<Array<{ workflow_name: string; is_global: boolean }>> {
  const minCount = opts.minCount ?? 1;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  let rows: Array<{ workflow_name: string; is_global: boolean }> = [];
  while (Date.now() < deadline) {
    const result = await listRegistrationsByRoutingKeyDirect(databaseUrl, {
      routingKey: opts.routingKey,
      onlyGlobal: opts.onlyGlobal,
    });
    rows = result.rows;
    if (rows.length >= minCount) return rows;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return rows;
}

/**
 * Wait for `workflow_registrations.updated_at` for a routing key to
 * exceed `baselineUpdatedAt`. Used by forgejo rotated-PAT e2e.
 */
export async function waitForRegistrationsUpdatedAtAdvanceDirect(
  databaseUrl: string,
  opts: {
    routingKey: string;
    baselineUpdatedAt: Date | null;
    timeoutMs?: number;
    intervalMs?: number;
  },
): Promise<{ advanced: boolean; latestUpdatedAt: Date | null }> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  let latest: Date | null = null;
  while (Date.now() < deadline) {
    const result = await listRegistrationsByRoutingKeyDirect(databaseUrl, {
      routingKey: opts.routingKey,
    });
    latest = result.latestUpdatedAt;
    if (
      latest &&
      (!opts.baselineUpdatedAt || latest.getTime() > opts.baselineUpdatedAt.getTime())
    ) {
      return { advanced: true, latestUpdatedAt: latest };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { advanced: false, latestUpdatedAt: latest };
}

/**
 * UPDATE a workflow_registrations row's commit_sha. Used by cron-scheduler
 * e2e where the manual-schedule handler rejects null commit SHAs.
 */
export async function updateWorkflowRegistrationCommitShaDirect(
  databaseUrl: string,
  opts: { id: string; commitSha: string },
): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await pool.query(`UPDATE workflow_registrations SET commit_sha = $1 WHERE id = $2`, [
      opts.commitSha,
      opts.id,
    ]);
  } finally {
    await pool.end();
  }
}

/**
 * Lock-entry seeding for the admin-API e2e, which uses a custom
 * shape (cron schedule). Returns the inserted id.
 */
export async function insertWorkflowRegistrationRawDirect(
  databaseUrl: string,
  opts: {
    routingKey: string;
    repoIdentifier: string;
    workflowName: string;
    lockEntry: Record<string, unknown>;
    triggerTypes: string[];
    customerId: string;
    isGlobal?: boolean;
    disabled?: boolean;
    commitSha?: string;
    id?: string;
  },
): Promise<{ id: string }> {
  const pool = createPool(databaseUrl);
  try {
    const idClause = opts.id ? '$7' : 'gen_random_uuid()';
    const extras: unknown[] = [];
    if (opts.id) extras.push(opts.id);
    const columns: string[] = [];
    const placeholders: string[] = [];
    if (opts.isGlobal !== undefined) {
      columns.push('is_global');
      placeholders.push(`$${7 + extras.length}`);
      extras.push(opts.isGlobal);
    }
    if (opts.disabled !== undefined) {
      columns.push('disabled');
      placeholders.push(`$${7 + extras.length}`);
      extras.push(opts.disabled);
    }
    if (opts.commitSha !== undefined) {
      columns.push('commit_sha');
      placeholders.push(`$${7 + extras.length}`);
      extras.push(opts.commitSha);
    }
    const extraColumns = columns.length > 0 ? `, ${columns.join(', ')}` : '';
    const extraPlaceholders = placeholders.length > 0 ? `, ${placeholders.join(', ')}` : '';
    const sql = `INSERT INTO workflow_registrations
      (routing_key, repo_identifier, workflow_name, lock_entry, trigger_types, customer_id${opts.id ? ', id' : ''}${extraColumns})
      VALUES ($1, $2, $3, $4, $5, $6${opts.id ? `, ${idClause}` : ''}${extraPlaceholders})
      ON CONFLICT (routing_key, repo_identifier, workflow_name) DO UPDATE SET
        lock_entry = EXCLUDED.lock_entry,
        trigger_types = EXCLUDED.trigger_types,
        customer_id = EXCLUDED.customer_id
      RETURNING id`;
    const result = await pool.query<{ id: string }>(sql, [
      opts.routingKey,
      opts.repoIdentifier,
      opts.workflowName,
      JSON.stringify(opts.lockEntry),
      opts.triggerTypes,
      opts.customerId,
      ...extras,
    ]);
    return { id: result.rows[0].id };
  } finally {
    await pool.end();
  }
}

/**
 * INSERT with a STRICT shape (no ON CONFLICT). Used by registration-schema
 * e2e to prove the unique constraint rejects duplicates. Throws the raw
 * DB error (caller matches /unique/i).
 */
export async function insertWorkflowRegistrationStrictDirect(
  databaseUrl: string,
  opts: {
    routingKey: string;
    repoIdentifier: string;
    workflowName: string;
    lockEntryJson?: string;
    triggerTypes: readonly string[];
    customerId: string;
  },
): Promise<{ id: string | null }> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO workflow_registrations
         (routing_key, repo_identifier, workflow_name, lock_entry, trigger_types, customer_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       RETURNING id`,
      [
        opts.routingKey,
        opts.repoIdentifier,
        opts.workflowName,
        opts.lockEntryJson ?? '{}',
        opts.triggerTypes as readonly string[],
        opts.customerId,
      ],
    );
    return { id: result.rows[0]?.id ?? null };
  } finally {
    await pool.end();
  }
}

/**
 * READ-ONLY: latest registry_versions.version, or null if the default
 * row is missing. Used by registration-admin-api e2e to bracket a
 * refresh call.
 */
export async function getRegistryVersionDirect(
  databaseUrl: string,
  opts: { id?: string } = {},
): Promise<number | null> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query<{ version: number }>(
      `SELECT version FROM registry_versions WHERE id = $1`,
      [opts.id ?? 'default'],
    );
    return result.rows[0]?.version ?? null;
  } finally {
    await pool.end();
  }
}

/**
 * UPDATE `registry_versions.version = version + 1` WHERE id (default).
 * Simpler than `bumpRegistryVersionDirect` — used by global-workflow
 * e2e which wants the side-effect (force index refresh) without the
 * return value.
 */
export async function bumpRegistryVersionSimpleDirect(
  databaseUrl: string,
  opts: { id?: string } = {},
): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await pool.query(`UPDATE registry_versions SET version = version + 1 WHERE id = $1`, [
      opts.id ?? 'default',
    ]);
  } finally {
    await pool.end();
  }
}

// ── cron_last_fired ──────────────────────────────────────────────────

/**
 * Seed cron_last_fired for a registration with an `-INTERVAL` offset so
 * the scheduler fires on the next evaluation. Upsert via ON CONFLICT.
 */
export async function upsertCronLastFiredDirect(
  databaseUrl: string,
  opts: { registrationId: string; agoInterval: string },
): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await pool.query(
      `INSERT INTO cron_last_fired (registration_id, last_fired_at)
         VALUES ($1, NOW() - ($2)::interval)
         ON CONFLICT (registration_id) DO UPDATE SET
           last_fired_at = NOW() - ($2)::interval,
           updated_at = NOW()`,
      [opts.registrationId, opts.agoInterval],
    );
  } finally {
    await pool.end();
  }
}

/**
 * READ-ONLY: count cron_last_fired rows for a registration. Used by
 * registration-schema e2e to assert the FK cascade deletes the row.
 */
export async function countCronLastFiredDirect(
  databaseUrl: string,
  opts: { registrationId: string },
): Promise<number> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM cron_last_fired WHERE registration_id = $1`,
      [opts.registrationId],
    );
    return result.rows[0]?.cnt ?? 0;
  } finally {
    await pool.end();
  }
}

/**
 * INSERT a cron_last_fired row with an explicit timestamp. Used by
 * registration-schema e2e to set up the FK cascade test.
 */
export async function insertCronLastFiredNowDirect(
  databaseUrl: string,
  opts: { registrationId: string },
): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await pool.query(
      `INSERT INTO cron_last_fired (registration_id, last_fired_at) VALUES ($1, NOW())`,
      [opts.registrationId],
    );
  } finally {
    await pool.end();
  }
}

/**
 * DELETE cron_last_fired rows for a registration. Teardown helper.
 */
export async function deleteCronLastFiredDirect(
  databaseUrl: string,
  opts: { registrationId: string },
): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await pool.query(`DELETE FROM cron_last_fired WHERE registration_id = $1`, [
      opts.registrationId,
    ]);
  } finally {
    await pool.end();
  }
}

/**
 * DELETE execution_runs by workflow_name. Teardown helper for
 * manual-schedule e2e.
 */
export async function deleteExecutionRunsByWorkflowNameDirect(
  databaseUrl: string,
  opts: { workflowName: string },
): Promise<{ deleted: number }> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query(`DELETE FROM execution_runs WHERE workflow_name = $1`, [
      opts.workflowName,
    ]);
    return { deleted: result.rowCount ?? 0 };
  } finally {
    await pool.end();
  }
}

// ── generic_webhook_sources extras ───────────────────────────────────

/**
 * READ-ONLY: SELECT generic_webhook_sources by routing_key.
 * Used by forgejo e2e to assert the source exists with correct git_config.
 */
export async function getGenericWebhookSourceByRoutingKeyDirect(
  databaseUrl: string,
  opts: { routingKey: string },
): Promise<{ id: string; git_config: unknown; customer_id: string | null } | null> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query<{
      id: string;
      git_config: unknown;
      customer_id: string | null;
    }>(`SELECT id, git_config, customer_id FROM generic_webhook_sources WHERE routing_key = $1`, [
      opts.routingKey,
    ]);
    return result.rows[0] ?? null;
  } finally {
    await pool.end();
  }
}

/**
 * READ-ONLY: list active (enabled=true) generic_webhook_sources.
 * Used by cluster-leader-failover e2e to prove the seeded source exists
 * before a leader crash.
 */
export async function listActiveGenericWebhookSourcesDirect(
  databaseUrl: string,
): Promise<Array<{ id: string; customer_id: string | null; routing_key: string }>> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query<{
      id: string;
      customer_id: string | null;
      routing_key: string;
    }>(`SELECT id, customer_id, routing_key FROM generic_webhook_sources WHERE enabled = true`);
    return result.rows;
  } finally {
    await pool.end();
  }
}

/**
 * UPDATE generic_webhook_sources.verification_config for a source by
 * name + customer_id. Used by the generic-webhook-auth e2e which seeds
 * sources and then writes custom auth configs.
 */
export async function updateGenericWebhookVerificationConfigDirect(
  databaseUrl: string,
  opts: { name: string; customerId: string; verificationConfig: Record<string, unknown> },
): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await pool.query(
      `UPDATE generic_webhook_sources
         SET verification_config = $1
        WHERE name = $2 AND customer_id = $3`,
      [JSON.stringify(opts.verificationConfig), opts.name, opts.customerId],
    );
  } finally {
    await pool.end();
  }
}

/**
 * DELETE generic_webhook_sources by name list. Teardown for the auth
 * e2e, which seeded 3 sources by name.
 */
export async function deleteGenericWebhookSourcesByNameDirect(
  databaseUrl: string,
  opts: { names: readonly string[] },
): Promise<{ deleted: number }> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query(
      `DELETE FROM generic_webhook_sources WHERE name = ANY($1::text[])`,
      [opts.names as readonly string[]],
    );
    return { deleted: result.rowCount ?? 0 };
  } finally {
    await pool.end();
  }
}

/**
 * UPDATE generic_webhook_sources.deleted_at = NULL for a row by id.
 * Used by the generic-webhook e2e to restore a soft-deleted source
 * after the soft-delete test ran — there is no CLI-level undelete.
 */
export async function restoreSoftDeletedGenericWebhookSourceDirect(
  databaseUrl: string,
  opts: { id: string },
): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await pool.query(`UPDATE generic_webhook_sources SET deleted_at = NULL WHERE id = $1`, [
      opts.id,
    ]);
  } finally {
    await pool.end();
  }
}

// ── org_settings (global workflow policy) ────────────────────────────

/**
 * One entry in any of the three repo-pattern lists stored on `org_settings`.
 * `routingKey` is the source-qualifier; when absent, the entry applies to
 * any source in the org.
 */
export interface OrgSettingsRepoPatternEntry {
  routingKey?: string;
  pattern: string;
}

/**
 * UPSERT org_settings for a customer/org id. `globalWorkflowsEnabled` is
 * required; the three list fields are each optional. Each list is a jsonb
 * array of `{routingKey?, pattern}` entries. Pass `null` to clear a list.
 */
export interface UpsertOrgSettingsOpts {
  customerId: string;
  globalWorkflowsEnabled: boolean;
  allowedRepos?: OrgSettingsRepoPatternEntry[] | null;
  deniedRepos?: OrgSettingsRepoPatternEntry[] | null;
  elevatedRepos?: OrgSettingsRepoPatternEntry[] | null;
}

export async function upsertOrgSettingsGlobalWorkflowsDirect(
  databaseUrl: string,
  opts: UpsertOrgSettingsOpts,
): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await pool.query(
      `INSERT INTO org_settings (
         customer_id, global_workflows_enabled,
         global_workflow_allowed_repos,
         global_workflow_denied_repos,
         global_workflow_elevated_repos
       ) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb)
       ON CONFLICT (customer_id) DO UPDATE SET
         global_workflows_enabled = EXCLUDED.global_workflows_enabled,
         global_workflow_allowed_repos = EXCLUDED.global_workflow_allowed_repos,
         global_workflow_denied_repos = EXCLUDED.global_workflow_denied_repos,
         global_workflow_elevated_repos = EXCLUDED.global_workflow_elevated_repos,
         updated_at = NOW()`,
      [
        opts.customerId,
        opts.globalWorkflowsEnabled,
        opts.allowedRepos == null ? null : JSON.stringify(opts.allowedRepos),
        opts.deniedRepos == null ? null : JSON.stringify(opts.deniedRepos),
        opts.elevatedRepos == null ? null : JSON.stringify(opts.elevatedRepos),
      ],
    );
  } finally {
    await pool.end();
  }
}

/**
 * UPDATE org_settings.global_workflow_denied_repos for a customer/org id.
 * Assumes the row exists (upsertOrgSettingsGlobalWorkflowsDirect was
 * called earlier in the test).
 */
export async function updateOrgSettingsDeniedReposDirect(
  databaseUrl: string,
  opts: { customerId: string; deniedRepos: OrgSettingsRepoPatternEntry[] | null },
): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await pool.query(
      `UPDATE org_settings
         SET global_workflow_denied_repos = $2::jsonb,
             updated_at = NOW()
        WHERE customer_id = $1`,
      [opts.customerId, opts.deniedRepos == null ? null : JSON.stringify(opts.deniedRepos)],
    );
  } finally {
    await pool.end();
  }
}

/**
 * DELETE org_settings by customer/org id. Teardown helper.
 */
export async function deleteOrgSettingsByCustomerIdDirect(
  databaseUrl: string,
  opts: { customerId: string },
): Promise<{ deleted: number }> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query(`DELETE FROM org_settings WHERE customer_id = $1`, [
      opts.customerId,
    ]);
    return { deleted: result.rowCount ?? 0 };
  } finally {
    await pool.end();
  }
}

// ── execution_runs + held_runs read helpers ────────────────────────

/**
 * READ-ONLY: fetch an execution_runs row by run_id, returning the
 * security-relevant columns the ci-security e2e asserts on. Throws
 * when the row is missing.
 */
export interface ExecutionRunSecurityRow {
  run_id: string;
  trust_tier: string | null;
  lock_file_source: string | null;
  contributor_username: string | null;
  status: string;
}

export async function getExecutionRunSecurityDirect(
  databaseUrl: string,
  opts: { runId: string },
): Promise<ExecutionRunSecurityRow> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query<ExecutionRunSecurityRow>(
      `SELECT run_id, trust_tier, lock_file_source, contributor_username, status
         FROM execution_runs WHERE run_id = $1`,
      [opts.runId],
    );
    if (result.rows.length === 0) {
      throw new Error(`execution_runs: row not found (run_id=${opts.runId})`);
    }
    return result.rows[0];
  } finally {
    await pool.end();
  }
}

/**
 * READ-ONLY: fetch a held_runs row by id (with the security columns).
 * Returns null if missing.
 */
export interface HeldRunSecurityRow {
  id: string;
  run_id: string;
  hold_type: string;
  queue_type: string;
  status: string;
  reason: string | null;
  expires_at: string | null;
  approved_by: string | null;
  resolved_at: string | null;
}

export async function getHeldRunByIdDirect(
  databaseUrl: string,
  opts: { id: string },
): Promise<HeldRunSecurityRow | null> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query<HeldRunSecurityRow>(
      `SELECT id, run_id, hold_type, queue_type, status, reason,
              expires_at, approved_by, resolved_at
         FROM held_runs WHERE id = $1`,
      [opts.id],
    );
    return result.rows[0] ?? null;
  } finally {
    await pool.end();
  }
}

/** One recorded approver decision for a held run (`held_run_approvals` row). */
export interface HeldRunApprovalRow {
  id: string;
  held_run_id: string;
  approver_user_id: string;
  decision: string;
  created_at: Date;
}

/**
 * READ-ONLY: list the recorded approver decisions for a held run, newest
 * first. Approver attribution lives in `held_run_approvals` (one row per
 * decision), not on the `held_runs` row — used by ci-security e2e to prove
 * an approval was stamped with the approving user's sub.
 */
export async function listHeldRunApprovalsDirect(
  databaseUrl: string,
  opts: { heldRunId: string },
): Promise<HeldRunApprovalRow[]> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query<HeldRunApprovalRow>(
      `SELECT id, held_run_id, approver_user_id, decision, created_at
         FROM held_run_approvals WHERE held_run_id = $1
         ORDER BY created_at DESC`,
      [opts.heldRunId],
    );
    return result.rows;
  } finally {
    await pool.end();
  }
}

/**
 * READ-ONLY: count held_runs rows matching run_id + queue_type.
 * Used by ci-security e2e to prove no security hold exists for a
 * trusted contributor PR.
 */
export async function countHeldRunsByRunIdDirect(
  databaseUrl: string,
  opts: { runId: string; queueType?: string },
): Promise<number> {
  const pool = createPool(databaseUrl);
  try {
    const result = opts.queueType
      ? await pool.query<{ cnt: number }>(
          `SELECT COUNT(*)::int AS cnt FROM held_runs WHERE run_id = $1 AND queue_type = $2`,
          [opts.runId, opts.queueType],
        )
      : await pool.query<{ cnt: number }>(
          `SELECT COUNT(*)::int AS cnt FROM held_runs WHERE run_id = $1`,
          [opts.runId],
        );
    return result.rows[0]?.cnt ?? 0;
  } finally {
    await pool.end();
  }
}

// ── Platform-side run + event_log helpers ─────────────────────────

/**
 * Wait for Platform-side `execution_runs.status = <status>` where
 * `created_at > since`. Returns the final status + failure_reason or
 * null if the timeout elapsed. Used by webhook-pipeline (failed) and
 * orchestrator-never-reconnects (timed_out_stale).
 */
export async function waitForPlatformExecutionRunStatusDirect(
  databaseUrl: string,
  opts: {
    status: string;
    since: Date;
    timeoutMs?: number;
    intervalMs?: number;
  },
): Promise<{ status: string; failure_reason: string | null } | null> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  const pool = createPool(databaseUrl);
  try {
    while (Date.now() < deadline) {
      const result = await pool.query<{ status: string; failure_reason: string | null }>(
        `SELECT status, failure_reason FROM execution_runs
          WHERE created_at > $1 AND status = $2
          ORDER BY created_at DESC LIMIT 1`,
        [opts.since, opts.status],
      );
      if (result.rows.length > 0) return result.rows[0];
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
  } finally {
    await pool.end();
  }
}

/**
 * Wait for Platform `event_log` to show at least `minDistinctRouted`
 * distinct `routed_to` values since a given timestamp. Used by
 * cluster-round-robin to prove at least 2 orchestrators received
 * deliveries. Returns the observed count (0 if timed out).
 */
export async function waitForPlatformEventLogDistinctRoutedDirect(
  databaseUrl: string,
  opts: {
    since: Date;
    minDistinctRouted: number;
    timeoutMs?: number;
    intervalMs?: number;
  },
): Promise<{ distinctRouted: number }> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;
  const pool = createPool(databaseUrl);
  try {
    let distinct = 0;
    while (Date.now() < deadline) {
      const result = await pool.query<{ cnt: number }>(
        `SELECT COUNT(DISTINCT routed_to)::int AS cnt FROM event_log WHERE received_at > $1`,
        [opts.since],
      );
      distinct = result.rows[0]?.cnt ?? 0;
      if (distinct >= opts.minDistinctRouted) return { distinctRouted: distinct };
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return { distinctRouted: distinct };
  } finally {
    await pool.end();
  }
}

/**
 * Wait for an orchestrator `event_log` row keyed by `delivery_id`.
 * Returns the full row (the webhook-pipeline e2e asserts many
 * columns) or null on timeout.
 */
export interface EventLogRow {
  org_id: string;
  delivery_id: string;
  status: string;
  source: string;
  event: string;
  provider: string;
  payload_hash: string;
  payload_omitted: boolean;
  payload_key: string | null;
  payload_size_bytes: number;
  matched_count: number;
  run_id: string | null;
}

export async function waitForEventLogRowByDeliveryIdDirect(
  databaseUrl: string,
  opts: { deliveryId: string; timeoutMs?: number; intervalMs?: number },
): Promise<EventLogRow | null> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  const pool = createPool(databaseUrl);
  try {
    while (Date.now() < deadline) {
      const res = await pool.query<EventLogRow>(
        `SELECT org_id, delivery_id, status, source, event, provider, payload_hash,
                payload_omitted, payload_key, payload_size_bytes, matched_count, run_id
           FROM event_log WHERE delivery_id = $1`,
        [opts.deliveryId],
      );
      if (res.rowCount && res.rowCount > 0) return res.rows[0];
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
  } finally {
    await pool.end();
  }
}

/**
 * Resolve a Platform `webhook_sources.routing_key` for an org.
 *
 * - With `routingKeyLikePrefix` only: returns the newest match. Note that
 *   this picks whichever generic source was registered most recently — if
 *   tests have created additional generic sources (e.g. universal-git-forgejo
 *   creating `stg-universal-git-forgejo`), the newest may NOT be the
 *   `stg-generic` default seeded by `pnpm deploy:stg`.
 * - With `orchDbUrl` + `nameInOrchDb`: looks up the source by name in the
 *   orchestrator's `generic_webhook_sources` table, then verifies the
 *   resulting routing key is registered in Platform's `webhook_sources`.
 *   This is the disambiguating path Bucket-B tests should use when other
 *   generic sources may exist alongside the default.
 */
export async function resolvePlatformWebhookSourceRoutingKeyDirect(
  platformDbUrl: string,
  opts: {
    orgId: string;
    routingKeyLikePrefix: string;
    orchDbUrl?: string;
    nameInOrchDb?: string;
  },
): Promise<string | null> {
  // Name-aware path: ask the orchestrator DB for the source UUID by name,
  // then construct the routing key and verify Platform has it.
  if (opts.orchDbUrl && opts.nameInOrchDb) {
    const orchPool = createPool(opts.orchDbUrl);
    let candidateRoutingKey: string | null = null;
    try {
      const res = await orchPool.query<{ id: string }>(
        `SELECT id FROM generic_webhook_sources
          WHERE customer_id = $1 AND name = $2 AND deleted_at IS NULL
          LIMIT 1`,
        [opts.orgId, opts.nameInOrchDb],
      );
      const id = res.rows[0]?.id;
      if (!id) return null;
      candidateRoutingKey = `generic:${opts.orgId}:${id}`;
    } finally {
      await orchPool.end();
    }
    const platformPool = createPool(platformDbUrl);
    try {
      const res = await platformPool.query<{ routing_key: string }>(
        `SELECT routing_key FROM webhook_sources
          WHERE org_id = $1 AND routing_key = $2 LIMIT 1`,
        [opts.orgId, candidateRoutingKey],
      );
      return res.rows[0]?.routing_key ?? null;
    } finally {
      await platformPool.end();
    }
  }

  const pool = createPool(platformDbUrl);
  try {
    const result = await pool.query<{ routing_key: string }>(
      `SELECT routing_key FROM webhook_sources
        WHERE org_id = $1 AND routing_key LIKE $2
        ORDER BY registered_at DESC LIMIT 1`,
      [opts.orgId, `${opts.routingKeyLikePrefix}%`],
    );
    return result.rows[0]?.routing_key ?? null;
  } finally {
    await pool.end();
  }
}

/**
 * Idempotent seeding of an E2E regular user + org membership + owner
 * role on the Platform DB. Used by stg-ha-smoke before seeding a user
 * API key. Requires the org to already have an owner role.
 */
export async function ensureOrgOwnerMemberDirect(
  platformDbUrl: string,
  opts: {
    orgId: string;
    idpSub: string;
    email: string;
    displayName: string;
  },
): Promise<{ ownerRoleId: string }> {
  const pool = createPool(platformDbUrl);
  try {
    const ownerRole = await pool.query<{ id: string }>(
      `SELECT id FROM roles WHERE org_id = $1 AND is_owner = true LIMIT 1`,
      [opts.orgId],
    );
    if (ownerRole.rows.length === 0) {
      throw new Error(`ensureOrgOwnerMemberDirect: no owner role found for org ${opts.orgId}`);
    }
    const ownerRoleId = ownerRole.rows[0].id;
    await pool.query(
      `INSERT INTO users (idp_sub, email, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (idp_sub) DO NOTHING`,
      [opts.idpSub, opts.email, opts.displayName],
    );
    await pool.query(
      `INSERT INTO org_members (org_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [opts.orgId, opts.idpSub],
    );
    await pool.query(
      `INSERT INTO role_assignments (org_id, user_id, role_id, assigned_by)
         VALUES ($1, $2, $3, $2)
         ON CONFLICT (org_id, user_id, role_id) DO NOTHING`,
      [opts.orgId, opts.idpSub, ownerRoleId],
    );
    return { ownerRoleId };
  } finally {
    await pool.end();
  }
}

// ── peer_credentials direct helpers ────────────────────────────────

/**
 * Cleanup peer_credentials by instance_id LIKE pattern. Used by the
 * cluster-peer-credentials e2e before/after each test to wipe its
 * own seeded rows without touching real cluster credentials.
 */
export async function deletePeerCredentialsByInstanceIdLikeDirect(
  databaseUrl: string,
  opts: { pattern: string },
): Promise<{ deleted: number }> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query(`DELETE FROM peer_credentials WHERE instance_id LIKE $1`, [
      opts.pattern,
    ]);
    return { deleted: result.rowCount ?? 0 };
  } finally {
    await pool.end();
  }
}

/**
 * Insert a peer_credentials row with an explicit expires_at. Used by
 * the "expired credential is not returned" e2e — the store's save()
 * always computes a future expiry, so tests that need a pre-expired
 * row must bypass it.
 */
export async function insertPeerCredentialExpiredDirect(
  databaseUrl: string,
  opts: {
    instanceId: string;
    credentialHash: string;
    role: string;
    routingKeys: readonly string[];
    expiresAt: Date;
  },
): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await pool.query(
      `INSERT INTO peer_credentials (instance_id, credential_hash, role, routing_keys, expires_at)
       VALUES ($1, $2, $3, $4::text[], $5)`,
      [
        opts.instanceId,
        opts.credentialHash,
        opts.role,
        Array.from(opts.routingKeys),
        opts.expiresAt,
      ],
    );
  } finally {
    await pool.end();
  }
}

/**
 * READ-ONLY: `revoked_at` for a peer_credentials row by hash. Used
 * by the "save revokes old credential" e2e to assert revocation.
 * Returns null when the row is missing entirely (distinct from
 * "present but not revoked").
 */
export async function getPeerCredentialRevokedAtDirect(
  databaseUrl: string,
  opts: { credentialHash: string },
): Promise<{ present: boolean; revokedAt: Date | null }> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM peer_credentials WHERE credential_hash = $1`,
      [opts.credentialHash],
    );
    if (result.rows.length === 0) return { present: false, revokedAt: null };
    return { present: true, revokedAt: result.rows[0].revoked_at };
  } finally {
    await pool.end();
  }
}

/**
 * READ-ONLY: list active peer_credentials ids EXCLUDING a
 * `instance_id LIKE` pattern. Used by revokeAll e2e to snapshot
 * real cluster credentials it will restore later.
 */
export async function listActivePeerCredentialsExcludingDirect(
  databaseUrl: string,
  opts: { excludeInstanceIdPattern: string },
): Promise<{ ids: string[] }> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query<{ id: string }>(
      `SELECT id FROM peer_credentials
        WHERE revoked_at IS NULL AND instance_id NOT LIKE $1`,
      [opts.excludeInstanceIdPattern],
    );
    return { ids: result.rows.map((r) => r.id) };
  } finally {
    await pool.end();
  }
}

/**
 * Clear revoked_at on a set of peer_credentials ids. Used by revokeAll
 * e2e to restore real cluster credentials after the destructive test.
 */
export async function clearPeerCredentialsRevokedAtByIdsDirect(
  databaseUrl: string,
  opts: { ids: readonly string[] },
): Promise<{ updated: number }> {
  if (opts.ids.length === 0) return { updated: 0 };
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query(
      `UPDATE peer_credentials SET revoked_at = NULL WHERE id = ANY($1::uuid[])`,
      [opts.ids as readonly string[]],
    );
    return { updated: result.rowCount ?? 0 };
  } finally {
    await pool.end();
  }
}

/**
 * READ-ONLY: count currently-active (non-revoked, non-expired)
 * peer_credentials rows for a given instance_id. Used by the
 * concurrent-save e2e to assert 1 <= count <= 2.
 */
export async function countActivePeerCredentialsByInstanceDirect(
  databaseUrl: string,
  opts: { instanceId: string },
): Promise<number> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query<{ cnt: number }>(
      `SELECT count(*)::int AS cnt FROM peer_credentials
        WHERE instance_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [opts.instanceId],
    );
    return result.rows[0]?.cnt ?? 0;
  } finally {
    await pool.end();
  }
}

/**
 * Terminate every idle backend of the connecting user except our own
 * connection. Mirrors what a Postgres leader demotion does to idle pooled
 * connections — used by resilience tests to verify the pg pool error
 * handlers absorb the termination without a process restart.
 *
 * Returns the number of backends terminated.
 */
export async function terminateIdleDbBackendsDirect(databaseUrl: string): Promise<number> {
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE pid <> pg_backend_pid()
         AND usename = current_user
         AND state = 'idle'`,
    );
    return result.rowCount ?? 0;
  } finally {
    await pool.end();
  }
}
