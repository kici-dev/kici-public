import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { registerBlobRoutes } from './blob-routes.js';
import { generateSigningSecret, signToken } from './sign-url.js';

describe('registerBlobRoutes', () => {
  let dir: string;
  let app: Hono;
  let secret: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'blob-routes-test-'));
    secret = generateSigningSecret();
    app = new Hono();
    registerBlobRoutes(app, { basePath: dir, signingSecret: secret });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function getBlob(key: string, sig: string) {
    const url = `http://localhost/api/v1/cache/blob/${key}${sig === '' ? '' : `?sig=${encodeURIComponent(sig)}`}`;
    return app.fetch(new Request(url));
  }

  async function putBlob(key: string, sig: string, body: BodyInit) {
    const url = `http://localhost/api/v1/cache/blob/${key}${sig === '' ? '' : `?sig=${encodeURIComponent(sig)}`}`;
    return app.fetch(new Request(url, { method: 'PUT', body }));
  }

  it('GET streams a cached blob with a valid token', async () => {
    await mkdir(join(dir, 'dep'), { recursive: true });
    await writeFile(join(dir, 'dep/abc'), Buffer.from('hello world'));
    const { token } = signToken(secret, 'GET', 'dep/abc');

    const res = await getBlob('dep/abc', token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    const body = await res.text();
    expect(body).toBe('hello world');
  });

  it('GET 404s when the file does not exist', async () => {
    const { token } = signToken(secret, 'GET', 'dep/missing');
    const res = await getBlob('dep/missing', token);
    expect(res.status).toBe(404);
  });

  it('GET 401s when sig query param is missing', async () => {
    await mkdir(join(dir, 'dep'), { recursive: true });
    await writeFile(join(dir, 'dep/abc'), Buffer.from('x'));
    const res = await getBlob('dep/abc', '');
    expect(res.status).toBe(401);
  });

  it('GET 401s when token is signed for the wrong method', async () => {
    await mkdir(join(dir, 'dep'), { recursive: true });
    await writeFile(join(dir, 'dep/abc'), Buffer.from('x'));
    const { token } = signToken(secret, 'PUT', 'dep/abc');
    const res = await getBlob('dep/abc', token);
    expect(res.status).toBe(401);
  });

  it('GET 401s when token is signed for a different key', async () => {
    await mkdir(join(dir, 'dep'), { recursive: true });
    await writeFile(join(dir, 'dep/abc'), Buffer.from('x'));
    const { token } = signToken(secret, 'GET', 'dep/different');
    const res = await getBlob('dep/abc', token);
    expect(res.status).toBe(401);
  });

  it('GET 400s on .. traversal segment', async () => {
    const { token } = signToken(secret, 'GET', '../../../etc/passwd');
    const res = await getBlob('..%2F..%2F..%2Fetc%2Fpasswd', token);
    expect(res.status).toBe(400);
  });

  it('PUT writes a blob with a valid token', async () => {
    const { token } = signToken(secret, 'PUT', 'dep/new');
    const res = await putBlob('dep/new', token, 'fresh content');
    expect(res.status).toBe(200);
    const onDisk = await readFile(join(dir, 'dep/new'), 'utf-8');
    expect(onDisk).toBe('fresh content');
  });

  it('PUT 401s with no sig', async () => {
    const res = await putBlob('dep/new', '', 'x');
    expect(res.status).toBe(401);
  });

  it('PUT 401s when sig is signed for GET', async () => {
    const { token } = signToken(secret, 'GET', 'dep/new');
    const res = await putBlob('dep/new', token, 'x');
    expect(res.status).toBe(401);
  });

  it('PUT 401s when sig is signed by the wrong secret', async () => {
    const wrong = generateSigningSecret();
    const { token } = signToken(wrong, 'PUT', 'dep/new');
    const res = await putBlob('dep/new', token, 'x');
    expect(res.status).toBe(401);
  });

  it('PUT 400s on .. traversal segment', async () => {
    const { token } = signToken(secret, 'PUT', '../etc/passwd');
    const res = await putBlob('..%2Fetc%2Fpasswd', token, 'x');
    expect(res.status).toBe(400);
  });

  it('PUT creates intermediate directories', async () => {
    const { token } = signToken(secret, 'PUT', 'a/b/c/deep');
    const res = await putBlob('a/b/c/deep', token, 'nested');
    expect(res.status).toBe(200);
    const onDisk = await readFile(join(dir, 'a/b/c/deep'), 'utf-8');
    expect(onDisk).toBe('nested');
  });

  it('PUT then GET round-trips identical bytes', async () => {
    const payload = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256));
    const putTok = signToken(secret, 'PUT', 'dep/bin').token;
    const putRes = await putBlob('dep/bin', putTok, payload);
    expect(putRes.status).toBe(200);
    const getTok = signToken(secret, 'GET', 'dep/bin').token;
    const getRes = await getBlob('dep/bin', getTok);
    expect(getRes.status).toBe(200);
    const got = Buffer.from(await getRes.arrayBuffer());
    expect(got.equals(payload)).toBe(true);
  });
});
