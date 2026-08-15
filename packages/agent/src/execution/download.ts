/**
 * Shared HTTP/HTTPS download utility.
 *
 * Extracted from workflow-loader.ts to avoid duplication across
 * dep-restore.ts and workflow-loader.ts.
 */

import https from 'node:https';
import http from 'node:http';
import { createLogger } from '@kici-dev/shared';
import { resolveOrchestratorUrl } from './dep-restore.js';

const logger = createLogger({ prefix: 'agent:download' });

/** Download timeout: 5 minutes. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Per-attempt upload timeout: 5 minutes, matching the download's.
 *
 * Without one, a wedged socket — a half-open connection an object store never
 * answers on — hangs the PUT until the whole job's timeout kills the step, and
 * the failure surfaces as "the job timed out" rather than "the upload stalled".
 * A timeout also makes the retry ladder reachable for that failure mode: an
 * `ETIMEDOUT` is a transport error, so it retries, where an indefinite hang can
 * never reach a second attempt.
 *
 * Applied per attempt, so a large cache tarball on a slow link gets the full
 * budget again on each retry rather than sharing one across all three.
 */
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Retries a pre-signed upload makes after its first attempt, matching the
 * dep-tarball download's ceiling (`MAX_RETRIES` in `dep-restore.ts`) so both
 * halves of the agent's object-storage traffic give up at the same point.
 */
export const UPLOAD_MAX_RETRIES = 2;

/** Base delay before the first retry; doubles for each subsequent one. */
const UPLOAD_RETRY_BASE_DELAY_MS = 500;

/** Error carrying the HTTP status a pre-signed upload was answered with. */
class PresignedUploadHttpError extends Error {
  constructor(readonly statusCode: number) {
    super(`HTTP ${statusCode} uploading to pre-signed URL`);
    this.name = 'PresignedUploadHttpError';
  }
}

/**
 * Whether a failed upload attempt is worth repeating.
 *
 * A transport failure (connection refused, reset, DNS) never reached a
 * responder, and 5xx / 429 are the object-storage overload signals AWS
 * documents as retry-with-backoff (S3 answers `SlowDown` with 503). Every other
 * status is a decision the server will repeat: a 403 from an expired or
 * malformed signature, a 400 from a malformed request. Retrying those burns the
 * ceiling without a chance of success and delays the real error.
 */
function isRetryableUploadFailure(err: unknown): boolean {
  if (!(err instanceof PresignedUploadHttpError)) return true;
  return err.statusCode >= 500 || err.statusCode === 429;
}

/**
 * Download content from an HTTP/HTTPS URL.
 *
 * Includes a 5-minute timeout to prevent the agent from hanging indefinitely
 * on slow or unresponsive endpoints.
 *
 * @param url - The URL to download from
 * @returns The response body as a Buffer
 */
export function downloadUrl(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    client
      .get(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }, (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          reject(new Error(`HTTP ${res.statusCode} downloading from ${url}`));
          res.resume();
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

/** One PUT of the whole buffer. Rejects with {@link PresignedUploadHttpError} on a non-2xx. */
function putOnce(resolvedUrl: string, data: Buffer, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(resolvedUrl);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'PUT',
        headers: {
          'Content-Length': data.length,
        },
      },
      (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          reject(new PresignedUploadHttpError(res.statusCode));
          res.resume();
          return;
        }
        res.resume();
        res.on('end', () => resolve());
        res.on('error', reject);
      },
    );
    // `setTimeout` here is inactivity on the socket, not a deadline: it fires
    // when nothing has been read or written for the interval. Destroying the
    // request is what turns the stall into an `ECONNRESET`/`ETIMEDOUT` the
    // caller can retry, rather than a promise that never settles.
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Pre-signed upload timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end(data);
  });
}

/**
 * Upload a buffer to a pre-signed S3 URL via HTTP PUT, retrying a transient
 * failure.
 *
 * Used for direct-to-S3 uploads of bundles and dep tarballs. Localhost /
 * 127.0.0.1 URLs are rewritten via `resolveOrchestratorUrl` so the
 * filesystem cache backend's signed URLs work from container agents that
 * can't reach the orchestrator's host loopback directly.
 *
 * **Why retrying is safe here.** A pre-signed PUT writes one whole object at a
 * single key: there is no multipart session, no append, and no
 * server-generated identity, so a repeat attempt writes the same bytes to the
 * same key and the last write wins. S3 also only makes an object visible once
 * the body has been received in full, so an attempt that died mid-body left
 * nothing behind. A retry therefore cannot double-write or produce a torn
 * object — which is why every AWS SDK retries PUTs by default.
 *
 * Only a failure that can plausibly differ next time is repeated — see
 * {@link isRetryableUploadFailure}.
 *
 * @param url - The pre-signed URL to upload to
 * @param data - The buffer to upload
 * @param opts.baseDelayMs - Backoff before the first retry (doubles thereafter)
 * @param opts.timeoutMs - Per-attempt socket-inactivity timeout (see
 *   {@link UPLOAD_TIMEOUT_MS}); an override exists so a test can drive the
 *   stall path without waiting out the production budget.
 */
export async function uploadToPresignedUrl(
  url: string,
  data: Buffer,
  opts?: { baseDelayMs?: number; timeoutMs?: number },
): Promise<void> {
  const resolved = resolveOrchestratorUrl(url);
  const baseDelayMs = opts?.baseDelayMs ?? UPLOAD_RETRY_BASE_DELAY_MS;
  const timeoutMs = opts?.timeoutMs ?? UPLOAD_TIMEOUT_MS;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      logger.warn('Retrying pre-signed upload', {
        attempt,
        delayMs,
        error: lastError?.message,
      });
      await new Promise((r) => setTimeout(r, delayMs));
    }
    try {
      await putOnce(resolved, data, timeoutMs);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (!isRetryableUploadFailure(lastError)) throw lastError;
    }
  }

  throw new Error(
    `Pre-signed upload failed after ${UPLOAD_MAX_RETRIES + 1} attempts: ${lastError?.message}`,
  );
}
