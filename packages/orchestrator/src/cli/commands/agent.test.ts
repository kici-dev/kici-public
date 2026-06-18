import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

// Mock pg pool — agent direct-DB list uses createPool from @kici-dev/shared
const mockPoolQuery = vi.fn();
const mockPoolEnd = vi.fn();

vi.mock('@kici-dev/shared', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    createPool: vi.fn(() => ({
      query: mockPoolQuery,
      end: mockPoolEnd,
    })),
  };
});

const { registerAgentCommands } = await import('./agent.js');

interface MockClient {
  get: ReturnType<typeof vi.fn>;
  listAgentTokens: ReturnType<typeof vi.fn>;
  createAgentToken: ReturnType<typeof vi.fn>;
  revokeAgentToken: ReturnType<typeof vi.fn>;
}

function makeMockClient(): MockClient {
  return {
    get: vi.fn(),
    listAgentTokens: vi.fn(),
    createAgentToken: vi.fn(),
    revokeAgentToken: vi.fn(),
  };
}

async function runCommand(
  args: string[],
  client: MockClient = makeMockClient(),
): Promise<{ stdout: string; stderr: string; exitCode: number | null; client: MockClient }> {
  const program = new Command();
  program.exitOverride();
  registerAgentCommands(program, () => client as any);

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

describe('kici-admin agent CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.KICI_DATABASE_URL;
    mockPoolQuery.mockReset();
    mockPoolEnd.mockReset();
  });

  it('list (no flag) uses HTTP listAgentTokens', async () => {
    const client = makeMockClient();
    client.listAgentTokens.mockResolvedValue({
      tokens: [{ id: 't-1', tokenPrefix: 'pre', labels: ['linux'], agentType: 'static' }],
    });
    const { stdout, exitCode } = await runCommand(['agent', 'list'], client);
    expect(exitCode).toBeNull();
    expect(client.listAgentTokens).toHaveBeenCalledWith(undefined);
    expect(stdout).toContain('t-1');
  });

  it('list --include-pending merges the pending endpoint', async () => {
    const client = makeMockClient();
    client.listAgentTokens.mockResolvedValue({
      tokens: [{ id: 't-1', tokenPrefix: 'pre', labels: [], agentType: 'static' }],
    });
    client.get.mockResolvedValue([{ connectionId: 'c-1', address: '1.2.3.4' }]);
    const { stdout, exitCode } = await runCommand(['agent', 'list', '--include-pending'], client);
    expect(exitCode).toBeNull();
    expect(client.get).toHaveBeenCalledWith('/api/v1/agent-tokens/pending');
    expect(stdout).toContain('t-1');
    expect(stdout).toContain('Pending agents (1)');
    expect(stdout).toContain('c-1');
  });

  it('list --include-pending tolerates missing pending endpoint (warns only)', async () => {
    const client = makeMockClient();
    client.listAgentTokens.mockResolvedValue({ tokens: [] });
    client.get.mockRejectedValue(new Error('HTTP 404: not mounted'));
    const { stderr, exitCode } = await runCommand(['agent', 'list', '--include-pending'], client);
    expect(exitCode).toBeNull();
    expect(stderr).toContain('--include-pending failed');
    expect(stderr).toContain('not mounted');
  });

  it('list --database-url uses direct-DB and warns on --include-pending', async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [
        {
          id: 't-1',
          token_prefix: 'pre',
          labels: '["linux"]',
          agent_type: 'static',
          created_at: '2026-04-19',
          last_seen_at: null,
          expires_at: null,
        },
      ],
    });
    const { stdout, stderr, exitCode } = await runCommand([
      'agent',
      'list',
      '--include-pending',
      '--database-url',
      'postgres://x',
    ]);
    expect(exitCode).toBeNull();
    expect(stderr).toContain('--include-pending is ignored in direct-DB mode');
    expect(mockPoolQuery).toHaveBeenCalled();
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);
    expect(stdout).toContain('t-1');
    expect(stdout).toContain('linux');
  });

  it('list --database-url --json emits structured JSON', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const { stdout, exitCode } = await runCommand([
      'agent',
      'list',
      '--database-url',
      'postgres://x',
      '--json',
    ]);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ tokens: [], pendingAgents: [] });
  });

  //: revoke output must surface the kick count so operators can
  // tell at a glance whether the revocation actually closed any
  // in-flight WS connections.
  it('revoke prints "(kicked N agent connections)" using the API kicked count', async () => {
    const client = makeMockClient();
    client.revokeAgentToken.mockResolvedValue({ kicked: 3 });
    const { stdout, exitCode } = await runCommand(['agent', 'revoke', 'tok-abc'], client);
    expect(exitCode).toBeNull();
    expect(client.revokeAgentToken).toHaveBeenCalledExactlyOnceWith('tok-abc');
    expect(stdout).toContain('Agent token tok-abc revoked (kicked 3 agent connections).');
  });

  it('revoke pluralises "connection" vs "connections" correctly when kicked === 1', async () => {
    const client = makeMockClient();
    client.revokeAgentToken.mockResolvedValue({ kicked: 1 });
    const { stdout, exitCode } = await runCommand(['agent', 'revoke', 'tok-xyz'], client);
    expect(exitCode).toBeNull();
    expect(stdout).toContain('Agent token tok-xyz revoked (kicked 1 agent connection).');
  });

  it('revoke reports "kicked 0 agent connections" when no WS was open', async () => {
    const client = makeMockClient();
    client.revokeAgentToken.mockResolvedValue({ kicked: 0 });
    const { stdout, exitCode } = await runCommand(['agent', 'revoke', 'tok-stale'], client);
    expect(exitCode).toBeNull();
    expect(stdout).toContain('Agent token tok-stale revoked (kicked 0 agent connections).');
  });
});
