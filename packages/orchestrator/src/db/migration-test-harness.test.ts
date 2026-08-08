import { describe, it, expect } from 'vitest';
import { pathToFileURL } from 'node:url';
import { migrationNameFromTestUrl } from './migration-test-harness.js';

describe('migrationNameFromTestUrl', () => {
  it('derives the migration name from a per-migration test module URL', () => {
    const url = pathToFileURL(
      '/repo/packages/orchestrator/src/db/migrations/030_held_runs_env_set_null.test.ts',
    ).href;
    expect(migrationNameFromTestUrl(url)).toBe('030_held_runs_env_set_null');
  });

  it('keeps the three-digit prefix and drops only the .test.ts suffix', () => {
    const url = pathToFileURL('/x/migrations/099_cluster_settings.test.ts').href;
    expect(migrationNameFromTestUrl(url)).toBe('099_cluster_settings');
  });

  it('throws for a test file that is not named after a migration', () => {
    const url = pathToFileURL('/x/agent/host-roster.test.ts').href;
    expect(() => migrationNameFromTestUrl(url)).toThrow(/only for per-migration tests/);
  });
});
