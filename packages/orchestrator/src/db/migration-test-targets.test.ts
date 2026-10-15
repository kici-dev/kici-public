import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * `NNN_thing.test.ts` asserts the schema migration `NNN` produces, so it must migrate only as
 * far as `NNN`: under `migrateToLatest()` a later migration may have reshaped the column, and
 * the test fails or passes for the wrong reason. Those suites run only with
 * `KICI_TEST_ADMIN_DATABASE_URL`, so the rot is invisible in a normal `pnpm test`.
 *
 * This guard reads the sources off disk, so it runs in every `pnpm test` and fails once a
 * per-migration test bypasses `migrateToOwnMigration()`, which derives the target from the
 * test's file name.
 *
 * Repo/store tests outside `migrations/` want head-of-list schema and are out of scope.
 */
describe('per-migration test targets', () => {
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

  /** Every `NNN_*.test.ts` in migrations/, paired with its own migration name. */
  function perMigrationTests(): { file: string; migrationName: string; source: string }[] {
    return readdirSync(migrationsDir)
      .filter((f) => /^\d{3}_.*\.test\.ts$/.test(f))
      .sort()
      .map((file) => ({
        file,
        migrationName: file.replace(/\.test\.ts$/, ''),
        source: readFileSync(join(migrationsDir, file), 'utf8'),
      }));
  }

  /**
   * A test that opens a real database, the only kind with a target to get wrong. Any
   * real-connection signal matches, not only the env-var name, so a test gated through a shared
   * helper still must use the harness. A mock-database test casts to `Kysely<…>` and matches none.
   */
  function databaseBacked(t: { source: string }): boolean {
    return (
      t.source.includes('KICI_TEST_ADMIN_DATABASE_URL') ||
      /new Kysely[<(]/.test(t.source) ||
      /new pg\.Pool\s*\(/.test(t.source)
    );
  }

  it('finds per-migration tests at all (guard is not vacuous)', () => {
    const tests = perMigrationTests();
    expect(tests.length).toBeGreaterThan(0);
    expect(tests.filter(databaseBacked).length).toBeGreaterThan(0);
  });

  it('never applies the whole migration set (no migrateToLatest call)', () => {
    const offenders = perMigrationTests()
      .filter((t) => /\.migrateToLatest\s*\(/.test(t.source))
      .map((t) => t.file);
    expect(
      offenders,
      `Per-migration tests must not call migrateToLatest() — it applies every ` +
        `migration, so the assertions run against head-of-list schema instead of ` +
        `the schema the migration under test produces. Use ` +
        `migrateToOwnMigration(db, import.meta.url) instead. Offenders: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('never builds its own Migrator (which could target anything)', () => {
    const offenders = perMigrationTests()
      .filter((t) => /new Migrator\s*\(/.test(t.source))
      .map((t) => t.file);
    expect(
      offenders,
      `Per-migration tests must migrate through migrateToOwnMigration(), which ` +
        `derives the target from the test file name. Hand-building a Migrator ` +
        `reintroduces the chance of naming the wrong target. Offenders: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('migrates through the harness, passing its own module URL', () => {
    const offenders = perMigrationTests()
      .filter(databaseBacked)
      .filter((t) => !t.source.includes('migrateToOwnMigration(db, import.meta.url)'))
      .map((t) => t.file);
    expect(
      offenders,
      `Each database-backed per-migration test must call ` +
        `migrateToOwnMigration(db, import.meta.url) so it asserts against the ` +
        `schema its own migration produces. Offenders: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
