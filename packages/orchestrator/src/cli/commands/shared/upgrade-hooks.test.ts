import { describe, expect, it, vi } from 'vitest';
import {
  buildUpgradeHooks,
  readDatabaseUrlFromEnvFile,
  resolveDatabaseUrl,
} from './upgrade-hooks.js';

describe('readDatabaseUrlFromEnvFile', () => {
  it('reads the URL', () => {
    expect(readDatabaseUrlFromEnvFile('KICI_DATABASE_URL=postgres://a/b\nOTHER=1\n')).toBe(
      'postgres://a/b',
    );
  });

  it('strips balanced quotes', () => {
    expect(readDatabaseUrlFromEnvFile('KICI_DATABASE_URL="postgres://a/b"')).toBe('postgres://a/b');
    expect(readDatabaseUrlFromEnvFile("KICI_DATABASE_URL='postgres://a/b'")).toBe('postgres://a/b');
  });

  it('ignores comments and blanks', () => {
    expect(
      readDatabaseUrlFromEnvFile('# KICI_DATABASE_URL=wrong\n\nKICI_DATABASE_URL=right\n'),
    ).toBe('right');
  });

  it('keeps a value containing an equals sign intact', () => {
    expect(readDatabaseUrlFromEnvFile('KICI_DATABASE_URL=postgres://a/b?x=1&y=2')).toBe(
      'postgres://a/b?x=1&y=2',
    );
  });

  it('is null when the key is absent or empty', () => {
    expect(readDatabaseUrlFromEnvFile('OTHER=1')).toBeNull();
    expect(readDatabaseUrlFromEnvFile('KICI_DATABASE_URL=')).toBeNull();
  });
});

describe('resolveDatabaseUrl', () => {
  it('prefers the instance env file over the ambient environment', () => {
    const prev = process.env.KICI_DATABASE_URL;
    process.env.KICI_DATABASE_URL = 'postgres://ambient/db';
    try {
      expect(resolveDatabaseUrl('/x/.env', () => 'KICI_DATABASE_URL=postgres://file/db')).toBe(
        'postgres://file/db',
      );
    } finally {
      if (prev === undefined) delete process.env.KICI_DATABASE_URL;
      else process.env.KICI_DATABASE_URL = prev;
    }
  });

  it('falls back to the environment when the file cannot be read', () => {
    const prev = process.env.KICI_DATABASE_URL;
    process.env.KICI_DATABASE_URL = 'postgres://ambient/db';
    try {
      expect(
        resolveDatabaseUrl('/missing/.env', () => {
          throw new Error('ENOENT');
        }),
      ).toBe('postgres://ambient/db');
    } finally {
      if (prev === undefined) delete process.env.KICI_DATABASE_URL;
      else process.env.KICI_DATABASE_URL = prev;
    }
  });

  it('throws rather than returning nothing, so the upgrade refuses loudly', () => {
    const prevA = process.env.KICI_DATABASE_URL;
    delete process.env.KICI_DATABASE_URL;
    try {
      expect(() =>
        resolveDatabaseUrl('/x/.env', () => {
          throw new Error('ENOENT');
        }),
      ).toThrow(/could not be resolved/);
    } finally {
      if (prevA !== undefined) process.env.KICI_DATABASE_URL = prevA;
    }
  });
});

describe('buildUpgradeHooks', () => {
  it('reads the migration ledger from the running service', async () => {
    const get = vi.fn().mockResolvedValue({ migrations: [{ name: '1_a', status: 'applied' }] });
    const hooks = buildUpgradeHooks(() => ({ get }) as never);
    expect(await hooks.migrationStatus!()).toEqual({
      migrations: [{ name: '1_a', status: 'applied' }],
    });
    expect(get).toHaveBeenCalledWith('/api/v1/admin/db/migrate/status');
  });

  it('drains, then polls until the coordinator is quiet', async () => {
    const snaps = [
      { draining: true, jobsRunning: 1 },
      { draining: true, jobsRunning: 0 },
    ];
    const drain = vi.fn().mockResolvedValue({ draining: true, jobsRunning: 1 });
    const drainStatus = vi.fn(async () => snaps.shift()!);
    const hooks = buildUpgradeHooks(() => ({ drain, drainStatus }) as never);

    const res = await hooks.drain!(1);

    expect(drain).toHaveBeenCalledWith('drain');
    expect(res.quiesced).toBe(true);
  }, 20_000);

  it('reverts the schema through the running service', async () => {
    const post = vi.fn().mockResolvedValue({});
    const hooks = buildUpgradeHooks(() => ({ post }) as never);
    await hooks.migrateDown!('132_c');
    expect(post).toHaveBeenCalledWith('/api/v1/admin/db/migrate/to', { name: '132_c' });
  });

  it('throws, rather than exiting, when no admin token is configured', async () => {
    // kici-admin's own getClient calls process.exit, which a caller cannot
    // catch — so an upgrade on an install with no admin credentials died
    // outright instead of degrading. Every admin-API hook must throw here so
    // the upgrade's own handlers can warn and continue.
    const hooks = buildUpgradeHooks(() => null);

    await expect(hooks.migrationStatus!()).rejects.toThrow(/no admin token is configured/);
    await expect(hooks.drain!(1)).rejects.toThrow(/no admin token is configured/);
    await expect(hooks.migrateDown!('132_c')).rejects.toThrow(/no admin token is configured/);
  });
});
