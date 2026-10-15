import type { InitFailure } from '@kici-dev/engine';

/**
 * Reject reason for a pending init / dynamic-eval job the agent reported as
 * failed. Carries the agent's optional structured `job.status.data` initFailure
 * so the catch records the correct category, not just a string.
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
