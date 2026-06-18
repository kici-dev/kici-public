/**
 * Shared HTTP/HTTPS download utility.
 *
 * Extracted from workflow-loader.ts to avoid duplication across
 * dep-restore.ts and workflow-loader.ts.
 */

import https from 'node:https';
import http from 'node:http';
import { resolveOrchestratorUrl } from './dep-restore.js';

/** Download timeout: 5 minutes. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

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

/**
 * Upload a buffer to a pre-signed S3 URL via HTTP PUT.
 *
 * Used for direct-to-S3 uploads of bundles and dep tarballs. Localhost /
 * 127.0.0.1 URLs are rewritten via `resolveOrchestratorUrl` so the
 * filesystem cache backend's signed URLs work from container agents that
 * can't reach the orchestrator's host loopback directly.
 *
 * @param url - The pre-signed URL to upload to
 * @param data - The buffer to upload
 */
export function uploadToPresignedUrl(url: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const resolved = resolveOrchestratorUrl(url);
    const parsed = new URL(resolved);
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
          reject(new Error(`HTTP ${res.statusCode} uploading to pre-signed URL`));
          res.resume();
          return;
        }
        res.resume();
        res.on('end', () => resolve());
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}
