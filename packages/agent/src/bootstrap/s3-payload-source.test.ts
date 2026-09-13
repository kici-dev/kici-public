import { describe, it, expect, vi } from 'vitest';
import { S3PayloadSource, type S3PayloadSourceDeps } from './s3-payload-source.js';

const SHA = 'a'.repeat(64);

function makeDeps(over: Partial<S3PayloadSourceDeps> = {}): {
  deps: S3PayloadSourceDeps;
  fetchToFile: ReturnType<typeof vi.fn>;
} {
  const fetchToFile = vi.fn(async () => {});
  const deps: S3PayloadSourceDeps = {
    presign: vi.fn(async () => ({ url: 'https://cache/presigned', sha256: SHA })),
    fetchToFile,
    cacheDir: '/var/cache/kici-payloads',
    exists: vi.fn(async () => false),
    ...over,
  };
  return { deps, fetchToFile };
}

describe('S3PayloadSource', () => {
  it('fetches via the presigned URL into a version-keyed cache path and returns the hash', async () => {
    const { deps, fetchToFile } = makeDeps();
    const src = new S3PayloadSource(deps);
    const staged = await src.resolve('linux-x64', '1.2.3');
    expect(staged).toEqual({
      tarballPath: '/var/cache/kici-payloads/1.2.3/kici-agent-linux-x64.tar.gz',
      sha256: SHA,
    });
    expect(deps.presign).toHaveBeenCalledWith('linux-x64', '1.2.3');
    expect(fetchToFile).toHaveBeenCalledWith(
      'https://cache/presigned',
      '/var/cache/kici-payloads/1.2.3/kici-agent-linux-x64.tar.gz',
    );
  });

  it('is cache-once: an already-present tarball is not re-fetched', async () => {
    const { deps, fetchToFile } = makeDeps({ exists: vi.fn(async () => true) });
    const src = new S3PayloadSource(deps);
    const staged = await src.resolve('linux-arm64', '2.0.0');
    expect(fetchToFile).not.toHaveBeenCalled();
    expect(staged.tarballPath).toBe('/var/cache/kici-payloads/2.0.0/kici-agent-linux-arm64.tar.gz');
  });

  it('throws a clear error naming version+platform when the object is missing', async () => {
    const { deps } = makeDeps({ presign: vi.fn(async () => null) });
    const src = new S3PayloadSource(deps);
    await expect(src.resolve('linux-x64', '9.9.9')).rejects.toThrow(
      /9\.9\.9.*linux-x64|linux-x64.*9\.9\.9/s,
    );
  });
});
