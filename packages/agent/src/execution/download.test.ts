import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { uploadToPresignedUrl, UPLOAD_MAX_RETRIES } from './download.js';

/**
 * Object-storage backends answer an overload with a retryable 5xx — S3
 * documents 500 and 503 (`SlowDown`) as "retry with backoff" — so a single
 * transient blip must not fail a customer's build. These tests drive
 * {@link uploadToPresignedUrl} against a real loopback HTTP server rather than
 * a stubbed `http.request`, because the retry has to survive the whole
 * request/response cycle (headers written, body streamed, socket reused).
 */

interface Recorded {
  /** One entry per request the server actually received. */
  bodies: Buffer[];
}

/** Spin a server that answers `statuses[i]` to the i-th request (last repeats). */
async function serverAnswering(statuses: number[]): Promise<{
  url: string;
  recorded: Recorded;
  close: () => Promise<void>;
}> {
  const recorded: Recorded = { bodies: [] };
  let seen = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      recorded.bodies.push(Buffer.concat(chunks));
      const status = statuses[Math.min(seen, statuses.length - 1)]!;
      seen++;
      res.writeHead(status);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/bucket/key?sig=abc`,
    recorded,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** Fast, deterministic backoff so the suite does not pay the production delay. */
const fastRetry = { baseDelayMs: 1 };

describe('uploadToPresignedUrl', () => {
  it('retries a transient 503 and succeeds on a later attempt', async () => {
    const s = await serverAnswering([503, 503, 200]);
    closers.push(s.close);

    await expect(
      uploadToPresignedUrl(s.url, Buffer.from('payload'), fastRetry),
    ).resolves.toBeUndefined();

    expect(s.recorded.bodies).toHaveLength(3);
    // Every attempt PUTs the identical full body — the retry is a repeat of the
    // same whole-object write, never a partial or appended one.
    for (const body of s.recorded.bodies) expect(body.toString()).toBe('payload');
  });

  it('gives up after the attempt ceiling and reports how many it made', async () => {
    const s = await serverAnswering([503]);
    closers.push(s.close);

    await expect(uploadToPresignedUrl(s.url, Buffer.from('x'), fastRetry)).rejects.toThrow(
      `Pre-signed upload failed after ${UPLOAD_MAX_RETRIES + 1} attempts: HTTP 503 uploading to pre-signed URL`,
    );
    expect(s.recorded.bodies).toHaveLength(UPLOAD_MAX_RETRIES + 1);
  });

  it('does not retry a 403 — an expired or malformed signature never recovers', async () => {
    const s = await serverAnswering([403]);
    closers.push(s.close);

    await expect(uploadToPresignedUrl(s.url, Buffer.from('x'), fastRetry)).rejects.toThrow(
      'HTTP 403 uploading to pre-signed URL',
    );
    expect(s.recorded.bodies).toHaveLength(1);
  });

  it('retries a 429 throttle', async () => {
    const s = await serverAnswering([429, 200]);
    closers.push(s.close);

    await expect(uploadToPresignedUrl(s.url, Buffer.from('x'), fastRetry)).resolves.toBeUndefined();
    expect(s.recorded.bodies).toHaveLength(2);
  });

  it('succeeds on the first attempt without retrying', async () => {
    const s = await serverAnswering([200]);
    closers.push(s.close);

    await expect(uploadToPresignedUrl(s.url, Buffer.from('x'), fastRetry)).resolves.toBeUndefined();
    expect(s.recorded.bodies).toHaveLength(1);
  });

  it('retries a connection failure (no response at all)', async () => {
    // Claim a port, then close the listener so the first connects are refused.
    const s = await serverAnswering([200]);
    await s.close();

    await expect(uploadToPresignedUrl(s.url, Buffer.from('x'), fastRetry)).rejects.toThrow(
      `Pre-signed upload failed after ${UPLOAD_MAX_RETRIES + 1} attempts`,
    );
  });
});

describe('uploadToPresignedUrl — stalled socket', () => {
  /** Spin a server that accepts the body and then never answers. */
  async function serverThatNeverAnswers(): Promise<{ url: string; close: () => Promise<void> }> {
    const sockets: import('node:net').Socket[] = [];
    const server = http.createServer((req) => {
      req.resume();
      // Deliberately no `res.end()` — the client is left waiting on a socket
      // that will never carry a response, which is the wedged-upload shape.
    });
    server.on('connection', (s) => sockets.push(s));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return {
      url: `http://127.0.0.1:${port}/bucket/key?sig=abc`,
      close: () =>
        new Promise<void>((resolve) => {
          for (const s of sockets) s.destroy();
          server.close(() => resolve());
        }),
    };
  }

  it('gives up on a socket that never answers instead of hanging forever', async () => {
    // Without a timeout the PUT hangs until the whole job's timeout kills the
    // step, and the failure reads as "the job timed out" rather than "the
    // upload stalled". The timeout is also what makes the retry ladder
    // reachable for this failure mode at all.
    const s = await serverThatNeverAnswers();
    closers.push(s.close);

    await expect(
      uploadToPresignedUrl(s.url, Buffer.from('payload'), { ...fastRetry, timeoutMs: 150 }),
    ).rejects.toThrow(
      new RegExp(`failed after ${UPLOAD_MAX_RETRIES + 1} attempts.*timed out after 150ms`),
    );
  }, 20_000);
});
