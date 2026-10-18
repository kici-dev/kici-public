import { describe, expect, it, vi, beforeEach } from 'vitest';
import { runCli } from '../../__test-helpers__/cli.js';

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
  return {
    ...(await runCli((p) => registerExecutionCommands(p, () => client as any), args)),
    client,
  };
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
      '0a1b2c3d-0000-4000-8000-0000000000e1',
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
      '0a1b2c3d-0000-4000-8000-0000000000e1',
      '--database-url',
      'postgres://x',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('run not found');
  });

  it('show resolves a short run id over the admin API', async () => {
    const full = '709c899a-b06f-45d0-a3e2-d0a14fa62094';
    const client = makeMockClient() as MockClient & { listRuns: ReturnType<typeof vi.fn> };
    client.listRuns = vi.fn().mockResolvedValue({ runs: [{ runId: full }], total: 1 });
    client.get.mockResolvedValue({ run: { run_id: full }, jobs: [] });
    await runCommand(['execution', 'show', '709c899a'], client);
    // fails-when: the short id is sent to /executions/:runId, which Postgres rejects
    expect(client.get).toHaveBeenCalledWith(`/api/v1/admin/executions/${full}`);
  });

  it('show refuses a short run id in direct-database mode before connecting', async () => {
    const { stderr, exitCode } = await runCommand([
      'execution',
      'show',
      '709c899a',
      '--database-url',
      'postgres://x',
    ]);
    expect(exitCode).toBe(1);
    // fails-when: the prefix reaches the uuid column as a raw pg error
    expect(stderr).toContain('--database-url needs a full run id');
    expect(mockShowExecutionRunDirect).not.toHaveBeenCalled();
  });
});
