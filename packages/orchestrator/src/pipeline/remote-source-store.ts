import type { Kysely } from 'kysely';
import type { Database, RemoteSourceRow } from '../db/types.js';

/**
 * Routing key a Platform-relayed `test.trigger` carries; `resolveOrgId` maps it
 * back to the org id via the `remote_sources` row.
 */
export function remoteRoutingKeyFor(orgId: string): string {
  return `remote:${orgId}`;
}

/**
 * Idempotently upsert an org's `remote_sources` anchor on every Platform
 * (re)connect, after `auth.success`. The unique `(customer_id)` constraint
 * makes it a self-heal that updates a changed `cluster_id`.
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
