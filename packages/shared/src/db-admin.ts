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

/**
 * Bulk-delete `contexts` (and their FK-dependent rows) for an org, or for
 * every org when `orgId` is omitted. `context_bindings` /
 * `context_variables` / `context_source_overrides` cascade
 * automatically (ON DELETE CASCADE). `held_runs` and `execution_runs` reference
 * `contexts(id)` with ON DELETE SET NULL, so deleting contexts alone
 * would leave orphaned `held_runs` rows carrying a null context reference;
 * this helper deletes the org's `held_runs` too so a warm-start reset gets a
 * clean slate. Runs in a transaction so both deletes commit atomically. Used by
 * the E2E warm-start reset (so seeded contexts don't leak between
 * categories) and exposed via `kici-admin context purge`.
 */
export async function purgeContextsDirect(
  databaseUrl: string,
  orgId?: string,
): Promise<{ contextsDeleted: number; heldRunsDeleted: number }> {
  const pool = createPool(databaseUrl);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const where = orgId ? 'WHERE org_id = $1' : '';
    const params = orgId ? [orgId] : [];
    const held = await client.query(`DELETE FROM held_runs ${where}`, params);
    const envs = await client.query(`DELETE FROM contexts ${where}`, params);
    await client.query('COMMIT');
    return {
      contextsDeleted: envs.rowCount ?? 0,
      heldRunsDeleted: held.rowCount ?? 0,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

// ── context ops ────────────────────────────────────────────────────
//
// Direct-DB helpers backing `kici-admin context` (Stage 5a #1). These
// abstract the `ON CONFLICT (org_id, name) DO UPDATE` upsert pattern that
// the e2e setup helpers previously open-coded against `new pg.Pool`. Every
// helper owns its own pool (max=1) and awaits `pool.end()` in finally —
// callers pass a database URL, not a pool.

/**
 * Allowed policy field names for `setContextPolicyDirect`. Kept as an
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

export interface SeedContextOpts {
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

export interface SeedContextResult {
  envId: string;
  created: boolean;
}

/**
 * Upsert a context row keyed by (org_id, name). Returns the env id and
 * whether the row was newly inserted. `branchRestrictions` / `requiredReviewers`
 * are JSON-serialised server-side; pass them as plain arrays or objects.
 *
 * An omitted `holdExpirySeconds` is written as NULL rather than a literal
 * window: the column carries no DDL default, so "never set" and "cleared" both
 * land on NULL and resolve through the one `DEFAULT_HOLD_EXPIRY_SECONDS`
 * fallback on read. Writing a literal here would give this path a second,
 * longer default that no read-side code knows about.
 */
export async function seedContextDirect(
  databaseUrl: string,
  opts: SeedContextOpts,
): Promise<SeedContextResult> {
  if (opts.waitTimerSeconds != null && opts.waitTimerSeconds < 0) {
    throw new Error(`context: waitTimerSeconds must be >= 0 (got ${opts.waitTimerSeconds})`);
  }
  if (opts.holdExpirySeconds != null && opts.holdExpirySeconds < 1) {
    throw new Error(`context: holdExpirySeconds must be >= 1 (got ${opts.holdExpirySeconds})`);
  }
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const branchJson = JSON.stringify(opts.branchRestrictions ?? []);
    const reviewersJson =
      opts.requiredReviewers === undefined ? null : JSON.stringify(opts.requiredReviewers);
    const result = await pool.query<{ id: string; inserted: boolean }>(
      `INSERT INTO contexts
          (org_id, name, type, enabled, branch_restrictions, required_reviewers,
           wait_timer_seconds, hold_expiry_seconds, minimum_trust, glob_pattern)
        VALUES ($1, $2, COALESCE($3, 'fixed'), COALESCE($4, true), $5::jsonb, $6::jsonb,
                $7, $8, $9, $10)
        ON CONFLICT (org_id, name) DO UPDATE SET
          type = COALESCE(EXCLUDED.type, contexts.type),
          enabled = EXCLUDED.enabled,
          branch_restrictions = EXCLUDED.branch_restrictions,
          required_reviewers = EXCLUDED.required_reviewers,
          wait_timer_seconds = EXCLUDED.wait_timer_seconds,
          hold_expiry_seconds = EXCLUDED.hold_expiry_seconds,
          minimum_trust = EXCLUDED.minimum_trust,
          glob_pattern = COALESCE(EXCLUDED.glob_pattern, contexts.glob_pattern),
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
    if (!row) throw new Error(`context: upsert returned no row for ${opts.name}`);
    return { envId: row.id, created: row.inserted };
  } finally {
    await pool.end();
  }
}

export interface DeleteContextOpts {
  orgId: string;
  name: string;
}

/**
 * Delete a context keyed by (org_id, name). Returns whether a row was
 * removed. The `context_bindings`, `context_variables`, and
 * `context_source_overrides` children all carry
 * `FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE`,
 * so a single DELETE on `contexts` cascades to those children. The
 * `held_runs` FK uses `ON DELETE SET NULL`, so terminal held-run history
 * survives the delete with a null context reference. Pending held runs
 * still reference the context, so this helper pre-checks their count and
 * throws before issuing the DELETE — approve or reject them first.
 */
export async function deleteContextDirect(
  databaseUrl: string,
  opts: DeleteContextOpts,
): Promise<{ deleted: boolean }> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    // The `'pending'` literal mirrors HeldRunStatus.Pending
    // (orchestrator contexts/held-runs.ts) — the source of truth for the
    // value. @kici-dev/shared cannot import the orchestrator enum (dependency
    // direction), so the string is embedded here like other status literals in
    // this module.
    const pending = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM held_runs hr
         JOIN contexts e ON e.id = hr.context_id
        WHERE e.org_id = $1 AND e.name = $2 AND hr.status = 'pending'`,
      [opts.orgId, opts.name],
    );
    const pendingCount = Number(pending.rows[0]?.count ?? 0);
    if (pendingCount > 0) {
      throw new Error(
        `context has ${pendingCount} pending held run(s) — approve or reject them first`,
      );
    }
    const result = await pool.query<{ id: string }>(
      `DELETE FROM contexts WHERE org_id = $1 AND name = $2 RETURNING id`,
      [opts.orgId, opts.name],
    );
    return { deleted: result.rows.length > 0 };
  } finally {
    await pool.end();
  }
}

export interface SeedContextBindingOpts {
  orgId: string;
  contextName: string;
  scopePattern: string;
  /** Host selector; defaults to `'**'` (all hosts). */
  hostPattern?: string;
}

/**
 * Upsert an `context_bindings` row connecting `contextName` to `scopePattern`
 * (scoped to `hostPattern`, default `'**'`). Throws if the context does
 * not exist.
 */
export async function seedContextBindingDirect(
  databaseUrl: string,
  opts: SeedContextBindingOpts,
): Promise<{ created: boolean }> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const envRow = await pool.query<{ id: string }>(
      `SELECT id FROM contexts WHERE org_id = $1 AND name = $2`,
      [opts.orgId, opts.contextName],
    );
    if (envRow.rows.length === 0) {
      throw new Error(`context: not found (org=${opts.orgId}, name=${opts.contextName})`);
    }
    const envId = envRow.rows[0].id;
    const result = await pool.query<{ inserted: boolean }>(
      `INSERT INTO context_bindings (org_id, context_id, scope_pattern, host_pattern)
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

export interface SetContextPolicyOpts {
  orgId: string;
  contextName: string;
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
 * were NOT in `opts` are left untouched. Throws if the context is missing.
 */
export async function setContextPolicyDirect(
  databaseUrl: string,
  opts: SetContextPolicyOpts,
): Promise<void> {
  if (opts.waitTimerSeconds != null && opts.waitTimerSeconds < 0) {
    throw new Error(`context: waitTimerSeconds must be >= 0 (got ${opts.waitTimerSeconds})`);
  }
  if (opts.holdExpirySeconds != null && opts.holdExpirySeconds < 1) {
    throw new Error(`context: holdExpirySeconds must be >= 1 (got ${opts.holdExpirySeconds})`);
  }

  const setClauses: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  const addSet = (column: string, value: unknown, cast?: string): void => {
    if (!ENV_POLICY_COLUMNS.has(column)) {
      throw new Error(`context: unknown policy column ${column}`);
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
    throw new Error('context: setContextPolicy requires at least one policy field');
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    params.push(opts.orgId, opts.contextName);
    const orgParam = `$${idx}`;
    const nameParam = `$${idx + 1}`;
    const sql = `UPDATE contexts
                    SET ${setClauses.join(', ')}, updated_at = now()
                    WHERE org_id = ${orgParam} AND name = ${nameParam}`;
    const result = await pool.query(sql, params);
    if ((result.rowCount ?? 0) === 0) {
      throw new Error(`context: not found (org=${opts.orgId}, name=${opts.contextName})`);
    }
  } finally {
    await pool.end();
  }
}

export interface ContextRow {
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
 * SELECT * FROM contexts WHERE org_id = $1, ordered by name.
 */
export async function listContextsDirect(
  databaseUrl: string,
  opts: { orgId: string },
): Promise<{ contexts: ContextRow[] }> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await pool.query<ContextRow>(
      `SELECT id, org_id, name, type, enabled, branch_restrictions, required_reviewers,
              wait_timer_seconds, hold_expiry_seconds, minimum_trust,
              created_at, updated_at
         FROM contexts
        WHERE org_id = $1
        ORDER BY name`,
      [opts.orgId],
    );
    return { contexts: result.rows };
  } finally {
    await pool.end();
  }
}

export interface ContextVariableRow {
  key: string;
  value: string;
  locked: boolean;
  updated_at: string;
}

export interface ContextBindingRow {
  scope_pattern: string;
  host_pattern: string;
  created_at: string;
}

export interface ShowContextResult {
  context: ContextRow;
  variables: ContextVariableRow[];
  bindings: ContextBindingRow[];
}

/**
 * Fetch a single context row joined with its variables and bindings.
 * Throws if the context does not exist.
 */
export async function showContextDirect(
  databaseUrl: string,
  opts: { orgId: string; name: string },
): Promise<ShowContextResult> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const envResult = await pool.query<ContextRow>(
      `SELECT id, org_id, name, type, enabled, branch_restrictions, required_reviewers,
              wait_timer_seconds, hold_expiry_seconds, minimum_trust,
              created_at, updated_at
         FROM contexts
        WHERE org_id = $1 AND name = $2`,
      [opts.orgId, opts.name],
    );
    if (envResult.rows.length === 0) {
      throw new Error(`context: not found (org=${opts.orgId}, name=${opts.name})`);
    }
    const env = envResult.rows[0];
    const variables = await pool.query<ContextVariableRow>(
      `SELECT key, value, locked, updated_at
         FROM context_variables
        WHERE context_id = $1
        ORDER BY key`,
      [env.id],
    );
    const bindings = await pool.query<ContextBindingRow>(
      `SELECT scope_pattern, host_pattern, created_at
         FROM context_bindings
        WHERE context_id = $1
        ORDER BY scope_pattern, host_pattern`,
      [env.id],
    );
    return {
      context: env,
      variables: variables.rows,
      bindings: bindings.rows,
    };
  } finally {
    await pool.end();
  }
}

export interface CreateContextTemplateOpts {
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
 * Create (or update) a context template + its seed variables in one
 * transaction. Templates are represented as contexts with `type='template'`
 * by convention. Returns `{ envId, variablesSet }`.
 *
 * An omitted `holdExpirySeconds` is written as NULL rather than a literal
 * window, for the same reason as `seedContextDirect`: the column has no DDL
 * default and every read resolves NULL through `DEFAULT_HOLD_EXPIRY_SECONDS`.
 */
export async function createContextTemplateDirect(
  databaseUrl: string,
  opts: CreateContextTemplateOpts,
): Promise<{ envId: string; created: boolean; variablesSet: number }> {
  if (opts.holdExpirySeconds != null && opts.holdExpirySeconds < 1) {
    throw new Error(`context: holdExpirySeconds must be >= 1 (got ${opts.holdExpirySeconds})`);
  }
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const envResult = await client.query<{ id: string; inserted: boolean }>(
      `INSERT INTO contexts
          (org_id, name, type, enabled, branch_restrictions, required_reviewers,
           wait_timer_seconds, hold_expiry_seconds, minimum_trust)
        VALUES ($1, $2, COALESCE($3, 'template'), true, $4::jsonb, $5::jsonb, $6, $7, $8)
        ON CONFLICT (org_id, name) DO UPDATE SET
          type = COALESCE(EXCLUDED.type, contexts.type),
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
    if (!row) throw new Error(`context: template upsert returned no row`);
    let variablesSet = 0;
    if (opts.variables) {
      for (const [key, value] of Object.entries(opts.variables)) {
        await client.query(
          `INSERT INTO context_variables (org_id, context_id, key, value, locked)
             VALUES ($1, $2, $3, $4, false)
             ON CONFLICT (org_id, context_id, key) DO UPDATE SET
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

export interface SetContextSecretOpts {
  orgId: string;
  context: string;
  key: string;
  encryptedValue: string;
}

/**
 * UPSERT a scoped_secrets row keyed by (org_id, scope=context, key).
 * Writes the value verbatim — the caller is responsible for encryption
 * (matches the stage-4 deferral noted in the plan).
 */
export async function setContextSecretDirect(
  databaseUrl: string,
  opts: SetContextSecretOpts,
): Promise<{ inserted: boolean }> {
  if (!opts.orgId) throw new Error('context: orgId required');
  if (!opts.context) throw new Error('context: context name required');
  if (!opts.key) throw new Error('context: key required');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await pool.query<{ inserted: boolean }>(
      `INSERT INTO scoped_secrets (org_id, scope, key, encrypted_value)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, scope, key) DO UPDATE SET
           encrypted_value = EXCLUDED.encrypted_value,
           updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
      [opts.orgId, opts.context, opts.key, opts.encryptedValue],
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
  context: string | null;
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
  /** Ordered bound deployment-context names (JSON-encoded `string[]`), or null. */
  contexts: string | null;
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
              ref, sha, routing_key, context, trust_tier, created_at,
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
 * One `check_run_tracking` row: the orchestrator's record of a check run it posted.
 *
 * Named `...DirectRow` rather than `CheckRunTrackingRow` because the
 * orchestrator's own `db/types.ts` already exports that name for the Kysely
 * `Selectable`, whose `check_run_id` is a `number`. Two same-named types with
 * different field types, both in scope inside the orchestrator package, is a
 * silent-comparison-bug waiting to happen.
 */
export interface CheckRunTrackingDirectRow {
  provider: string;
  owner: string;
  repo: string;
  sha: string;
  check_name: string;
  /**
   * The id the provider returned when the check run was CREATED. It is written
   * once, at create time, when the check run is still `queued` — the later
   * terminal update is a PATCH that writes nothing here. So a non-null value
   * proves creation, NOT that the check run reached a conclusion.
   *
   * Null does not prove the create failed either: the write is best-effort and
   * falls back to cache-only on a DB error, so the check run can exist at the
   * provider with no id recorded here.
   *
   * Selected as `::text` because the column is BIGINT and node-postgres maps
   * int8 to a string to avoid precision loss. The cast makes that explicit in
   * the query rather than depending on driver defaults, so adding a global
   * int8 type parser later cannot silently change this field's type.
   */
  check_run_id: string | null;
  /**
   * `'pending'` is stamped BEFORE the create call and `'completed'` after it
   * returns an id. Nothing resets it when a create fails, so a row stuck on
   * `'pending'` means the create never returned — still in flight or
   * permanently failed, which this column alone cannot distinguish.
   */
  build_creation_state: string | null;
  run_id: string | null;
  /**
   * Written only for per-job check names (`kici/<workflow>/job/<job>`). The
   * workflow-level `kici/<workflow>` row always has null here.
   */
  in_progress_sent_at: Date | null;
  /**
   * When the terminal (`completed`) update was accepted by the provider. This
   * is the column that answers "did we complete it?" — `check_run_id` only
   * answers "did we create it?".
   *
   * Best-effort like every write on this table, so null means "we have no
   * record of sending it", not "it was never sent".
   */
  terminal_sent_at: Date | null;
}

export interface ListCheckRunTrackingOpts {
  sha: string;
  checkName?: string;
  limit?: number;
}

/**
 * READ-ONLY: SELECT check_run_tracking rows for a commit. One row per
 * `(provider, owner, repo, sha, check_name)`, ordered by check_name.
 *
 * Each column answers a different question. `check_run_id` is written once,
 * when the check run is created in the `queued` state, so it answers "did we
 * create it?". `terminal_sent_at` is stamped only after the provider accepts
 * the terminal `completed` PATCH, so it answers "did we complete it?". Every
 * write here is best-effort, so a null column is "no record", never proof of
 * failure — see the per-field notes for what each one does and does not prove.
 */
export async function listCheckRunTrackingDirect(
  databaseUrl: string,
  opts: ListCheckRunTrackingOpts,
): Promise<{ rows: CheckRunTrackingDirectRow[] }> {
  const pool = createPool(databaseUrl);
  try {
    const clauses: string[] = ['sha = $1'];
    const params: unknown[] = [opts.sha];
    if (opts.checkName !== undefined) {
      clauses.push(`check_name = $2`);
      params.push(opts.checkName);
    }
    const limit = Math.max(1, Math.min(1000, opts.limit ?? 50));
    const result = await pool.query<CheckRunTrackingDirectRow>(
      `SELECT provider, owner, repo, sha, check_name,
              check_run_id::text AS check_run_id,
              build_creation_state, run_id, in_progress_sent_at, terminal_sent_at
         FROM check_run_tracking
        WHERE ${clauses.join(' AND ')}
        ORDER BY check_name
        LIMIT ${limit}`,
      params,
    );
    return { rows: result.rows };
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
              ref, sha, routing_key, context, trust_tier, created_at,
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
              started_at, completed_at, duration_ms, created_at, error_message, contexts
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
