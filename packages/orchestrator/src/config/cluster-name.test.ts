import { describe, it, expect } from 'vitest';
import { createMockDb } from '../__test-helpers__/mock-db.js';
import {
  getClusterName,
  readClusterName,
  resolveAndPersistClusterName,
  setClusterName,
} from './cluster-name.js';
import { CLUSTER_NAME_FORMAT_MESSAGE } from '@kici-dev/engine/protocol/cluster-name';

function fixedRandomSource(byteValues: number[]) {
  return (size: number) =>
    new Uint8Array(
      byteValues.slice(0, size).concat(Array(Math.max(0, size - byteValues.length)).fill(0)),
    );
}

describe('readClusterName', () => {
  it('returns the stored value', async () => {
    const { db } = createMockDb({ selectFirstRow: { value: 'production' } });
    expect(await readClusterName(db)).toBe('production');
  });

  it('returns null when no row exists', async () => {
    const { db } = createMockDb({ selectFirstRow: undefined });
    expect(await readClusterName(db)).toBe(null);
  });

  it('throws when the stored value violates the regex', async () => {
    const { db } = createMockDb({ selectFirstRow: { value: 'Bad_Name' } });
    await expect(readClusterName(db)).rejects.toThrow();
  });
});

describe('getClusterName', () => {
  it('returns the stored value', async () => {
    const { db } = createMockDb({ selectFirstRow: { value: 'production' } });
    expect(await getClusterName(db)).toBe('production');
  });

  it('throws when no row exists', async () => {
    const { db } = createMockDb({ selectFirstRow: undefined });
    await expect(getClusterName(db)).rejects.toThrow(/resolveAndPersistClusterName must run/);
  });
});

describe('setClusterName', () => {
  it('persists a valid name via UPSERT', async () => {
    const { db, mocks } = createMockDb();
    const result = await setClusterName(db, 'production-arm');
    expect(result).toBe('production-arm');
    expect(mocks.insertInto).toHaveBeenCalledWith('cluster_meta');
    expect(mocks.insertValues).toHaveBeenCalledWith({
      key: 'cluster_name',
      value: 'production-arm',
    });
    expect(mocks.onConflict).toHaveBeenCalled();
  });

  it('rejects an invalid name with the documented message', async () => {
    const { db } = createMockDb();
    await expect(setClusterName(db, 'Bad_Name')).rejects.toThrow(CLUSTER_NAME_FORMAT_MESSAGE);
  });

  it('rejects an empty string', async () => {
    const { db } = createMockDb();
    await expect(setClusterName(db, '')).rejects.toThrow();
  });
});

describe('resolveAndPersistClusterName', () => {
  it('returns the stored value when a row already exists (source=stored)', async () => {
    const { db, mocks } = createMockDb({ selectFirstRow: { value: 'production' } });
    const result = await resolveAndPersistClusterName(db, {
      KICI_CLUSTER_NAME: 'should-be-ignored',
    });
    expect(result).toEqual({ clusterName: 'production', source: 'stored' });
    // No insert when an existing row was returned.
    expect(mocks.insertInto).not.toHaveBeenCalled();
  });

  it('seeds from KICI_CLUSTER_NAME when no row exists (source=env-seeded)', async () => {
    const { db, mocks } = createMockDb({ selectFirstRow: undefined });
    const result = await resolveAndPersistClusterName(db, { KICI_CLUSTER_NAME: 'production' });
    expect(result).toEqual({ clusterName: 'production', source: 'env-seeded' });
    expect(mocks.insertValues).toHaveBeenCalledWith({
      key: 'cluster_name',
      value: 'production',
    });
  });

  it('auto-generates when neither stored nor env set (source=auto-generated)', async () => {
    const { db, mocks } = createMockDb({ selectFirstRow: undefined });
    // 0x11 0x22 0x33 → "cluster-112233"
    const result = await resolveAndPersistClusterName(
      db,
      {},
      fixedRandomSource([0x11, 0x22, 0x33]),
    );
    expect(result).toEqual({
      clusterName: 'cluster-112233',
      source: 'auto-generated',
    });
    expect(mocks.insertValues).toHaveBeenCalledWith({
      key: 'cluster_name',
      value: 'cluster-112233',
    });
  });

  it('rejects an env var that violates the regex', async () => {
    const { db } = createMockDb({ selectFirstRow: undefined });
    await expect(
      resolveAndPersistClusterName(db, { KICI_CLUSTER_NAME: 'Bad_Name' }),
    ).rejects.toThrow();
  });

  it('treats whitespace-only env var as unset', async () => {
    const { db, mocks } = createMockDb({ selectFirstRow: undefined });
    const result = await resolveAndPersistClusterName(
      db,
      { KICI_CLUSTER_NAME: '   ' },
      fixedRandomSource([0xab, 0xcd, 0xef]),
    );
    expect(result.source).toBe('auto-generated');
    expect(result.clusterName).toBe('cluster-abcdef');
    expect(mocks.insertValues).toHaveBeenCalledWith({
      key: 'cluster_name',
      value: 'cluster-abcdef',
    });
  });
});
