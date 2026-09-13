import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockSetContextSecretDirect = vi.fn();

vi.mock('@kici-dev/shared', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    setContextSecretDirect: mockSetContextSecretDirect,
  };
});

// ── fix-prefixed-scopes direct-DB harness ────────────────────────────────────
// The command opens its own pool and builds its own PgSecretStore, so the DB
// client, the store factory and the master-key loader are stubbed. Everything
// else in the module (notably SecretScopeExistsError, whose identity the
// command's `instanceof` check depends on) stays real.

const mockListScopes = vi.fn();
const mockRenameScope = vi.fn();
const mockDbDestroy = vi.fn();
/** Rows `listRegisteredBackendNames` reads out of `secret_backends`. */
let registeredBackendRows: Array<{ name: string }> = [];

const mockDb = {
  destroy: (...args: unknown[]) => mockDbDestroy(...args),
  selectFrom: () => ({
    select: () => ({ execute: async () => registeredBackendRows }),
  }),
};

vi.mock('../../db/client.js', () => ({
  createPool: () => ({}),
  createDb: () => mockDb,
}));

vi.mock('../../secrets/config.js', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    loadSecretStoreConfig: () => ({
      masterKey: Buffer.alloc(32),
      oldMasterKey: undefined,
      keyVersion: 1,
    }),
  };
});

vi.mock('../../secrets/pg-secret-store.js', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    PgSecretStore: {
      create: async () => ({ listScopes: mockListScopes, renameScope: mockRenameScope }),
    },
  };
});

const { SecretScopeExistsError } = await import('../../secrets/pg-secret-store.js');
const { registerSecretCommands, planPrefixedScopeFixes } = await import('./secret.js');

interface MockClient {
  listScopes: ReturnType<typeof vi.fn>;
  listKeys: ReturnType<typeof vi.fn>;
  setSecret: ReturnType<typeof vi.fn>;
  deleteSecret: ReturnType<typeof vi.fn>;
}

function makeMockClient(): MockClient {
  return {
    listScopes: vi.fn(),
    listKeys: vi.fn(),
    setSecret: vi.fn(),
    deleteSecret: vi.fn(),
  };
}

async function runCommand(
  args: string[],
  client: MockClient = makeMockClient(),
): Promise<{ stdout: string; stderr: string; exitCode: number | null; client: MockClient }> {
  const program = new Command();
  program.exitOverride();
  registerSecretCommands(program, () => client as any);

  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  let exitCode: number | null = null;

  console.log = (...a: any[]) => logs.push(a.join(' '));
  console.error = (...a: any[]) => errors.push(a.join(' '));

  const origExit = process.exit;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`EXIT:${code}`);
  }) as any;

  try {
    await program.parseAsync(args, { from: 'user' });
  } catch (err: any) {
    if (!err.message?.startsWith('EXIT:') && !err.code?.startsWith('commander.')) {
      console.log = origLog;
      console.error = origError;
      process.exit = origExit;
      throw err;
    }
  } finally {
    console.log = origLog;
    console.error = origError;
    process.exit = origExit;
  }

  return { stdout: logs.join('\n'), stderr: errors.join('\n'), exitCode, client };
}

describe('kici-admin secret CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.KICI_DATABASE_URL;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── positional form ──────────────────────────────────────────────────────
  describe('set (positional form)', () => {
    it('sets a secret via HTTP when no dbUrl', async () => {
      const client = makeMockClient();
      client.setSecret.mockResolvedValue(undefined);
      const { stdout, exitCode } = await runCommand(
        ['secret', 'set', 'org-1', 'production', 'API_KEY', '--value', 'abc123'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.setSecret).toHaveBeenCalledWith('org-1', 'production', 'API_KEY', 'abc123');
      expect(stdout).toContain("Secret 'API_KEY' set in scope 'production'");
    });

    it('sets a secret via direct-DB mode', async () => {
      mockSetContextSecretDirect.mockResolvedValue({ inserted: true });
      const { stdout, exitCode } = await runCommand([
        'secret',
        'set',
        'org-1',
        'staging',
        'DEPLOY_KEY',
        '--value',
        'ciphertext',
        '--database-url',
        'postgres://x',
      ]);
      expect(exitCode).toBeNull();
      expect(mockSetContextSecretDirect).toHaveBeenCalledWith('postgres://x', {
        orgId: 'org-1',
        context: 'staging',
        key: 'DEPLOY_KEY',
        encryptedValue: 'ciphertext',
      });
      expect(stdout).toContain('(direct)');
    });

    it('refuses a direct-DB write whose key would make the AAD ambiguous', async () => {
      // Direct-DB writes the row itself, so it never reaches the admin route or
      // PgSecretStore — it needs its own guard.
      mockSetContextSecretDirect.mockResolvedValue({ inserted: true });
      const { stderr, exitCode } = await runCommand([
        'secret',
        'set',
        'org-1',
        'staging',
        'a:b',
        '--value',
        'ciphertext',
        '--database-url',
        'postgres://x',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/letters, digits/);
      expect(mockSetContextSecretDirect).not.toHaveBeenCalled();
    });
  });

  // ── sugar form ───────────────────────────────────────────────────────────
  describe('set (--context sugar form)', () => {
    it('sets a secret via HTTP using --org/--context/--key', async () => {
      const client = makeMockClient();
      client.setSecret.mockResolvedValue(undefined);
      const { stdout, exitCode } = await runCommand(
        [
          'secret',
          'set',
          '--org',
          'org-1',
          '--context',
          'production',
          '--key',
          'API_KEY',
          '--value',
          'v1',
        ],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.setSecret).toHaveBeenCalledWith('org-1', 'production', 'API_KEY', 'v1');
      expect(stdout).toContain("Secret 'API_KEY' set in scope 'production'");
    });

    it('sets a secret via direct-DB using --context sugar', async () => {
      mockSetContextSecretDirect.mockResolvedValue({ inserted: false });
      const { stdout, exitCode } = await runCommand([
        'secret',
        'set',
        '--org',
        'org-1',
        '--context',
        'staging',
        '--key',
        'DEPLOY_KEY',
        '--value',
        'v1',
        '--database-url',
        'postgres://x',
      ]);
      expect(exitCode).toBeNull();
      expect(mockSetContextSecretDirect).toHaveBeenCalledWith('postgres://x', {
        orgId: 'org-1',
        context: 'staging',
        key: 'DEPLOY_KEY',
        encryptedValue: 'v1',
      });
      expect(stdout).toContain('(direct)');
    });

    it('errors when --context missing --org', async () => {
      const { stderr, exitCode } = await runCommand([
        'secret',
        'set',
        '--context',
        'staging',
        '--key',
        'K',
        '--value',
        'v',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('--org is required');
    });

    it('errors when --context missing --key', async () => {
      const { stderr, exitCode } = await runCommand([
        'secret',
        'set',
        '--org',
        'org-1',
        '--context',
        'staging',
        '--value',
        'v',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('--key is required');
    });

    it('errors when mixing positional and sugar flags', async () => {
      const { stderr, exitCode } = await runCommand([
        'secret',
        'set',
        'org-1',
        'scope-1',
        'KEY-1',
        '--context',
        'staging',
        '--value',
        'v',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Cannot mix positional');
    });

    it('errors when neither positional nor sugar args provided', async () => {
      const { stderr, exitCode } = await runCommand(['secret', 'set', '--value', 'v']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Missing arguments');
    });
  });

  // ── scopes / list / delete (already existing, minimal coverage) ──────────
  describe('scopes / list / delete', () => {
    it('scopes prints each scope', async () => {
      const client = makeMockClient();
      client.listScopes.mockResolvedValue({ scopes: ['staging', 'production'] });
      const { stdout, exitCode } = await runCommand(['secret', 'scopes', 'org-1'], client);
      expect(exitCode).toBeNull();
      expect(client.listScopes).toHaveBeenCalledWith('org-1', false);
      expect(stdout).toContain('staging');
      expect(stdout).toContain('production');
    });

    it('scopes --all-backends asks for the cross-backend listing', async () => {
      const client = makeMockClient();
      client.listScopes.mockResolvedValue({ scopes: ['pg:staging', 'vault:aws/prod'] });
      const { stdout, exitCode } = await runCommand(
        ['secret', 'scopes', 'org-1', '--all-backends'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.listScopes).toHaveBeenCalledWith('org-1', true);
      expect(stdout).toContain('vault:aws/prod');
    });

    it('list prints each key', async () => {
      const client = makeMockClient();
      client.listKeys.mockResolvedValue({ keys: ['API_KEY', 'DB_URL'] });
      const { stdout, exitCode } = await runCommand(['secret', 'list', 'org-1', 'staging'], client);
      expect(exitCode).toBeNull();
      expect(client.listKeys).toHaveBeenCalledWith('org-1', 'staging');
      expect(stdout).toContain('API_KEY');
      expect(stdout).toContain('DB_URL');
    });

    it('delete with --yes skips prompt and calls client', async () => {
      const client = makeMockClient();
      client.deleteSecret.mockResolvedValue(undefined);
      const { stdout, exitCode } = await runCommand(
        ['secret', 'delete', 'org-1', 'staging', 'API_KEY', '--yes'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.deleteSecret).toHaveBeenCalledWith('org-1', 'staging', 'API_KEY');
      expect(stdout).toContain("deleted from scope 'staging'");
    });
  });

  // ── input modes ──────────────────────────────────────────────────────
  describe('set input modes', () => {
    let tmp: string;
    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'kici-secret-test-'));
      delete process.env.KICI_TEST_VALUE;
    });
    afterEach(() => {
      rmSync(tmp, { recursive: true, force: true });
      delete process.env.KICI_TEST_VALUE;
    });

    it('--value emits a stderr warning', async () => {
      const client = makeMockClient();
      client.setSecret.mockResolvedValue(undefined);
      const origStderrWrite = process.stderr.write.bind(process.stderr);
      const stderrChunks: string[] = [];
      process.stderr.write = ((chunk: any) => {
        stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      }) as any;
      try {
        const { exitCode } = await runCommand(
          ['secret', 'set', 'org-1', 'prod', 'K', '--value', 'v'],
          client,
        );
        expect(exitCode).toBeNull();
        expect(client.setSecret).toHaveBeenCalledWith('org-1', 'prod', 'K', 'v');
        expect(stderrChunks.join('')).toMatch(/--value puts the value in shell history/);
      } finally {
        process.stderr.write = origStderrWrite;
      }
    });

    it('--from-env reads from env var', async () => {
      process.env.KICI_TEST_VALUE = 'env_secret';
      const client = makeMockClient();
      client.setSecret.mockResolvedValue(undefined);
      const { exitCode } = await runCommand(
        ['secret', 'set', 'org-1', 'prod', 'K', '--from-env', 'KICI_TEST_VALUE'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.setSecret).toHaveBeenCalledWith('org-1', 'prod', 'K', 'env_secret');
    });

    it('--from-env errors when env var is unset', async () => {
      const client = makeMockClient();
      const { stderr, exitCode } = await runCommand(
        ['secret', 'set', 'org-1', 'prod', 'K', '--from-env', 'KICI_NOT_SET'],
        client,
      );
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/environment variable is not set/);
      expect(client.setSecret).not.toHaveBeenCalled();
    });

    it('--from-file reads file and trims trailing newline by default', async () => {
      const path = join(tmp, 'secret.txt');
      writeFileSync(path, 'file_secret\n', 'utf8');
      const client = makeMockClient();
      client.setSecret.mockResolvedValue(undefined);
      const { exitCode } = await runCommand(
        ['secret', 'set', 'org-1', 'prod', 'K', '--from-file', path],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.setSecret).toHaveBeenCalledWith('org-1', 'prod', 'K', 'file_secret');
    });

    it('rejects ambiguous --value + --from-env', async () => {
      const client = makeMockClient();
      const { stderr, exitCode } = await runCommand(
        ['secret', 'set', 'org-1', 'prod', 'K', '--value', 'v', '--from-env', 'KICI_TEST_VALUE'],
        client,
      );
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/Ambiguous input mode/);
      expect(client.setSecret).not.toHaveBeenCalled();
    });

    it('--dry-run skips the write and prints fingerprint', async () => {
      const client = makeMockClient();
      const { stdout, exitCode } = await runCommand(
        ['secret', 'set', 'org-1', 'prod', 'K', '--value', 'preview', '--dry-run'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.setSecret).not.toHaveBeenCalled();
      expect(stdout).toMatch(/\[dry-run\]/);
      expect(stdout).toMatch(/sha256=[0-9a-f]{64}/);
    });

    it('--confirm-fingerprint accepts matching hash', async () => {
      const value = 'fp-match';
      const { createHash } = await import('node:crypto');
      const computedFp = createHash('sha256').update(value, 'utf8').digest('hex');

      const client = makeMockClient();
      client.setSecret.mockResolvedValue(undefined);
      const { exitCode } = await runCommand(
        [
          'secret',
          'set',
          'org-1',
          'prod',
          'K',
          '--value',
          value,
          '--confirm-fingerprint',
          computedFp,
        ],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.setSecret).toHaveBeenCalledWith('org-1', 'prod', 'K', value);
    });

    it('--confirm-fingerprint rejects mismatch and skips write', async () => {
      const client = makeMockClient();
      const { stderr, exitCode } = await runCommand(
        [
          'secret',
          'set',
          'org-1',
          'prod',
          'K',
          '--value',
          'real',
          '--confirm-fingerprint',
          'a'.repeat(64),
        ],
        client,
      );
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/--confirm-fingerprint mismatch/);
      expect(client.setSecret).not.toHaveBeenCalled();
    });
  });
});

// ── fix-prefixed-scopes planner ────────────────────────────────────────────
describe('planPrefixedScopeFixes', () => {
  const backends = ['pg', 'vault'];

  it('plans a rename for a scope stored with a registered qualifier', () => {
    const plan = planPrefixedScopeFixes(['pg:production'], backends);
    expect(plan.renames).toEqual([{ from: 'pg:production', to: 'production', backendName: 'pg' }]);
    expect(plan.skips).toEqual([]);
  });

  it('leaves an already-bare scope alone', () => {
    const plan = planPrefixedScopeFixes(['production', 'aws/prod'], backends);
    expect(plan.renames).toEqual([]);
    expect(plan.skips).toEqual([]);
  });

  it('leaves an UNREGISTERED head alone — it is a path, not a stale qualifier', () => {
    const plan = planPrefixedScopeFixes(['github:42'], backends);
    expect(plan.renames).toEqual([]);
    expect(plan.skips).toEqual([]);
  });

  it('SKIPS rather than merges when the bare target already exists', () => {
    const plan = planPrefixedScopeFixes(['pg:production', 'production'], backends);
    expect(plan.renames).toEqual([]);
    expect(plan.skips).toHaveLength(1);
    expect(plan.skips[0].scope).toBe('pg:production');
    expect(plan.skips[0].reason).toMatch(/already exists/);
  });

  it('SKIPS a non-pg qualifier rather than moving the secret into PG', () => {
    // These scopes come out of the PG store, so 'vault:foo' is a PG row
    // wearing another backend's name. Renaming it to 'foo' would make it a
    // real PG secret — the cross-backend move the rename route refuses.
    const plan = planPrefixedScopeFixes(['vault:foo'], backends);
    expect(plan.renames).toEqual([]);
    expect(plan.skips).toHaveLength(1);
    expect(plan.skips[0].scope).toBe('vault:foo');
    expect(plan.skips[0].reason).toMatch(/would move the secret into PG/);
  });

  it('SKIPS a bare qualifier with an empty path', () => {
    const plan = planPrefixedScopeFixes(['pg:'], backends);
    expect(plan.renames).toEqual([]);
    expect(plan.skips[0].reason).toMatch(/empty path/);
  });

  it('treats a leading colon as a path, never an empty backend name', () => {
    const plan = planPrefixedScopeFixes([':orphan'], backends);
    expect(plan.renames).toEqual([]);
    expect(plan.skips).toEqual([]);
  });

  it('splits on the first colon only', () => {
    const plan = planPrefixedScopeFixes(['pg:a:b'], backends);
    expect(plan.renames).toEqual([{ from: 'pg:a:b', to: 'a:b', backendName: 'pg' }]);
  });

  it('plans nothing when no backend is registered', () => {
    const plan = planPrefixedScopeFixes(['pg:production'], []);
    expect(plan.renames).toEqual([]);
    expect(plan.skips).toEqual([]);
  });
});

describe('kici-admin secret fix-prefixed-scopes — a refused rename must not abort the repair', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredBackendRows = [{ name: 'pg' }];
    mockDbDestroy.mockResolvedValue(undefined);
  });

  async function runFix() {
    return runCommand(['secret', 'fix-prefixed-scopes', 'org-1', '--database-url', 'postgres://x']);
  }

  it('skips a destination the store refuses as occupied and still repairs the scopes behind it', async () => {
    // The planner's occupancy check reads listScopes, which only sees scopes
    // that hold secret rows — a destination existing solely as a context
    // binding is invisible to it, so the store is the one that refuses. Two
    // scopes are queued; the FIRST is refused.
    mockListScopes.mockResolvedValue(['pg:alpha', 'pg:beta']);
    mockRenameScope
      .mockRejectedValueOnce(new SecretScopeExistsError('alpha'))
      .mockResolvedValueOnce(undefined);

    const { stdout, stderr, exitCode } = await runFix();

    // The second rename was attempted at all only because the first did not
    // abort the loop — this assertion cannot hold if the error propagates.
    expect(mockRenameScope).toHaveBeenCalledTimes(2);
    expect(mockRenameScope).toHaveBeenNthCalledWith(1, 'org-1', 'pg:alpha', 'alpha');
    expect(mockRenameScope).toHaveBeenNthCalledWith(2, 'org-1', 'pg:beta', 'beta');

    expect(stderr).toContain("SKIPPED 'pg:alpha'");
    expect(stderr).toMatch(/already exists/);
    expect(stdout).toContain('1 scope(s) repaired, 1 skipped.');
    // 2 = "some scopes still need a human", not 1 = hard failure.
    expect(exitCode).toBe(2);
  });

  it('still fails hard on a rename error that is not an occupancy conflict', async () => {
    mockListScopes.mockResolvedValue(['pg:alpha', 'pg:beta']);
    mockRenameScope.mockRejectedValue(new Error('connection reset'));

    const { stderr, exitCode } = await runFix();

    expect(stderr).toContain('Error: connection reset');
    expect(exitCode).toBe(1);
    // Aborted on the first rename — an unknown fault must not be swallowed and
    // the remaining scopes must not be touched.
    expect(mockRenameScope).toHaveBeenCalledTimes(1);
  });

  it('exits 0 and repairs everything when no destination is occupied', async () => {
    mockListScopes.mockResolvedValue(['pg:alpha']);
    mockRenameScope.mockResolvedValue(undefined);

    const { stdout, exitCode } = await runFix();

    expect(stdout).toContain('1 scope(s) repaired, 0 skipped.');
    expect(exitCode).toBeNull();
  });
});
