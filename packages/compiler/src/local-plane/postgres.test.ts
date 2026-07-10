import { describe, it, expect, vi, beforeEach } from 'vitest';

const embeddedStart = vi.fn();
const embeddedInit = vi.fn();
const embeddedCreateDb = vi.fn();
vi.mock('embedded-postgres', () => ({
  default: vi.fn().mockImplementation(function () {
    return {
      initialise: embeddedInit,
      start: embeddedStart,
      createDatabase: embeddedCreateDb,
      stop: vi.fn(),
    };
  }),
}));

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: spawnMock, execFile: vi.fn() }));

describe('startPlanePostgres', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.KICI_LOCAL_PG_MODE;
    // Fresh, non-existent state dir so the one-time cluster init path runs
    // (no PG_VERSION file yet).
    process.env.KICI_CONFIG_DIR = `/tmp/pgtest-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  it('uses embedded-postgres when it initialises', async () => {
    embeddedInit.mockResolvedValue(undefined);
    embeddedStart.mockResolvedValue(undefined);
    embeddedCreateDb.mockResolvedValue(undefined);
    const { startPlanePostgres, __setEmbeddedDaemonForTest } = await import('./postgres.js');
    // Stub the pg_ctl daemonizer so the unit test never spawns a real process.
    __setEmbeddedDaemonForTest(async () => {});
    const h = await startPlanePostgres();
    expect(h.kind).toBe('embedded');
    expect(h.url).toContain('kici_local');
    expect(embeddedStart).toHaveBeenCalled();
  });

  it('falls back to podman when embedded init throws', async () => {
    embeddedInit.mockRejectedValue(new Error('no native binary'));
    const { startPlanePostgres, __setReadyPollerForTest } = await import('./postgres.js');
    __setReadyPollerForTest(async () => true);
    spawnMock.mockReturnValue({ on: vi.fn(), unref: vi.fn() });
    const h = await startPlanePostgres();
    expect(h.kind).toBe('podman');
    expect(spawnMock).toHaveBeenCalledWith(
      'podman',
      expect.arrayContaining(['run', '-d']),
      expect.anything(),
    );
  });
});
