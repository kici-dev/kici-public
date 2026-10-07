import { afterEach, describe, expect, it, vi } from 'vitest';

// The real module builds a store against Postgres + S3; the fake below stands
// in for both so the test pins what this side passes to the shared ops: the
// `orchestrator` key segment and the `Orchestrator` error noun.
const keys = vi.hoisted(() => [
  'cs/orchestrator/execution_runs/rk-1/2026/10/04/abc123.jsonl.gz',
  'cs/platform/execution_runs/org-1/2026/10/04/def456.jsonl.gz',
]);

vi.mock('../../db/client.js', () => ({ createDb: () => ({ destroy: async () => undefined }) }));
vi.mock('../../cold-store/orchestrator-cold-store.js', () => ({
  readOrchestratorColdStoreConfig: () => ({
    enabled: true,
    storage: { bucket: 'b', prefix: 'cs/' },
  }),
  OrchestratorColdStore: class {
    getAdapter = (table: string) => (table === 'execution_runs' ? {} : undefined);
    listAdapters = () => [{ table: 'execution_runs' }];
    listObjectKeys = async (prefix: string) => keys.filter((k) => k.startsWith(prefix));
  },
}));

const { archiveNow, listChunks } = await import('./cold-store-impl.js');

describe('kici-admin cold-store ops (orchestrator side)', () => {
  afterEach(() => vi.restoreAllMocks());

  // fails-when: the orchestrator side passes db: 'platform' to the shared ops
  it('lists chunks under the orchestrator key segment only', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await listChunks({ databaseUrl: 'postgres://unused/db', table: 'execution_runs' });
    expect(write.mock.calls.map((c) => String(c[0]))).toEqual([
      '{"chunkId":"abc123","tenantId":"rk-1","partitionDate":"2026-10-04","dataKey":"cs/orchestrator/execution_runs/rk-1/2026/10/04/abc123.jsonl.gz","manifestKey":null}\n',
    ]);
  });

  // fails-when: the side label is not 'Orchestrator'
  it('names the orchestrator in the unknown-adapter error', async () => {
    await expect(
      archiveNow({ databaseUrl: 'postgres://unused/db', table: 'nope' }),
    ).rejects.toThrow(
      "no cold-store adapter registered for table 'nope' on Orchestrator; registered: execution_runs",
    );
  });
});
