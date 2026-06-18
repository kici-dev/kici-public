import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

// Shared mock fns for *Direct helpers + AdminApiClient
const mockSeedEnvironmentDirect = vi.fn();
const mockSeedEnvironmentBindingDirect = vi.fn();
const mockSetEnvironmentPolicyDirect = vi.fn();
const mockListEnvironmentsDirect = vi.fn();
const mockShowEnvironmentDirect = vi.fn();
const mockCreateEnvironmentTemplateDirect = vi.fn();
const mockDeleteEnvironmentDirect = vi.fn();

vi.mock('@kici-dev/shared', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    seedEnvironmentDirect: mockSeedEnvironmentDirect,
    seedEnvironmentBindingDirect: mockSeedEnvironmentBindingDirect,
    setEnvironmentPolicyDirect: mockSetEnvironmentPolicyDirect,
    listEnvironmentsDirect: mockListEnvironmentsDirect,
    showEnvironmentDirect: mockShowEnvironmentDirect,
    createEnvironmentTemplateDirect: mockCreateEnvironmentTemplateDirect,
    deleteEnvironmentDirect: mockDeleteEnvironmentDirect,
  };
});

const { registerEnvironmentCommands } = await import('./environment.js');

interface MockClient {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function makeMockClient(): MockClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
}

async function runCommand(
  args: string[],
  client: MockClient = makeMockClient(),
): Promise<{ stdout: string; stderr: string; exitCode: number | null; client: MockClient }> {
  const program = new Command();
  program.exitOverride();

  registerEnvironmentCommands(program, () => client as any);

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
    if (!err.message?.startsWith('EXIT:')) {
      if (!err.code?.startsWith('commander.')) {
        console.log = origLog;
        console.error = origError;
        process.exit = origExit;
        throw err;
      }
    }
  } finally {
    console.log = origLog;
    console.error = origError;
    process.exit = origExit;
  }

  return { stdout: logs.join('\n'), stderr: errors.join('\n'), exitCode, client };
}

describe('kici-admin environment CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.KICI_DATABASE_URL;
  });

  describe('create', () => {
    it('creates an environment in direct-DB mode with policy fields', async () => {
      mockSeedEnvironmentDirect.mockResolvedValue({ envId: 'env-123', created: true });
      const { stdout, exitCode } = await runCommand([
        'environment',
        'create',
        '--org',
        'org-1',
        '--name',
        'staging',
        '--type',
        'fixed',
        '--branch-restrictions',
        '["main"]',
        '--required-reviewers',
        'user-1,user-2',
        '--wait-timer',
        '60',
        '--database-url',
        'postgres://localhost/test',
      ]);
      expect(exitCode).toBeNull();
      expect(mockSeedEnvironmentDirect).toHaveBeenCalledWith(
        'postgres://localhost/test',
        expect.objectContaining({
          orgId: 'org-1',
          name: 'staging',
          type: 'fixed',
          enabled: true,
          branchRestrictions: ['main'],
          requiredReviewers: ['user-1', 'user-2'],
          waitTimerSeconds: 60,
        }),
      );
      expect(stdout).toContain('envId=env-123');
      expect(stdout).toContain('created=true');
      expect(stdout).toContain('(direct)');
    });

    it('creates an environment in HTTP mode', async () => {
      const client = makeMockClient();
      client.post.mockResolvedValue({ envId: 'env-abc', created: true });
      const { stdout, exitCode } = await runCommand(
        ['environment', 'create', '--org', 'org-1', '--name', 'production'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.post).toHaveBeenCalledWith(
        '/api/v1/admin/environments',
        expect.objectContaining({ orgId: 'org-1', name: 'production' }),
      );
      expect(mockSeedEnvironmentDirect).not.toHaveBeenCalled();
      expect(stdout).toContain('envId=env-abc');
      expect(stdout).not.toContain('(direct)');
    });

    it('fails when direct-DB helper throws', async () => {
      mockSeedEnvironmentDirect.mockRejectedValue(new Error('upsert failed'));
      const { stderr, exitCode } = await runCommand([
        'environment',
        'create',
        '--org',
        'o',
        '--name',
        'x',
        '--database-url',
        'postgres://bad',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('upsert failed');
    });

    it('rejects invalid JSON in --branch-restrictions', async () => {
      const { stderr, exitCode } = await runCommand([
        'environment',
        'create',
        '--org',
        'o',
        '--name',
        'x',
        '--branch-restrictions',
        'not-json',
        '--database-url',
        'postgres://local',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('--branch-restrictions');
      expect(stderr.toLowerCase()).toContain('invalid json');
    });

    it('rejects --type glob without --glob-pattern', async () => {
      const { stderr, exitCode } = await runCommand([
        'environment',
        'create',
        '--org',
        'o',
        '--name',
        'review',
        '--type',
        'glob',
        '--database-url',
        'postgres://local',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('--glob-pattern');
    });

    it('rejects --glob-pattern without --type glob', async () => {
      const { stderr, exitCode } = await runCommand([
        'environment',
        'create',
        '--org',
        'o',
        '--name',
        'review',
        '--glob-pattern',
        'x/*',
        '--database-url',
        'postgres://local',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('--type glob');
    });

    it('passes globPattern through in direct-DB mode', async () => {
      mockSeedEnvironmentDirect.mockResolvedValue({ envId: 'env-glob', created: true });
      const { exitCode } = await runCommand([
        'environment',
        'create',
        '--org',
        'org1',
        '--name',
        'review',
        '--type',
        'glob',
        '--glob-pattern',
        'review/*',
        '--database-url',
        'postgres://localhost/test',
      ]);
      expect(exitCode).toBeNull();
      expect(mockSeedEnvironmentDirect).toHaveBeenCalledWith(
        'postgres://localhost/test',
        expect.objectContaining({ globPattern: 'review/*' }),
      );
    });
  });

  describe('bind', () => {
    it('binds a scope pattern in direct-DB mode', async () => {
      mockSeedEnvironmentBindingDirect.mockResolvedValue({ created: true });
      const { stdout, exitCode } = await runCommand([
        'environment',
        'bind',
        '--org',
        'o',
        '--env',
        'staging',
        '--scope',
        'staging',
        '--database-url',
        'postgres://local',
      ]);
      expect(exitCode).toBeNull();
      expect(mockSeedEnvironmentBindingDirect).toHaveBeenCalledWith('postgres://local', {
        orgId: 'o',
        envName: 'staging',
        scopePattern: 'staging',
      });
      expect(stdout).toContain('created=true');
      expect(stdout).toContain('(direct)');
    });

    it('binds via HTTP API', async () => {
      const client = makeMockClient();
      client.post.mockResolvedValue({ created: true });
      const { stdout, exitCode } = await runCommand(
        ['environment', 'bind', '--org', 'o', '--env', 'production', '--scope', 'aws/prod/**'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.post).toHaveBeenCalledWith('/api/v1/admin/environments/production/bind', {
        orgId: 'o',
        scopePattern: 'aws/prod/**',
      });
      expect(stdout).toContain('created=true');
    });

    it('propagates direct-DB helper errors', async () => {
      mockSeedEnvironmentBindingDirect.mockRejectedValue(
        new Error('environment: not found (org=o, name=ghost)'),
      );
      const { stderr, exitCode } = await runCommand([
        'environment',
        'bind',
        '--org',
        'o',
        '--env',
        'ghost',
        '--scope',
        'x',
        '--database-url',
        'postgres://local',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('not found');
    });
  });

  describe('set-policy', () => {
    it('updates only the provided policy fields (direct mode)', async () => {
      mockSetEnvironmentPolicyDirect.mockResolvedValue(undefined);
      const { stdout, exitCode } = await runCommand([
        'environment',
        'set-policy',
        '--org',
        'o',
        '--env',
        'staging',
        '--wait-timer',
        '120',
        '--minimum-trust',
        'known',
        '--database-url',
        'postgres://local',
      ]);
      expect(exitCode).toBeNull();
      expect(mockSetEnvironmentPolicyDirect).toHaveBeenCalledWith(
        'postgres://local',
        expect.objectContaining({
          orgId: 'o',
          envName: 'staging',
          waitTimerSeconds: 120,
          minimumTrust: 'known',
        }),
      );
      const callArgs = mockSetEnvironmentPolicyDirect.mock.calls[0][1];
      // branchRestrictions / requiredReviewers NOT present when not passed
      expect(callArgs.branchRestrictions).toBeUndefined();
      expect(callArgs.requiredReviewers).toBeUndefined();
      expect(stdout).toContain('set-policy');
      expect(stdout).toContain('(direct)');
    });

    it('routes through HTTP PATCH when no dbUrl', async () => {
      const client = makeMockClient();
      client.patch.mockResolvedValue({});
      const { exitCode } = await runCommand(
        [
          'environment',
          'set-policy',
          '--org',
          'o',
          '--env',
          'prod',
          '--branch-restrictions',
          '["main","release/*"]',
        ],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.patch).toHaveBeenCalledWith(
        '/api/v1/admin/environments/prod/policy',
        expect.objectContaining({
          orgId: 'o',
          envName: 'prod',
          branchRestrictions: ['main', 'release/*'],
        }),
      );
    });

    it('sends allowLocalExecution=true when --allow-local-execution true (direct mode)', async () => {
      mockSetEnvironmentPolicyDirect.mockResolvedValue(undefined);
      const { stdout, exitCode } = await runCommand([
        'environment',
        'set-policy',
        '--org',
        'o',
        '--env',
        'staging',
        '--allow-local-execution',
        'true',
        '--database-url',
        'postgres://local',
      ]);
      expect(exitCode).toBeNull();
      const callArgs = mockSetEnvironmentPolicyDirect.mock.calls[0][1];
      expect(callArgs.allowLocalExecution).toBe(true);
      expect(stdout).toContain('set-policy');
    });

    it('sends allowLocalExecution=false when --allow-local-execution false (HTTP mode)', async () => {
      const client = makeMockClient();
      client.patch.mockResolvedValue({});
      const { exitCode } = await runCommand(
        [
          'environment',
          'set-policy',
          '--org',
          'o',
          '--env',
          'staging',
          '--allow-local-execution',
          'false',
        ],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.patch).toHaveBeenCalledWith(
        '/api/v1/admin/environments/staging/policy',
        expect.objectContaining({ allowLocalExecution: false }),
      );
    });

    it('surfaces env-not-found error', async () => {
      mockSetEnvironmentPolicyDirect.mockRejectedValue(
        new Error('environment: not found (org=o, name=ghost)'),
      );
      const { stderr, exitCode } = await runCommand([
        'environment',
        'set-policy',
        '--org',
        'o',
        '--env',
        'ghost',
        '--wait-timer',
        '60',
        '--database-url',
        'postgres://local',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('not found');
    });
  });

  describe('list', () => {
    it('lists environments in direct-DB mode (table)', async () => {
      mockListEnvironmentsDirect.mockResolvedValue({
        environments: [
          {
            id: 'id-1',
            org_id: 'o',
            name: 'staging',
            type: 'fixed',
            enabled: true,
            branch_restrictions: '[]',
            required_reviewers: null,
            wait_timer_seconds: null,
            hold_expiry_seconds: 86400,
            minimum_trust: null,
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
          },
        ],
      });
      const { stdout, exitCode } = await runCommand([
        'environment',
        'list',
        '--org',
        'o',
        '--database-url',
        'postgres://local',
      ]);
      expect(exitCode).toBeNull();
      expect(mockListEnvironmentsDirect).toHaveBeenCalledWith('postgres://local', { orgId: 'o' });
      expect(stdout).toContain('staging');
      expect(stdout).toContain('fixed');
      expect(stdout).toContain('NAME');
    });

    it('emits raw JSON with --json', async () => {
      mockListEnvironmentsDirect.mockResolvedValue({ environments: [] });
      const { stdout, exitCode } = await runCommand([
        'environment',
        'list',
        '--org',
        'o',
        '--database-url',
        'postgres://local',
        '--json',
      ]);
      expect(exitCode).toBeNull();
      const parsed = JSON.parse(stdout);
      expect(parsed).toEqual({ environments: [] });
    });

    it('uses HTTP GET when no dbUrl', async () => {
      const client = makeMockClient();
      client.get.mockResolvedValue({ environments: [] });
      const { exitCode } = await runCommand(['environment', 'list', '--org', 'o-42'], client);
      expect(exitCode).toBeNull();
      expect(client.get).toHaveBeenCalledWith('/api/v1/admin/environments?orgId=o-42');
    });
  });

  describe('show', () => {
    it('prints env + variables + bindings in direct mode', async () => {
      mockShowEnvironmentDirect.mockResolvedValue({
        environment: {
          id: 'env-1',
          org_id: 'o',
          name: 'staging',
          type: 'fixed',
          enabled: true,
          branch_restrictions: '[]',
          required_reviewers: null,
          wait_timer_seconds: null,
          hold_expiry_seconds: 86400,
          minimum_trust: null,
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
        },
        variables: [
          { key: 'API_URL', value: 'https://example.com', locked: false, updated_at: '2026-01-01' },
        ],
        bindings: [{ scope_pattern: 'staging', created_at: '2026-01-01' }],
      });
      const { stdout, exitCode } = await runCommand([
        'environment',
        'show',
        '--org',
        'o',
        '--name',
        'staging',
        '--database-url',
        'postgres://local',
      ]);
      expect(exitCode).toBeNull();
      expect(stdout).toContain('id:');
      expect(stdout).toContain('env-1');
      expect(stdout).toContain('API_URL=https://example.com');
      expect(stdout).toContain('staging');
    });

    it('surfaces not-found error from helper', async () => {
      mockShowEnvironmentDirect.mockRejectedValue(
        new Error('environment: not found (org=o, name=ghost)'),
      );
      const { stderr, exitCode } = await runCommand([
        'environment',
        'show',
        '--org',
        'o',
        '--name',
        'ghost',
        '--database-url',
        'postgres://local',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('not found');
    });
  });

  describe('delete', () => {
    it('deletes an environment in direct-DB mode', async () => {
      mockDeleteEnvironmentDirect.mockResolvedValue({ deleted: true });
      const { exitCode } = await runCommand([
        'environment',
        'delete',
        '--org',
        'org1',
        '--name',
        'review',
        '--database-url',
        'postgres://local',
      ]);
      expect(exitCode).toBeNull();
      expect(mockDeleteEnvironmentDirect).toHaveBeenCalledWith('postgres://local', {
        orgId: 'org1',
        name: 'review',
      });
    });

    it('exits 1 when the environment is not found (direct mode)', async () => {
      mockDeleteEnvironmentDirect.mockResolvedValue({ deleted: false });
      const { stderr, exitCode } = await runCommand([
        'environment',
        'delete',
        '--org',
        'org1',
        '--name',
        'review',
        '--database-url',
        'postgres://local',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr.toLowerCase()).toContain('not found');
    });

    it('issues a DELETE to the admin API in HTTP mode', async () => {
      const client = makeMockClient();
      client.delete.mockResolvedValue({ deleted: true });
      const { exitCode } = await runCommand(
        ['environment', 'delete', '--org', 'org1', '--name', 'review'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.delete).toHaveBeenCalledWith('/api/v1/admin/environments/review?orgId=org1');
    });
  });

  describe('create-template', () => {
    it('creates template with variables in direct-DB mode', async () => {
      mockCreateEnvironmentTemplateDirect.mockResolvedValue({
        envId: 'tmpl-1',
        created: true,
        variablesSet: 2,
      });
      const { stdout, exitCode } = await runCommand([
        'environment',
        'create-template',
        '--org',
        'o',
        '--template',
        'staging-tmpl',
        '--variables',
        '{"K1":"V1","K2":"V2"}',
        '--database-url',
        'postgres://local',
      ]);
      expect(exitCode).toBeNull();
      expect(mockCreateEnvironmentTemplateDirect).toHaveBeenCalledWith(
        'postgres://local',
        expect.objectContaining({
          orgId: 'o',
          templateName: 'staging-tmpl',
          type: 'template',
          variables: { K1: 'V1', K2: 'V2' },
        }),
      );
      expect(stdout).toContain('envId=tmpl-1');
      expect(stdout).toContain('variablesSet=2');
    });

    it('rejects non-object --variables JSON', async () => {
      const { stderr, exitCode } = await runCommand([
        'environment',
        'create-template',
        '--org',
        'o',
        '--template',
        't',
        '--variables',
        '["not","an","object"]',
        '--database-url',
        'postgres://local',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('--variables');
    });

    it('routes through HTTP POST when no dbUrl', async () => {
      const client = makeMockClient();
      client.post.mockResolvedValue({ envId: 't-2', created: false, variablesSet: 0 });
      const { exitCode } = await runCommand(
        ['environment', 'create-template', '--org', 'o', '--template', 't'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.post).toHaveBeenCalledWith(
        '/api/v1/admin/environments/templates',
        expect.objectContaining({ orgId: 'o', templateName: 't' }),
      );
    });
  });
});
