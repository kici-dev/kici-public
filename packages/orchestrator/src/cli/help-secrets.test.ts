/**
 * `kici-admin --help` (top level and every subcommand) never prints a secret
 * read from the environment, and the env vars behind those options still
 * supply their values when a command runs.
 *
 * Surface ids exercised here (needled by the coverage gate):
 *   cli:kici-admin:token list
 */
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '@kici-dev/test-support/http';
import {
  flatHelp,
  secretEnvVarsReadIn,
  sentinelLeaksAfterLoad,
} from '@kici-dev/test-support/cli-help-secrets';

const SRC_DIR = fileURLToPath(new URL('../', import.meta.url));
const SECRET_ENV_VARS = secretEnvVarsReadIn(SRC_DIR);

/**
 * Import the whole CLI tree fresh, so a module-scope env read sees the stubbed
 * env. Re-importing every command module is slow, hence the long timeout.
 */
async function freshProgram() {
  vi.resetModules();
  const { buildProgram } = await import('./kici-admin.js');
  return buildProgram();
}
const FRESH_IMPORT_TIMEOUT_MS = 120_000;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('kici-admin help never prints an env secret', () => {
  it('reads the admin env vars it is meant to cover', () => {
    // fails-when: the source scan stops finding env reads, so the leak check below
    // plants no sentinel and passes vacuously.
    expect(SECRET_ENV_VARS).toEqual(expect.arrayContaining(['KICI_ADMIN_TOKEN', 'KICI_ADMIN_URL']));
  });

  it(
    'prints no sentinel in the help of any command',
    async () => {
      const { program, leaks } = await sentinelLeaksAfterLoad(SECRET_ENV_VARS, freshProgram);
      // fails-when: an option takes `process.env.X` as its Commander default (the
      // `--token` default printed the admin token), anywhere in the command tree.
      expect(leaks).toEqual([]);
      // fails-when: the root options lose the env hint that replaced the printed value.
      const rootHelp = flatHelp(program);
      expect(rootHelp).toContain('(env: KICI_ADMIN_TOKEN)');
      expect(rootHelp).toMatch(/default: "http:\/\/localhost:\d+", env: KICI_ADMIN_URL/);
    },
    FRESH_IMPORT_TIMEOUT_MS,
  );
});

describe('kici-admin env-backed options still resolve at run time', () => {
  function stubAdminApi() {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ tokens: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    return fetchMock;
  }

  it(
    'authenticates with only KICI_ADMIN_TOKEN and KICI_ADMIN_URL set',
    async () => {
      vi.stubEnv('KICI_ADMIN_TOKEN', 'env-token');
      vi.stubEnv('KICI_ADMIN_URL', 'http://orch.example:7000');
      const fetchMock = stubAdminApi();
      const program = await freshProgram();
      await program.parseAsync(['node', 'kici-admin', 'token', 'list']);
      // breaks-if-wrong: the env var is no longer read once it stops being the
      // option default, so a command run with only the env set has no credential.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('http://orch.example:7000/api/v1/admin/tokens');
      expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer env-token');
    },
    FRESH_IMPORT_TIMEOUT_MS,
  );

  it(
    'prefers --token over the env, and falls back to the default URL',
    async () => {
      vi.stubEnv('KICI_ADMIN_TOKEN', 'env-token');
      vi.stubEnv('KICI_ADMIN_URL', undefined);
      const fetchMock = stubAdminApi();
      const program = await freshProgram();
      await program.parseAsync(['node', 'kici-admin', '--token', 'flag-token', 'token', 'list']);
      const [url, init] = fetchMock.mock.calls[0]!;
      // breaks-if-wrong: env precedence flips over the flag, or the default URL is lost.
      expect(url).toMatch(/^http:\/\/localhost:\d+\/api\/v1\/admin\/tokens$/);
      expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer flag-token');
    },
    FRESH_IMPORT_TIMEOUT_MS,
  );

  it(
    'prefers --url over KICI_ADMIN_URL',
    async () => {
      vi.stubEnv('KICI_ADMIN_TOKEN', 'env-token');
      vi.stubEnv('KICI_ADMIN_URL', 'http://env.example:1');
      const fetchMock = stubAdminApi();
      const program = await freshProgram();
      await program.parseAsync([
        'node',
        'kici-admin',
        '--url',
        'http://flag.example:2',
        'token',
        'list',
      ]);
      // breaks-if-wrong: the env URL overrides an explicit --url.
      expect(fetchMock.mock.calls[0]![0]).toBe('http://flag.example:2/api/v1/admin/tokens');
    },
    FRESH_IMPORT_TIMEOUT_MS,
  );

  it(
    'treats an empty KICI_ADMIN_TOKEN as no token',
    async () => {
      vi.stubEnv('KICI_ADMIN_TOKEN', '');
      const fetchMock = stubAdminApi();
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`exit ${code}`);
      }) as never);
      const program = await freshProgram();
      // breaks-if-wrong: an empty env value now counts as a credential and is sent.
      await expect(program.parseAsync(['node', 'kici-admin', 'token', 'list'])).rejects.toThrow(
        'exit 1',
      );
      expect(error).toHaveBeenCalledWith('Error: --token or KICI_ADMIN_TOKEN is required');
      expect(fetchMock).not.toHaveBeenCalled();
    },
    FRESH_IMPORT_TIMEOUT_MS,
  );
});
