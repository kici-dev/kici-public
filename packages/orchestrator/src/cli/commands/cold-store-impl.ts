/**
 * Implementations for `kici-admin cold-store` subcommands: the shared
 * cold-store admin ops (`createColdStoreAdminOps` in `@kici-dev/shared`),
 * bound to an `OrchestratorColdStore` built against the orchestrator
 * Postgres + S3.
 *
 * No per-invocation breadcrumb row is written: the Platform admin CLI's
 * `audit_log` breadcrumb has no `access_log` counterpart here.
 */
import { ChunkLru, createColdStoreAdminOps, createLogger, createPool } from '@kici-dev/shared';
import { createDb } from '../../db/client.js';
import {
  OrchestratorColdStore,
  readOrchestratorColdStoreConfig,
} from '../../cold-store/orchestrator-cold-store.js';

const logger = createLogger({ prefix: 'kici-admin-cold-store' });

async function build(deps: { databaseUrl: string; instanceId?: string }) {
  const config = readOrchestratorColdStoreConfig();
  const pool = createPool(deps.databaseUrl);
  const kdb = createDb(pool);
  const store = new OrchestratorColdStore({
    kdb,
    config,
    instanceId: deps.instanceId ?? 'kici-admin-cli',
    chunkCache: new ChunkLru<string, Buffer>({
      maxBytes: 256 * 1024 * 1024,
      sizeOf: (v) => v.byteLength,
    }),
    log: (level, msg, extra) => {
      if (level === 'info') logger.info(msg, extra);
      else if (level === 'warn') logger.warn(msg, extra);
      else logger.error(msg, extra);
    },
  });
  return {
    store,
    prefix: config.storage.prefix,
    enabled: config.enabled,
    close: async () => {
      await kdb.destroy();
      await pool.end().catch(() => undefined);
    },
  };
}

export const {
  archiveNow,
  dryRunArchive,
  listChunks,
  verifyChunk,
  replayChunk,
  replayIntoPg,
  reconcile,
  listPurgeable,
  purgeNow,
  peekChunk,
} = createColdStoreAdminOps({
  db: 'orchestrator',
  label: 'Orchestrator',
  reconcileInstanceId: 'kici-admin-cli:reconcile',
  build,
});
