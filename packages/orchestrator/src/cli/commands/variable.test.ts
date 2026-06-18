import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { registerVariableCommands } = await import('./variable.js');

interface MockClient {
  listVariables: ReturnType<typeof vi.fn>;
  setVariable: ReturnType<typeof vi.fn>;
  deleteVariable: ReturnType<typeof vi.fn>;
}

function makeMockClient(): MockClient {
  return {
    listVariables: vi.fn(),
    setVariable: vi.fn(),
    deleteVariable: vi.fn(),
  };
}

async function runCommand(
  args: string[],
  client: MockClient = makeMockClient(),
): Promise<{ stdout: string; stderr: string; exitCode: number | null; client: MockClient }> {
  const program = new Command();
  program.exitOverride();
  registerVariableCommands(program, () => client as any);

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

describe('kici-admin variable CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.KICI_TEST_VARIABLE_VALUE;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('list', () => {
    it('prints key + locked tag by default', async () => {
      const client = makeMockClient();
      client.listVariables.mockResolvedValue({
        variables: [
          { key: 'DB_URL', value: 'postgres://x', locked: false, updated_at: 't' },
          { key: 'NODE_ENV', value: 'production', locked: true, updated_at: 't' },
        ],
      });
      const { stdout, exitCode } = await runCommand(
        ['variable', 'list', 'org-1', 'production'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.listVariables).toHaveBeenCalledWith('org-1', 'production');
      expect(stdout).toContain('DB_URL');
      expect(stdout).toContain('NODE_ENV');
      expect(stdout).toContain('[locked]');
      expect(stdout).not.toContain('postgres://x');
    });

    it('--values prints inline values', async () => {
      const client = makeMockClient();
      client.listVariables.mockResolvedValue({
        variables: [{ key: 'PORT', value: '8080', locked: false, updated_at: 't' }],
      });
      const { stdout } = await runCommand(
        ['variable', 'list', 'org-1', 'production', '--values'],
        client,
      );
      expect(stdout).toContain('PORT=8080');
    });

    it('handles empty list', async () => {
      const client = makeMockClient();
      client.listVariables.mockResolvedValue({ variables: [] });
      const { stdout } = await runCommand(['variable', 'list', 'org-1', 'production'], client);
      expect(stdout).toContain('No variables');
    });
  });

  describe('get', () => {
    it('prints value when key exists', async () => {
      const client = makeMockClient();
      client.listVariables.mockResolvedValue({
        variables: [{ key: 'PORT', value: '8080', locked: false, updated_at: 't' }],
      });
      const { stdout, exitCode } = await runCommand(
        ['variable', 'get', 'org-1', 'production', 'PORT'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(stdout).toBe('8080');
    });

    it('exits 1 when key missing', async () => {
      const client = makeMockClient();
      client.listVariables.mockResolvedValue({ variables: [] });
      const { stderr, exitCode } = await runCommand(
        ['variable', 'get', 'org-1', 'production', 'NOPE'],
        client,
      );
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/not found/);
    });
  });

  describe('set', () => {
    let tmp: string;
    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'kici-variable-test-'));
    });
    afterEach(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    it('--value sets variable', async () => {
      const client = makeMockClient();
      client.setVariable.mockResolvedValue(undefined);
      const { stdout, exitCode } = await runCommand(
        ['variable', 'set', 'org-1', 'production', 'PORT', '--value', '8080'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.setVariable).toHaveBeenCalledWith(
        'org-1',
        'production',
        'PORT',
        '8080',
        undefined,
      );
      expect(stdout).toContain("Variable 'PORT' set");
    });

    it('--locked forwards lock flag', async () => {
      const client = makeMockClient();
      client.setVariable.mockResolvedValue(undefined);
      const { stdout, exitCode } = await runCommand(
        ['variable', 'set', 'org-1', 'production', 'PORT', '--value', '8080', '--locked'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.setVariable).toHaveBeenCalledWith('org-1', 'production', 'PORT', '8080', true);
      expect(stdout).toContain('[locked]');
    });

    it('--from-env reads value from env var', async () => {
      process.env.KICI_TEST_VARIABLE_VALUE = 'env_value_99';
      const client = makeMockClient();
      client.setVariable.mockResolvedValue(undefined);
      const { exitCode } = await runCommand(
        ['variable', 'set', 'org-1', 'production', 'V', '--from-env', 'KICI_TEST_VARIABLE_VALUE'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.setVariable).toHaveBeenCalledWith(
        'org-1',
        'production',
        'V',
        'env_value_99',
        undefined,
      );
    });

    it('--from-file reads value from file', async () => {
      const path = join(tmp, 'v.txt');
      writeFileSync(path, 'file_value\n', 'utf8');
      const client = makeMockClient();
      client.setVariable.mockResolvedValue(undefined);
      const { exitCode } = await runCommand(
        ['variable', 'set', 'org-1', 'production', 'V', '--from-file', path],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.setVariable).toHaveBeenCalledWith(
        'org-1',
        'production',
        'V',
        'file_value',
        undefined,
      );
    });

    it('--dry-run skips write', async () => {
      const client = makeMockClient();
      const { stdout, exitCode } = await runCommand(
        ['variable', 'set', 'org-1', 'production', 'V', '--value', 'x', '--dry-run'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.setVariable).not.toHaveBeenCalled();
      expect(stdout).toMatch(/\[dry-run\]/);
      expect(stdout).toMatch(/sha256=[0-9a-f]{64}/);
    });

    it('rejects ambiguous input modes', async () => {
      const client = makeMockClient();
      const { stderr, exitCode } = await runCommand(
        ['variable', 'set', 'org-1', 'production', 'V', '--value', 'x', '--from-file', '/dev/null'],
        client,
      );
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/Ambiguous input mode/);
      expect(client.setVariable).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('--yes skips prompt and deletes', async () => {
      const client = makeMockClient();
      client.deleteVariable.mockResolvedValue(undefined);
      const { stdout, exitCode } = await runCommand(
        ['variable', 'delete', 'org-1', 'production', 'V', '--yes'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.deleteVariable).toHaveBeenCalledWith('org-1', 'production', 'V');
      expect(stdout).toContain("deleted from environment 'production'");
    });
  });
});
