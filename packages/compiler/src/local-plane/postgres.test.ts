import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const embeddedStart = vi.fn();
const embeddedInit = vi.fn();
const embeddedCreateDb = vi.fn();
const embeddedStop = vi.fn();
const ctorOptions: Array<Record<string, unknown>> = [];
vi.mock('embedded-postgres', () => ({
  default: vi.fn().mockImplementation(function (opts: Record<string, unknown>) {
    ctorOptions.push(opts);
    return {
      initialise: embeddedInit,
      start: embeddedStart,
      createDatabase: embeddedCreateDb,
      stop: embeddedStop,
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

describe('embedded Postgres bootstrap', () => {
  let dir: string;
  beforeEach(() => {
    embeddedInit.mockReset();
    embeddedStart.mockReset();
    embeddedCreateDb.mockReset();
    embeddedStop.mockReset().mockResolvedValue(undefined);
    spawnMock.mockReset();
    delete process.env.KICI_LOCAL_PG_MODE;
    dir = mkdtempSync(join(tmpdir(), 'kici-pgboot-'));
    process.env.KICI_CONFIG_DIR = dir;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('routes the embedded server log to the plane pg log, not the console', async () => {
    embeddedInit.mockImplementation(async () => {
      (ctorOptions.at(-1)!.onLog as (m: string) => void)('database system is shut down');
    });
    embeddedStart.mockResolvedValue(undefined);
    embeddedCreateDb.mockResolvedValue(undefined);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { startPlanePostgres } = await import('./postgres.js');
    const { planePaths } = await import('./paths.js');
    await startPlanePostgres({ embeddedDaemon: async () => {} });
    // fails-when: onLog is not passed, so embedded-postgres defaults it to console.log
    expect(consoleLog).not.toHaveBeenCalled();
    expect(readFileSync(planePaths().pgLogFile, 'utf-8')).toContain('database system is shut down');
    expect(existsSync(planePaths().pgBootstrapStamp)).toBe(true);
  });

  it('ignores only duplicate_database from createDatabase', async () => {
    const { isDuplicateDatabaseError } = await import('./postgres.js');
    expect(isDuplicateDatabaseError(Object.assign(new Error('exists'), { code: '42P04' }))).toBe(
      true,
    );
    // breaks-if-wrong: any other failure must surface instead of being swallowed
    expect(isDuplicateDatabaseError(Object.assign(new Error('auth'), { code: '28P01' }))).toBe(
      false,
    );
    expect(isDuplicateDatabaseError('exists')).toBe(false);
  });

  it('surfaces a createDatabase failure that is not duplicate_database', async () => {
    embeddedInit.mockResolvedValue(undefined);
    embeddedStart.mockResolvedValue(undefined);
    embeddedCreateDb.mockRejectedValue(
      Object.assign(new Error('password failed'), { code: '28P01' }),
    );
    spawnMock.mockReturnValue({ on: vi.fn(), unref: vi.fn() });
    const { startPlanePostgres } = await import('./postgres.js');
    const { planePaths } = await import('./paths.js');
    // fails-when: the createDatabase catch swallows every error again
    await expect(startPlanePostgres({ readyPoller: async () => false })).rejects.toThrow(
      /embedded: embedded PostgreSQL bootstrap failed: password failed/,
    );
    expect(existsSync(planePaths().pgBootstrapStamp)).toBe(false);
    // fails-when: a failed bootstrap leaves its in-process server holding the plane port
    expect(embeddedStop).toHaveBeenCalledTimes(1);
  });

  it('finishes a half-done bootstrap: PG_VERSION present, stamp absent', async () => {
    const { planePaths } = await import('./paths.js');
    mkdirSync(planePaths().pgData, { recursive: true });
    writeFileSync(join(planePaths().pgData, 'PG_VERSION'), '18\n');
    embeddedStart.mockResolvedValue(undefined);
    embeddedCreateDb.mockRejectedValue(Object.assign(new Error('exists'), { code: '42P04' }));
    const { startPlanePostgres } = await import('./postgres.js');
    const h = await startPlanePostgres({ embeddedDaemon: async () => {} });
    expect(h.kind).toBe('embedded');
    // fails-when: the PG_VERSION early return skips createDatabase forever
    expect(embeddedInit).not.toHaveBeenCalled();
    expect(embeddedCreateDb).toHaveBeenCalledWith('kici_local');
    expect(existsSync(planePaths().pgBootstrapStamp)).toBe(true);
  });

  it('skips the bootstrap entirely once the stamp exists', async () => {
    const { planePaths } = await import('./paths.js');
    mkdirSync(planePaths().root, { recursive: true });
    writeFileSync(planePaths().pgBootstrapStamp, 'done\n');
    const { startPlanePostgres } = await import('./postgres.js');
    await startPlanePostgres({ embeddedDaemon: async () => {} });
    // breaks-if-wrong: a bootstrapped plane must not restart the in-process server
    expect(embeddedStart).not.toHaveBeenCalled();
  });

  it('names the embedded failure and the pg log when podman also fails', async () => {
    embeddedInit.mockRejectedValue(new Error('initdb: locale not supported'));
    spawnMock.mockReturnValue({ on: vi.fn(), unref: vi.fn() });
    const { startPlanePostgres } = await import('./postgres.js');
    // fails-when: the embedded error is dropped before the podman fallback
    await expect(startPlanePostgres({ readyPoller: async () => false })).rejects.toThrow(
      /initdb: locale not supported[\s\S]*orchestrator\.log\.pg/,
    );
  });
});

describe('plane Postgres log rotation', () => {
  /** A fresh config dir whose plane root holds a `orchestrator.log.pg` of `size` bytes. */
  async function seedPgLog(size: number): Promise<{ dir: string; pgLogFile: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'kici-pglog-'));
    process.env.KICI_CONFIG_DIR = dir;
    // This describe has no beforeEach of its own; the embedded path must be the
    // one under test, so clear a podman force left by an earlier case.
    delete process.env.KICI_LOCAL_PG_MODE;
    const { planePaths } = await import('./paths.js');
    const { pgLogFile, root } = planePaths();
    mkdirSync(root, { recursive: true });
    writeFileSync(pgLogFile, '');
    truncateSync(pgLogFile, size);
    return { dir, pgLogFile };
  }

  it('rotates an over-cap postmaster log before pg_ctl reopens it', async () => {
    // fails-when: the postmaster log is already PLANE_LOG_MAX_BYTES + 1 bytes
    // and no cluster is serving. Without the rotate call in startPlanePostgres
    // the .pg.1 sibling never appears — pg_ctl opens the log in append mode and
    // nothing else ever truncates it.
    embeddedInit.mockResolvedValue(undefined);
    embeddedStart.mockResolvedValue(undefined);
    embeddedCreateDb.mockResolvedValue(undefined);
    const { PLANE_LOG_MAX_BYTES } = await import('./plane-log.js');
    const { dir, pgLogFile } = await seedPgLog(PLANE_LOG_MAX_BYTES + 1);
    try {
      const { startPlanePostgres } = await import('./postgres.js');
      const h = await startPlanePostgres({ embeddedDaemon: async () => {} });
      expect(h.kind).toBe('embedded');
      expect(statSync(`${pgLogFile}.1`).size).toBe(PLANE_LOG_MAX_BYTES + 1);
      expect(existsSync(pgLogFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves an under-cap postmaster log alone', async () => {
    // breaks-if-wrong: the postmaster log grows slowly (5.7 MB over two months
    // on the development machine), so almost every boot must NOT rotate it —
    // an unconditional rotate would discard the startup and checkpoint history
    // that makes it worth keeping.
    embeddedInit.mockResolvedValue(undefined);
    embeddedStart.mockResolvedValue(undefined);
    embeddedCreateDb.mockResolvedValue(undefined);
    const { dir, pgLogFile } = await seedPgLog(0);
    try {
      writeFileSync(pgLogFile, 'database system is ready\n');
      const { startPlanePostgres } = await import('./postgres.js');
      await startPlanePostgres({ embeddedDaemon: async () => {} });
      expect(existsSync(`${pgLogFile}.1`)).toBe(false);
      expect(readFileSync(pgLogFile, 'utf-8')).toBe('database system is ready\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never rotates the log of a cluster that is still serving', async () => {
    // breaks-if-wrong: the rotation is gated on `embeddedClusterIsServing`.
    // Drop that gate and a boot that finds its own postmaster still up (the
    // orchestrator died, Postgres did not) renames the log under the live
    // writer — every later line lands in `.pg.1` and `.pg` stays empty — and
    // then runs `pg_ctl start` against the running cluster, which fails and
    // falls the plane through to the Podman backend.
    //
    // The serving cluster is real as far as pg_ctl can tell: a data dir with a
    // PG_VERSION marker but no bootstrap stamp (a plane from an older CLI) and a
    // postmaster.pid naming this plane's port and a live same-user pid.
    // `pg_ctl status` checks liveness with kill(pid, 0) and refuses only its own
    // pid and its parent's; the vitest main process is neither.
    const { PLANE_LOG_MAX_BYTES } = await import('./plane-log.js');
    const { dir, pgLogFile } = await seedPgLog(PLANE_LOG_MAX_BYTES + 1);
    try {
      const { planePaths, planePorts } = await import('./paths.js');
      const { pgData } = planePaths();
      mkdirSync(pgData, { recursive: true });
      writeFileSync(join(pgData, 'PG_VERSION'), '18\n');
      writeFileSync(
        join(pgData, 'postmaster.pid'),
        [
          String(process.ppid),
          pgData,
          '1785000000',
          String(planePorts().postgres),
          '/tmp',
          '',
          'ready   ',
        ].join('\n'),
      );
      const embeddedDaemon = vi.fn(async () => {});
      const { startPlanePostgres } = await import('./postgres.js');
      const h = await startPlanePostgres({ embeddedDaemon });
      expect(h.kind).toBe('embedded');
      expect(embeddedDaemon).not.toHaveBeenCalled();
      // fails-when: the bootstrap runs before the serving check; its in-process
      // server cannot start against the live cluster, so the plane would fall
      // through to Podman.
      expect(embeddedStart).not.toHaveBeenCalled();
      expect(existsSync(`${pgLogFile}.1`)).toBe(false);
      expect(statSync(pgLogFile).size).toBe(PLANE_LOG_MAX_BYTES + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
