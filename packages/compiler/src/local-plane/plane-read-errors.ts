/** How the read retry classifies the local plane's admin API errors. */

import {
  AdminApiHttpError,
  AdminApiUnreachableError,
  type AdminRequestOptions,
} from '@kici-dev/orchestrator';
import { toErrorMessage } from '@kici-dev/core';
import { READ_REQUEST_TIMEOUT_MS, readRequestSignal } from '../remote/platform-client.js';
import { isTransientStatus, type ReadRetryOptions } from '../remote/read-retry.js';

/** `AdminApiClient.get`, injectable for tests. */
export interface PlaneReadClient {
  get<T>(path: string, opts?: AdminRequestOptions): Promise<T>;
}

/**
 * Bounds each read, body included, by `timeoutMs` (a passed deadline is a transient
 * `AdminApiUnreachableError`); `signal` (Ctrl-C) ends a read at once.
 */
export function withReadDeadline(
  client: PlaneReadClient,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): PlaneReadClient {
  const timeoutMs = opts.timeoutMs ?? READ_REQUEST_TIMEOUT_MS;
  return {
    get: <T>(path: string) =>
      client.get<T>(path, { signal: readRequestSignal(timeoutMs, opts.signal) }),
  };
}

export function isTransientPlaneReadError(err: unknown): boolean {
  if (err instanceof AdminApiUnreachableError) return true;
  return err instanceof AdminApiHttpError && isTransientStatus(err.status);
}

/** One line; drops kici-admin's `KICI_ADMIN_URL` advice, which does not apply to the plane. */
export function describePlaneReadError(err: unknown): string {
  if (err instanceof AdminApiUnreachableError) {
    if ((err.cause as Error | undefined)?.name === 'TimeoutError') {
      return 'no answer before the read deadline';
    }
    const detail = innermostCauseMessage(err);
    return detail ? `connection failed: ${detail}` : 'connection failed';
  }
  return toErrorMessage(err);
}

function innermostCauseMessage(err: Error): string {
  let detail = '';
  let current: unknown = err.cause;
  while (current instanceof Error) {
    if (current.message) detail = current.message;
    current = current.cause;
  }
  return detail;
}

export const PLANE_READ_ERRORS: Pick<ReadRetryOptions, 'isTransient' | 'describe'> = {
  isTransient: isTransientPlaneReadError,
  describe: describePlaneReadError,
};
