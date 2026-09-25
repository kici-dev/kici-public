import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

// Shared mock fns for *Direct helpers + AdminApiClient
const mockSeedContextDirect = vi.fn();
const mockSeedContextBindingDirect = vi.fn();
const mockSetContextPolicyDirect = vi.fn();
const mockListContextsDirect = vi.fn();
const mockShowContextDirect = vi.fn();
const mockCreateContextTemplateDirect = vi.fn();
const mockDeleteContextDirect = vi.fn();

vi.mock('@kici-dev/shared', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    seedContextDirect: mockSeedContextDirect,
    seedContextBindingDirect: mockSeedContextBindingDirect,
    setContextPolicyDirect: mockSetContextPolicyDirect,
    listContextsDirect: mockListContextsDirect,
    showContextDirect: mockShowContextDirect,
    createContextTemplateDirect: mockCreateContextTemplateDirect,
    deleteContextDirect: mockDeleteContextDirect,
  };
});

const { registerContextCommands } = await import('./context.js');
const { unboundContextWarning } = await import('./shared/unbound-context-warning.js');
const { ContextType } = await import('@kici-dev/engine');

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

  registerContextCommands(program, () => client as any);

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

describe('kici-admin context CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.KICI_DATABASE_URL;
  });

  describe('create', () => {
    it('creates a context in direct-DB mode with policy fields', async () => {
      mockSeedContextDirect.mockResolvedValue({ envId: 'env-123', created: true });
      const { stdout, exitCode } = await runCommand([
        'context',
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
      expect(mockSeedContextDirect).toHaveBeenCalledWith(
        'postgres://localhost/test',
        expect.objectContaining({
          orgId: 'org-1',
          name: 'staging',
          type: 'fixed',
          branchRestrictions: ['main'],
          requiredReviewers: ['user-1', 'user-2'],
          waitTimerSeconds: 60,
        }),
      );
      // fails-when: create defaults --enabled, so a re-run re-enables a disabled context
      expect(mockSeedContextDirect.mock.calls[0][1].enabled).toBeUndefined();
      expect(stdout).toContain('envId=env-123');
      expect(stdout).toContain('created=true');
      expect(stdout).toContain('(direct)');
    });

    it('creates a context in HTTP mode', async () => {
      const client = makeMockClient();
      client.post.mockResolvedValue({ envId: 'env-abc', created: true });
      const { stdout, exitCode } = await runCommand(
        ['context', 'create', '--org', 'org-1', '--name', 'production'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.post).toHaveBeenCalledWith(
        '/api/v1/admin/contexts',
        expect.objectContaining({ orgId: 'org-1', name: 'production' }),
      );
      expect(mockSeedContextDirect).not.toHaveBeenCalled();
      expect(stdout).toContain('envId=env-abc');
      expect(stdout).not.toContain('(direct)');
      // fails-when: the HTTP body carries enabled without --enabled, re-enabling the context
      // (an undefined field is dropped when the client serialises the body)
      expect(JSON.parse(JSON.stringify(client.post.mock.calls[0][1]))).not.toHaveProperty(
        'enabled',
      );
    });

    it('sends enabled only when --enabled is given (both modes)', async () => {
      const client = makeMockClient();
      client.post.mockResolvedValue({ envId: 'env-abc', created: false });
      await runCommand(
        ['context', 'create', '--org', 'org-1', '--name', 'production', '--enabled', 'false'],
        client,
      );
      // breaks-if-wrong: an explicit --enabled must still reach the orchestrator
      expect(client.post.mock.calls[0][1]).toMatchObject({ enabled: false });
      mockSeedContextDirect.mockResolvedValue({ envId: 'env-1', created: false });
      await runCommand([
        'context',
        'create',
        '--org',
        'org-1',
        '--name',
        'production',
        '--enabled',
        'true',
        '--database-url',
        'postgres://localhost/test',
      ]);
      expect(mockSeedContextDirect.mock.calls[0][1]).toMatchObject({ enabled: true });
    });

    // A fixed context's secrets reach a job only through its bindings, so a
    // create that leaves a fixed context unbound warns; the exit code stays 0.
    it('warns on stderr when the created context has no binding (direct-DB)', async () => {
      mockSeedContextDirect.mockResolvedValue({ envId: 'env-1', created: true });
      mockListContextsDirect.mockResolvedValue({
        contexts: [{ name: 'staging', type: ContextType.enum.fixed }],
      });
      mockShowContextDirect.mockResolvedValue({
        context: { name: 'staging', type: ContextType.enum.fixed },
        variables: [],
        bindings: [],
      });
      const { stderr, exitCode } = await runCommand([
        'context',
        'create',
        '--org',
        'org-1',
        '--name',
        'staging',
        '--database-url',
        'postgres://localhost/test',
      ]);
      // fails-when: create leaves a bindingless fixed context without a warning
      expect(stderr).toContain(unboundContextWarning('org-1', 'staging', ContextType.enum.fixed));
      expect(exitCode).toBeNull();
    });

    it('prints no warning when an updated context is already bound (HTTP)', async () => {
      const client = makeMockClient();
      client.post.mockResolvedValue({ envId: 'env-1', created: false });
      client.get.mockImplementation(async (path: string) =>
        path.startsWith('/api/v1/admin/contexts?')
          ? { contexts: [{ name: 'staging', type: ContextType.enum.fixed }] }
          : {
              context: { name: 'staging', type: ContextType.enum.fixed },
              variables: [],
              bindings: [{ scope_pattern: 'staging', host_pattern: '**' }],
            },
      );
      // breaks-if-wrong: a bound context must be created or updated silently
      const { stderr, exitCode } = await runCommand(
        ['context', 'create', '--org', 'org-1', '--name', 'staging'],
        client,
      );
      expect(client.get).toHaveBeenCalledWith('/api/v1/admin/contexts/staging?orgId=org-1');
      expect(stderr).not.toContain('has no binding');
      expect(exitCode).toBeNull();
    });

    it('fails when direct-DB helper throws', async () => {
      mockSeedContextDirect.mockRejectedValue(new Error('upsert failed'));
      const { stderr, exitCode } = await runCommand([
        'context',
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
        'context',
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
        'context',
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
        'context',
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
      mockSeedContextDirect.mockResolvedValue({ envId: 'env-glob', created: true });
      const { exitCode } = await runCommand([
        'context',
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
      expect(mockSeedContextDirect).toHaveBeenCalledWith(
        'postgres://localhost/test',
        expect.objectContaining({ globPattern: 'review/*' }),
      );
    });
  });

  describe('bind', () => {
    it('binds a scope pattern in direct-DB mode', async () => {
      mockSeedContextBindingDirect.mockResolvedValue({ created: true });
      const { stdout, exitCode } = await runCommand([
        'context',
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
      expect(mockSeedContextBindingDirect).toHaveBeenCalledWith('postgres://local', {
        orgId: 'o',
        contextName: 'staging',
        scopePattern: 'staging',
        hostPattern: '**',
      });
      expect(stdout).toContain('created=true');
      expect(stdout).toContain('(direct)');
    });

    it('binds via HTTP API', async () => {
      const client = makeMockClient();
      client.post.mockResolvedValue({ created: true });
      const { stdout, exitCode } = await runCommand(
        ['context', 'bind', '--org', 'o', '--env', 'production', '--scope', 'aws/prod/**'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.post).toHaveBeenCalledWith('/api/v1/admin/contexts/production/bind', {
        orgId: 'o',
        scopePattern: 'aws/prod/**',
        hostPattern: '**',
      });
      expect(stdout).toContain('created=true');
    });

    it('passes --host through to the HTTP API', async () => {
      const client = makeMockClient();
      client.post.mockResolvedValue({ created: true });
      const { exitCode } = await runCommand(
        [
          'context',
          'bind',
          '--org',
          'o',
          '--env',
          'production',
          '--scope',
          'prod/hosts/box-00002/**',
          '--host',
          'box-00002',
        ],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.post).toHaveBeenCalledWith('/api/v1/admin/contexts/production/bind', {
        orgId: 'o',
        scopePattern: 'prod/hosts/box-00002/**',
        hostPattern: 'box-00002',
      });
    });

    it('propagates direct-DB helper errors', async () => {
      mockSeedContextBindingDirect.mockRejectedValue(
        new Error('context: not found (org=o, name=ghost)'),
      );
      const { stderr, exitCode } = await runCommand([
        'context',
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
      mockSetContextPolicyDirect.mockResolvedValue(undefined);
      const { stdout, exitCode } = await runCommand([
        'context',
        'set-policy',
        '--org',
        'o',
        '--env',
        'staging',
        '--wait-timer',
        '120',
        '--minimum-trust',
        'trusted',
        '--database-url',
        'postgres://local',
      ]);
      expect(exitCode).toBeNull();
      expect(mockSetContextPolicyDirect).toHaveBeenCalledWith(
        'postgres://local',
        expect.objectContaining({
          orgId: 'o',
          contextName: 'staging',
          waitTimerSeconds: 120,
          minimumTrust: 'trusted',
        }),
      );
      const callArgs = mockSetContextPolicyDirect.mock.calls[0][1];
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
          'context',
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
        '/api/v1/admin/contexts/prod/policy',
        expect.objectContaining({
          orgId: 'o',
          contextName: 'prod',
          branchRestrictions: ['main', 'release/*'],
        }),
      );
    });

    // fails-when: the removed `known` tier is parsed again. Direct-DB mode has
    //   no route schema behind it, so the CLI is the only place the value is
    //   checked before it reaches the row.
    it.each(['create', 'set-policy', 'create-template'])(
      '%s refuses --minimum-trust known and names the accepted value',
      async (sub) => {
        const target =
          sub === 'create'
            ? ['--name', 'staging']
            : sub === 'set-policy'
              ? ['--env', 'staging']
              : ['--template', 'base'];
        const { stderr, exitCode } = await runCommand([
          'context',
          sub,
          '--org',
          'o',
          ...target,
          '--minimum-trust',
          'known',
          '--database-url',
          'postgres://local',
        ]);
        expect(exitCode).toBe(1);
        expect(stderr).toMatch(/--minimum-trust/);
        expect(stderr).toMatch(/trusted/);
        expect(mockSeedContextDirect).not.toHaveBeenCalled();
        expect(mockSetContextPolicyDirect).not.toHaveBeenCalled();
        expect(mockCreateContextTemplateDirect).not.toHaveBeenCalled();
      },
    );

    // breaks-if-wrong: "null" still clears the floor on set-policy.
    it('set-policy --minimum-trust null clears the floor (direct mode)', async () => {
      mockSetContextPolicyDirect.mockResolvedValue(undefined);
      const { exitCode } = await runCommand([
        'context',
        'set-policy',
        '--org',
        'o',
        '--env',
        'staging',
        '--minimum-trust',
        'null',
        '--database-url',
        'postgres://local',
      ]);
      expect(exitCode).toBeNull();
      expect(mockSetContextPolicyDirect).toHaveBeenCalledWith(
        'postgres://local',
        expect.objectContaining({ minimumTrust: null }),
      );
    });

    it('sends allowLocalExecution=true when --allow-local-execution true (direct mode)', async () => {
      mockSetContextPolicyDirect.mockResolvedValue(undefined);
      const { stdout, exitCode } = await runCommand([
        'context',
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
      const callArgs = mockSetContextPolicyDirect.mock.calls[0][1];
      expect(callArgs.allowLocalExecution).toBe(true);
      expect(stdout).toContain('set-policy');
    });

    it('sends allowLocalExecution=false when --allow-local-execution false (HTTP mode)', async () => {
      const client = makeMockClient();
      client.patch.mockResolvedValue({});
      const { exitCode } = await runCommand(
        [
          'context',
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
        '/api/v1/admin/contexts/staging/policy',
        expect.objectContaining({ allowLocalExecution: false }),
      );
    });

    it('surfaces env-not-found error', async () => {
      mockSetContextPolicyDirect.mockRejectedValue(
        new Error('context: not found (org=o, name=ghost)'),
      );
      const { stderr, exitCode } = await runCommand([
        'context',
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

    it('sends null when --hold-expiry is empty, so the column is cleared', async () => {
      // `Number('') === 0`, so a plain integer parse turns "clear" into a
      // 0-second expiry — which cancels every hold on the context.
      mockSetContextPolicyDirect.mockResolvedValue(undefined);
      const { exitCode } = await runCommand([
        'context',
        'set-policy',
        '--org',
        'o',
        '--env',
        'staging',
        '--hold-expiry',
        '',
        '--database-url',
        'postgres://local',
      ]);
      expect(exitCode).toBeNull();
      const callArgs = mockSetContextPolicyDirect.mock.calls[0][1];
      expect(callArgs.holdExpirySeconds).toBeNull();
    });

    it('sends a positive --hold-expiry unchanged', async () => {
      mockSetContextPolicyDirect.mockResolvedValue(undefined);
      const { exitCode } = await runCommand([
        'context',
        'set-policy',
        '--org',
        'o',
        '--env',
        'staging',
        '--hold-expiry',
        '900',
        '--database-url',
        'postgres://local',
      ]);
      expect(exitCode).toBeNull();
      const callArgs = mockSetContextPolicyDirect.mock.calls[0][1];
      expect(callArgs.holdExpirySeconds).toBe(900);
    });

    it('omits holdExpirySeconds entirely when --hold-expiry is not passed', async () => {
      mockSetContextPolicyDirect.mockResolvedValue(undefined);
      const { exitCode } = await runCommand([
        'context',
        'set-policy',
        '--org',
        'o',
        '--env',
        'staging',
        '--wait-timer',
        '60',
        '--database-url',
        'postgres://local',
      ]);
      expect(exitCode).toBeNull();
      const callArgs = mockSetContextPolicyDirect.mock.calls[0][1];
      expect('holdExpirySeconds' in callArgs).toBe(false);
    });

    it('exits non-zero on a non-numeric --hold-expiry', async () => {
      mockSetContextPolicyDirect.mockResolvedValue(undefined);
      const { stderr, exitCode } = await runCommand([
        'context',
        'set-policy',
        '--org',
        'o',
        '--env',
        'staging',
        '--hold-expiry',
        'abc',
        '--database-url',
        'postgres://local',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('--hold-expiry');
    });
  });

  describe('list', () => {
    it('lists contexts in direct-DB mode (table)', async () => {
      mockListContextsDirect.mockResolvedValue({
        contexts: [
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
        'context',
        'list',
        '--org',
        'o',
        '--database-url',
        'postgres://local',
      ]);
      expect(exitCode).toBeNull();
      expect(mockListContextsDirect).toHaveBeenCalledWith('postgres://local', { orgId: 'o' });
      expect(stdout).toContain('staging');
      expect(stdout).toContain('fixed');
      expect(stdout).toContain('NAME');
    });

    it('emits raw JSON with --json', async () => {
      mockListContextsDirect.mockResolvedValue({ contexts: [] });
      const { stdout, exitCode } = await runCommand([
        'context',
        'list',
        '--org',
        'o',
        '--database-url',
        'postgres://local',
        '--json',
      ]);
      expect(exitCode).toBeNull();
      const parsed = JSON.parse(stdout);
      expect(parsed).toEqual({ contexts: [] });
    });

    it('uses HTTP GET when no dbUrl', async () => {
      const client = makeMockClient();
      client.get.mockResolvedValue({ contexts: [] });
      const { exitCode } = await runCommand(['context', 'list', '--org', 'o-42'], client);
      expect(exitCode).toBeNull();
      expect(client.get).toHaveBeenCalledWith('/api/v1/admin/contexts?orgId=o-42');
    });
  });

  describe('show', () => {
    it('prints env + variables + bindings in direct mode', async () => {
      mockShowContextDirect.mockResolvedValue({
        context: {
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
        'context',
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
      mockShowContextDirect.mockRejectedValue(new Error('context: not found (org=o, name=ghost)'));
      const { stderr, exitCode } = await runCommand([
        'context',
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
    it('deletes a context in direct-DB mode', async () => {
      mockDeleteContextDirect.mockResolvedValue({ deleted: true });
      const { exitCode } = await runCommand([
        'context',
        'delete',
        '--org',
        'org1',
        '--name',
        'review',
        '--database-url',
        'postgres://local',
      ]);
      expect(exitCode).toBeNull();
      expect(mockDeleteContextDirect).toHaveBeenCalledWith('postgres://local', {
        orgId: 'org1',
        name: 'review',
      });
    });

    it('exits 1 when the context is not found (direct mode)', async () => {
      mockDeleteContextDirect.mockResolvedValue({ deleted: false });
      const { stderr, exitCode } = await runCommand([
        'context',
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
        ['context', 'delete', '--org', 'org1', '--name', 'review'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.delete).toHaveBeenCalledWith('/api/v1/admin/contexts/review?orgId=org1');
    });
  });

  describe('create-template', () => {
    it('creates template with variables in direct-DB mode', async () => {
      mockCreateContextTemplateDirect.mockResolvedValue({
        envId: 'tmpl-1',
        created: true,
        variablesSet: 2,
      });
      const { stdout, exitCode } = await runCommand([
        'context',
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
      expect(mockCreateContextTemplateDirect).toHaveBeenCalledWith(
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
        'context',
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
        ['context', 'create-template', '--org', 'o', '--template', 't'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.post).toHaveBeenCalledWith(
        '/api/v1/admin/contexts/templates',
        expect.objectContaining({ orgId: 'o', templateName: 't' }),
      );
    });
  });

  describe('--repo-patterns', () => {
    const DB = ['--database-url', 'postgres://local'];

    it('create passes the parsed patterns in direct-DB mode', async () => {
      mockSeedContextDirect.mockResolvedValue({ envId: 'env-1', created: true });
      const { exitCode } = await runCommand([
        'context',
        'create',
        '--org',
        'o',
        '--name',
        'deploy',
        '--repo-patterns',
        '["acme/workflows","acme/*"]',
        ...DB,
      ]);
      expect(exitCode).toBeNull();
      expect(mockSeedContextDirect).toHaveBeenCalledWith(
        'postgres://local',
        expect.objectContaining({ repoPatterns: ['acme/workflows', 'acme/*'] }),
      );
    });

    it('create sends the patterns over HTTP', async () => {
      const client = makeMockClient();
      client.post.mockResolvedValue({ envId: 'env-2', created: true });
      const { exitCode } = await runCommand(
        ['context', 'create', '--org', 'o', '--name', 'deploy', '--repo-patterns', '["acme/*"]'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.post).toHaveBeenCalledWith(
        '/api/v1/admin/contexts',
        expect.objectContaining({ repoPatterns: ['acme/*'] }),
      );
    });

    it('create leaves the patterns unset when the option is omitted', async () => {
      mockSeedContextDirect.mockResolvedValue({ envId: 'env-3', created: false });
      await runCommand(['context', 'create', '--org', 'o', '--name', 'deploy', ...DB]);
      // fails-when: an omitted option is sent as [] and an upsert wipes the stored rule
      expect(mockSeedContextDirect.mock.calls[0][1].repoPatterns).toBeUndefined();
    });

    it('rejects invalid JSON', async () => {
      const { stderr, exitCode } = await runCommand([
        'context',
        'create',
        '--org',
        'o',
        '--name',
        'deploy',
        '--repo-patterns',
        'acme/*',
        ...DB,
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('--repo-patterns');
      expect(stderr.toLowerCase()).toContain('invalid json');
      expect(mockSeedContextDirect).not.toHaveBeenCalled();
    });

    it.each(['"acme/*"', '[1]', '{"a":"b"}'])(
      'rejects %s, which is not an array of strings',
      async (raw) => {
        const { stderr, exitCode } = await runCommand([
          'context',
          'set-policy',
          '--org',
          'o',
          '--env',
          'deploy',
          '--repo-patterns',
          raw,
          ...DB,
        ]);
        // fails-when: the CLI forwards a non-array to direct-DB mode, which has no schema in front
        // breaks-if-wrong: '["acme/*"]' and '[]' (below) must still pass
        expect(exitCode).toBe(1);
        expect(stderr).toContain('--repo-patterns: must be a JSON array of strings');
        expect(mockSetContextPolicyDirect).not.toHaveBeenCalled();
      },
    );

    it('set-policy sets the patterns and an empty array clears them', async () => {
      mockSetContextPolicyDirect.mockResolvedValue(undefined);
      await runCommand([
        'context',
        'set-policy',
        '--org',
        'o',
        '--env',
        'deploy',
        '--repo-patterns',
        '["acme/workflows"]',
        ...DB,
      ]);
      await runCommand([
        'context',
        'set-policy',
        '--org',
        'o',
        '--env',
        'deploy',
        '--repo-patterns',
        '[]',
        ...DB,
      ]);
      expect(mockSetContextPolicyDirect).toHaveBeenNthCalledWith(
        1,
        'postgres://local',
        expect.objectContaining({ repoPatterns: ['acme/workflows'] }),
      );
      expect(mockSetContextPolicyDirect).toHaveBeenNthCalledWith(
        2,
        'postgres://local',
        expect.objectContaining({ repoPatterns: [] }),
      );
    });

    it('set-policy sends the patterns over HTTP', async () => {
      const client = makeMockClient();
      client.patch.mockResolvedValue({ updated: true });
      const { exitCode } = await runCommand(
        ['context', 'set-policy', '--org', 'o', '--env', 'deploy', '--repo-patterns', '["a/b"]'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.patch).toHaveBeenCalledWith(
        '/api/v1/admin/contexts/deploy/policy',
        expect.objectContaining({ repoPatterns: ['a/b'] }),
      );
    });

    it('show prints the patterns and --json carries the field', async () => {
      const context = {
        id: 'env-1',
        org_id: 'o',
        name: 'deploy',
        type: 'fixed',
        enabled: true,
        branch_restrictions: [],
        repo_patterns: ['acme/workflows'],
        required_reviewers: null,
        wait_timer_seconds: null,
        hold_expiry_seconds: null,
        minimum_trust: null,
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
      };
      mockShowContextDirect.mockResolvedValue({ context, variables: [], bindings: [] });
      const table = await runCommand(['context', 'show', '--org', 'o', '--name', 'deploy', ...DB]);
      expect(table.stdout).toContain('repos=acme/workflows');
      const json = await runCommand([
        'context',
        'show',
        '--org',
        'o',
        '--name',
        'deploy',
        ...DB,
        '--json',
      ]);
      expect(JSON.parse(json.stdout).context.repo_patterns).toEqual(['acme/workflows']);
    });
  });
});
