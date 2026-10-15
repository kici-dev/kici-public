/** HTTP/HTTPS download and pre-signed upload helpers shared by dep-restore.ts and workflow-loader.ts. */

import https from 'node:https';
import http from 'node:http';
import { createLogger } from '@kici-dev/shared';
import { resolveOrchestratorUrl } from './dep-restore.js';
import { redactUrl } from './resumable-download.js';

const logger = createLogger({ prefix: 'agent:download' });

const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Per-attempt upload timeout, matching the download's. Without one, a
 * half-open socket hangs the PUT until the job timeout kills the step, the
 * failure reads "the job timed out" instead of "the upload stalled", and the
 * retry ladder is never reached. Per attempt, so a large tarball on a slow
 * link gets the full budget on each retry.
 */
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Retries after the first attempt. Matches `DEFAULT_DOWNLOAD_LIMITS.maxAttempts`
 * in `resumable-download.ts` so uploads and downloads give up at the same point.
 */
export const UPLOAD_MAX_RETRIES = 2;

/** Doubles for each subsequent retry. */
const UPLOAD_RETRY_BASE_DELAY_MS = 500;

class PresignedUploadHttpError extends Error {
  constructor(readonly statusCode: number) {
    super(`HTTP ${statusCode} uploading to pre-signed URL`);
    this.name = 'PresignedUploadHttpError';
  }
}

/**
 * Transport failures (refused, reset, DNS) never reached a responder, and
 * 5xx / 429 are the overload signals AWS documents as retry-with-backoff (S3
 * answers `SlowDown` with 503). Any other status (403 bad signature, 400
 * malformed request) repeats, so retrying only delays the real error.
 */
function isRetryableUploadFailure(err: unknown): boolean {
  if (!(err instanceof PresignedUploadHttpError)) return true;
  return err.statusCode >= 500 || err.statusCode === 429;
}

/** 5-minute timeout so a slow or unresponsive endpoint cannot hang the agent. */
export function downloadUrl(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    client
      .get(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }, (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          reject(new Error(`HTTP ${res.statusCode} downloading from ${redactUrl(url)}`));
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
    // Socket inactivity, not a deadline. Destroying the request turns the stall
    // into a retryable error rather than a promise that never settles.
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Pre-signed upload timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end(data);
  });
}

/**
 * PUT a buffer to a pre-signed S3 URL (bundles, dep tarballs), retrying a
 * transient failure ({@link isRetryableUploadFailure}). Localhost / 127.0.0.1
 * URLs are rewritten via `resolveOrchestratorUrl` so the filesystem cache
 * backend's signed URLs work from container agents that can't reach the
 * orchestrator's host loopback.
 *
 * **Retrying is safe**: a pre-signed PUT writes one whole object at one key (no
 * multipart, no append, no server-generated identity), and S3 exposes an object
 * only once its body arrived in full, so a retry cannot double-write or tear an
 * object — which is why every AWS SDK retries PUTs by default.
 *
 * @param opts.baseDelayMs - Backoff before the first retry (doubles thereafter)
 * @param opts.timeoutMs - Per-attempt socket-inactivity timeout; overridable so
 *   a test can drive the stall path without the production budget.
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
