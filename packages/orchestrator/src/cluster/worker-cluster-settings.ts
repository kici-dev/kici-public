/**
 * The cluster-settings snapshot a coordinator serves to DB-less workers.
 *
 * A worker cannot read `cluster_settings`, so every knob it applies at spawn
 * reaches it through this snapshot, pulled over the peer channel whenever a
 * coordinator advertises a newer settings version. Each value is the stored
 * override, or the serving coordinator's configured default when the column
 * is NULL.
 */
import type { WorkerClusterSettings } from '@kici-dev/engine';
import type { ClusterSettingsReader } from './cluster-settings-reader.js';

/** The configured defaults behind each snapshot field. */
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
 * Resolve the worker snapshot and its version from ONE read of the row. A
 * worker stores the version with the values and pulls again only when a
 * coordinator advertises a higher version, so a version read separately from
 * the values could pair a newer version with older values for good.
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
