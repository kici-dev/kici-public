/**
 * HTTP routes for the filesystem cache backend.
 *
 * `FilesystemCacheStorage` mints signed `http://<orch>/api/v1/cache/blob/<key>?sig=<token>`
 * URLs that the agent uses to GET cached bytes or PUT new uploads. These
 * routes verify the HMAC token, reject path traversal, and stream content
 * to / from disk under the configured `basePath`.
 *
 * The S3 backend doesn't go through these routes — it uses real pre-signed
 * URLs against the S3 endpoint. These routes are mounted only when the
 * filesystem backend is active (`deps.fsCache` truthy in app.ts).
 */

import type { Hono } from 'hono';
import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { stream as honoStream } from 'hono/streaming';
import { verifyToken } from './sign-url.js';

export interface FsCacheRouteDeps {
  basePath: string;
  signingSecret: string;
}

/** Mount filesystem-backend cache routes onto an existing Hono app. */
export function registerBlobRoutes(app: Hono, deps: FsCacheRouteDeps): void {
  const { basePath, signingSecret } = deps;

  app.get('/api/v1/cache/blob/:key{.+}', async (c) => {
    const key = c.req.param('key');
    const validationError = validateKey(key);
    if (validationError) return c.json({ error: validationError }, 400);

    const sig = c.req.query('sig');
    if (!sig) return c.json({ error: 'Missing sig' }, 401);
    const verify = verifyToken(signingSecret, 'GET', key, sig);
    if (!verify.ok) return c.json({ error: `Invalid token (${verify.reason})` }, 401);

    const filePath = join(basePath, key);
    let stat;
    try {
      stat = await fsPromises.stat(filePath);
    } catch (err: unknown) {
      if (isEnoent(err)) return c.json({ error: 'Not found' }, 404);
      throw err;
    }
    if (!stat.isFile()) return c.json({ error: 'Not a file' }, 404);

    c.header('Content-Type', 'application/octet-stream');
    c.header('Content-Length', String(stat.size));
    return honoStream(c, async (writer) => {
      const fileStream = createReadStream(filePath);
      for await (const chunk of fileStream) {
        await writer.write(chunk as Uint8Array);
      }
    });
  });

  app.put('/api/v1/cache/blob/:key{.+}', async (c) => {
    const key = c.req.param('key');
    const validationError = validateKey(key);
    if (validationError) return c.json({ error: validationError }, 400);

    const sig = c.req.query('sig');
    if (!sig) return c.json({ error: 'Missing sig' }, 401);
    const verify = verifyToken(signingSecret, 'PUT', key, sig);
    if (!verify.ok) return c.json({ error: `Invalid token (${verify.reason})` }, 401);

    const body = c.req.raw.body;
    if (!body) return c.json({ error: 'Missing body' }, 400);

    const filePath = join(basePath, key);
    await fsPromises.mkdir(dirname(filePath), { recursive: true });

    // Atomic write: stream into a temp sibling, fsync, rename. Prevents
    // half-written files from being readable if the connection drops.
    const tmpPath = `${filePath}.tmp-${randomBytes(6).toString('hex')}`;
    const handle = await fsPromises.open(tmpPath, 'w');
    try {
      await pipeline(
        Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream('', { fd: handle.fd, autoClose: false }),
      );
      await handle.sync();
    } catch (err) {
      await fsPromises.rm(tmpPath, { force: true });
      throw err;
    } finally {
      await handle.close();
    }
    await fsPromises.rename(tmpPath, filePath);

    return c.json({ ok: true }, 200);
  });
}

/**
 * Validate a cache key. Returns an error message string if invalid, or
 * `null` if the key is acceptable. Rejects:
 *
 *   - empty / NUL-containing keys
 *   - `..` path-traversal segments
 *   - leading or empty path segments (`/foo`, `foo//bar`)
 *
 * The same validation runs both at URL-signing time
 * (`FilesystemCacheStorage.resolvePath`) and at request-handling time, so a
 * malicious URL with a bad path can't reach the filesystem.
 */
function validateKey(key: string): string | null {
  if (!key || key.includes('\0')) return 'Invalid key';
  const segments = key.split('/');
  if (segments.length === 0) return 'Invalid key';
  for (const seg of segments) {
    if (seg === '' || seg === '..' || seg === '.') return 'Invalid key segment';
  }
  return null;
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}
