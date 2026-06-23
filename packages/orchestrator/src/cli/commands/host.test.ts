import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

const mockListAll = vi.fn();
const mockGet = vi.fn();
const mockDeclareStatic = vi.fn();

vi.mock('./shared/db.js', () => ({
  withDb: vi.fn(async (fn: (db: any) => Promise<any>) => fn({})),
}));

vi.mock('../../agent/host-roster.js', async (importActual) => {
  const actual = await importActual<typeof import('../../agent/host-roster.js')>();
  return {
    ...actual,
    HostRosterStore: class {
      listAll = mockListAll;
      get = mockGet;
      declareStatic = mockDeclareStatic;
    },
  };
});

const { registerHostCommands } = await import('./host.js');

async function runCommand(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const program = new Command();
  program.exitOverride();
  registerHostCommands(program);

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
      console.log = origLog;
      console.error = origError;
      process.exit = origExit;
      if (err.code?.startsWith('commander.'))
        return { stdout: logs.join('\n'), stderr: errors.join('\n'), exitCode };
      throw err;
    }
  } finally {
    console.log = origLog;
    console.error = origError;
    process.exit = origExit;
  }

  return { stdout: logs.join('\n'), stderr: errors.join('\n'), exitCode };
}

describe('kici-admin host', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('host list prints a table with derived status', async () => {
    mockListAll.mockResolvedValue([
      {
        agent_id: 'web-01',
        lifecycle_class: 'static',
        connected_instance_id: 'orch-A',
        last_seen: new Date(),
        labels: '["role:web"]',
        hostname: 'web-01',
      },
    ]);
    const { stdout } = await runCommand(['host', 'list']);
    expect(stdout).toContain('web-01');
    expect(stdout).toContain('ready');
  });

  it('host list shows unreachable for a declared-never-connected static host', async () => {
    mockListAll.mockResolvedValue([
      {
        agent_id: 'web-09',
        lifecycle_class: 'static',
        connected_instance_id: null,
        last_seen: new Date(),
        labels: '[]',
        hostname: null,
      },
    ]);
    const { stdout } = await runCommand(['host', 'list']);
    expect(stdout).toContain('unreachable');
  });

  it('host list --json emits JSON', async () => {
    mockListAll.mockResolvedValue([]);
    const { stdout } = await runCommand(['host', 'list', '--json']);
    expect(JSON.parse(stdout)).toEqual([]);
  });

  it('host get prints the matching host', async () => {
    mockGet.mockResolvedValue({
      agent_id: 'web-01',
      lifecycle_class: 'static',
      connected_instance_id: 'orch-A',
      last_seen: new Date(),
      labels: '["role:web"]',
      hostname: 'web-01',
    });
    const { stdout } = await runCommand(['host', 'get', '--agent-id', 'web-01']);
    expect(stdout).toContain('web-01');
  });

  it('host get exits non-zero when the host is missing', async () => {
    mockGet.mockResolvedValue(null);
    const { exitCode, stderr } = await runCommand(['host', 'get', '--agent-id', 'nope']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('No host found');
  });

  it('host declare requires --agent-id', async () => {
    const { exitCode } = await runCommand(['host', 'declare']);
    // commander rejects the missing requiredOption under exitOverride
    expect(exitCode).toBe(null);
  });

  it('host declare calls declareStatic with parsed labels', async () => {
    mockDeclareStatic.mockResolvedValue(undefined);
    const { stdout } = await runCommand([
      'host',
      'declare',
      '--agent-id',
      'web-09',
      '--labels',
      'role:web, gpu',
    ]);
    expect(mockDeclareStatic).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'web-09', labels: ['role:web', 'gpu'] }),
    );
    expect(stdout).toContain('Declared static host: web-09');
  });

  it('host declare parses repeatable --prop into a typed properties bag', async () => {
    mockDeclareStatic.mockResolvedValue(undefined);
    await runCommand([
      'host',
      'declare',
      '--agent-id',
      'db-01',
      '--prop',
      'region=eu',
      '--prop',
      'cores=8',
      '--prop',
      'gpu=true',
    ]);
    expect(mockDeclareStatic).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'db-01',
        properties: { region: 'eu', cores: 8, gpu: true },
      }),
    );
  });

  it('host declare rejects a malformed --prop value', async () => {
    const { exitCode, stderr } = await runCommand([
      'host',
      'declare',
      '--agent-id',
      'db-01',
      '--prop',
      'noequals',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Invalid property');
  });
});
