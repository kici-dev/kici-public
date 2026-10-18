/**
 * `kici --help` (top level and every subcommand) never prints a secret read
 * from the environment.
 */
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  secretEnvVarsReadIn,
  sentinelLeaksAfterLoad,
} from '@kici-dev/test-support/cli-help-secrets';

const SRC_DIR = fileURLToPath(new URL('./', import.meta.url));
const SECRET_ENV_VARS = secretEnvVarsReadIn(SRC_DIR);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('kici help never prints an env secret', () => {
  it('reads the credential env vars it is meant to cover', () => {
    // fails-when: the source scan stops finding env reads, so the leak check below
    // plants no sentinel and passes vacuously.
    expect(SECRET_ENV_VARS).toEqual(expect.arrayContaining(['KICI_ORCHESTRATOR_TOKEN']));
  });

  it('prints no sentinel in the help of any command', async () => {
    const { leaks } = await sentinelLeaksAfterLoad(SECRET_ENV_VARS, async () => {
      // Imported fresh, so a module-scope env read sees the stubbed env.
      vi.resetModules();
      const { buildProgram } = await import('./cli.js');
      return buildProgram();
    });
    // fails-when: an option takes `process.env.X` as its Commander default,
    // anywhere in the command tree.
    expect(leaks).toEqual([]);
  }, 120_000);
});
