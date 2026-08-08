import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { c as tarCreate } from 'tar';
import { REPO_ANCHOR, logger, sha256 } from '@kici-dev/core';
import {
  runsArtifactsDownloadCommand,
  destBasename,
  foldBasename,
  findCaseCollisions,
} from './download.js';
import * as clientMod from '../../../remote/dashboard-client.js';
import * as fsCaseMod from '../../../remote/fs-case.js';

const scratch: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Build a repo-anchored gzipped tarball carrying one file. */
async function repoTarball(rel: string, body: string): Promise<Buffer> {
  const staging = await mkdtemp(join(tmpdir(), 'dl-stage-'));
  scratch.push(staging);
  const full = join(staging, REPO_ANCHOR, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, body);
  const chunks: Buffer[] = [];
  for await (const c of tarCreate({ gzip: true, portable: true, cwd: staging }, [REPO_ANCHOR])) {
    chunks.push(Buffer.from(c as Uint8Array));
  }
  return Buffer.concat(chunks);
}

async function freshDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'dl-out-'));
  scratch.push(d);
  return d;
}

type Overrides = { sha256?: string; downloadUrl?: string | undefined };

/** Mock DashboardClient.load + global fetch to serve the given tarballs. */
function mockClient(
  tarballByName: Record<string, Buffer>,
  overrides: Record<string, Overrides> = {},
): ReturnType<typeof vi.fn> {
  const artifacts = Object.entries(tarballByName).map(([name, buf]) => ({
    name,
    jobId: 'build',
    sizeBytes: buf.length,
    sha256: sha256(buf),
    createdAt: '2026-07-24T00:00:00.000Z',
    downloadUrl: `https://s3.example/${name}?sig=1`,
    ...(overrides[name] ?? {}),
  }));
  vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
    listArtifacts: async () => ({ artifacts }),
  } as never);
  const fetchMock = vi.fn(async (url: string) => {
    const name = new URL(url).pathname.slice(1);
    return new Response(new Uint8Array(tarballByName[name]), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

function captureErrors(): string[] {
  const errs: string[] = [];
  vi.spyOn(logger, 'error').mockImplementation(((m: string) => void errs.push(m)) as never);
  return errs;
}

/** Force the filesystem probe to a chosen answer, or to fail. */
function stubCaseInsensitive(answer: boolean | Error) {
  const spy = vi.spyOn(fsCaseMod, 'isCaseInsensitiveDir');
  if (answer instanceof Error) spy.mockRejectedValue(answer);
  else spy.mockResolvedValue(answer);
  return spy;
}

describe('runsArtifactsDownloadCommand', () => {
  it('extracts a single named artifact into <out>/<name>/', async () => {
    mockClient({ app: await repoTarball('dist/app.js', 'BODY') });
    const out = await freshDir();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsArtifactsDownloadCommand('run-1', 'app', { output: out });
    expect(ok).toBe(true);
    expect(await readFile(join(out, 'app', 'dist/app.js'), 'utf8')).toBe('BODY');
  });

  it('never sends the PAT to the object-storage host', async () => {
    const fetchMock = mockClient({ app: await repoTarball('x', 'B') });
    const out = await freshDir();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runsArtifactsDownloadCommand('run-1', 'app', { output: out });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    // The presigned URL is fetched verbatim, and whatever init the request grows
    // must never carry credentials: the PAT authenticates to the Platform, not
    // to the object-storage host.
    expect(url).toBe('https://s3.example/app?sig=1');
    const headers = new Headers((init?.headers ?? {}) as HeadersInit);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
    expect(init?.credentials ?? 'omit').not.toBe('include');
  });

  it('writes the raw tarball with --archive', async () => {
    mockClient({ app: await repoTarball('x', 'B') });
    const out = await freshDir();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsArtifactsDownloadCommand('run-1', 'app', { output: out, archive: true });
    expect(ok).toBe(true);
    expect((await stat(join(out, 'app.tar.gz'))).size).toBeGreaterThan(0);
    expect(await readdir(out)).not.toContain('app');
  });

  it('downloads all artifacts when the name is omitted', async () => {
    mockClient({ a: await repoTarball('fa', '1'), b: await repoTarball('fb', '2') });
    const out = await freshDir();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsArtifactsDownloadCommand('run-1', undefined, { output: out });
    expect(ok).toBe(true);
    expect(await readFile(join(out, 'a', 'fa'), 'utf8')).toBe('1');
    expect(await readFile(join(out, 'b', 'fb'), 'utf8')).toBe('2');
  });

  it('reports an empty state when the run has no artifacts', async () => {
    mockClient({});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsArtifactsDownloadCommand('run-1', undefined, {});
    expect(ok).toBe(true);
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('No artifacts');
  });

  it('errors on an unknown name and lists the available names', async () => {
    mockClient({ app: await repoTarball('x', 'B') });
    const errs = captureErrors();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsArtifactsDownloadCommand('run-1', 'nope', {});
    expect(ok).toBe(false);
    expect(errs.join('\n')).toContain('app');
  });

  it('fails loudly on a checksum mismatch', async () => {
    mockClient({ app: await repoTarball('x', 'B') }, { app: { sha256: 'not-the-real-digest' } });
    const errs = captureErrors();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await freshDir();
    const ok = await runsArtifactsDownloadCommand('run-1', 'app', { output: out });
    expect(ok).toBe(false);
    expect(errs.join('\n')).toContain('checksum mismatch');
    expect(await readdir(out)).toHaveLength(0);
  });

  it('errors when a named artifact has no download URL', async () => {
    mockClient({ app: await repoTarball('x', 'B') }, { app: { downloadUrl: undefined } });
    const errs = captureErrors();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsArtifactsDownloadCommand('run-1', 'app', {});
    expect(ok).toBe(false);
    expect(errs.join('\n')).toContain('no download URL');
  });

  it('skips an unavailable entry when downloading all, and keeps the rest', async () => {
    mockClient(
      { a: await repoTarball('fa', '1'), b: await repoTarball('fb', '2') },
      { a: { downloadUrl: undefined } },
    );
    const warns: string[] = [];
    vi.spyOn(logger, 'warn').mockImplementation(((m: string) => void warns.push(m)) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await freshDir();
    const ok = await runsArtifactsDownloadCommand('run-1', undefined, { output: out });
    expect(ok).toBe(true);
    expect(warns.join('\n')).toContain('a');
    expect(await readFile(join(out, 'b', 'fb'), 'utf8')).toBe('2');
  });

  it('refuses a listed name that would escape the output directory', async () => {
    const buf = await repoTarball('x', 'B');
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      listArtifacts: async () => ({
        artifacts: [
          {
            name: '../escaped',
            jobId: 'build',
            sizeBytes: buf.length,
            sha256: sha256(buf),
            createdAt: '2026-07-24T00:00:00.000Z',
            downloadUrl: 'https://s3.example/evil?sig=1',
          },
        ],
      }),
    } as never);
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(buf), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const errs = captureErrors();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const parent = await freshDir();
    const out = join(parent, 'out');

    const ok = await runsArtifactsDownloadCommand('run-1', undefined, { output: out });

    expect(ok).toBe(false);
    expect(errs.join('\n')).toContain('not a valid artifact name');
    // Refused before any byte was fetched, and nothing was written beside `out`.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readdir(parent)).toEqual([]);
  });

  it('returns false when a non-2xx storage response is served', async () => {
    mockClient({ app: await repoTarball('x', 'B') });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 403 })),
    );
    const errs = captureErrors();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsArtifactsDownloadCommand('run-1', 'app', {});
    expect(ok).toBe(false);
    expect(errs.join('\n')).toContain('HTTP 403');
  });

  it('refuses a case-colliding set on a case-insensitive output directory', async () => {
    const fetchMock = mockClient({
      bundle: await repoTarball('fa', '1'),
      Bundle: await repoTarball('fb', '2'),
    });
    stubCaseInsensitive(true);
    const errs = captureErrors();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await freshDir();

    const ok = await runsArtifactsDownloadCommand('run-1', undefined, { output: out });

    expect(ok).toBe(false);
    const msg = errs.join('\n');
    expect(msg).toContain('"Bundle"');
    expect(msg).toContain('"bundle"');
    expect(msg).toContain('merge them into one directory');
    expect(msg).toContain('kici runs artifacts download <run-id> <name> -o <dir>');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readdir(out)).toEqual([]);
  });

  it('refuses a case-colliding set when the name argument is an empty string', async () => {
    // An empty `[name]` resolves to "download everything", so the guard has to
    // key off the same predicate rather than `name === undefined`.
    const fetchMock = mockClient({
      bundle: await repoTarball('fa', '1'),
      Bundle: await repoTarball('fb', '2'),
    });
    stubCaseInsensitive(true);
    const errs = captureErrors();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await freshDir();

    const ok = await runsArtifactsDownloadCommand('run-1', '', { output: out });

    expect(ok).toBe(false);
    expect(errs.join('\n')).toContain('differ only in case');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readdir(out)).toEqual([]);
  });

  it('downloads the survivor when the colliding partner has no object left', async () => {
    // The partner is skipped rather than written, so only one artifact ever
    // reaches the output directory — refusing here would block a safe download.
    mockClient(
      { bundle: await repoTarball('fa', '1'), Bundle: await repoTarball('fb', '2') },
      { bundle: { downloadUrl: undefined } },
    );
    const probe = stubCaseInsensitive(true);
    const warns: string[] = [];
    vi.spyOn(logger, 'warn').mockImplementation(((m: string) => void warns.push(m)) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await freshDir();

    const ok = await runsArtifactsDownloadCommand('run-1', undefined, { output: out });

    expect(ok).toBe(true);
    expect(probe).not.toHaveBeenCalled();
    expect(warns.join('\n')).toContain('bundle skipped');
    expect(await readFile(join(out, 'Bundle', 'fb'), 'utf8')).toBe('2');
  });

  it('names the archive basenames and the overwrite consequence with --archive', async () => {
    const fetchMock = mockClient({
      bundle: await repoTarball('fa', '1'),
      Bundle: await repoTarball('fb', '2'),
    });
    stubCaseInsensitive(true);
    const errs = captureErrors();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await freshDir();

    const ok = await runsArtifactsDownloadCommand('run-1', undefined, {
      output: out,
      archive: true,
    });

    expect(ok).toBe(false);
    const msg = errs.join('\n');
    expect(msg).toContain('"Bundle.tar.gz"');
    expect(msg).toContain('"bundle.tar.gz"');
    expect(msg).toContain('overwrite one file');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readdir(out)).toEqual([]);
  });

  it('downloads a case-colliding set on a case-sensitive output directory', async () => {
    mockClient({ bundle: await repoTarball('fa', '1'), Bundle: await repoTarball('fb', '2') });
    stubCaseInsensitive(false);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await freshDir();

    const ok = await runsArtifactsDownloadCommand('run-1', undefined, { output: out });

    expect(ok).toBe(true);
    expect(await readFile(join(out, 'bundle', 'fa'), 'utf8')).toBe('1');
    expect(await readFile(join(out, 'Bundle', 'fb'), 'utf8')).toBe('2');
  });

  it('never refuses a single named artifact', async () => {
    mockClient({ bundle: await repoTarball('fa', '1'), Bundle: await repoTarball('fb', '2') });
    stubCaseInsensitive(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await freshDir();

    const ok = await runsArtifactsDownloadCommand('run-1', 'Bundle', { output: out });

    expect(ok).toBe(true);
    expect(await readFile(join(out, 'Bundle', 'fb'), 'utf8')).toBe('2');
  });

  it('does not probe the filesystem when no two names fold together', async () => {
    mockClient({ a: await repoTarball('fa', '1'), b: await repoTarball('fb', '2') });
    const probe = stubCaseInsensitive(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await freshDir();

    const ok = await runsArtifactsDownloadCommand('run-1', undefined, { output: out });

    expect(ok).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it('refuses when the filesystem cannot be probed, and says so', async () => {
    const fetchMock = mockClient({
      bundle: await repoTarball('fa', '1'),
      Bundle: await repoTarball('fb', '2'),
    });
    stubCaseInsensitive(new Error('EACCES: permission denied'));
    const errs = captureErrors();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await freshDir();

    const ok = await runsArtifactsDownloadCommand('run-1', undefined, { output: out });

    expect(ok).toBe(false);
    const msg = errs.join('\n');
    expect(msg).toContain('could not be checked for case sensitivity');
    expect(msg).toContain('EACCES: permission denied');
    expect(msg).not.toContain('is on a case-insensitive filesystem');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an unsafe listed name that follows a safe one, before writing either', async () => {
    const buf = await repoTarball('x', 'B');
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      listArtifacts: async () => ({
        artifacts: ['good', '../escaped'].map((name) => ({
          name,
          jobId: 'build',
          sizeBytes: buf.length,
          sha256: sha256(buf),
          createdAt: '2026-07-24T00:00:00.000Z',
          downloadUrl: `https://s3.example/${encodeURIComponent(name)}?sig=1`,
        })),
      }),
    } as never);
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(buf), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const errs = captureErrors();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await freshDir();

    const ok = await runsArtifactsDownloadCommand('run-1', undefined, { output: out });

    expect(ok).toBe(false);
    expect(errs.join('\n')).toContain('not a valid artifact name');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readdir(out)).toEqual([]);
  });
});

describe('destBasename', () => {
  it('extracts into a directory named after the artifact', () => {
    expect(destBasename('bundle', false)).toBe('bundle');
  });

  it('appends the archive extension in archive mode', () => {
    expect(destBasename('bundle', true)).toBe('bundle.tar.gz');
  });
});

describe('findCaseCollisions', () => {
  it('finds nothing when every basename folds differently', () => {
    expect(findCaseCollisions(['app', 'bundle', 'docs'])).toEqual([]);
  });

  it('groups a colliding pair and leaves the rest alone', () => {
    expect(findCaseCollisions(['bundle', 'app', 'Bundle'])).toEqual([['Bundle', 'bundle']]);
  });

  it('groups more than two names that fold together', () => {
    expect(findCaseCollisions(['bundle', 'BUNDLE', 'Bundle'])).toEqual([
      ['BUNDLE', 'Bundle', 'bundle'],
    ]);
  });

  it('reports several independent groups in first-appearance order', () => {
    expect(findCaseCollisions(['a', 'A', 'b', 'B'])).toEqual([
      ['A', 'a'],
      ['B', 'b'],
    ]);
  });

  it('collides on the archive basenames in archive mode', () => {
    expect(findCaseCollisions(['bundle', 'Bundle'].map((n) => destBasename(n, true)))).toEqual([
      ['Bundle.tar.gz', 'bundle.tar.gz'],
    ]);
  });

  it('finds nothing for a single name', () => {
    expect(findCaseCollisions(['bundle'])).toEqual([]);
  });

  it('folds two unicode normalisations of the same name together', () => {
    const nfc = 'café';
    const nfd = 'café';
    expect(nfc).not.toBe(nfd);
    expect(foldBasename(nfd)).toBe(foldBasename(nfc));
    expect(findCaseCollisions([nfc, nfd])).toHaveLength(1);
  });
});
