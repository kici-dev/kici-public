import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOrgIngestCapReader } from './org-ingest-cap-reader.js';

// resolveOrgId is imported by the reader from ../pipeline/processor.js; stub it
// so the test drives org resolution without a real DB.
vi.mock('../pipeline/processor.js', () => ({
  resolveOrgId: vi.fn(),
}));
import { resolveOrgId } from '../pipeline/processor.js';

const resolveOrgIdMock = vi.mocked(resolveOrgId);

/**
 * Fake Kysely handle: only the `selectFrom('org_settings').select(...)
 * .where(...).executeTakeFirst()` chain the reader uses is modelled. The
 * executeTakeFirst spy lets each test control the org_settings row (or throw).
 */
const mkDb = (executeTakeFirst: () => Promise<unknown>) => {
  const chain = {
    select: () => chain,
    where: () => chain,
    executeTakeFirst,
  };
  return { selectFrom: () => chain } as never;
};

const CLUSTER_DEFAULT = 32;

beforeEach(() => {
  resolveOrgIdMock.mockReset();
});

describe('createOrgIngestCapReader', () => {
  it('returns the per-org override when the column is set', async () => {
    resolveOrgIdMock.mockResolvedValue('org-1');
    const reader = createOrgIngestCapReader({
      db: mkDb(async () => ({ ingest_max_concurrency: '10' })),
      clusterDefault: CLUSTER_DEFAULT,
    });
    const r = await reader.resolve('rk-1');
    expect(r).toEqual({ key: 'org-1', orgCap: 10 });
  });

  it('falls back to the cluster default when the column is null', async () => {
    resolveOrgIdMock.mockResolvedValue('org-2');
    const reader = createOrgIngestCapReader({
      db: mkDb(async () => ({ ingest_max_concurrency: null })),
      clusterDefault: CLUSTER_DEFAULT,
    });
    const r = await reader.resolve('rk-2');
    expect(r).toEqual({ key: 'org-2', orgCap: CLUSTER_DEFAULT });
  });

  it('degrades to routing-key + cluster default on a DB error', async () => {
    resolveOrgIdMock.mockRejectedValue(new Error('db down'));
    const reader = createOrgIngestCapReader({
      db: mkDb(async () => ({ ingest_max_concurrency: '10' })),
      clusterDefault: CLUSTER_DEFAULT,
    });
    const r = await reader.resolve('rk-3');
    expect(r).toEqual({ key: 'rk-3', orgCap: CLUSTER_DEFAULT });
  });

  it('degrades to routing-key + cluster default when no db is configured', async () => {
    const reader = createOrgIngestCapReader({ clusterDefault: CLUSTER_DEFAULT });
    const r = await reader.resolve('rk-4');
    expect(r).toEqual({ key: 'rk-4', orgCap: CLUSTER_DEFAULT });
    expect(resolveOrgIdMock).not.toHaveBeenCalled();
  });

  it('caches org resolution (no second resolveOrgId query within TTL)', async () => {
    resolveOrgIdMock.mockResolvedValue('org-5');
    const reader = createOrgIngestCapReader({
      db: mkDb(async () => ({ ingest_max_concurrency: '7' })),
      clusterDefault: CLUSTER_DEFAULT,
    });
    await reader.resolve('rk-5');
    await reader.resolve('rk-5');
    expect(resolveOrgIdMock).toHaveBeenCalledTimes(1);
  });

  it('caches the cap read (no second org_settings query within TTL)', async () => {
    resolveOrgIdMock.mockResolvedValue('org-6');
    const executeTakeFirst = vi.fn(async () => ({ ingest_max_concurrency: '9' }));
    const reader = createOrgIngestCapReader({
      db: mkDb(executeTakeFirst),
      clusterDefault: CLUSTER_DEFAULT,
    });
    await reader.resolve('rk-6');
    await reader.resolve('rk-6');
    expect(executeTakeFirst).toHaveBeenCalledTimes(1);
  });
});
