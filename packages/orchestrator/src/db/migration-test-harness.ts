/**
 * Test harness for the per-migration real-Postgres suites.
 *
 * A test named `NNN_thing.test.ts` documents the schema that migration `NNN`
 * produces, so it must apply the migration set only as far as `NNN`. Applying
 * the whole set instead runs the assertions against the schema at the head of
 * the migration list, where a later migration may already have dropped or
 * reshaped the column under test — the test then fails, or passes for the wrong
 * reason. Those suites only execute when `KICI_TEST_ADMIN_DATABASE_URL` is set,
 * so that rot stays invisible in a normal `pnpm test` run.
 *
 * The harness derives the target from the calling test file's own URL, so a
 * test can neither name the wrong migration nor drift when a file is renamed.
 * It has no fallback to the whole set: an unknown or no-op target throws.
 *
 * Repo/store tests outside `migrations/` (host roster, artifact store, the repo
 * suites) legitimately want head-of-list schema and use `migrateToLatest()`
 * directly instead.
 */
import type { Kysely } from 'kysely';
import { Migrator, type MigrationResultSet } from 'kysely/migration';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMigrationProvider } from './migration-provider.js';

/**
 * Derive `030_held_runs_env_set_null` from a
 * `.../migrations/030_held_runs_env_set_null.test.ts` module URL.
 *
 * Throws when the caller is not a per-migration test, so a copy-paste into an
 * unrelated suite fails loudly instead of silently migrating somewhere odd.
 */
export function migrationNameFromTestUrl(testUrl: string): string {
  const name = basename(fileURLToPath(testUrl)).replace(/\.test\.tsx?$/, '');
  if (!/^\d{3}_/.test(name)) {
    throw new Error(
      `migrateToOwnMigration() is only for per-migration tests named ` +
        `NNN_<migration>.test.ts; called from "${testUrl}". A test that wants ` +
        `head-of-list schema should build its own Migrator and call migrateToLatest().`,
    );
  }
  return name;
}

/**
 * Apply migrations `001..NNN` inclusive, where `NNN` is the migration the
 * calling test file is named after. Pass `import.meta.url` as `testUrl`.
 *
 * Returns Kysely's result set so callers keep their own error handling
 * (`if (error) throw error` / `expect(error).toBeUndefined()`). A target that
 * does not exist surfaces as `error`; a target that applied nothing, or stopped
 * somewhere other than itself, throws — neither can silently degrade into
 * "the whole migration set ran".
 */
export async function migrateToOwnMigration<DB>(
  db: Kysely<DB>,
  testUrl: string,
): Promise<MigrationResultSet> {
  const migrationName = migrationNameFromTestUrl(testUrl);
  const migrator = new Migrator({
    db: db as unknown as Kysely<unknown>,
    provider: createMigrationProvider(),
  });
  const resultSet = await migrator.migrateTo(migrationName);
  if (resultSet.error) return resultSet;

  const results = resultSet.results ?? [];
  if (results.length === 0) {
    throw new Error(
      `migrateTo('${migrationName}') applied no migrations. The test database ` +
        `was expected to be empty, so the target should have applied 001..${migrationName}.`,
    );
  }
  const last = results[results.length - 1];
  if (last?.migrationName !== migrationName || last.direction !== 'Up') {
    throw new Error(
      `migrateTo('${migrationName}') ended on ` +
        `${last?.direction ?? 'unknown'} "${last?.migrationName ?? 'unknown'}" — ` +
        `expected to finish by applying "${migrationName}".`,
    );
  }
  return resultSet;
}
