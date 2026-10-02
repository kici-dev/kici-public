/**
 * Errors a scaler backend's `spawn()` throws to tell the manager how to treat
 * the failure.
 */

/**
 * A spawn the host refused outright. Retrying cannot succeed until an operator
 * changes something — the binary path, the label set's env — so the manager
 * defers the scaler instead of freeing the capacity for an immediate retry.
 * The backend emits `scaler.failed` before it throws this.
 */
export class DeterministicSpawnError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DeterministicSpawnError';
  }
}

export function isDeterministicSpawnError(err: unknown): err is DeterministicSpawnError {
  return err instanceof DeterministicSpawnError;
}
