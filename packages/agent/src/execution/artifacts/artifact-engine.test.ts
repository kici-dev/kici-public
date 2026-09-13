import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packCachePaths } from '../cache/cache-engine.js';
import {
  createArtifactsApi,
  type ArtifactTransport,
  type ArtifactBeginUploadResult,
  type ArtifactDownloadLookup,
} from './artifact-engine.js';

// Capture presigned uploads in-memory instead of hitting the network.
const uploaded: { url: string; body: Buffer }[] = [];
vi.mock('../download.js', () => ({
  uploadToPresignedUrl: vi.fn(async (url: string, body: Buffer) => {
    uploaded.push({ url, body });
  }),
}));

beforeEach(() => {
  uploaded.length = 0;
});

/** A stub transport whose grant/lookup outcomes are configured per test. */
function stubTransport(overrides: Partial<ArtifactTransport>): ArtifactTransport {
  return {
    beginUpload: async () => ({ outcome: 'granted', uploadUrl: 'https://s3/put', storageKey: 'k' }),
    completeUpload: async () => {},
    download: async () => ({ outcome: 'not_found' }),
    ...overrides,
  };
}

describe('createArtifactsApi.upload', () => {
  it('packs, uploads, and completes — returning size + sha256', async () => {
    const root = await mkdtemp(join(tmpdir(), 'art-src-'));
    try {
      await mkdir(join(root, 'out'), { recursive: true });
      await writeFile(join(root, 'out', 'bin'), 'artifact-bytes');
      const completeArgs: unknown[] = [];
      const api = createArtifactsApi(
        root,
        stubTransport({
          beginUpload: async (name, size): Promise<ArtifactBeginUploadResult> => {
            expect(name).toBe('bundle');
            expect(size).toBeGreaterThan(0);
            return {
              outcome: 'granted',
              uploadUrl: 'https://s3/put',
              storageKey: 'artifacts/r/bundle.tar.gz',
            };
          },
          completeUpload: async (name, sizeBytes, sha256, storageKey) => {
            completeArgs.push({ name, sizeBytes, sha256, storageKey });
          },
        }),
      );
      const result = await api.upload('bundle', ['out']);
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.size).toBeGreaterThan(0);
      expect(uploaded).toHaveLength(1);
      expect(uploaded[0].url).toBe('https://s3/put');
      expect(completeArgs).toEqual([
        {
          name: 'bundle',
          sizeBytes: result.size,
          sha256: result.sha256,
          storageKey: 'artifacts/r/bundle.tar.gz',
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('throws when the commit is lost (transport completeUpload rejects)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'art-src-'));
    try {
      await mkdir(join(root, 'out'), { recursive: true });
      await writeFile(join(root, 'out', 'bin'), 'artifact-bytes');
      const api = createArtifactsApi(
        root,
        stubTransport({
          completeUpload: async () => {
            throw new Error('artifact upload-complete failed: db down');
          },
        }),
      );
      // A commit the orchestrator could not record must fail the step — the
      // artifact does not exist, so a green step would be silent data loss.
      await expect(api.upload('bundle', ['out'])).rejects.toThrow(/upload-complete failed/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('throws with the immutability message on a duplicate_name rejection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'art-src-'));
    try {
      await mkdir(join(root, 'out'), { recursive: true });
      await writeFile(join(root, 'out', 'bin'), 'x');
      const api = createArtifactsApi(
        root,
        stubTransport({
          beginUpload: async () => ({ outcome: 'rejected', reason: 'duplicate_name' }),
        }),
      );
      await expect(api.upload('bundle', ['out'])).rejects.toThrow(/immutable per run/);
      expect(uploaded).toHaveLength(0); // never uploaded after a rejection
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('surfaces size_cap / run_cap / org_quota reasons distinctly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'art-src-'));
    try {
      await mkdir(join(root, 'out'), { recursive: true });
      await writeFile(join(root, 'out', 'bin'), 'x');
      for (const [reason, re] of [
        ['size_cap', /per-artifact size cap/],
        ['run_cap', /run's artifact count cap/],
        ['org_quota', /organization's artifact storage quota/],
      ] as const) {
        const api = createArtifactsApi(
          root,
          stubTransport({ beginUpload: async () => ({ outcome: 'rejected', reason }) }),
        );
        await expect(api.upload('bundle', ['out'])).rejects.toThrow(re);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('surfaces an internal-failure detail (no enforcement reason) verbatim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'art-src-'));
    try {
      await mkdir(join(root, 'out'), { recursive: true });
      await writeFile(join(root, 'out', 'bin'), 'x');
      const api = createArtifactsApi(
        root,
        stubTransport({
          beginUpload: async (): Promise<ArtifactBeginUploadResult> => ({
            outcome: 'rejected',
            error: 'artifact uploads are not configured on this orchestrator',
          }),
        }),
      );
      await expect(api.upload('bundle', ['out'])).rejects.toThrow(
        'artifact "bundle": artifact uploads are not configured on this orchestrator',
      );
      expect(uploaded).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to the generic message when the rejection carries neither reason nor detail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'art-src-'));
    try {
      await mkdir(join(root, 'out'), { recursive: true });
      await writeFile(join(root, 'out', 'bin'), 'x');
      // What an older orchestrator (no `error` field) produces once it stops
      // sending the misleading org_quota reason.
      const api = createArtifactsApi(
        root,
        stubTransport({ beginUpload: async () => ({ outcome: 'rejected' }) }),
      );
      await expect(api.upload('bundle', ['out'])).rejects.toThrow(
        'artifact "bundle" upload was rejected',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an empty path list', async () => {
    const api = createArtifactsApi('/tmp', stubTransport({}));
    await expect(api.upload('bundle', [])).rejects.toThrow(/at least one path/);
  });

  it('rejects an invalid upload name with the shared message, not a validation dump', async () => {
    const api = createArtifactsApi('/tmp', stubTransport({}));
    await expect(api.upload('a/b', ['out'])).rejects.toThrow(
      'artifact "a/b": invalid artifact name: artifact name may only contain letters, digits, ".", "_", and "-"',
    );
    // An all-dots name would have to be escaped into a storage segment that a
    // literal name can also address, so the shared contract refuses it too.
    await expect(api.upload('..', ['out'])).rejects.toThrow(
      'artifact "..": invalid artifact name: artifact name must contain more than dots',
    );
  });

  it('never surfaces raw validation-issue JSON to the workflow author', async () => {
    // The regression guard. A raw `ArtifactNameSchema.parse` here would throw a
    // message that serializes the validation issues as JSON; asserting the
    // absence of that shape is what stops a refactor from reintroducing it.
    const api = createArtifactsApi('/tmp', stubTransport({}));
    await expect(api.upload('a/b', ['out'])).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('"code"') }),
    );
  });

  it('rejects the name before touching the transport', async () => {
    // A bad name must never reach beginUpload — the sandbox check exists to fail
    // fast, and a transport call would also make the error come back from the
    // orchestrator path instead.
    const beginUpload = vi.fn(async (): Promise<ArtifactBeginUploadResult> => {
      throw new Error('beginUpload must not be reached for a non-conforming name');
    });
    const api = createArtifactsApi('/tmp', stubTransport({ beginUpload }));
    await expect(api.upload('a/b', ['out'])).rejects.toThrow(/invalid artifact name/);
    expect(beginUpload).not.toHaveBeenCalled();
  });
});

describe('createArtifactsApi.download', () => {
  it('throws a not-found error when the run never uploaded the name', async () => {
    const api = createArtifactsApi(
      '/tmp',
      stubTransport({
        download: async (): Promise<ArtifactDownloadLookup> => ({ outcome: 'not_found' }),
      }),
    );
    await expect(api.download('bundle')).rejects.toThrow(/was not found in this run/);
  });

  it('rejects an invalid download name with the same shared message', async () => {
    // The same sentence as the upload door and as the orchestrator's own
    // rejection — one contract, one wording, wherever it is enforced.
    const download = vi.fn(async (): Promise<ArtifactDownloadLookup> => {
      throw new Error('download must not be reached for a non-conforming name');
    });
    const api = createArtifactsApi('/tmp', stubTransport({ download }));
    await expect(api.download('a/b')).rejects.toThrow(
      'artifact "a/b": invalid artifact name: artifact name may only contain letters, digits, ".", "_", and "-"',
    );
    expect(download).not.toHaveBeenCalled();
  });

  it('surfaces an internal-failure detail instead of the not-found message', async () => {
    const api = createArtifactsApi(
      '/tmp',
      stubTransport({
        download: async (): Promise<ArtifactDownloadLookup> => ({
          outcome: 'not_found',
          error: 'artifact downloads are not configured on this orchestrator',
        }),
      }),
    );
    await expect(api.download('bundle')).rejects.toThrow(
      'artifact "bundle": artifact downloads are not configured on this orchestrator',
    );
  });

  it('round-trips: uploads a tarball, then downloads + extracts it (data: URL)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'art-src-'));
    const dest = await mkdtemp(join(tmpdir(), 'art-dst-'));
    try {
      await mkdir(join(root, 'out'), { recursive: true });
      await writeFile(join(root, 'out', 'bin'), 'round-trip-bytes');
      const { tarball, hash } = await packCachePaths(root, ['out']);
      const dataUrl = `data:application/octet-stream;base64,${tarball.toString('base64')}`;
      const api = createArtifactsApi(
        dest,
        stubTransport({
          download: async (): Promise<ArtifactDownloadLookup> => ({
            outcome: 'found',
            downloadUrl: dataUrl,
            sizeBytes: tarball.length,
            sha256: hash,
          }),
        }),
      );
      const result = await api.download('bundle');
      expect(result.size).toBe(tarball.length);
      expect(result.sha256).toBe(hash);
      expect((await readFile(join(dest, 'out', 'bin'))).toString()).toBe('round-trip-bytes');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
    }
  });
});
