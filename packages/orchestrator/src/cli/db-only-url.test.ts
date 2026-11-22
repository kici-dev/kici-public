import { afterEach, describe, expect, it, vi } from 'vitest';

const directCalls: Array<{ fn: string; url: unknown }> = [];

vi.mock('@kici-dev/shared', async (importActual) => {
  const actual = await importActual<typeof import('@kici-dev/shared')>();
  const record = (fn: string, result: unknown) => async (url: unknown) => {
    directCalls.push({ fn, url });
    return result;
  };
  return {
    ...actual,
    prunePeerCredentialsDirect: record('prunePeerCredentialsDirect', { deleted: 0 }),
    resetRaftStateDirect: record('resetRaftStateDirect', { rowsDeleted: 0 }),
    purgeSecretBackendsDirect: record('purgeSecretBackendsDirect', { deleted: 0 }),
    purgeContextsDirect: record('purgeContextsDirect', { contextsDeleted: 0, heldRunsDeleted: 0 }),
  };
});

const { runKiciAdminProgram: run } = await import('../__test-helpers__/kici-admin-program.js');
const { setAdminUrlOnCommandLine } = await import('./commands/shared/cli-action.js');

const ENV_DB = 'postgresql://env-host/kici';

/**
 * The commands with no admin-API mode. Each runs while the orchestrator is
 * stopped, so the database is the only place it can act.
 */
const DB_ONLY_COMMANDS: Array<{ argv: string[]; fn: string }> = [
  { argv: ['peer', 'prune-credentials', '--filter', 'keep-%'], fn: 'prunePeerCredentialsDirect' },
  { argv: ['peer', 'reset-raft-state'], fn: 'resetRaftStateDirect' },
  { argv: ['backend', 'purge-stale'], fn: 'purgeSecretBackendsDirect' },
  { argv: ['context', 'purge'], fn: 'purgeContextsDirect' },
];

describe('database-only kici-admin commands', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setAdminUrlOnCommandLine(false);
    directCalls.length = 0;
  });

  for (const { argv, fn } of DB_ONLY_COMMANDS) {
    const name = argv.slice(0, 2).join(' ');

    it(`${name} uses KICI_DATABASE_URL when --url is on the command line`, async () => {
      vi.stubEnv('KICI_DATABASE_URL', ENV_DB);
      const r = await run(['--url', 'http://127.0.0.1:4000', ...argv]);
      // fails-when: an explicit --url makes the command ignore KICI_DATABASE_URL and refuse
      expect(r.stderr).toBe('');
      expect(r.exitCode).toBeNull();
      expect(directCalls).toEqual([{ fn, url: ENV_DB }]);
    });

    it(`${name} still refuses with no database URL at all`, async () => {
      vi.stubEnv('KICI_DATABASE_URL', undefined);
      const r = await run(['--url', 'http://127.0.0.1:4000', ...argv]);
      // breaks-if-wrong: the command never falls through to an admin API it does not have
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/--database-url/);
      expect(directCalls).toEqual([]);
    });
  }
});
