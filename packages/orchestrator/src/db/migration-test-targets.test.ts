import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Per-migration test target guard.
 *
 * A test named `NNN_thing.test.ts` documents the schema that migration `NNN`
 * produces, so it must apply the migration set only as far as `NNN`. Applying
 * the whole set instead (`migrateToLatest()`) runs the assertions against the
 * schema at the head of the migration list, where a later migration may already
 * have dropped or reshaped the column the test checks — the test then fails, or
 * worse passes for the wrong reason. Those suites only execute when
 * `KICI_TEST_ADMIN_DATABASE_URL` is set, so the rot is invisible in a normal
 * `pnpm test` run.
 *
 * This guard needs no database: it reads the test sources off disk, so it runs
 * in every `pnpm test` and fails the moment a per-migration test stops going
 * through `migrateToOwnMigration()` — the harness that derives the target from
 * the test file's own name and has no path back to the whole set.
 *
 * Repo/store tests outside `migrations/` (host roster, artifact store, the repo
 * suites) legitimately want head-of-list schema and are deliberately out of
 * this guard's scope.
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
   * A test that opens a real database — the only kind that has a target to get
   * wrong. Matched on any of the three real-connection signals rather than the
   * env-var name alone, so a test that reaches the gate through a shared helper
   * still has to go through the harness. A mock-database unit test casts an
   * object to `Kysely<…>` and matches none of these.
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
