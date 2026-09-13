import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createMigrationProvider } from './migration-provider.js';

/**
 * Registration-completeness guard.
 *
 * `migration-provider.ts` statically imports every migration (Rolldown can't
 * dynamic-import them at runtime), which means a migration FILE can be added
 * to `migrations/` and silently never run if it isn't also wired into the
 * provider map. A missing registration ships a schema behind the code and only
 * surfaces at deploy time as a "corrupted migrations: … missing" error. This
 * test fails loudly the moment a migration file isn't registered, so the deploy
 * never goes out with a phantom migration. Mirrors the platform-side guard in
 * `packages/platform/src/db/migration-provider.test.ts`.
 */
describe('migration provider registration completeness', () => {
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

  function migrationFileNames(): string[] {
    return readdirSync(migrationsDir)
      .filter((f) => /^\d{3}_.*\.ts$/.test(f) && !f.endsWith('.test.ts'))
      .map((f) => f.replace(/\.ts$/, ''))
      .sort();
  }

  async function registeredKeys(): Promise<string[]> {
    const migrations = await createMigrationProvider().getMigrations();
    return Object.keys(migrations).sort();
  }

  it('registers every migration file in migrations/ (no phantom/unregistered files)', async () => {
    const files = migrationFileNames();
    const registered = await registeredKeys();
    const unregistered = files.filter((f) => !registered.includes(f));
    expect(
      unregistered,
      `Migration files present on disk but NOT registered in migration-provider.ts: ` +
        `${unregistered.join(', ')}. Add a static import + map entry for each.`,
    ).toEqual([]);
  });

  it('every registered key maps to a migration file on disk (no dangling registration)', async () => {
    const files = migrationFileNames();
    const registered = await registeredKeys();
    const dangling = registered.filter((k) => !files.includes(k));
    expect(
      dangling,
      `Provider registers keys with no matching migration file: ${dangling.join(', ')}.`,
    ).toEqual([]);
  });

  it('every registered migration exposes an up() function', async () => {
    const migrations = await createMigrationProvider().getMigrations();
    for (const [key, migration] of Object.entries(migrations)) {
      expect(typeof migration.up, `${key}.up must be a function`).toBe('function');
    }
  });
});
