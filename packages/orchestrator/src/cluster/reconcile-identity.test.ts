import { describe, it, expect, beforeEach } from 'vitest';
import { runIdempotentStep } from '@kici-dev/shared/idempotency';
import { buildReconcileStep, reconcileIo, type ReconcileS3Config } from './reconcile-identity.js';

// Surface id needle for the coverage gate: cli:kici-admin:cluster reconcile-identity

const s3: ReconcileS3Config = {
  bucket: 'b',
  prefix: 'kici-cache/',
  accessKeyId: 'x',
  secretAccessKey: 'y',
};

const state = {
  dbValue: 'A' as string | null,
  sentinelValue: 'A' as string | null,
  dbWrites: [] as string[],
  sentinelWrites: [] as string[],
};

beforeEach(() => {
  state.dbValue = 'A';
  state.sentinelValue = 'A';
  state.dbWrites = [];
  state.sentinelWrites = [];
  reconcileIo.readClusterIdFromDb = async () => state.dbValue;
  reconcileIo.writeClusterIdToDb = async (_u: string, v: string) => {
    state.dbWrites.push(v);
    state.dbValue = v;
  };
  reconcileIo.readSentinel = async () => state.sentinelValue;
  reconcileIo.writeSentinel = async (_s: ReconcileS3Config, v: string) => {
    state.sentinelWrites.push(v);
    state.sentinelValue = v;
  };
});

describe('buildReconcileStep', () => {
  it('returns null (in sync) when DB and sentinel match', async () => {
    const step = buildReconcileStep({ databaseUrl: 'db', s3, direction: 'db-from-sentinel' });
    expect(await step.check()).toBeNull();
  });

  it('db-from-sentinel: drift then apply rewrites DB from sentinel', async () => {
    state.dbValue = 'NEW';
    state.sentinelValue = 'OLD';
    const step = buildReconcileStep({ databaseUrl: 'db', s3, direction: 'db-from-sentinel' });
    const res = await runIdempotentStep(step, { yes: true, log: () => {} });
    expect(res.outcome).toBe('applied');
    expect(state.dbWrites).toEqual(['OLD']);
  });

  it('sentinel-from-db (--adopt-db): drift then apply rewrites sentinel from DB', async () => {
    state.dbValue = 'DBID';
    state.sentinelValue = 'STALE';
    const step = buildReconcileStep({ databaseUrl: 'db', s3, direction: 'sentinel-from-db' });
    const res = await runIdempotentStep(step, { yes: true, log: () => {} });
    expect(res.outcome).toBe('applied');
    expect(state.sentinelWrites).toEqual(['DBID']);
  });

  it('db-from-sentinel throws when sentinel absent', async () => {
    state.dbValue = 'X';
    state.sentinelValue = null;
    const step = buildReconcileStep({ databaseUrl: 'db', s3, direction: 'db-from-sentinel' });
    await expect(step.check()).rejects.toThrow(/--adopt-db/);
  });

  it('sentinel-from-db writes a brand-new sentinel when it is absent', async () => {
    state.dbValue = 'DBID';
    state.sentinelValue = null;
    const step = buildReconcileStep({ databaseUrl: 'db', s3, direction: 'sentinel-from-db' });
    const res = await runIdempotentStep(step, { yes: true, log: () => {} });
    expect(res.outcome).toBe('applied');
    expect(state.sentinelWrites).toEqual(['DBID']);
  });

  it('throws when DB cluster_meta row absent', async () => {
    state.dbValue = null;
    const step = buildReconcileStep({ databaseUrl: 'db', s3, direction: 'db-from-sentinel' });
    await expect(step.check()).rejects.toThrow(/migrations/);
  });

  it('dry-run reports drift without applying', async () => {
    state.dbValue = 'NEW';
    state.sentinelValue = 'OLD';
    const step = buildReconcileStep({ databaseUrl: 'db', s3, direction: 'db-from-sentinel' });
    const res = await runIdempotentStep(step, { dryRun: true, log: () => {} });
    expect(res.outcome).toBe('dry-run');
    expect(state.dbWrites).toEqual([]);
  });

  it('declined leaves state unchanged', async () => {
    state.dbValue = 'NEW';
    state.sentinelValue = 'OLD';
    const step = buildReconcileStep({ databaseUrl: 'db', s3, direction: 'db-from-sentinel' });
    const res = await runIdempotentStep(step, { confirm: async () => false, log: () => {} });
    expect(res.outcome).toBe('declined');
    expect(state.dbWrites).toEqual([]);
  });
});
