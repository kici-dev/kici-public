import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

const mockListQueueDirect = vi.fn();
const mockShowQueueEntryDirect = vi.fn();

vi.mock('@kici-dev/shared', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    listQueueDirect: mockListQueueDirect,
    showQueueEntryDirect: mockShowQueueEntryDirect,
  };
});

const { registerQueueCommands } = await import('./queue.js');

interface MockClient {
  get: ReturnType<typeof vi.fn>;
}

function makeMockClient(): MockClient {
  return { get: vi.fn() };
}

async function runCommand(
  args: string[],
  client: MockClient = makeMockClient(),
): Promise<{ stdout: string; stderr: string; exitCode: number | null; client: MockClient }> {
  const program = new Command();
  program.exitOverride();
  registerQueueCommands(program, () => client as any);

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

describe('kici-admin queue CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.KICI_DATABASE_URL;
  });

  it('list returns table in direct-DB mode', async () => {
    mockListQueueDirect.mockResolvedValue({
      entries: [
        {
          id: 'uuid-1234-abcd',
          run_id: 'run-5678-efgh',
          workflow_name: 'ci',
          job_name: 'build',
          status: 'pending',
          routing_key: 'github:42',
          provider: 'github',
          created_at: '2026-04-19',
          expires_at: null,
          delivery_id: 'del-1',
        },
      ],
    });
    const { stdout, exitCode } = await runCommand([
      'queue',
      'list',
      '--database-url',
      'postgres://x',
    ]);
    expect(exitCode).toBeNull();
    expect(mockListQueueDirect).toHaveBeenCalledWith('postgres://x', {
      status: undefined,
      jobNamePrefix: undefined,
      limit: undefined,
    });
    expect(stdout).toContain('build');
    expect(stdout).toContain('pending');
  });

  it('list passes filters through', async () => {
    mockListQueueDirect.mockResolvedValue({ entries: [] });
    await runCommand([
      'queue',
      'list',
      '--status',
      'dispatched',
      '--job-name-prefix',
      'deploy-',
      '--limit',
      '50',
      '--database-url',
      'postgres://x',
      '--json',
    ]);
    expect(mockListQueueDirect).toHaveBeenCalledWith('postgres://x', {
      status: 'dispatched',
      jobNamePrefix: 'deploy-',
      limit: 50,
    });
  });

  it('list uses HTTP when no dbUrl', async () => {
    const client = makeMockClient();
    client.get.mockResolvedValue({ entries: [] });
    await runCommand(['queue', 'list', '--status', 'pending'], client);
    expect(client.get).toHaveBeenCalledWith('/api/v1/admin/queue?status=pending');
  });

  it('show surfaces not-found error from helper', async () => {
    mockShowQueueEntryDirect.mockRejectedValue(new Error('queue: entry not found (id=ghost)'));
    const { stderr, exitCode } = await runCommand([
      'queue',
      'show',
      'ghost',
      '--database-url',
      'postgres://x',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('queue: entry not found');
  });

  it('show returns row fields on happy path', async () => {
    mockShowQueueEntryDirect.mockResolvedValue({
      id: 'id-1',
      run_id: 'r-1',
      workflow_name: 'ci',
      job_name: 'test',
      status: 'pending',
      routing_key: 'rk',
      provider: 'github',
      created_at: '2026-04-19',
      expires_at: null,
      delivery_id: 'del-1',
    });
    const { stdout, exitCode } = await runCommand([
      'queue',
      'show',
      'id-1',
      '--database-url',
      'postgres://x',
    ]);
    expect(exitCode).toBeNull();
    expect(stdout).toContain('id: id-1');
    expect(stdout).toContain('status: pending');
  });
});
