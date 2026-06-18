import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockSetEnvironmentSecretDirect = vi.fn();

vi.mock('@kici-dev/shared', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    setEnvironmentSecretDirect: mockSetEnvironmentSecretDirect,
  };
});

const { registerSecretCommands } = await import('./secret.js');

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
      mockSetEnvironmentSecretDirect.mockResolvedValue({ inserted: true });
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
      expect(mockSetEnvironmentSecretDirect).toHaveBeenCalledWith('postgres://x', {
        orgId: 'org-1',
        environment: 'staging',
        key: 'DEPLOY_KEY',
        encryptedValue: 'ciphertext',
      });
      expect(stdout).toContain('(direct)');
    });
  });

  // ── sugar form ───────────────────────────────────────────────────────────
  describe('set (--environment sugar form)', () => {
    it('sets a secret via HTTP using --org/--environment/--key', async () => {
      const client = makeMockClient();
      client.setSecret.mockResolvedValue(undefined);
      const { stdout, exitCode } = await runCommand(
        [
          'secret',
          'set',
          '--org',
          'org-1',
          '--environment',
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

    it('sets a secret via direct-DB using --environment sugar', async () => {
      mockSetEnvironmentSecretDirect.mockResolvedValue({ inserted: false });
      const { stdout, exitCode } = await runCommand([
        'secret',
        'set',
        '--org',
        'org-1',
        '--environment',
        'staging',
        '--key',
        'DEPLOY_KEY',
        '--value',
        'v1',
        '--database-url',
        'postgres://x',
      ]);
      expect(exitCode).toBeNull();
      expect(mockSetEnvironmentSecretDirect).toHaveBeenCalledWith('postgres://x', {
        orgId: 'org-1',
        environment: 'staging',
        key: 'DEPLOY_KEY',
        encryptedValue: 'v1',
      });
      expect(stdout).toContain('(direct)');
    });

    it('errors when --environment missing --org', async () => {
      const { stderr, exitCode } = await runCommand([
        'secret',
        'set',
        '--environment',
        'staging',
        '--key',
        'K',
        '--value',
        'v',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('--org is required');
    });

    it('errors when --environment missing --key', async () => {
      const { stderr, exitCode } = await runCommand([
        'secret',
        'set',
        '--org',
        'org-1',
        '--environment',
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
        '--environment',
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
      expect(client.listScopes).toHaveBeenCalledWith('org-1');
      expect(stdout).toContain('staging');
      expect(stdout).toContain('production');
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
        expect(stderrChunks.join('')).toMatch(/--value puts the secret in shell history/);
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
