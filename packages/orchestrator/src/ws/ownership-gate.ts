import type { OwnershipTracker } from '../agent/ownership-tracker.js';

/** Whether a job-scoped agent frame may be handled. */
export type OwnershipDecision = 'accept' | 'reject';

/**
 * Resolve whether `agentId` may act on `jobId`, in the two steps every
 * job-scoped agent frame shares.
 *
 * 1. No tracker configured — ownership enforcement is off; accept.
 * 2. The synchronous in-memory check hits — accept without touching the
 *    database. This is the hot path: the owning coordinator answers from its
 *    own `agentJobs` map.
 * 3. Otherwise resolve asynchronously. `checkOwnership` returning false is
 *    "not decided yet", not "refused", whenever a database fallback is
 *    configured — so the caller must never treat step 2 as the verdict.
 *
 * A `reject` is final: the caller replies with the shared refusal wording (or,
 * where the message has no reply, drops the frame). What it must never do is
 * drop a frame that this function has not yet ruled on — an agent awaiting an
 * acknowledgment would hang until its own deadline expired.
 */
export async function gateOwnership(
  tracker: OwnershipTracker | undefined,
  agentId: string,
  jobId: string,
  messageType: string,
): Promise<OwnershipDecision> {
  if (!tracker) return 'accept';
  if (tracker.checkOwnership(agentId, jobId, messageType)) return 'accept';
  return (await tracker.validateAsync(agentId, jobId, messageType)) ? 'accept' : 'reject';
}
