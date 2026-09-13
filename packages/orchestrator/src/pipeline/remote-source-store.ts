import type { Kysely } from 'kysely';
import type { Database, RemoteSourceRow } from '../db/types.js';

/**
 * Deterministic routing key for an org's Platform-relayed remote runs. A
 * Platform-relayed `test.trigger` carries this key; `resolveOrgId` maps it back
 * to the canonical org id via the `remote_sources` row.
 */
export function remoteRoutingKeyFor(orgId: string): string {
  return `remote:${orgId}`;
}

/**
 * Idempotently upsert the `remote_sources` anchor for an org. Called on every
 * Platform (re)connect once the orchestrator learns its canonical org id from
 * `auth.success`. The unique `(customer_id)` constraint makes this a safe
 * self-heal — re-running updates `cluster_id` if the cluster identity changed.
 */
export async function provisionRemoteSource(
  db: Kysely<Database>,
  params: { orgId: string; clusterId: string | null },
): Promise<void> {
  await db
    .insertInto('remote_sources')
    .values({
      customer_id: params.orgId,
      routing_key: remoteRoutingKeyFor(params.orgId),
      cluster_id: params.clusterId,
    })
    .onConflict((oc) =>
      oc.column('customer_id').doUpdateSet({
        cluster_id: params.clusterId,
        updated_at: new Date(),
      }),
    )
    .execute();
}

/** Read the auto-provisioned remote-source row for an org, if it exists. */
export async function getRemoteSource(
  db: Kysely<Database>,
  orgId: string,
): Promise<RemoteSourceRow | undefined> {
  return db
    .selectFrom('remote_sources')
    .selectAll()
    .where('customer_id', '=', orgId)
    .executeTakeFirst();
}
