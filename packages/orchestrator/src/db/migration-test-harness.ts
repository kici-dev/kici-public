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
 * A DATA migration needs the state one step earlier as well, so it can insert
 * the rows it is supposed to rewrite: `migrateToPreviousMigration()` provides
 * it, deriving that target from the migration list rather than from a name the
 * test spells out.
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

/**
 * Apply migrations `001..NNN-1` — everything up to, but NOT including, the
 * migration the calling test file is named after. Pass `import.meta.url`.
 *
 * This is the pre-migration state a DATA migration has to be tested from. A
 * data migration rewrites rows that already exist, so its test has to straddle
 * it: migrate here, insert the rows an upgraded database actually holds, then
 * call {@link migrateToOwnMigration} and assert what moved. Going straight to
 * `migrateToOwnMigration` leaves no window to insert anything, so the
 * assertions would run against rows the migration never saw — a check that
 * passes identically with the migration body deleted.
 *
 * The target is derived from the migration list, so the caller never names the
 * previous migration and cannot drift when one is inserted before it. A test
 * for the very first migration throws, since there is no earlier state.
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
