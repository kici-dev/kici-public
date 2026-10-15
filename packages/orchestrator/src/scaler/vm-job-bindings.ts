/**
 * Durable job-to-agent bindings from the coordinator's dispatch queue: the coordinator's half
 * of live-VM tracking (a worker has no database). A VM whose agent holds a non-terminal job is
 * tracked even when its node has lost every in-memory trace of it.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { TERMINAL_DISPATCH_STATUSES } from '../queue/job-queue.js';

/**
 * The non-terminal job (`dispatch_queue.id`) each of `agentIds` holds: one it was dispatched
 * (`agent_id`) or one waiting for it to reconnect (`recovery_agent_id`).
 */
export async function findActiveJobBindings(
  db: Kysely<Database>,
  agentIds: readonly string[],
): Promise<Map<string, string>> {
  const bound = new Map<string, string>();
  if (agentIds.length === 0) return bound;
  const wanted = new Set(agentIds);
  const ids = [...wanted];
  const rows = await db
    .selectFrom('dispatch_queue')
    .select(['id', 'agent_id', 'recovery_agent_id'])
    .where('status', 'not in', TERMINAL_DISPATCH_STATUSES)
    .where((eb) => eb.or([eb('agent_id', 'in', ids), eb('recovery_agent_id', 'in', ids)]))
    .execute();
  for (const row of rows) {
    for (const agentId of [row.agent_id, row.recovery_agent_id]) {
      if (agentId && wanted.has(agentId)) bound.set(agentId, row.id);
    }
  }
  return bound;
}
