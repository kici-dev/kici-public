import { describe, it, expect, vi } from 'vitest';
import {
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
} from './db-backup.js';

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
