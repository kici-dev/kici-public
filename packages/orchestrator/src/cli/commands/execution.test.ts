import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

const mockListExecutionRunsDirect = vi.fn();
const mockShowExecutionRunDirect = vi.fn();

vi.mock('@kici-dev/shared', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    listExecutionRunsDirect: mockListExecutionRunsDirect,
    showExecutionRunDirect: mockShowExecutionRunDirect,
  };
});

const { registerExecutionCommands } = await import('./execution.js');

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
  registerExecutionCommands(program, () => client as any);

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

describe('kici-admin execution CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.KICI_DATABASE_URL;
  });

  it('list returns runs table in direct-DB mode', async () => {
    mockListExecutionRunsDirect.mockResolvedValue({
      runs: [
        {
          id: 'u-1',
          run_id: 'run-1',
          workflow_name: 'ci',
          status: 'success',
          provider: 'github',
          repo_identifier: 'o/r',
          ref: 'refs/heads/main',
          sha: 'abc',
          routing_key: 'rk',
          environment: 'staging',
          trust_tier: null,
          created_at: '2026-04-19',
          started_at: '2026-04-19',
          completed_at: null,
          duration_ms: null,
        },
      ],
    });
    const { stdout, exitCode } = await runCommand([
      'execution',
      'list',
      '--database-url',
      'postgres://x',
    ]);
    expect(exitCode).toBeNull();
    expect(mockListExecutionRunsDirect).toHaveBeenCalledWith('postgres://x', {
      routingKey: undefined,
      status: undefined,
      workflowName: undefined,
      limit: undefined,
    });
    expect(stdout).toContain('ci');
    expect(stdout).toContain('success');
  });

  it('list forwards filters', async () => {
    mockListExecutionRunsDirect.mockResolvedValue({ runs: [] });
    await runCommand([
      'execution',
      'list',
      '--routing-key',
      'rk',
      '--status',
      'failed',
      '--workflow-name',
      'ci',
      '--limit',
      '10',
      '--database-url',
      'postgres://x',
    ]);
    expect(mockListExecutionRunsDirect).toHaveBeenCalledWith('postgres://x', {
      routingKey: 'rk',
      status: 'failed',
      workflowName: 'ci',
      limit: 10,
    });
  });

  it('list uses HTTP when no dbUrl', async () => {
    const client = makeMockClient();
    client.get.mockResolvedValue({ runs: [] });
    await runCommand(['execution', 'list', '--workflow-name', 'ci'], client);
    expect(client.get).toHaveBeenCalledWith('/api/v1/admin/executions?workflowName=ci');
  });

  it('show prints run + jobs in direct-DB mode', async () => {
    mockShowExecutionRunDirect.mockResolvedValue({
      run: {
        id: 'u-1',
        run_id: 'run-1',
        workflow_name: 'ci',
        status: 'success',
        provider: 'github',
        repo_identifier: 'o/r',
        ref: 'refs/heads/main',
        sha: 'abc',
        routing_key: 'rk',
        environment: 'staging',
        trust_tier: null,
        created_at: '2026-04-19',
        started_at: '2026-04-19',
        completed_at: '2026-04-19',
        duration_ms: 1000,
      },
      jobs: [
        {
          id: 'j-1',
          run_id: 'u-1',
          job_id: 'jid-1',
          job_name: 'build',
          status: 'success',
          agent_id: 'a-1',
          started_at: '2026-04-19',
          completed_at: '2026-04-19',
          duration_ms: 500,
          created_at: '2026-04-19',
        },
      ],
    });
    const { stdout, exitCode } = await runCommand([
      'execution',
      'show',
      'run-1',
      '--database-url',
      'postgres://x',
    ]);
    expect(exitCode).toBeNull();
    expect(stdout).toContain('run_id:');
    expect(stdout).toContain('workflow:   ci');
    expect(stdout).toContain('build');
    expect(stdout).toContain('status=success');
  });

  it('show surfaces not-found error', async () => {
    mockShowExecutionRunDirect.mockRejectedValue(
      new Error('execution: run not found (run_id=ghost)'),
    );
    const { stderr, exitCode } = await runCommand([
      'execution',
      'show',
      'ghost',
      '--database-url',
      'postgres://x',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('run not found');
  });
});
