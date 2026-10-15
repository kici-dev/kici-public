/**
 * Rename `dispatch_queue.bundle_url` / `bundle_hash` → `source_tar_url` /
 * `source_tar_hash`.
 *
 * The cached build artifact is a raw `.kici/` source tarball
 * (`source/{contentHash}.tar.gz` in S3), not a Rolldown-bundled `.compiled.mjs`
 * (`bundles/{contentHash}.js`). The agent extracts it and imports the workflow
 * through the shared oxc-transform ESM loader hook.
 *
 * Pre-release rename with no data preservation: rows with old bundle URLs miss
 * their contentHash lookup under the SCHEMA_V4 cache prefix and get a fresh
 * build job, like any cache miss.
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
