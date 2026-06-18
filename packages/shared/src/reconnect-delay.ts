/**
 * Calculate reconnection delay with exponential backoff and jitter.
 *
 * Formula: baseDelay * multiplier^attempts * (1.0 + random * 0.5)
 * - Initial delay: 1000ms
 * - Multiplier: 1.5x per attempt
 * - Jitter: 0-50% additional randomness
 * - Max delay: capped at maxDelayMs
 */
export function getReconnectDelay(attempts: number, maxDelayMs: number): number {
  const baseDelay = 1000;
  const multiplier = 1.5;
  const jitterFactor = 1.0 + Math.random() * 0.5;
  const delay = baseDelay * Math.pow(multiplier, attempts) * jitterFactor;
  return Math.min(delay, maxDelayMs);
}
