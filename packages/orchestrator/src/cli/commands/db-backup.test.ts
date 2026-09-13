import { describe, it, expect, vi } from 'vitest';

// `createDbBackup` drives the module-level seams (pg_dump exec + stat), so the
// two host modules behind them are replaced. Every other test in this file
// injects its own seam and is unaffected.
vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      _bin: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
    ) => cb(null, { stdout: 'pg_dump (PostgreSQL) 16.3\n', stderr: '' }),
  ),
}));

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(async () => ({ size: 4096, mtimeMs: 0 })),
  readFile: vi.fn(async () => ''),
  writeFile: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  unlink: vi.fn(async () => undefined),
}));

import {
  createDbBackup,
  dumpFileName,
  dumpPathIn,
  pruneBackupDir,
  parsePgToolMajor,
  serverVersionMajor,
  assertToolVersionCompatible,
  manifestPath,
  writeManifest,
  readManifest,
  pgToolVersion,
  runPgDump,
  runPgRestore,
  pgEnvFromUrl,
  buildBackupManifest,
  restoreKeyWarning,
  type BackupManifest,
  type PruneIo,
} from './db-backup.js';

/** Minimal `pool.query` stand-in covering the three reads the backup makes. */
function fakePool(serverVersionNum = '160003') {
  return {
    query: async (sql: string) => {
      if (sql.includes('server_version_num')) {
        return { rows: [{ server_version_num: serverVersionNum }] };
      }
      if (sql.includes('config_versions')) return { rows: [{ max: 3 }] };
      return { rows: [{ value: 'cluster-abc' }] };
    },
  } as unknown as import('pg').Pool;
}

/** Captures the row `recordBackupRun` inserts. */
function fakeDb(sink: { row?: Record<string, unknown> }) {
  return {
    insertInto: () => ({
      values: (row: Record<string, unknown>) => {
        sink.row = row;
        return { execute: async () => undefined };
      },
    }),
  } as unknown as Parameters<typeof createDbBackup>[0]['db'];
}

describe('db-backup helpers', () => {
  it('parses the pg_dump major from --version output', () => {
    expect(parsePgToolMajor('pg_dump (PostgreSQL) 16.3')).toBe(16);
    expect(parsePgToolMajor('pg_restore (PostgreSQL) 15.6 (Debian 15.6-1)')).toBe(15);
  });

  it('derives the server major from server_version_num', () => {
    expect(serverVersionMajor('160003')).toBe(16);
    expect(serverVersionMajor('90605')).toBe(9);
  });

  it('accepts client >= server and rejects client < server', () => {
    expect(() => assertToolVersionCompatible(16, 16, 'pg_dump')).not.toThrow();
    expect(() => assertToolVersionCompatible(17, 16, 'pg_dump')).not.toThrow();
    expect(() => assertToolVersionCompatible(15, 16, 'pg_dump')).toThrow(/pg_dump 15.*major 16/);
  });

  it('round-trips a manifest and returns null when absent', async () => {
    const store = new Map<string, string>();
    const fs = {
      writeFile: async (p: string, data: string) => void store.set(p, data),
      readFile: async (p: string) => {
        if (!store.has(p)) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        return store.get(p)!;
      },
    };
    const m: BackupManifest = {
      createdAt: '2026-07-10T00:00:00.000Z',
      byteSize: 42,
      secretKeyVersion: 1,
      pgServerVersion: '160003',
      migrationsHash: 'abc123',
      clusterId: 'cluster-x',
      hostname: 'box',
    };
    await writeManifest('/tmp/x.dump', m, fs as never);
    expect(store.has(manifestPath('/tmp/x.dump'))).toBe(true);
    expect(await readManifest('/tmp/x.dump', fs as never)).toEqual(m);
    expect(await readManifest('/tmp/missing.dump', fs as never)).toBeNull();
  });

  it('surfaces a friendly install hint when the binary is missing', async () => {
    const run = vi.fn(async () => {
      const err = new Error('spawn pg_dump ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    await expect(pgToolVersion('pg_dump', run)).rejects.toThrow(/postgresql-client/);
  });

  it('invokes pg_dump with custom-format args + output path and NO url in argv', async () => {
    const run = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await runPgDump('postgres://u:secret@h:5432/db', '/tmp/out.dump', run);
    const [bin, args, opts] = run.mock.calls[0];
    expect(bin).toBe('pg_dump');
    expect(args).toEqual(['-Fc', '--file', '/tmp/out.dump']);
    // Credentials must NEVER appear on the command line (/proc/cmdline is world-readable).
    expect(args.join(' ')).not.toContain('secret');
    expect(args.join(' ')).not.toContain('postgres://');
    // They ride in the environment instead.
    expect((opts as { env: NodeJS.ProcessEnv }).env.PGPASSWORD).toBe('secret');
    expect((opts as { env: NodeJS.ProcessEnv }).env.PGDATABASE).toBe('db');
    expect((opts as { env: NodeJS.ProcessEnv }).env.PGHOST).toBe('h');
    expect((opts as { env: NodeJS.ProcessEnv }).env.PGPORT).toBe('5432');
  });

  it('invokes pg_restore with --clean --if-exists --no-owner + input path and NO url in argv', async () => {
    const run = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await runPgRestore('postgres://u:secret@h/db', '/tmp/in.dump', run);
    const [bin, args, opts] = run.mock.calls[0];
    expect(bin).toBe('pg_restore');
    // --dbname carries the (non-secret) DB name so pg_restore enters
    // restore-into-DB mode; credentials stay in the environment.
    expect(args).toEqual([
      '--clean',
      '--if-exists',
      '--no-owner',
      '--dbname',
      'db',
      '/tmp/in.dump',
    ]);
    expect(args.join(' ')).not.toContain('secret');
    expect((opts as { env: NodeJS.ProcessEnv }).env.PGPASSWORD).toBe('secret');
    expect((opts as { env: NodeJS.ProcessEnv }).env.PGDATABASE).toBe('db');
  });

  it('pgEnvFromUrl maps only the present components', () => {
    expect(pgEnvFromUrl('postgres://u@h/db')).toEqual({
      PGHOST: 'h',
      PGUSER: 'u',
      PGDATABASE: 'db',
    });
    expect(pgEnvFromUrl('postgres://u:p@h:6543/db?sslmode=require')).toEqual({
      PGHOST: 'h',
      PGPORT: '6543',
      PGUSER: 'u',
      PGPASSWORD: 'p',
      PGDATABASE: 'db',
      PGSSLMODE: 'require',
    });
  });
});

describe('buildBackupManifest', () => {
  it('assembles a manifest from meta + file stats', () => {
    const m = buildBackupManifest({
      now: new Date('2026-07-10T12:00:00.000Z'),
      byteSize: 1234,
      serverVersionNum: '160003',
      secretKeyVersion: 2,
      clusterId: 'c1',
      migrationsHash: 'deadbeef',
      hostname: 'box-1',
    });
    expect(m).toEqual({
      createdAt: '2026-07-10T12:00:00.000Z',
      byteSize: 1234,
      secretKeyVersion: 2,
      pgServerVersion: '160003',
      migrationsHash: 'deadbeef',
      clusterId: 'c1',
      hostname: 'box-1',
    });
  });
});

describe('restoreKeyWarning', () => {
  it('warns loudly when the dump had secrets but KICI_SECRET_KEY is unset', () => {
    const w = restoreKeyWarning({ secretKeyVersion: 2, keyEnvPresent: false });
    expect(w).toMatch(/KICI_SECRET_KEY is not set/);
    expect(w).toMatch(/generation 2/);
  });
  it('gives an informational reminder when the key IS set', () => {
    const w = restoreKeyWarning({ secretKeyVersion: 2, keyEnvPresent: true });
    expect(w).toMatch(/generation 2/);
    expect(w).not.toMatch(/not set/);
  });
  it('returns null when the dump carried no encrypted secrets', () => {
    expect(restoreKeyWarning({ secretKeyVersion: null, keyEnvPresent: false })).toBeNull();
  });
});

describe('createDbBackup', () => {
  it('dumps, writes the manifest, and records the backup run', async () => {
    const sink: { row?: Record<string, unknown> } = {};
    const now = new Date('2026-09-04T10:11:12.000Z');

    const result = await createDbBackup({
      databaseUrl: 'postgres://u:p@h:5432/kici',
      outputPath: '/backups/kici.dump',
      db: fakeDb(sink),
      pool: fakePool(),
      now,
    });

    expect(result.outputPath).toBe('/backups/kici.dump');
    expect(result.byteSize).toBe(4096);
    expect(result.manifest.createdAt).toBe(now.toISOString());
    expect(result.manifest.secretKeyVersion).toBe(3);
    expect(result.manifest.pgServerVersion).toBe('160003');
    expect(result.manifest.clusterId).toBe('cluster-abc');
    expect(result.manifest.migrationsHash).toMatch(/^[0-9a-f]{64}$/);

    expect(sink.row).toMatchObject({
      dump_path: '/backups/kici.dump',
      byte_size: '4096',
      secret_key_version: 3,
      pg_server_version: '160003',
    });
  });

  it('throws (never exits) when pg_dump is older than the server', async () => {
    await expect(
      createDbBackup({
        databaseUrl: 'postgres://u:p@h:5432/kici',
        outputPath: '/backups/kici.dump',
        db: fakeDb({}),
        pool: fakePool('170001'),
        now: new Date(),
      }),
    ).rejects.toThrow(/pg_dump 16 is older than the server \(major 17\)/);
  });

  it('propagates a database read failure as an error', async () => {
    const pool = {
      query: async () => {
        throw new Error('connection refused');
      },
    } as unknown as import('pg').Pool;

    await expect(
      createDbBackup({
        databaseUrl: 'postgres://u:p@h:5432/kici',
        outputPath: '/backups/kici.dump',
        db: fakeDb({}),
        pool,
        now: new Date(),
      }),
    ).rejects.toThrow(/connection refused/);
  });
});

describe('dump paths', () => {
  it('stamps the timestamp into the filename and joins the retention dir', () => {
    const now = new Date('2026-09-04T10:11:12.000Z');
    expect(dumpFileName(now)).toBe('kici-orchestrator-backup-2026-09-04T10-11-12-000Z.dump');
    expect(dumpPathIn('/var/backups', now)).toBe(
      '/var/backups/kici-orchestrator-backup-2026-09-04T10-11-12-000Z.dump',
    );
  });
});

describe('pruneBackupDir', () => {
  function makePruneIo(names: string[], mtimes: Record<string, number>) {
    const unlinked: string[] = [];
    const present = new Set(names);
    const io: PruneIo = {
      readdir: async () => names,
      mtimeMs: async (p) => mtimes[p.split('/').pop()!] ?? 0,
      unlink: async (p) => {
        const base = p.split('/').pop()!;
        if (!present.has(base)) throw new Error(`ENOENT: ${p}`);
        present.delete(base);
        unlinked.push(p);
      },
    };
    return { io, unlinked };
  }

  it('keeps the newest N dumps and deletes older ones with their manifests', async () => {
    const names = [
      'a.dump',
      'a.dump.manifest.json',
      'b.dump',
      'b.dump.manifest.json',
      'c.dump',
      'c.dump.manifest.json',
      'd.dump',
      'd.dump.manifest.json',
    ];
    const { io, unlinked } = makePruneIo(names, {
      'a.dump': 400,
      'b.dump': 300,
      'c.dump': 200,
      'd.dump': 100,
    });

    const removed = await pruneBackupDir('/backups', 2, io);

    expect(removed).toEqual([
      '/backups/c.dump',
      '/backups/c.dump.manifest.json',
      '/backups/d.dump',
      '/backups/d.dump.manifest.json',
    ]);
    expect(unlinked).toEqual(removed);
    // The two newest dumps and their manifests are untouched.
    expect(removed).not.toContain('/backups/a.dump');
    expect(removed).not.toContain('/backups/b.dump');
  });

  it('tolerates a dump with no manifest sibling', async () => {
    const { io } = makePruneIo(['a.dump', 'b.dump'], { 'a.dump': 200, 'b.dump': 100 });
    expect(await pruneBackupDir('/backups', 1, io)).toEqual(['/backups/b.dump']);
  });

  it('removes nothing when the directory holds at most `keep` dumps', async () => {
    const { io } = makePruneIo(['a.dump'], { 'a.dump': 1 });
    expect(await pruneBackupDir('/backups', 7, io)).toEqual([]);
  });

  it('disables pruning for a non-positive keep', async () => {
    const { io, unlinked } = makePruneIo(['a.dump', 'b.dump'], { 'a.dump': 2, 'b.dump': 1 });
    expect(await pruneBackupDir('/backups', 0, io)).toEqual([]);
    expect(unlinked).toEqual([]);
  });
});
