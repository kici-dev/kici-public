import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

// Shared mock fns
const mockCreateToken = vi.fn();
const mockListActive = vi.fn();
const mockRevoke = vi.fn();
const mockRevokeAll = vi.fn();
const mockResetRaftStateDirect = vi.fn();
const mockPrunePeerCredentialsDirect = vi.fn();

vi.mock('./shared/db.js', () => ({
  withDb: vi.fn(async (fn: (db: any) => Promise<any>) => fn({})),
}));

vi.mock('@kici-dev/shared', async (importActual) => {
  const actual = await importActual<typeof import('@kici-dev/shared')>();
  return {
    ...actual,
    resetRaftStateDirect: (...args: unknown[]) => mockResetRaftStateDirect(...args),
    prunePeerCredentialsDirect: (...args: unknown[]) => mockPrunePeerCredentialsDirect(...args),
  };
});

const mockSilenceJoinTokenLogger = vi.fn();

vi.mock('../../cluster/join-token.js', () => {
  return {
    JoinTokenManager: class MockJoinTokenManager {
      createToken = mockCreateToken;
    },
    silenceJoinTokenLogger: mockSilenceJoinTokenLogger,
  };
});

vi.mock('../../cluster/peer-credentials.js', () => {
  return {
    PeerCredentialStore: class MockPeerCredentialStore {
      listActive = mockListActive;
      revoke = mockRevoke;
      revokeAll = mockRevokeAll;
    },
  };
});

const { registerPeerCommands } = await import('./peer.js');

async function runCommand(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const program = new Command();
  program.exitOverride();

  const mockGetClient = () => ({}) as any;
  registerPeerCommands(program, mockGetClient);

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

      // Commander errors are control flow
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

describe('peer CLI commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create-token', () => {
    it('creates token with default role (coordinator) and expiry', async () => {
      mockCreateToken.mockResolvedValue('kici_join_v1.routing.secret123');

      const { stdout } = await runCommand(['peer', 'create-token']);

      expect(mockCreateToken).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: 'default',
          routingKey: 'default',
          createdBy: 'cli',
          role: 'coordinator',
          expiryMs: 3600_000,
        }),
      );
      expect(stdout).toContain('kici_join_v1.routing.secret123');
      expect(stdout).toContain('role: coordinator');
      expect(stdout).toContain('only be used once');
    });

    it('creates token with specified role and expiry', async () => {
      mockCreateToken.mockResolvedValue('kici_join_v1.r.s');

      await runCommand([
        'peer',
        'create-token',
        '--role',
        'worker',
        '--expiry-hours',
        '24',
        '--org-id',
        'org-42',
        '--routing-key',
        'github:42',
      ]);

      expect(mockCreateToken).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: 'org-42',
          routingKey: 'github:42',
          createdBy: 'cli',
          role: 'worker',
          expiryMs: 24 * 3600_000,
        }),
      );
    });

    it('rejects invalid role', async () => {
      const { stderr, exitCode } = await runCommand(['peer', 'create-token', '--role', 'admin']);

      expect(exitCode).toBe(1);
      expect(stderr).toContain('--role must be "coordinator" or "worker"');
      expect(mockCreateToken).not.toHaveBeenCalled();
    });

    it('emits structured JSON when --json is set', async () => {
      mockCreateToken.mockResolvedValue('kici_join_v1.routing.secret-json');

      const { stdout } = await runCommand([
        'peer',
        'create-token',
        '--role',
        'worker',
        '--expiry-hours',
        '2',
        '--org-id',
        'org-json',
        '--routing-key',
        'github:json',
        '--created-by',
        'deploy-stg',
        '--json',
      ]);

      // Stdout must be a single JSON document — no prose, no "only be used once"
      // footer — so callers can pipe through `JSON.parse` safely.
      const parsed = JSON.parse(stdout);
      expect(parsed).toEqual(
        expect.objectContaining({
          token: 'kici_join_v1.routing.secret-json',
          role: 'worker',
          orgId: 'org-json',
          routingKey: 'github:json',
        }),
      );
      expect(typeof parsed.expiresAt).toBe('string');
      expect(stdout).not.toContain('only be used once');
      expect(mockCreateToken).toHaveBeenCalledWith(
        expect.objectContaining({
          createdBy: 'deploy-stg',
          role: 'worker',
          expiryMs: 2 * 3600_000,
        }),
      );
      // --json contract: module logger must be silenced so its info line
      // doesn't leak into the JSON stdout channel.
      expect(mockSilenceJoinTokenLogger).toHaveBeenCalledTimes(1);
    });

    it('does not silence the module logger in non-JSON mode', async () => {
      mockCreateToken.mockResolvedValue('kici_join_v1.r.s');

      await runCommand(['peer', 'create-token']);

      expect(mockSilenceJoinTokenLogger).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('lists active peers in table format', async () => {
      mockListActive.mockResolvedValue([
        {
          instanceId: 'inst-1',
          role: 'coordinator',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          lastSeenAt: new Date('2026-01-02T00:00:00Z'),
          expiresAt: new Date('2026-04-01T00:00:00Z'),
        },
        {
          instanceId: 'inst-2',
          role: 'worker',
          createdAt: new Date('2026-01-05T00:00:00Z'),
          lastSeenAt: null,
          expiresAt: new Date('2026-04-05T00:00:00Z'),
        },
      ]);

      const { stdout } = await runCommand(['peer', 'list']);

      expect(mockListActive).toHaveBeenCalledTimes(1);
      expect(stdout).toContain('inst-1');
      expect(stdout).toContain('inst-2');
      expect(stdout).toContain('coordinator');
      expect(stdout).toContain('worker');
      expect(stdout).toContain('never');
    });

    it('shows message when no active peers', async () => {
      mockListActive.mockResolvedValue([]);

      const { stdout } = await runCommand(['peer', 'list']);

      expect(stdout).toContain('No active peers found.');
    });
  });

  describe('revoke', () => {
    it('revokes a peer by instance ID', async () => {
      mockRevoke.mockResolvedValue(undefined);

      const { stdout } = await runCommand(['peer', 'revoke', '--instance-id', 'inst-42']);

      expect(mockRevoke).toHaveBeenCalledWith('inst-42');
      expect(stdout).toContain('inst-42');
      expect(stdout).toContain('revoked');
    });
  });

  describe('revoke-all', () => {
    it('refuses without --confirm flag', async () => {
      const { stderr, exitCode } = await runCommand(['peer', 'revoke-all']);

      expect(exitCode).toBe(1);
      expect(stderr).toContain('Pass --confirm to proceed');
      expect(mockRevokeAll).not.toHaveBeenCalled();
    });

    it('revokes all with --confirm flag', async () => {
      mockRevokeAll.mockResolvedValue(5);

      const { stdout } = await runCommand(['peer', 'revoke-all', '--confirm']);

      expect(mockRevokeAll).toHaveBeenCalledTimes(1);
      expect(stdout).toContain('Revoked 5 peer credentials.');
    });
  });

  describe('prune-credentials', () => {
    const originalKiciDbUrl = process.env.KICI_DATABASE_URL;

    beforeEach(() => {
      delete process.env.KICI_DATABASE_URL;
    });

    // Restore env after suite
    it('restore env after prune-credentials suite', () => {
      if (originalKiciDbUrl !== undefined) process.env.KICI_DATABASE_URL = originalKiciDbUrl;
      expect(true).toBe(true);
    });

    it('requires --filter (commander-enforced)', async () => {
      const { exitCode } = await runCommand([
        'peer',
        'prune-credentials',
        '--database-url',
        'postgresql://localhost/kici',
      ]);
      // Commander's requiredOption throws a `commander.missingMandatoryOptionValue`
      // error before action runs; our harness swallows it so exitCode stays null
      // but the direct helper must not have been invoked.
      expect(mockPrunePeerCredentialsDirect).not.toHaveBeenCalled();
      // exitCode is null because Commander throws (caught by exitOverride) rather
      // than calling process.exit.
      expect(exitCode).toBeNull();
    });

    it('refuses without --database-url (direct-DB only)', async () => {
      const { stderr, exitCode } = await runCommand([
        'peer',
        'prune-credentials',
        '--filter',
        'e2e-%',
      ]);

      expect(exitCode).toBe(1);
      expect(stderr).toContain('requires --database-url');
      expect(mockPrunePeerCredentialsDirect).not.toHaveBeenCalled();
    });

    it('deletes peer_credentials rows matching the NOT-LIKE filter in direct-DB mode', async () => {
      mockPrunePeerCredentialsDirect.mockResolvedValue({ deleted: 7 });

      const { stdout } = await runCommand([
        'peer',
        'prune-credentials',
        '--filter',
        'e2e-%',
        '--database-url',
        'postgresql://localhost/kici',
      ]);

      expect(mockPrunePeerCredentialsDirect).toHaveBeenCalledWith('postgresql://localhost/kici', {
        keepInstanceIdPattern: 'e2e-%',
      });
      expect(stdout).toContain('7 rows deleted');
    });

    it('emits JSON when --json is passed', async () => {
      mockPrunePeerCredentialsDirect.mockResolvedValue({ deleted: 0 });

      const { stdout } = await runCommand([
        'peer',
        'prune-credentials',
        '--filter',
        'e2e-%',
        '--database-url',
        'postgresql://localhost/kici',
        '--json',
      ]);

      const parsed = JSON.parse(stdout);
      expect(parsed).toEqual({ deleted: 0 });
    });

    it('accepts KICI_DATABASE_URL from env (no --database-url flag)', async () => {
      process.env.KICI_DATABASE_URL = 'postgresql://env-host/kici';
      mockPrunePeerCredentialsDirect.mockResolvedValue({ deleted: 3 });

      const { stdout } = await runCommand(['peer', 'prune-credentials', '--filter', 'keep-%']);

      expect(mockPrunePeerCredentialsDirect).toHaveBeenCalledWith('postgresql://env-host/kici', {
        keepInstanceIdPattern: 'keep-%',
      });
      expect(stdout).toContain('3 rows deleted');
    });
  });

  describe('reset-raft-state', () => {
    const originalKiciDbUrl = process.env.KICI_DATABASE_URL;

    beforeEach(() => {
      delete process.env.KICI_DATABASE_URL;
    });

    // Restore after suite
    it('restore env after suite', () => {
      if (originalKiciDbUrl !== undefined) process.env.KICI_DATABASE_URL = originalKiciDbUrl;
      expect(true).toBe(true);
    });

    it('refuses without --database-url (direct-DB only)', async () => {
      const { stderr, exitCode } = await runCommand(['peer', 'reset-raft-state']);

      expect(exitCode).toBe(1);
      expect(stderr).toContain('requires --database-url');
      expect(mockResetRaftStateDirect).not.toHaveBeenCalled();
    });

    it('deletes raft_state rows in direct-DB mode', async () => {
      mockResetRaftStateDirect.mockResolvedValue({ rowsDeleted: 3 });

      const { stdout } = await runCommand([
        'peer',
        'reset-raft-state',
        '--database-url',
        'postgresql://localhost/kici',
      ]);

      expect(mockResetRaftStateDirect).toHaveBeenCalledWith('postgresql://localhost/kici');
      expect(stdout).toContain('3 rows deleted');
    });

    it('emits JSON when --json is passed', async () => {
      mockResetRaftStateDirect.mockResolvedValue({ rowsDeleted: 0 });

      const { stdout } = await runCommand([
        'peer',
        'reset-raft-state',
        '--database-url',
        'postgresql://localhost/kici',
        '--json',
      ]);

      const parsed = JSON.parse(stdout);
      expect(parsed).toEqual({ rowsDeleted: 0 });
    });

    it('accepts KICI_DATABASE_URL from env', async () => {
      process.env.KICI_DATABASE_URL = 'postgresql://env-host/kici';
      mockResetRaftStateDirect.mockResolvedValue({ rowsDeleted: 1 });

      const { stdout } = await runCommand(['peer', 'reset-raft-state']);

      expect(mockResetRaftStateDirect).toHaveBeenCalledWith('postgresql://env-host/kici');
      expect(stdout).toContain('1 rows deleted');
    });
  });
});
