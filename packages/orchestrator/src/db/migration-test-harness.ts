/**
 * Test harness for the per-migration real-Postgres suites.
 *
 * A test named `NNN_thing.test.ts` documents the schema migration `NNN` produces, so it applies
 * the set only as far as `NNN`: at the head of the list a later migration may have dropped or
 * reshaped the column under test, and the test fails or passes for the wrong reason. These
 * suites run only when `KICI_TEST_ADMIN_DATABASE_URL` is set, so that rot is invisible in a
 * normal `pnpm test`.
 *
 * The target comes from the calling test file's own URL, so a test cannot name the wrong
 * migration or drift on rename. There is no fallback to the whole set: an unknown or no-op
 * target throws. `migrateToPreviousMigration()` gives a DATA migration the state one step
 * earlier, derived from the migration list.
 *
 * Repo/store tests outside `migrations/` want head-of-list schema and use `migrateToLatest()`.
 */
import type { Kysely } from 'kysely';
import { Migrator, type MigrationResultSet } from 'kysely/migration';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMigrationProvider } from './migration-provider.js';

/**
 * Derive `030_held_runs_env_set_null` from a `.../migrations/030_held_runs_env_set_null.test.ts`
 * URL. Throws for a non-per-migration caller, so a copy-paste into another suite fails loudly.
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
 * Apply migrations `001..NNN` inclusive, `NNN` being the calling test file's migration. Pass
 * `import.meta.url` as `testUrl`.
 *
 * Returns Kysely's result set so callers keep their own error handling. A missing target
 * surfaces as `error`; a target that applied nothing, or stopped elsewhere, throws — neither
 * silently degrades into "the whole migration set ran".
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

/**
 * Apply migrations `001..NNN-1`: up to, but NOT including, the calling test file's migration.
 * Pass `import.meta.url`.
 *
 * A DATA migration's test straddles it: migrate here, insert the rows an upgraded database
 * holds, then call {@link migrateToOwnMigration} and assert what moved. Without this window the
 * assertions run against rows the migration never saw, and pass with its body deleted.
 *
 * The target comes from the migration list, so it cannot drift when a migration is inserted
 * before it. The first migration throws: there is no earlier state.
 */
export async function migrateToPreviousMigration<DB>(
  db: Kysely<DB>,
  testUrl: string,
): Promise<MigrationResultSet> {
  const migrationName = migrationNameFromTestUrl(testUrl);
  const provider = createMigrationProvider();
  const names = Object.keys(await provider.getMigrations()).sort();
  const index = names.indexOf(migrationName);
  if (index < 0) {
    throw new Error(
      `"${migrationName}" is not a registered migration. A per-migration test ` +
        `must be named after a migration the provider knows about.`,
    );
  }
  if (index === 0) {
    throw new Error(
      `"${migrationName}" is the first migration, so there is no earlier state ` +
        `to straddle. Only a migration that rewrites pre-existing rows needs one.`,
    );
  }
  const previous = names[index - 1]!;

  const migrator = new Migrator({ db: db as unknown as Kysely<unknown>, provider });
  const resultSet = await migrator.migrateTo(previous);
  if (resultSet.error) return resultSet;

  const results = resultSet.results ?? [];
  if (results.length === 0) {
    throw new Error(
      `migrateTo('${previous}') applied no migrations. The test database was ` +
        `expected to be empty, so the target should have applied 001..${previous}.`,
    );
  }
  const last = results[results.length - 1];
  if (last?.migrationName !== previous || last.direction !== 'Up') {
    throw new Error(
      `migrateTo('${previous}') ended on ` +
        `${last?.direction ?? 'unknown'} "${last?.migrationName ?? 'unknown'}" — ` +
        `expected to finish by applying "${previous}", the migration before ` +
        `"${migrationName}".`,
    );
  }
  return resultSet;
}
