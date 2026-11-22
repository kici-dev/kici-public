import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../__test-helpers__/cli.js';

const mockSetSecretDirect = vi.fn();
const mockVerifySecretsDirect = vi.fn();
const DIRECT_SETTINGS = { masterKeys: null, pgCustomerSecrets: true };
const mockListContextsDirect = vi.fn();
const mockShowContextDirect = vi.fn();

vi.mock('@kici-dev/shared', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    listContextsDirect: mockListContextsDirect,
    showContextDirect: mockShowContextDirect,
  };
});

// The encrypting writer has its own database test (shared/secret-direct.db.test.ts).
vi.mock('./shared/secret-direct.js', () => ({
  setSecretDirect: mockSetSecretDirect,
  verifySecretsDirect: mockVerifySecretsDirect,
  resolveDirectSecretSettings: () => DIRECT_SETTINGS,
  secretEnvFromEnvFile: () => ({}),
}));

const { registerSecretCommands, UNCONFIRMED_KEY_WARNING } = await import('./secret.js');
const { unboundContextWarning } = await import('./shared/unbound-context-warning.js');
const { ContextType } = await import('@kici-dev/engine');

interface MockClient {
  get: ReturnType<typeof vi.fn>;
  listScopes: ReturnType<typeof vi.fn>;
  verifySecrets: ReturnType<typeof vi.fn>;
  listKeys: ReturnType<typeof vi.fn>;
  setSecret: ReturnType<typeof vi.fn>;
  deleteSecret: ReturnType<typeof vi.fn>;
  createScope: ReturnType<typeof vi.fn>;
  renameScope: ReturnType<typeof vi.fn>;
  deleteScope: ReturnType<typeof vi.fn>;
}

function makeMockClient(): MockClient {
  return {
    get: vi.fn(),
    listScopes: vi.fn(),
    verifySecrets: vi.fn(),
    listKeys: vi.fn(),
    setSecret: vi.fn(),
    deleteSecret: vi.fn(),
    createScope: vi.fn(),
    renameScope: vi.fn(),
    deleteScope: vi.fn(),
  };
}

async function runCommand(
  args: string[],
  client: MockClient = makeMockClient(),
): Promise<{ stdout: string; stderr: string; exitCode: number | null; client: MockClient }> {
  return { ...(await runCli((p) => registerSecretCommands(p, () => client as any), args)), client };
}

describe('kici-admin secret CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.KICI_DATABASE_URL;
    mockSetSecretDirect.mockResolvedValue({ keyConfirmed: true });
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
      mockSetSecretDirect.mockResolvedValue({ keyConfirmed: true });
      const { stdout, exitCode } = await runCommand([
        'secret',
        'set',
        'org-1',
        'staging',
        'DEPLOY_KEY',
        '--value',
        'plain-value',
        '--database-url',
        'postgres://x',
      ]);
      expect(exitCode).toBeNull();
      // The plaintext goes to the encrypting writer, never to a verbatim insert.
      expect(mockSetSecretDirect).toHaveBeenCalledWith(
        'postgres://x',
        { orgId: 'org-1', scope: 'staging', key: 'DEPLOY_KEY', value: 'plain-value' },
        DIRECT_SETTINGS,
      );
      expect(stdout).toContain('(direct)');
    });
  });

  // ── unbound-context warning ──────────────────────────────────────────────
  // A secret written to a scope named after a fixed context with no binding
  // reaches no job. The write still succeeds; the warning names the fix.
  describe('set — unbound context warning', () => {
    function contextsClient(bindings: number): MockClient {
      const client = makeMockClient();
      client.setSecret.mockResolvedValue(undefined);
      client.get.mockImplementation(async (path: string) =>
        path.startsWith('/api/v1/admin/contexts?')
          ? { contexts: [{ name: 'staging', type: ContextType.enum.fixed }] }
          : {
              context: { name: 'staging', type: ContextType.enum.fixed },
              variables: [],
              bindings: Array.from({ length: bindings }, () => ({ scope_pattern: 'staging' })),
            },
      );
      return client;
    }

    it('warns on stderr and still exits 0 when the target context has no binding (HTTP)', async () => {
      const { stderr, exitCode, client } = await runCommand(
        ['secret', 'set', '--org', 'org-1', '--context', 'staging', '--key', 'K', '--value', 'v'],
        contextsClient(0),
      );
      expect(client.setSecret).toHaveBeenCalledWith('org-1', 'staging', 'K', 'v');
      // fails-when: the warning is not printed for a bindingless fixed context
      expect(stderr).toContain(unboundContextWarning('org-1', 'staging'));
      expect(exitCode).toBeNull();
    });

    it('warns in direct-DB mode too', async () => {
      mockSetSecretDirect.mockResolvedValue({ keyConfirmed: true });
      mockListContextsDirect.mockResolvedValue({
        contexts: [{ name: 'staging', type: ContextType.enum.fixed }],
      });
      mockShowContextDirect.mockResolvedValue({
        context: { name: 'staging', type: ContextType.enum.fixed },
        variables: [],
        bindings: [],
      });
      const { stderr, exitCode } = await runCommand([
        'secret',
        'set',
        'org-1',
        'staging',
        'K',
        '--value',
        'ciphertext',
        '--database-url',
        'postgres://x',
      ]);
      expect(stderr).toContain(unboundContextWarning('org-1', 'staging'));
      expect(exitCode).toBeNull();
    });

    it('prints no warning when the target context is bound', async () => {
      // breaks-if-wrong: a bound context must write silently
      const { stderr, exitCode } = await runCommand(
        ['secret', 'set', '--org', 'org-1', '--context', 'staging', '--key', 'K', '--value', 'v'],
        contextsClient(1),
      );
      expect(stderr).not.toContain('has no binding');
      expect(exitCode).toBeNull();
    });
  });

  // ── sugar form ───────────────────────────────────────────────────────────
  describe('verify', () => {
    const PLAIN = { orgId: 'org-1', scope: 'legacy', key: 'PLAIN' };

    it('lists each undecryptable secret by location and exits 1 (HTTP)', async () => {
      const client = makeMockClient();
      client.verifySecrets.mockResolvedValue({ undecryptable: [PLAIN] });
      const { stdout, exitCode } = await runCommand(['secret', 'verify'], client);
      // fails-when: verify exits 0 while a row the orchestrator cannot read is stored
      expect(exitCode).toBe(1);
      expect(stdout).toContain('org org-1  scope legacy  key PLAIN');
      expect(stdout).toContain('kici-admin secret set');
    });

    it('exits 0 when every secret decrypts', async () => {
      // breaks-if-wrong: a clean install must pass the check a script gates on
      const client = makeMockClient();
      client.verifySecrets.mockResolvedValue({ undecryptable: [] });
      const { stdout, exitCode } = await runCommand(['secret', 'verify', '--json'], client);
      expect(exitCode).toBeNull();
      expect(JSON.parse(stdout)).toEqual({ undecryptable: [] });
    });

    it('reads the database directly in direct-DB mode', async () => {
      mockVerifySecretsDirect.mockResolvedValue([PLAIN]);
      const client = makeMockClient();
      const { exitCode } = await runCommand(
        ['secret', 'verify', '--database-url', 'postgres://x', '--env-file', '/etc/kici/o.env'],
        client,
      );
      expect(mockVerifySecretsDirect).toHaveBeenCalledWith('postgres://x', DIRECT_SETTINGS);
      expect(client.verifySecrets).not.toHaveBeenCalled();
      expect(exitCode).toBe(1);
    });
  });

  describe('--env-file and the master key', () => {
    it('refuses --env-file outside direct-database mode, for set and verify', async () => {
      // fails-when: --env-file is silently ignored, so the operator believes its key was used
      for (const args of [
        ['secret', 'set', 'org-1', 'staging', 'K', '--value', 'v', '--env-file', '/etc/kici/o.env'],
        ['secret', 'verify', '--env-file', '/etc/kici/o.env'],
      ]) {
        const { stderr, exitCode, client } = await runCommand(args);
        expect(exitCode, args.join(' ')).toBe(1);
        expect(stderr).toContain('--env-file is read only in direct-database mode');
        expect(client.setSecret).not.toHaveBeenCalled();
        expect(client.verifySecrets).not.toHaveBeenCalled();
      }
    });

    it('warns, and points at secret verify, when no stored secret confirms the key', async () => {
      mockSetSecretDirect.mockResolvedValue({ keyConfirmed: false });
      const { stdout, stderr, exitCode } = await runCommand([
        'secret',
        'set',
        'org-1',
        'staging',
        'K',
        '--value',
        'v',
        '--database-url',
        'postgres://x',
        '--env-file',
        '/etc/kici/o.env',
      ]);
      expect(exitCode).toBeNull();
      expect(stdout).toContain("Secret 'K' set in scope 'staging' for org org-1 (direct).");
      expect(stderr).toContain(UNCONFIRMED_KEY_WARNING);
      expect(UNCONFIRMED_KEY_WARNING).toContain('kici-admin secret verify');
      // breaks-if-wrong: a key the store confirmed writes with no warning
      mockSetSecretDirect.mockResolvedValue({ keyConfirmed: true });
      const confirmed = await runCommand([
        'secret',
        'set',
        'org-1',
        'staging',
        'K',
        '--value',
        'v',
        '--database-url',
        'postgres://x',
      ]);
      expect(confirmed.stderr).not.toContain('confirms the master key');
    });
  });

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
      mockSetSecretDirect.mockResolvedValue({ keyConfirmed: true });
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
      expect(mockSetSecretDirect).toHaveBeenCalledWith(
        'postgres://x',
        { orgId: 'org-1', scope: 'staging', key: 'DEPLOY_KEY', value: 'v1' },
        DIRECT_SETTINGS,
      );
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
    it("scopes prints every backend's scopes in qualified form", async () => {
      const client = makeMockClient();
      client.listScopes.mockResolvedValue({ scopes: ['pg:staging', 'vault:aws/prod'] });
      const { stdout, exitCode } = await runCommand(['secret', 'scopes', 'org-1'], client);
      expect(exitCode).toBeNull();
      // breaks-if-wrong: the listing must still reach the client with only the org.
      expect(client.listScopes).toHaveBeenCalledWith('org-1');
      expect(stdout).toContain('pg:staging');
      expect(stdout).toContain('vault:aws/prod');
    });

    // fails-when: the option is registered again. Every backend is listed by
    //   default, so there is nothing left for the flag to opt into.
    it('scopes refuses the removed --all-backends flag', async () => {
      const program = new Command();
      program.exitOverride();
      program.configureOutput({ writeErr: () => {} });
      registerSecretCommands(program, () => makeMockClient() as any);
      await expect(
        program.parseAsync(['secret', 'scopes', 'org-1', '--all-backends'], { from: 'user' }),
      ).rejects.toThrow(/unknown option '--all-backends'/);
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

  // ── secret scope create|rename|delete ───────────────────────────────────
  describe('scope create / rename / delete', () => {
    it('create sends the org and the scope as typed, backend qualifier included', async () => {
      const client = makeMockClient();
      client.createScope.mockResolvedValue({ created: true });
      const { stdout, exitCode } = await runCommand(
        ['secret', 'scope', 'create', 'org-1', 'pg:aws/prod'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.createScope).toHaveBeenCalledWith('org-1', 'pg:aws/prod');
      expect(stdout).toContain("Secret scope 'pg:aws/prod' created for org org-1.");
    });

    it('create --json prints the route response', async () => {
      const client = makeMockClient();
      client.createScope.mockResolvedValue({ created: true });
      const { stdout } = await runCommand(
        ['secret', 'scope', 'create', 'org-1', 'staging', '--json'],
        client,
      );
      expect(JSON.parse(stdout)).toEqual({ created: true });
    });

    it('rename sends the old and the new scope name', async () => {
      const client = makeMockClient();
      client.renameScope.mockResolvedValue({ renamed: true });
      const { stdout, exitCode } = await runCommand(
        ['secret', 'scope', 'rename', 'org-1', 'aws/prod', 'aws/production'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.renameScope).toHaveBeenCalledWith('org-1', 'aws/prod', 'aws/production');
      expect(stdout).toContain("Secret scope 'aws/prod' renamed to 'aws/production'");
    });

    it('rename exits 1 with the route error when the destination exists', async () => {
      // fails-when: the action swallows the rejection and exits 0 — a refused
      //   rename would then read as a success in a script.
      const client = makeMockClient();
      client.renameScope.mockRejectedValue(
        new Error("HTTP 409: Secret scope 'aws/staging' already exists"),
      );
      const { stderr, exitCode } = await runCommand(
        ['secret', 'scope', 'rename', 'org-1', 'aws/prod', 'aws/staging'],
        client,
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain('HTTP 409');
    });

    it('delete with --yes skips the prompt and deletes the scope', async () => {
      const client = makeMockClient();
      client.deleteScope.mockResolvedValue({ deleted: true });
      const { stdout, exitCode } = await runCommand(
        ['secret', 'scope', 'delete', 'org-1', 'staging', '--yes'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.deleteScope).toHaveBeenCalledWith('org-1', 'staging');
      expect(stdout).toContain("Secret scope 'staging' deleted for org org-1.");
    });

    it('delete --yes --json prints the route response', async () => {
      const client = makeMockClient();
      client.deleteScope.mockResolvedValue({ deleted: true });
      const { stdout } = await runCommand(
        ['secret', 'scope', 'delete', 'org-1', 'staging', '--yes', '--json'],
        client,
      );
      expect(JSON.parse(stdout)).toEqual({ deleted: true });
    });

    it('create exits 1 when a required argument is missing', async () => {
      // fails-when: the scope argument is declared optional, so the verb
      //   would reach the orchestrator with an undefined scope.
      const client = makeMockClient();
      const program = new Command();
      program.exitOverride();
      program.configureOutput({ writeErr: () => {} });
      registerSecretCommands(program, () => client as any);
      await expect(
        program.parseAsync(['secret', 'scope', 'create', 'org-1'], { from: 'user' }),
      ).rejects.toThrow(/missing required argument 'scope'/);
      expect(client.createScope).not.toHaveBeenCalled();
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
