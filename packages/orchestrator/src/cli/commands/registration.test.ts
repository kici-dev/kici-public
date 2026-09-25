import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

const mockListRegistrationsDirect = vi.fn();
const mockShowRegistrationDirect = vi.fn();

vi.mock('@kici-dev/shared', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    listRegistrationsDirect: mockListRegistrationsDirect,
    showRegistrationDirect: mockShowRegistrationDirect,
  };
});

const { registerRegistrationCommands } = await import('./registration.js');

interface MockClient {
  get: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function makeMockClient(): MockClient {
  return { get: vi.fn(), patch: vi.fn(), delete: vi.fn() };
}

async function runCommand(
  args: string[],
  client: MockClient = makeMockClient(),
): Promise<{ stdout: string; stderr: string; exitCode: number | null; client: MockClient }> {
  const program = new Command();
  program.exitOverride();
  registerRegistrationCommands(program, () => client as any);

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

describe('kici-admin registration CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.KICI_DATABASE_URL;
  });

  it('list returns table in direct-DB mode', async () => {
    mockListRegistrationsDirect.mockResolvedValue({
      registrations: [
        {
          id: 'uuid-aaaa-bbbb',
          repo_identifier: 'o/r',
          workflow_name: 'ci',
          routing_key: 'rk',
          customer_id: 'c-1',
          trigger_types: ['webhook'],
          disabled: false,
          is_global: false,
          commit_sha: 'sha1',
          source_file: '.kici/workflows/ci.ts',
          created_at: '2026-04-19',
          updated_at: '2026-04-19',
        },
      ],
    });
    const { stdout, exitCode } = await runCommand([
      'registration',
      'list',
      '--org',
      'c-1',
      '--database-url',
      'postgres://x',
    ]);
    expect(exitCode).toBeNull();
    expect(mockListRegistrationsDirect).toHaveBeenCalledWith('postgres://x', {
      customerId: 'c-1',
      routingKey: undefined,
      repoIdentifier: undefined,
      triggerType: undefined,
      limit: undefined,
    });
    expect(stdout).toContain('ci');
    expect(stdout).toContain('o/r');
  });

  it('list uses HTTP when no dbUrl', async () => {
    const client = makeMockClient();
    client.get.mockResolvedValue({ registrations: [], total: 0 });
    await runCommand(['registration', 'list', '--org', 'c-1', '--routing-key', 'rk'], client);
    expect(client.get).toHaveBeenCalledWith(
      '/api/v1/admin/registrations?customerId=c-1&routingKey=rk',
    );
  });

  it('show prints registration details', async () => {
    mockShowRegistrationDirect.mockResolvedValue({
      registration: {
        id: 'uuid-1',
        repo_identifier: 'o/r',
        workflow_name: 'ci',
        routing_key: 'rk',
        customer_id: 'c-1',
        trigger_types: ['webhook', 'cron'],
        disabled: false,
        is_global: false,
        commit_sha: 'sha1',
        source_file: '.kici/workflows/ci.ts',
        created_at: '2026-04-19',
        updated_at: '2026-04-19',
        lock_entry: { name: 'ci' },
        provider_context: {},
      },
      registryVersion: 42,
    });
    const { stdout, exitCode } = await runCommand([
      'registration',
      'show',
      'uuid-1',
      '--database-url',
      'postgres://x',
    ]);
    expect(exitCode).toBeNull();
    expect(stdout).toContain('id:');
    expect(stdout).toContain('triggers:      webhook,cron');
    expect(stdout).toContain('registry_version: 42');
  });

  it('show surfaces not-found error', async () => {
    mockShowRegistrationDirect.mockRejectedValue(new Error('registration: not found (id=ghost)'));
    const { stderr, exitCode } = await runCommand([
      'registration',
      'show',
      'ghost',
      '--database-url',
      'postgres://x',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('registration: not found');
  });

  describe('disable / enable / delete', () => {
    it('disable PATCHes the disable route with disabled: true', async () => {
      const client = makeMockClient();
      client.patch.mockResolvedValue({ disabled: true, registryVersion: 9 });
      const { stdout, exitCode } = await runCommand(['registration', 'disable', 'reg/1'], client);
      expect(exitCode).toBeNull();
      // fails-when: the id is interpolated raw, or the verb sends the wrong flag.
      expect(client.patch).toHaveBeenCalledWith('/api/v1/admin/registrations/reg%2F1/disable', {
        disabled: true,
      });
      expect(stdout).toContain('registration disable: id=reg/1 disabled=true registry_version=9');
    });

    it('enable PATCHes the same route with disabled: false', async () => {
      const client = makeMockClient();
      client.patch.mockResolvedValue({ disabled: false, registryVersion: 10 });
      const { stdout } = await runCommand(['registration', 'enable', 'reg-1', '--json'], client);
      expect(client.patch).toHaveBeenCalledWith('/api/v1/admin/registrations/reg-1/disable', {
        disabled: false,
      });
      expect(JSON.parse(stdout)).toEqual({ disabled: false, registryVersion: 10 });
    });

    it('disable exits 1 with the route error for an unknown id', async () => {
      const client = makeMockClient();
      client.patch.mockRejectedValue(new Error('HTTP 404: Registration not found'));
      const { stderr, exitCode } = await runCommand(['registration', 'disable', 'ghost'], client);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('HTTP 404: Registration not found');
    });

    it('delete --yes DELETEs the registration without prompting', async () => {
      const client = makeMockClient();
      client.delete.mockResolvedValue({ deleted: true, registryVersion: 11 });
      const { stdout, exitCode } = await runCommand(
        ['registration', 'delete', 'reg-1', '--yes', '--json'],
        client,
      );
      expect(exitCode).toBeNull();
      expect(client.delete).toHaveBeenCalledWith('/api/v1/admin/registrations/reg-1');
      expect(JSON.parse(stdout)).toEqual({ deleted: true, registryVersion: 11 });
    });
  });
});
