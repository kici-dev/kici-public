import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createMigrationProvider } from './migration-provider.js';

/**
 * Registration-completeness guard. `migration-provider.ts` imports every migration statically,
 * so a file added to `migrations/` but not to the provider map never runs: the schema ships
 * behind the code and only surfaces at deploy time as "corrupted migrations: … missing". The
 * Platform's migrations carry the same guard.
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
