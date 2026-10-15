// Covers surface: cli:kici-admin:check-run list
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { runCli } from '../../__test-helpers__/cli.js';

const mockListCheckRunTrackingDirect = vi.fn();

vi.mock('@kici-dev/shared', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    listCheckRunTrackingDirect: mockListCheckRunTrackingDirect,
  };
});

const { registerCheckRunCommands } = await import('./check-run.js');

async function runCommand(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return runCli((p) => registerCheckRunCommands(p), args);
}

const ROW = {
  provider: 'github',
  owner: 'kici-dev',
  repo: 'test-repo',
  sha: 'abc123',
  check_name: 'kici/e2e-test',
  check_run_id: '9876543210',
  build_creation_state: 'completed',
  run_id: 'run-1',
  in_progress_sent_at: new Date('2026-08-01T10:00:00.000Z'),
  terminal_sent_at: new Date('2026-08-01T10:05:00.000Z'),
};

describe('kici-admin check-run CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.KICI_DATABASE_URL;
  });

  it('list prints a tracking table in direct-DB mode', async () => {
    mockListCheckRunTrackingDirect.mockResolvedValue({ rows: [ROW] });
    const { stdout, exitCode } = await runCommand([
      'check-run',
      'list',
      '--sha',
      'abc123',
      '--database-url',
      'postgres://x',
    ]);
    expect(exitCode).toBeNull();
    expect(mockListCheckRunTrackingDirect).toHaveBeenCalledWith('postgres://x', {
      sha: 'abc123',
      checkName: undefined,
      limit: undefined,
    });
    expect(stdout).toContain('kici/e2e-test');
    expect(stdout).toContain('9876543210');
    expect(stdout).toContain('2026-08-01T10:00:00.000Z');
  });

  it('list forwards the check-name and limit filters', async () => {
    mockListCheckRunTrackingDirect.mockResolvedValue({ rows: [] });
    await runCommand([
      'check-run',
      'list',
      '--sha',
      'abc123',
      '--check-name',
      'kici/e2e-test',
      '--limit',
      '10',
      '--database-url',
      'postgres://x',
    ]);
    expect(mockListCheckRunTrackingDirect).toHaveBeenCalledWith('postgres://x', {
      sha: 'abc123',
      checkName: 'kici/e2e-test',
      limit: 10,
    });
  });

  it('emits JSON with --json', async () => {
    mockListCheckRunTrackingDirect.mockResolvedValue({ rows: [ROW] });
    const { stdout } = await runCommand([
      'check-run',
      'list',
      '--sha',
      'abc123',
      '--json',
      '--database-url',
      'postgres://x',
    ]);
    expect(JSON.parse(stdout).rows[0].check_run_id).toBe('9876543210');
  });

  // A null check_run_id row is the point of the command: only CREATE_STATE
  // separates its two meanings, so it must render, not be dropped.
  it('renders a null check_run_id as an em dash rather than omitting the row', async () => {
    mockListCheckRunTrackingDirect.mockResolvedValue({
      rows: [
        {
          ...ROW,
          check_run_id: null,
          build_creation_state: null,
          in_progress_sent_at: null,
        },
      ],
    });
    const { stdout } = await runCommand([
      'check-run',
      'list',
      '--sha',
      'abc123',
      '--database-url',
      'postgres://x',
    ]);
    expect(stdout).toContain('kici/e2e-test');
    expect(stdout).toMatch(/kici\/e2e-test\s+—/);
  });

  it('shows an in-flight create as pending, not as a failed post', async () => {
    mockListCheckRunTrackingDirect.mockResolvedValue({
      rows: [{ ...ROW, check_run_id: null, build_creation_state: 'pending' }],
    });
    const { stdout } = await runCommand([
      'check-run',
      'list',
      '--sha',
      'abc123',
      '--database-url',
      'postgres://x',
    ]);
    expect(stdout).toContain('CREATE_STATE');
    expect(stdout).toContain('pending');
  });

  it('reports an empty result rather than printing a bare header', async () => {
    mockListCheckRunTrackingDirect.mockResolvedValue({ rows: [] });
    const { stdout } = await runCommand([
      'check-run',
      'list',
      '--sha',
      'nope',
      '--database-url',
      'postgres://x',
    ]);
    expect(stdout).toContain('No check-run tracking rows found.');
  });

  it('fails with a clear message when no database URL is available', async () => {
    mockListCheckRunTrackingDirect.mockResolvedValue({ rows: [] });
    const { stderr, exitCode } = await runCommand(['check-run', 'list', '--sha', 'abc123']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Database URL required');
    expect(mockListCheckRunTrackingDirect).not.toHaveBeenCalled();
  });

  it('falls back to KICI_DATABASE_URL when --database-url is absent', async () => {
    process.env.KICI_DATABASE_URL = 'postgres://env';
    mockListCheckRunTrackingDirect.mockResolvedValue({ rows: [] });
    await runCommand(['check-run', 'list', '--sha', 'abc123']);
    expect(mockListCheckRunTrackingDirect).toHaveBeenCalledWith('postgres://env', {
      sha: 'abc123',
      checkName: undefined,
      limit: undefined,
    });
  });

  it('rejects a non-integer limit', async () => {
    const { stderr, exitCode } = await runCommand([
      'check-run',
      'list',
      '--sha',
      'abc123',
      '--limit',
      'lots',
      '--database-url',
      'postgres://x',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--limit');
    expect(mockListCheckRunTrackingDirect).not.toHaveBeenCalled();
  });

  // TERMINAL_SENT separates "the terminal update was never sent" from "the
  // provider is lagging", the attribution the command exists for.
  it('renders TERMINAL_SENT as a timestamp when the terminal update was sent', async () => {
    mockListCheckRunTrackingDirect.mockResolvedValue({ rows: [ROW] });
    const { stdout } = await runCommand([
      'check-run',
      'list',
      '--sha',
      'abc123',
      '--database-url',
      'postgres://x',
    ]);
    expect(stdout).toContain('TERMINAL_SENT');
    expect(stdout).toContain('2026-08-01T10:05:00.000Z');
  });

  it('renders TERMINAL_SENT as an em dash for a check run stuck at create', async () => {
    mockListCheckRunTrackingDirect.mockResolvedValue({
      rows: [{ ...ROW, terminal_sent_at: null }],
    });
    const { stdout } = await runCommand([
      'check-run',
      'list',
      '--sha',
      'abc123',
      '--database-url',
      'postgres://x',
    ]);
    expect(stdout).toContain('TERMINAL_SENT');
    expect(stdout).not.toContain('2026-08-01T10:05:00.000Z');
    expect(stdout).toMatch(/9876543210\s+completed\s+—/);
  });

  it('requires --sha', async () => {
    const { exitCode } = await runCommand(['check-run', 'list', '--database-url', 'postgres://x']);
    expect(mockListCheckRunTrackingDirect).not.toHaveBeenCalled();
    expect(exitCode).toBeNull();
  });
});
