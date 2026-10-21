import { createHash } from 'node:crypto';
import pg from 'pg';
import type { MigrationProvider } from 'kysely/migration';
import { createPool } from './db.js';
import { depCacheKeyOf } from './dep-cache-key.js';

/**
 * DB-operation helpers shared by `kici-admin` (orchestrator DB) and
 * `kici-platform-admin` (Platform DB); each CLI adds its own migration provider
 * and audit log. Callers pass a full database URL: this module reads no
 * environment variables.
 */

export const MIGRATION_HASH_TABLE = '_migration_content_hash';

interface ParsedDatabaseUrl {
  adminUrl: string;
  dbName: string;
  dbOwner: string;
}

/**
 * `adminUrl` points at the `postgres` maintenance DB, so callers can
 * `CREATE` / `DROP DATABASE` on `dbName`. `dbOwner` is the URL's username and
 * owns a database this module creates.
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

/** Redacts the password for safe logging. */
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
 * Drop `dbName` (if it exists), then recreate it owned by `owner`. `WITH (FORCE)`
 * terminates the database's connections inside the DROP itself, so a client that
 * reconnects at once (a starting Platform or orchestrator) cannot slip in between a
 * separate terminate and the DROP.
 */
export async function dropAndCreateDatabase(databaseUrl: string): Promise<void> {
  const { adminUrl, dbName, dbOwner } = parseDatabaseUrl(databaseUrl);
  assertValidIdentifier(dbName, 'database name');
  assertValidIdentifier(dbOwner, 'database owner');
  await withAdminPool(adminUrl, async (pool) => {
    await pool.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await pool.query(`CREATE DATABASE "${dbName}" OWNER "${dbOwner}"`);
  });
}

export interface EnsureDatabaseOpts {
  /**
   * Defaults to the URL's username. Pass it when the admin user is privileged
   * (e.g. Patroni superuser) but a separate non-privileged role must own the
   * database, as for Keycloak's database on the Platform Patroni cluster.
   */
  owner?: string;
  /**
   * After creating (or finding) the database, run
   * `REVOKE CONNECT ON DATABASE "<name>" FROM PUBLIC`. Use it on shared
   * clusters: the default `PUBLIC` CONNECT grant lets any role with LOGIN on
   * the cluster reach the new database. Idempotent.
   */
  revokeConnectFromPublic?: boolean;
  /**
   * After the optional revoke, `GRANT CONNECT ON DATABASE "<name>" TO "<role>"`
   * for each role, re-granting the roles that need CONNECT once `PUBLIC`
   * loses it. Idempotent. Each name is validated as a SQL identifier before
   * interpolation.
   */
  grantConnectToRoles?: string[];
}

/** CREATE DATABASE IF NOT EXISTS (idempotent); `opts` sets the owner and CONNECT grants. */
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

/** CREATE ROLE ... LOGIN [CREATEDB]; an existing role gets the new password. */
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
 * Create a read-only role with SELECT on every public-schema table, including
 * tables created later. `databaseUrl` must connect as the DB owner or a
 * superuser, which ALTER DEFAULT PRIVILEGES needs.
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

/** An identifier followed by the bundler's `$<n>` rename suffix. */
const BUNDLER_RENAME_SUFFIX = /\b([A-Za-z_][A-Za-z0-9_]*)\$\d+\b/g;

function bundleStableSource(fn: (...args: never[]) => unknown): string {
  return fn.toString().replace(BUNDLER_RENAME_SUFFIX, '$1');
}

/**
 * Hash every migration's name and `up`/`down` source (`Function.toString()`),
 * so rewriting a migration body changes the hash even under the same filename.
 *
 * The bundler suffixes clashing identifiers with `$<n>`, numbered by the rest
 * of the bundle, so the CLI and server bundles differ in source text. The
 * suffixes are removed before hashing: a database the orchestrator migrated
 * reads current to `db check-schema`, and the reverse.
 */
export async function computeMigrationsHash(provider: MigrationProvider): Promise<string> {
  const migrations = await provider.getMigrations();
  const names = Object.keys(migrations).sort();
  const hash = createHash('sha256');
  for (const name of names) {
    const migration = migrations[name];
    hash.update(name);
    hash.update('\0');
    hash.update(bundleStableSource(migration.up));
    hash.update('\0');
    if (migration.down) {
      hash.update(bundleStableSource(migration.down));
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Row key for the `computeMigrationsHash` hash. The file-based hash writes the
 * `'kysely_migration'` row of the same table, so the distinct key keeps the two
 * from clobbering each other. Both `db check-schema` commands read this row.
 */
const PROVIDER_HASH_KEY = 'kysely_migration_provider';

/** Create the marker table if missing, then upsert `hash` under `PROVIDER_HASH_KEY`. */
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

/** Returns `null` when the marker table or row is missing. */
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
 * Backs `kici-admin queue clear --database-url`, the fallback when the
 * orchestrator is not reachable over HTTP (e.g. cleanup before it restarts).
 */
export async function clearDispatchQueueDirect(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await pool.query('TRUNCATE dispatch_queue');
  } finally {
    await pool.end();
  }
}

/** Delete runs and jobs whose routing key is NULL or not `routingKey`. */
export async function purgeStaleExecutionDirect(
  databaseUrl: string,
  routingKey: string,
): Promise<PurgeStaleExecutionResult> {
  const pool = createPool(databaseUrl);
  try {
    // concurrency_groups has no FK on run_id, so it is cleaned explicitly: rows
    // of another deployment, and rows whose run is not pending, running or
    // cancelling. After a restart the previous process's agents are gone, and
    // slot release (created_at ASC) would otherwise pick such an orphan first.
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
 * longer points at an existing source. An org's remote source
 * (`remote:<orgId>`, a `remote_sources` row) is a source the purge never
 * touches, so the registrations under it are kept. `dryRun` only counts.
 *
 * Registrations under the wiped generic sources would otherwise survive and
 * join the next run's cross-source dispatch fan-out, cloning long-dead repos.
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
      // The purge keeps only the sources under `routingKey` and the remote
      // sources, and deletes every generic source, so every other registration,
      // except one under a remote source, is left pointing at no source and is
      // deleted.
      // fails-when: the count skips the generic sources' registrations the purge deletes,
      // or counts the registrations under a remote source the purge keeps
      const orphanRegistrations = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM workflow_registrations
          WHERE routing_key != $1
            AND routing_key NOT IN (SELECT routing_key FROM remote_sources)`,
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
    // Delete registrations whose routing key resolves to no row in `sources` or
    // `remote_sources` (the purge never touches the latter).
    // fails-when: a registration under a live remote source (`remote:<orgId>`) is deleted
    // breaks-if-wrong: a registration under no source at all must still be deleted
    const registrations = await pool.query(
      `DELETE FROM workflow_registrations
        WHERE routing_key != $1
          AND routing_key NOT IN (SELECT routing_key FROM sources)
          AND routing_key NOT IN (SELECT routing_key FROM remote_sources)`,
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

/** Delete the scoped secrets of `orgId`, or of every org when it is omitted. */
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
 * Backs `kici-admin context purge`: delete the contexts of `orgId`, or of every
 * org when it is omitted. Bindings, variables and source overrides cascade.
 * `held_runs` and `execution_runs` use ON DELETE SET NULL, so the org's
 * `held_runs` are deleted too, in the same transaction, for a clean slate.
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
// Back `kici-admin context`, so no caller open-codes the
// `ON CONFLICT (org_id, name) DO UPDATE` upsert. Each helper takes a database
// URL and owns a max=1 pool it always ends.

/** Allowlist, so caller input never drives the column names interpolated into the UPDATE. */
const ENV_POLICY_COLUMNS = new Set<string>([
  'branch_restrictions',
  'repo_patterns',
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
  /**
   * `owner/repo` glob patterns the context is limited to. Omitted leaves an
   * existing row's patterns unchanged and writes `[]` on insert.
   */
  repoPatterns?: string[];
  requiredReviewers?: unknown;
  waitTimerSeconds?: number | null;
  holdExpirySeconds?: number | null;
  minimumTrust?: string | null;
  globPattern?: string | null;
}

/** Policy fields an upsert writes only when the caller supplied them. */
interface UpsertPolicyFields {
  enabled?: boolean;
  branchRestrictions?: unknown;
  repoPatterns?: string[];
  requiredReviewers?: unknown;
  waitTimerSeconds?: number | null;
  holdExpirySeconds?: number | null;
  minimumTrust?: string | null;
}

const UPSERT_POLICY_COLUMNS: ReadonlyArray<[keyof UpsertPolicyFields, string]> = [
  ['enabled', 'enabled'],
  ['branchRestrictions', 'branch_restrictions'],
  ['repoPatterns', 'repo_patterns'],
  ['requiredReviewers', 'required_reviewers'],
  ['waitTimerSeconds', 'wait_timer_seconds'],
  ['holdExpirySeconds', 'hold_expiry_seconds'],
  ['minimumTrust', 'minimum_trust'],
];

/**
 * `ON CONFLICT` assignments for the policy fields the caller supplied. An
 * omitted field (`undefined`) keeps the stored value, matching the admin HTTP
 * upsert; a supplied one — including `[]` or `null` — replaces it, so an
 * explicit empty value still clears the rule.
 */
function suppliedPolicyAssignments(opts: UpsertPolicyFields): string[] {
  // fails-when: an omitted field is assigned from EXCLUDED, so a re-run without its flag clears it
  // breaks-if-wrong: a supplied [] / null must still be assigned, or a rule cannot be cleared
  return UPSERT_POLICY_COLUMNS.filter(([field]) => opts[field] !== undefined).map(
    ([, column]) => `${column} = EXCLUDED.${column},`,
  );
}

export interface SeedContextResult {
  envId: string;
  created: boolean;
}

/**
 * Upsert a context by (org_id, name). Pass `branchRestrictions` /
 * `requiredReviewers` as plain values; they are JSON-serialised here. On
 * conflict only the supplied policy fields change.
 *
 * An omitted `holdExpirySeconds` is written as NULL: the column has no DDL
 * default, so "never set" and "cleared" both resolve through the one
 * `DEFAULT_HOLD_EXPIRY_SECONDS` read fallback. A literal here would be a
 * second, longer default no reader knows about.
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
           wait_timer_seconds, hold_expiry_seconds, minimum_trust, glob_pattern, repo_patterns)
        VALUES ($1, $2, COALESCE($3, 'fixed'), COALESCE($4, true), $5::jsonb, $6::jsonb,
                $7, $8, $9, $10, $11::jsonb)
        ON CONFLICT (org_id, name) DO UPDATE SET
          type = COALESCE(EXCLUDED.type, contexts.type),
          ${suppliedPolicyAssignments(opts).join('\n          ')}
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
        JSON.stringify(opts.repoPatterns ?? []),
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
 * Delete a context by (org_id, name). Bindings, variables and source overrides
 * cascade; terminal held runs survive with a null context (ON DELETE SET NULL).
 * Throws while the context has pending held runs: approve or reject them first.
 */
export async function deleteContextDirect(
  databaseUrl: string,
  opts: DeleteContextOpts,
): Promise<{ deleted: boolean }> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    // 'pending' mirrors HeldRunStatus.Pending (orchestrator contexts/held-runs.ts),
    // which @kici-dev/shared cannot import (dependency direction).
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

/** Bind `contextName` to `scopePattern` (idempotent). Throws if the context is missing. */
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
  /** `owner/repo` glob patterns; `[]` clears the rule. */
  repoPatterns?: string[];
  requiredReviewers?: unknown;
  waitTimerSeconds?: number | null;
  holdExpirySeconds?: number | null;
  minimumTrust?: string | null;
  enabled?: boolean;
  allowLocalExecution?: boolean;
}

/** Update only the policy fields present in `opts`. Throws if the context is missing. */
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
  if (opts.repoPatterns !== undefined) {
    addSet('repo_patterns', JSON.stringify(opts.repoPatterns), 'jsonb');
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
  repo_patterns: unknown;
  required_reviewers: unknown;
  wait_timer_seconds: number | null;
  hold_expiry_seconds: number | null;
  minimum_trust: string | null;
  created_at: string;
  updated_at: string;
}

/** An org's contexts, ordered by name. */
export async function listContextsDirect(
  databaseUrl: string,
  opts: { orgId: string },
): Promise<{ contexts: ContextRow[] }> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await pool.query<ContextRow>(
      `SELECT id, org_id, name, type, enabled, branch_restrictions, repo_patterns,
              required_reviewers, wait_timer_seconds, hold_expiry_seconds, minimum_trust,
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

/** A context with its variables and bindings. Throws if the context is missing. */
export async function showContextDirect(
  databaseUrl: string,
  opts: { orgId: string; name: string },
): Promise<ShowContextResult> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const envResult = await pool.query<ContextRow>(
      `SELECT id, org_id, name, type, enabled, branch_restrictions, repo_patterns,
              required_reviewers, wait_timer_seconds, hold_expiry_seconds, minimum_trust,
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
 * Omits `enabled` and `repo_patterns`: the template INSERT sets neither, so
 * their `EXCLUDED` values are insert defaults that would reset an existing
 * template whenever a caller's object carried the field.
 */
function templatePolicyFields(opts: CreateContextTemplateOpts): UpsertPolicyFields {
  return {
    branchRestrictions: opts.branchRestrictions,
    requiredReviewers: opts.requiredReviewers,
    waitTimerSeconds: opts.waitTimerSeconds,
    holdExpirySeconds: opts.holdExpirySeconds,
    minimumTrust: opts.minimumTrust,
  };
}

/**
 * Upsert a context template (a context with `type='template'` by convention)
 * and its seed variables in one transaction. `holdExpirySeconds` and conflict
 * handling behave as in `seedContextDirect`.
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
          ${suppliedPolicyAssignments(templatePolicyFields(opts)).join('\n          ')}
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

/** Upsert a context-scoped secret, written verbatim: the caller encrypts it. */
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

// ── queue + execution read ops ─────────────────────────────────────────

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
  /** E.g. the terminal statuses, to find non-terminal rows. */
  statusNotIn?: readonly string[];
  jobNamePrefix?: string;
  /** Exact match (e.g. `__build__e2e-test`). */
  jobName?: string;
  /** A LIKE pattern (e.g. `__build__%` excludes build jobs). */
  jobNameNotLike?: string;
  workflowName?: string;
  /** Exclusive lower bound on created_at. */
  createdAfter?: string | Date;
  limit?: number;
}

/**
 * Read-only, newest first; the limit defaults to 100 and is clamped to 1–1000.
 * Rows carry the cache metadata columns, so no second round-trip is needed.
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

/** Read-only. Throws when no row matches. */
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

/** Read-only, newest first; the limit defaults to 100 and is clamped to 1–1000. */
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
 * The orchestrator's record of a check run it posted. Not named
 * `CheckRunTrackingRow`: the orchestrator's `db/types.ts` exports that name with
 * a `number` `check_run_id`, and two same-named types with different field
 * types in one package invite silent comparison bugs.
 */
export interface CheckRunTrackingDirectRow {
  provider: string;
  owner: string;
  repo: string;
  sha: string;
  check_name: string;
  /**
   * Written once, when the check run is created (still `queued`); the terminal
   * PATCH writes nothing here. Non-null proves creation, not a conclusion. Null
   * does not prove a failed create: the write is best-effort (cache-only on a
   * DB error), so the check run can exist with no id recorded.
   *
   * Selected as `::text` (the column is BIGINT) so a future global int8 type
   * parser cannot silently change this field's type.
   */
  check_run_id: string | null;
  /**
   * `'pending'` before the create call, `'completed'` once it returns an id.
   * Nothing resets it on failure, so a row stuck on `'pending'` is in flight or
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
   * When the provider accepted the terminal `completed` update: the "did we
   * complete it?" column. Best-effort, so null means "no record of sending it",
   * not "never sent".
   */
  terminal_sent_at: Date | null;
}

export interface ListCheckRunTrackingOpts {
  sha: string;
  checkName?: string;
  limit?: number;
}

/**
 * Read-only: a commit's rows, one per `(provider, owner, repo, sha, check_name)`,
 * ordered by check_name. `check_run_id` answers "did we create it?",
 * `terminal_sent_at` "did we complete it?"; a null is "no record", never proof
 * of failure (see `CheckRunTrackingDirectRow`).
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

/** Read-only: a run and its jobs (empty for a pending run). Throws if no run matches. */
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

// ── workflow_registrations read ops ────────────────────────────────────────

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
  /** Matches rows whose trigger_types contains it. */
  triggerType?: string;
  limit?: number;
}

export interface ListRegistrationsResult {
  registrations: WorkflowRegistrationRow[];
  /** Latest `registry_versions.version`, or null if the table has no row. */
  registryVersion: number | null;
}

/**
 * Read-only, newest-updated first. Also returns the latest registry version,
 * so callers can assert a registry bump without a second round trip.
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
 * Read-only: one registration plus the latest registry version (bumped on every
 * registration insert or delete). Throws if the id is unknown.
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

// ── workflow register-manual ───────────────────────────────────────────────

/**
 * A trigger of one of these types, or one that pins `repos: [...]`, yields a
 * registration on default-branch push extraction. Kept in sync with
 * packages/orchestrator/src/registration/extractor.ts, duplicated so this
 * helper has no runtime dependency on the engine package.
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
  /** Package-manager lockfile hash; part of the dependency-cache key. */
  lockfileHash?: unknown;
  /** In-repo `workspace:` sibling digest; part of the dependency-cache key. */
  siblingsDigest?: unknown;
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
  /**
   * One line per registered workflow whose lock declares a compile schema the
   * orchestrator release's agents do not implement. The admin API sets it; the
   * direct-DB path leaves it to the caller.
   */
  warnings?: string[];
}

/**
 * The offline counterpart of the orchestrator's `RegistrationStore.replaceAll()`:
 * upsert one row per registerable workflow, keyed by
 * (routing_key, repo_identifier, workflow_name), and bump `registry_versions`
 * in the same transaction so watching orchestrators refresh their index.
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

  // Written on every row with its lock entry, so a row never keeps another lock
  // file's dependency-cache key. The orchestrator uses the key only while
  // `dep_cache_key_sha` still equals the row's commit.
  const { lockfileHash, siblingsDigest } = depCacheKeyOf(lockFile);
  const depCacheKeySha = opts.commitSha ?? null;

  const pool = createPool(databaseUrl);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const workflow of registerable) {
      const triggerTypes = [...new Set(workflow.triggers.map((t: { _type: string }) => t._type))];
      await client.query(
        `INSERT INTO workflow_registrations (
          repo_identifier, workflow_name, lock_entry, trigger_types,
          routing_key, provider_context, customer_id, commit_sha, source_file,
          lockfile_hash, siblings_digest, dep_cache_key_sha
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (routing_key, repo_identifier, workflow_name) DO UPDATE SET
          lock_entry = EXCLUDED.lock_entry,
          trigger_types = EXCLUDED.trigger_types,
          provider_context = EXCLUDED.provider_context,
          customer_id = EXCLUDED.customer_id,
          commit_sha = EXCLUDED.commit_sha,
          source_file = EXCLUDED.source_file,
          lockfile_hash = EXCLUDED.lockfile_hash,
          siblings_digest = EXCLUDED.siblings_digest,
          dep_cache_key_sha = EXCLUDED.dep_cache_key_sha,
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
          lockfileHash,
          siblingsDigest,
          depCacheKeySha,
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
      // The original error wins.
    });
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * Clear `raft_state` so a freshly started orchestrator self-elects with a clean
 * term. Used after a warm-mode process swap: otherwise the new process loads a
 * high term and spends 60+ seconds in failed election rounds. Idempotent.
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
 * Emit an event as a step's `ctx.emit()` would, with no running step: insert
 * it into `kici_events` and `pg_notify('kici_event_channel', <id>)` so the
 * orchestrator EventRouter picks it up at once. The event always gets
 * `chain_depth=0` and `expires_at=NOW() + 1h`.
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

export const SchemaStatusKind = {
  Current: 'current',
  Missing: 'missing',
  Pending: 'pending',
  UnknownApplied: 'unknown-applied',
  HashMissing: 'hash-missing',
  HashMismatch: 'hash-mismatch',
} as const;
export type SchemaStatusKind = (typeof SchemaStatusKind)[keyof typeof SchemaStatusKind];

export interface SchemaStatus {
  current: boolean;
  kind: SchemaStatusKind;
  reason?: string;
  /** Migrations the provider carries that the database has not applied. */
  pending?: string[];
}

/** PostgreSQL's `undefined_table` SQLSTATE. */
const UNDEFINED_TABLE = '42P01';

/**
 * Compare the applied ledger and the stored content hash against `provider`.
 *
 * `kind` is the structured verdict callers branch on. A count difference keeps
 * the `migration count mismatch (applied=N, expected=M)` reason: deploy-prod's
 * rollback preflight parses it from every image, old ones included. A
 * connection failure throws instead of reporting a missing table.
 *
 * Callers use this as a warm-start freshness gate.
 */
export async function isSchemaCurrent(
  pool: pg.Pool,
  provider: MigrationProvider,
): Promise<SchemaStatus> {
  const expected = Object.keys(await provider.getMigrations()).sort();

  let applied: string[];
  try {
    const result = await pool.query<{ name: string }>(
      'SELECT name FROM "kysely_migration" ORDER BY name',
    );
    applied = result.rows.map((r) => r.name);
  } catch (err) {
    if ((err as { code?: string }).code !== UNDEFINED_TABLE) throw err;
    return {
      current: false,
      kind: SchemaStatusKind.Missing,
      reason: 'kysely_migration table missing',
    };
  }

  const expectedSet = new Set(expected);
  const appliedSet = new Set(applied);
  const unknown = applied.filter((n) => !expectedSet.has(n));
  const pending = expected.filter((n) => !appliedSet.has(n));
  const countReason = `migration count mismatch (applied=${applied.length}, expected=${expected.length})`;
  if (unknown.length > 0) {
    return {
      current: false,
      kind: SchemaStatusKind.UnknownApplied,
      reason:
        applied.length !== expected.length
          ? countReason
          : `migration names mismatch (unknown applied: ${unknown.join(', ')})`,
    };
  }
  if (pending.length > 0) {
    return { current: false, kind: SchemaStatusKind.Pending, reason: countReason, pending };
  }

  const storedHash = await readStoredMigrationContentHash(pool);
  if (storedHash === null) {
    return { current: false, kind: SchemaStatusKind.HashMissing, reason: 'content hash missing' };
  }
  if (storedHash !== (await computeMigrationsHash(provider))) {
    return { current: false, kind: SchemaStatusKind.HashMismatch, reason: 'content hash mismatch' };
  }
  return { current: true, kind: SchemaStatusKind.Current };
}

// ── Orchestrator DB direct helpers ──────────────────────────────────

/**
 * Purge backends whose encrypted config no longer decrypts (e.g. after
 * KICI_SECRET_KEY rotated over a kept database). The default `pg` backend
 * carries the `config_encrypted = ''` sentinel, which loadAllStores() never
 * decrypts, so it is kept: everything relies on it being registered.
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

/** Delete the peer credentials whose instance_id is NOT LIKE `keepInstanceIdPattern`. */
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

/** An `org_settings` repo-pattern entry; without `routingKey` it applies to every source in the org. */
export interface OrgSettingsRepoPatternEntry {
  routingKey?: string;
  pattern: string;
}

/** An orchestrator `event_log` row, keyed by `delivery_id`. */
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
