import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
    const { startPlanePostgres } = await import('./postgres.js');
    // Stub the pg_ctl daemonizer so the unit test never spawns a real process.
    const h = await startPlanePostgres({ embeddedDaemon: async () => {} });
    expect(h.kind).toBe('embedded');
    expect(h.url).toContain('kici_local');
    expect(embeddedStart).toHaveBeenCalled();
  });

  it('falls back to podman when embedded init throws', async () => {
    embeddedInit.mockRejectedValue(new Error('no native binary'));
    const { startPlanePostgres } = await import('./postgres.js');
    spawnMock.mockReturnValue({ on: vi.fn(), unref: vi.fn() });
    const h = await startPlanePostgres({ readyPoller: async () => true });
    expect(h.kind).toBe('podman');
    expect(spawnMock).toHaveBeenCalledWith(
      'podman',
      expect.arrayContaining(['run', '-d']),
      expect.anything(),
    );
  });
});

describe('embeddedClusterIsServing', () => {
  /** Write a postmaster.pid whose 4th line is the port, as PostgreSQL does. */
  function seedPidFile(port: number): string {
    const dir = mkdtempSync(join(tmpdir(), 'kici-pgserving-'));
    process.env.KICI_CONFIG_DIR = dir;
    const pgData = join(dir, 'local', 'pgdata');
    mkdirSync(pgData, { recursive: true });
    writeFileSync(
      join(pgData, 'postmaster.pid'),
      ['4242', pgData, '1785000000', String(port), '/tmp', '', 'ready   '].join('\n'),
    );
    return dir;
  }

  it('is false when the data dir has no postmaster.pid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kici-pgserving-'));
    process.env.KICI_CONFIG_DIR = dir;
    const { embeddedClusterIsServing } = await import('./postgres.js');
    expect(await embeddedClusterIsServing(45432)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('is false when a postmaster is running on a DIFFERENT port', async () => {
    // Reusing it would hand the plane a database on the wrong port; the check
    // must return before it ever consults pg_ctl.
    const dir = seedPidFile(45999);
    const { embeddedClusterIsServing } = await import('./postgres.js');
    expect(await embeddedClusterIsServing(45432)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('is false when pg_ctl reports the cluster is not running (stale pid file)', async () => {
    // pg_ctl is unresolvable/failing under the mocked module graph, which is the
    // same signal as a non-zero status: start it rather than assume it is up.
    const dir = seedPidFile(45432);
    const { embeddedClusterIsServing } = await import('./postgres.js');
    expect(await embeddedClusterIsServing(45432)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
