/**
 * Retry for the read-only status polls that follow a run. A failed read says
 * nothing about the run, so a transient failure is retried with capped backoff;
 * a refusal (4xx) is final at once.
 */

import { setTimeout as delay } from 'node:timers/promises';
import { toErrorMessage } from '@kici-dev/core';
import { DashboardApiErrorCode } from '@kici-dev/engine/protocol/dashboard-api-errors';
import { ConnectionError, HttpStatusError, NotFoundError } from './platform-client.js';

/**
 * Outlasts a saturated orchestrator pool (5 s acquire timeout, 30 s statement
 * timeout) and a host stall, and stays well inside the 15-minute idle window.
 */
export const READ_RETRY_BUDGET_MS = 120_000;

const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 10_000;

/** 408 and 429 ask the client to come back later; every 5xx is the server's own failure. */
const TRANSIENT_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 429]);

export interface ReadRetryOptions {
  /** Max time retrying consecutive failures. */
  budgetMs?: number;
  /** First backoff delay, doubled per attempt up to `maxDelayMs`. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  onTransientFailure?: (err: unknown, attempt: number) => void;
  /** Once aborted, the last failure is rethrown instead of retried. */
  signal?: AbortSignal;
  /** Defaults to {@link isTransientRemoteReadError}. */
  isTransient?: (err: unknown) => boolean;
  /** Names the last error when the budget runs out. */
  describe?: (err: unknown) => string;
}

/** A transient failure kept recurring for the whole retry budget. */
export class ReadRetryExhaustedError extends Error {
  constructor(
    readonly lastError: unknown,
    readonly budgetMs: number,
    describe: (err: unknown) => string = toErrorMessage,
  ) {
    super(`kept failing for ${Math.round(budgetMs / 1000)}s (last error: ${describe(lastError)})`);
    this.name = 'ReadRetryExhaustedError';
  }
}

export function isTransientStatus(status: number): boolean {
  return status >= 500 || TRANSIENT_CLIENT_STATUSES.has(status);
}

/** A dropped connection, passed deadline, 5xx, 408, 429, or 404 coded `orchestrator_not_found`. */
export function isTransientRemoteReadError(err: unknown): boolean {
  if (err instanceof ConnectionError) return true;
  if (err instanceof NotFoundError) {
    return err.code === DashboardApiErrorCode.enum.orchestrator_not_found;
  }
  return err instanceof HttpStatusError && isTransientStatus(err.status);
}

/** Run `read`, retrying transient failures until it succeeds or the budget is spent. */
export async function readWithRetry<T>(
  read: () => Promise<T>,
  opts: ReadRetryOptions = {},
): Promise<T> {
  const budgetMs = opts.budgetMs ?? READ_RETRY_BUDGET_MS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const isTransient = opts.isTransient ?? isTransientRemoteReadError;
  let firstFailureAt = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (err) {
      if (!isTransient(err) || opts.signal?.aborted) throw err;
      const now = Date.now();
      if (attempt === 1) firstFailureAt = now;
      const elapsed = now - firstFailureAt;
      if (elapsed >= budgetMs) throw new ReadRetryExhaustedError(err, budgetMs, opts.describe);
      opts.onTransientFailure?.(err, attempt);
      const wait = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs, budgetMs - elapsed);
      await delay(wait, undefined, { signal: opts.signal }).catch(() => undefined);
      if (opts.signal?.aborted) throw err;
    }
  }
}

/** A `get`-only client whose every read goes through {@link readWithRetry}. */
export function withReadRetry<C extends { get<T>(path: string): Promise<T> }>(
  client: C,
  opts: ReadRetryOptions = {},
): { get<T>(path: string): Promise<T> } {
  return { get: <T>(path: string) => readWithRetry(() => client.get<T>(path), opts) };
}
