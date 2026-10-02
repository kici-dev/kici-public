import { describe, it, expect } from 'vitest';
import { ClusterSettingsReader } from './cluster-settings-reader.js';
import { resolveWorkerClusterSettingsSnapshot } from './worker-cluster-settings.js';

/**
 * A cluster_settings stub whose single-row read returns `rows` in order (the
 * last one repeats), so a test can change the row between two reads.
 */
function readerOver(...rows: Array<Record<string, unknown> | undefined>): ClusterSettingsReader {
  let reads = 0;
  const db = {
    selectFrom: () => ({
      selectAll: () => ({
        where: () => ({
          executeTakeFirst: async () => rows[Math.min(reads++, rows.length - 1)],
        }),
      }),
    }),
  } as never;
  // TTL 0: every read goes to the database, the worst case for a mixed snapshot.
  return new ClusterSettingsReader(db, 0);
}

const DEFAULTS = { agentTokenTtlMs: 3_600_000, firecrackerApiSocketWaitMs: 30_000 };

describe('resolveWorkerClusterSettingsSnapshot', () => {
  it('serves the stored firecracker_api_socket_wait_ms override with the row version', async () => {
    // BIGINT columns come back from PostgreSQL as strings.
    const snapshot = await resolveWorkerClusterSettingsSnapshot(
      readerOver({ id: 'default', version: '3', firecracker_api_socket_wait_ms: '45000' }),
      DEFAULTS,
    );

    // fails-when: the coordinator leaves the knob out of the snapshot, so a
    // DB-less worker never applies an operator's override.
    expect(snapshot).toEqual({
      version: 3,
      settings: { agentTokenTtlMs: 3_600_000, firecrackerApiSocketWaitMs: 45_000 },
    });
  });

  // fails-when: the values and the version come from separate reads. A worker
  // would record the newer version with the older values, and never pull again
  // because it pulls only when a coordinator advertises a higher version.
  it('takes the version and the values from the same read of the row', async () => {
    const snapshot = await resolveWorkerClusterSettingsSnapshot(
      readerOver(
        { id: 'default', version: 4, firecracker_api_socket_wait_ms: 45_000 },
        { id: 'default', version: 5, firecracker_api_socket_wait_ms: 60_000 },
      ),
      DEFAULTS,
    );

    expect(snapshot).toEqual({
      version: 4,
      settings: { agentTokenTtlMs: 3_600_000, firecrackerApiSocketWaitMs: 45_000 },
    });
  });

  it('falls back to the configured default when the column is NULL', async () => {
    const snapshot = await resolveWorkerClusterSettingsSnapshot(
      readerOver({
        id: 'default',
        version: 3,
        firecracker_api_socket_wait_ms: null,
        agent_token_ttl_ms: null,
      }),
      DEFAULTS,
    );

    expect(snapshot).toEqual({ version: 3, settings: DEFAULTS });
  });

  // breaks-if-wrong: a cluster whose row was never written serves version 0,
  // which a worker never takes as newer than what it has
  it('serves version 0 and the defaults when no row exists', async () => {
    expect(await resolveWorkerClusterSettingsSnapshot(readerOver(undefined), DEFAULTS)).toEqual({
      version: 0,
      settings: DEFAULTS,
    });
  });
});
