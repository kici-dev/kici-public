export type RetryBackoff = 'fixed' | 'exponential';

export interface ResolvedRetry {
  maxAttempts: number;
  delayMs: number;
  backoff: RetryBackoff;
  maxDelayMs: number;
}

/** Delay (ms) to wait after a failed 1-based `attempt` before the next attempt. */
export function computeBackoffDelay(attempt: number, cfg: ResolvedRetry): number {
  if (cfg.backoff === 'fixed') return cfg.delayMs;
  return Math.min(cfg.delayMs * 2 ** (attempt - 1), cfg.maxDelayMs);
}
