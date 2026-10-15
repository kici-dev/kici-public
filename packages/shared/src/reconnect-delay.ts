/**
 * Reconnection delay in ms: 1000 * 1.5^attempts plus 0-50% jitter, capped at
 * `maxDelayMs`.
 */
export function getReconnectDelay(attempts: number, maxDelayMs: number): number {
  const baseDelay = 1000;
  const multiplier = 1.5;
  const jitterFactor = 1.0 + Math.random() * 0.5;
  const delay = baseDelay * Math.pow(multiplier, attempts) * jitterFactor;
  return Math.min(delay, maxDelayMs);
}
