import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DOWNLOAD_LIMITS,
  DownloadFailedError,
  describeError,
  downloadToFile,
  redactUrl,
  type DownloadAttempt,
} from './resumable-download.js';

const BODY = randomBytes(1024 * 1024 + 123);
const BODY_SHA = createHash('sha256').update(BODY).digest('hex');
const HALF = 512 * 1024;
const ETAG = '"body-v1"';
/** Retries in these tests wait 1 ms instead of the production 500 ms. */
const FAST = { retryBaseDelayMs: 1 };

let dir: string;
let server: Server | undefined;
let seen: Array<{ range?: string; ifMatch?: string }>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'resumable-download-test-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

/** Start a server; `handler` gets the 1-based request number. */
async function serve(
  handler: (req: IncomingMessage, res: ServerResponse, n: number) => void,
): Promise<string> {
  seen = [];
  server = createServer((req, res) => {
    seen.push({
      range: req.headers.range,
      ifMatch: req.headers['if-match'] as string | undefined,
    });
    handler(req, res, seen.length);
  });
  server.keepAliveTimeout = 0;
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no server address');
  return `http://127.0.0.1:${addr.port}/deps.tar.gz?X-Amz-Signature=secret`;
}

/** Answer a `Range: bytes=N-` request with 206, anything else with the full 200 body. */
function serveRange(req: IncomingMessage, res: ServerResponse): void {
  const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
  if (m) {
    const start = Number(m[1]);
    res.writeHead(206, {
      'content-length': String(BODY.length - start),
      'content-range': `bytes ${start}-${BODY.length - 1}/${BODY.length}`,
      etag: ETAG,
    });
    res.end(BODY.subarray(start));
    return;
  }
  res.writeHead(200, { 'content-length': String(BODY.length), etag: ETAG });
  res.end(BODY);
}

/** Send the first half of the body, then drop the connection. */
function cutMidBody(res: ServerResponse): void {
  res.writeHead(200, { 'content-length': String(BODY.length), etag: ETAG });
  res.write(BODY.subarray(0, HALF), () => setTimeout(() => res.socket?.destroy(), 20));
}

async function sha(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

describe('downloadToFile', () => {
  it('completes a response the server closes the moment it is written', async () => {
    // The undici race: FIN right after the last byte. `fetch` loses about half
    // of these (see dep-restore.race.test.ts); node:http must lose none.
    // fails-when: the downloader reads the body through undici `fetch`
    const url = await serve((req, res) => {
      res.writeHead(200, { 'content-length': String(BODY.length), etag: ETAG });
      res.end(BODY, () => req.socket.end());
    });
    for (let i = 0; i < 20; i++) {
      const dest = join(dir, `fin-${i}`);
      const r = await downloadToFile(url, dest, { limits: FAST });
      expect(r.attempts).toHaveLength(1);
      expect(await sha(dest)).toBe(BODY_SHA);
    }
  });

  it('resumes a cut download with Range from the bytes on disk and If-Match', async () => {
    // fails-when: the retry downloads from zero, or asks for a byte other than the one on disk
    // breaks-if-wrong: an uncut download sends no Range (next test)
    const url = await serve((req, res, n) => (n === 1 ? cutMidBody(res) : serveRange(req, res)));
    const failed: DownloadAttempt[] = [];
    const dest = join(dir, 'cut');
    const r = await downloadToFile(url, dest, {
      limits: FAST,
      onAttemptFailed: (a) => failed.push(a),
    });
    expect(await sha(dest)).toBe(BODY_SHA);
    expect(seen).toHaveLength(2);
    const start = Number(/^bytes=(\d+)-$/.exec(seen[1].range ?? '')?.[1]);
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThanOrEqual(HALF);
    expect(start).toBe(failed[0].bytesOnDisk);
    expect(seen[1].ifMatch).toBe(ETAG);
    expect(r.attempts.map((a) => a.resumeFrom)).toEqual([0, start]);
  });

  it('sends no Range when nothing was cut', async () => {
    const url = await serve((req, res) => serveRange(req, res));
    await downloadToFile(url, join(dir, 'plain'), { limits: FAST });
    expect(seen).toEqual([{ range: undefined, ifMatch: undefined }]);
  });

  it('rewrites the file from zero when the server ignores Range and answers 200', async () => {
    // fails-when: a 200 body is appended to the partial file
    const url = await serve((_req, res, n) => {
      if (n === 1) return cutMidBody(res);
      res.writeHead(200, { 'content-length': String(BODY.length), etag: ETAG });
      res.end(BODY);
    });
    const dest = join(dir, 'ignored-range');
    await downloadToFile(url, dest, { limits: FAST });
    expect(seen).toHaveLength(2);
    expect(seen[1].range).toMatch(/^bytes=\d+-$/);
    expect(await sha(dest)).toBe(BODY_SHA);
  });

  it('restarts from zero when a 206 does not continue the file', async () => {
    // fails-when: a 206 whose Content-Range starts elsewhere is appended
    const url = await serve((req, res, n) => {
      if (n === 1) return cutMidBody(res);
      if (n === 2) {
        res.writeHead(206, {
          'content-length': '10',
          'content-range': `bytes 0-9/${BODY.length}`,
          etag: ETAG,
        });
        res.end(BODY.subarray(0, 10));
        return;
      }
      serveRange(req, res);
    });
    const dest = join(dir, 'bad-range');
    await downloadToFile(url, dest, { limits: FAST });
    expect(seen).toHaveLength(3);
    expect(seen[2].range).toBeUndefined();
    expect(await sha(dest)).toBe(BODY_SHA);
  });

  it('restarts from zero after 412 (the object changed)', async () => {
    const url = await serve((req, res, n) => {
      if (n === 1) return cutMidBody(res);
      if (n === 2) {
        res.writeHead(412);
        res.end();
        return;
      }
      serveRange(req, res);
    });
    const dest = join(dir, 'precondition');
    await downloadToFile(url, dest, { limits: FAST });
    expect(seen.map((s) => s.range === undefined)).toEqual([true, false, true]);
    expect(await sha(dest)).toBe(BODY_SHA);
  });

  it('does not resume without an ETag', async () => {
    const url = await serve((_req, res, n) => {
      res.writeHead(200, { 'content-length': String(BODY.length) });
      if (n === 1) {
        res.write(BODY.subarray(0, HALF), () => setTimeout(() => res.socket?.destroy(), 20));
        return;
      }
      res.end(BODY);
    });
    const dest = join(dir, 'no-etag');
    await downloadToFile(url, dest, { limits: FAST });
    expect(seen.map((s) => s.range)).toEqual([undefined, undefined]);
    expect(await sha(dest)).toBe(BODY_SHA);
  });

  it('names a stall, then resumes', async () => {
    // fails-when: no inactivity bound exists (the attempt hangs until the 5 min deadline)
    const url = await serve((req, res, n) => {
      if (n === 1) {
        res.writeHead(200, { 'content-length': String(BODY.length), etag: ETAG });
        res.write(BODY.subarray(0, HALF)); // then silence
        return;
      }
      serveRange(req, res);
    });
    const failed: DownloadAttempt[] = [];
    const dest = join(dir, 'stall');
    await downloadToFile(url, dest, {
      limits: { ...FAST, stallTimeoutMs: 200 },
      onAttemptFailed: (a) => failed.push(a),
    });
    expect(failed[0].error?.message).toBe('stalled: no data for 200 ms');
    expect(seen[1].range).toMatch(/^bytes=\d+-$/);
    expect(await sha(dest)).toBe(BODY_SHA);
  });

  it('bounds one attempt by its deadline even while bytes keep trickling', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-length': String(BODY.length), etag: ETAG });
      const t = setInterval(() => res.write(Buffer.alloc(10)), 20);
      res.on('close', () => clearInterval(t));
    });
    const err = await downloadToFile(url, join(dir, 'deadline'), {
      limits: { ...FAST, attemptTimeoutMs: 300, maxAttempts: 2 },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownloadFailedError);
    const attempts = (err as DownloadFailedError).attempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[0].error?.message).toBe('attempt timed out after 300 ms');
  });

  it('fails a redirect to an unparseable Location instead of crashing the process', async () => {
    // fails-when: the URL parse throws inside the response callback, escaping as an
    //   uncaught exception that takes the agent process down
    // breaks-if-wrong: a valid redirect is still followed (next test)
    const url = await serve((_req, res) => {
      res.writeHead(302, { location: 'http://[bad' });
      res.end();
    });
    const err = await downloadToFile(url, join(dir, 'bad-redirect'), {
      limits: { ...FAST, maxAttempts: 1 },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownloadFailedError);
    expect((err as Error).message).toBe(
      'Download failed after 1 attempt: HTTP 302 redirect to an invalid Location',
    );
  });

  it('follows a redirect', async () => {
    const url = await serve((req, res) => {
      if (req.url?.startsWith('/moved')) return serveRange(req, res);
      res.writeHead(302, { location: '/moved' });
      res.end();
    });
    const dest = join(dir, 'redirected');
    await downloadToFile(url, dest, { limits: FAST });
    expect(await sha(dest)).toBe(BODY_SHA);
    expect(seen).toHaveLength(2);
  });

  it('fails a 404 at once', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const err = await downloadToFile(url, join(dir, 'missing'), { limits: FAST }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DownloadFailedError);
    expect((err as Error).message).toBe('Download failed after 1 attempt: HTTP 404');
    expect(seen).toHaveLength(1);
  });

  it('retries a 503 up to the attempt budget', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    const err = await downloadToFile(url, join(dir, 'unavailable'), { limits: FAST }).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toBe('Download failed after 3 attempts: HTTP 503');
    expect(seen).toHaveLength(DEFAULT_DOWNLOAD_LIMITS.maxAttempts);
  });

  it('keeps durations non-negative when the wall clock steps backwards', async () => {
    // A negative duration fails the report schema, and the whole report is dropped.
    // fails-when: a duration is measured with Date.now()
    const url = await serve((req, res) => serveRange(req, res));
    let wall = 2_000_000_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (wall -= 60_000));
    try {
      const r = await downloadToFile(url, join(dir, 'clock-step'), { limits: FAST });
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
      expect(r.attempts[0].durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      now.mockRestore();
    }
  });

  it('pins the production limits', () => {
    expect(DEFAULT_DOWNLOAD_LIMITS).toEqual({
      maxAttempts: 3,
      attemptTimeoutMs: 300_000,
      stallTimeoutMs: 60_000,
      retryBaseDelayMs: 500,
    });
  });
});

describe('redactUrl', () => {
  it('drops the query and userinfo', () => {
    expect(redactUrl('https://u:p@bucket.s3.amazonaws.com/deps/x.tar.gz?X-Amz-Signature=abc')).toBe(
      'https://bucket.s3.amazonaws.com/deps/x.tar.gz',
    );
    expect(redactUrl('file:///tmp/deps.tar.gz')).toBe('file:///tmp/deps.tar.gz');
  });
});

describe('describeError', () => {
  it('keeps the cause code and message', () => {
    const cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    expect(describeError(new TypeError('terminated', { cause }))).toEqual({
      message: 'terminated',
      causeCode: 'UND_ERR_SOCKET',
      causeMessage: 'other side closed',
    });
  });
});
