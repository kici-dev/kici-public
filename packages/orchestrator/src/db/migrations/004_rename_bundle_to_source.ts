/**
 * Rename `dispatch_queue.bundle_url` / `bundle_hash` → `source_tar_url` /
 * `source_tar_hash`.
 *
 * The cached build artifact changed from a Rolldown-bundled `.compiled.mjs`
 * (keyed under `bundles/{contentHash}.js` in S3) to a raw `.kici/` source
 * tarball (keyed under `source/{contentHash}.tar.gz`). The agent extracts it
 * and imports the workflow via the shared oxc-transform ESM loader hook
 * instead of running Rolldown at runtime.
 *
 * Pre-release rename: no data preservation needed. Any rows referencing the
 * old bundle URLs will fail their contentHash lookup once the new SCHEMA_V4
 * cache prefix lands, and the orchestrator will schedule a fresh build job —
 * same as any other cache miss.
 */

import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('dispatch_queue')
    .renameColumn('bundle_url', 'source_tar_url')
    .execute();
  await db.schema
    .alterTable('dispatch_queue')
    .renameColumn('bundle_hash', 'source_tar_hash')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('dispatch_queue')
    .renameColumn('source_tar_url', 'bundle_url')
    .execute();
  await db.schema
    .alterTable('dispatch_queue')
    .renameColumn('source_tar_hash', 'bundle_hash')
    .execute();
}
