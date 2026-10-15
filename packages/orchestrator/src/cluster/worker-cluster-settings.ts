/**
 * The cluster-settings snapshot a coordinator serves to DB-less workers.
 *
 * Every knob a worker applies at spawn reaches it through this snapshot,
 * pulled over the peer channel whenever a coordinator advertises a newer
 * settings version. Each value is the stored override, or the serving
 * coordinator's configured default when the column is NULL.
 */
import type { WorkerClusterSettings } from '@kici-dev/engine';
import type { ClusterSettingsReader } from './cluster-settings-reader.js';

export interface WorkerClusterSettingDefaults {
  agentTokenTtlMs: number;
  firecrackerApiSocketWaitMs: number;
  concurrencyWaitTimeoutMs: number;
}

/** A worker snapshot and the `cluster_settings.version` its values belong to. */
export interface WorkerClusterSettingsSnapshot {
  version: number;
  settings: WorkerClusterSettings;
}

/** A pg BIGINT/INTEGER (string | number | null) as a number, or `fallback` when unset. */
function numberOr(value: unknown, fallback: number): number {
  return value === null || value === undefined ? fallback : Number(value);
}

/**
 * Resolve the snapshot and its version from ONE row read: a worker pulls again
 * only on a higher advertised version, so a separately read version could pair
 * a newer version with older values for good.
 */
export async function resolveWorkerClusterSettingsSnapshot(
  reader: Pick<ClusterSettingsReader, 'getRow'>,
  defaults: WorkerClusterSettingDefaults,
): Promise<WorkerClusterSettingsSnapshot> {
  const row = await reader.getRow();
  return {
    version: numberOr(row?.version, 0),
    settings: {
      agentTokenTtlMs: numberOr(row?.agent_token_ttl_ms, defaults.agentTokenTtlMs),
      firecrackerApiSocketWaitMs: numberOr(
        row?.firecracker_api_socket_wait_ms,
        defaults.firecrackerApiSocketWaitMs,
      ),
      concurrencyWaitTimeoutMs: numberOr(
        row?.concurrency_wait_timeout_ms,
        defaults.concurrencyWaitTimeoutMs,
      ),
    },
  };
}
