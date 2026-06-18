import type { InitFailure } from '@kici-dev/engine';

/**
 * Reject reason for a pending init / dynamic-eval job the agent reported as
 * failed. Carries the optional structured initFailure the agent attached to
 * job.status.data so the orchestrator catch can record the correct category
 * instead of collapsing everything to a string.
 */
export class AgentJobFailedError extends Error {
  readonly name = 'AgentJobFailedError';
  constructor(
    message: string,
    readonly initFailure?: InitFailure,
  ) {
    super(message);
    // Restore prototype chain for instanceof across the transpile boundary.
    Object.setPrototypeOf(this, AgentJobFailedError.prototype);
  }
}
