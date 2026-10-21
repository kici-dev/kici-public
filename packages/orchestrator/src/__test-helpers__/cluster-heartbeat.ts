/**
 * Upsert a `cluster_instances` heartbeat `minutesAgo` minutes in the past, for
 * real-Postgres tests of the liveness reads (`liveInstanceIds`,
 * `hasOtherLiveInstance`, the stale detector's sweep).
 */
import { type Kysely, sql } from 'kysely';
import type { Database } from '../db/types.js';

export async function insertClusterHeartbeat(
  db: Kysely<Database>,
  instanceId: string,
  minutesAgo: number,
): Promise<void> {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  await sql`
    INSERT INTO public.cluster_instances (instance_id, last_heartbeat_at)
    VALUES (${instanceId}, ${at})
    ON CONFLICT (instance_id) DO UPDATE SET last_heartbeat_at = EXCLUDED.last_heartbeat_at
  `.execute(db);
}
