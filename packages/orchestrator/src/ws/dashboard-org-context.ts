/**
 * The org and routing key the dashboard handlers scope their reads to, resolved
 * when the orchestrator authenticates with the Platform.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

export interface DashboardOrgContext {
  orgId: string;
  routingKey: string;
}

/**
 * With the org the Platform authenticated this orchestrator as, pick a routing
 * key of THAT org: a GitHub source, else a live generic source, else the
 * `remote_sources` anchor a sourceless Platform-first org has. Without one,
 * take the first source of any real tenant org in the same order. Never
 * `__default__`: the dashboard reads the Platform-managed org, and an
 * orchestrator that also holds `__default__` sources must not scope the
 * dashboard to them.
 */
export async function resolveDashboardOrgContext(
  db: Kysely<Database>,
  attachedOrgId: string | undefined,
): Promise<DashboardOrgContext | undefined> {
  const [op, org] = attachedOrgId
    ? (['=', attachedOrgId] as const)
    : (['!=', '__default__'] as const);
  const resolved =
    (await db
      .selectFrom('sources')
      .select(['customer_id', 'routing_key'])
      .where('customer_id', op, org)
      .limit(1)
      .executeTakeFirst()) ??
    (await db
      .selectFrom('generic_webhook_sources')
      .select(['customer_id', 'routing_key'])
      .where('customer_id', op, org)
      .where('deleted_at', 'is', null)
      .limit(1)
      .executeTakeFirst()) ??
    (await db
      .selectFrom('remote_sources')
      .select(['customer_id', 'routing_key'])
      .where('customer_id', op, org)
      .limit(1)
      .executeTakeFirst());
  return resolved ? { orgId: resolved.customer_id, routingKey: resolved.routing_key } : undefined;
}
