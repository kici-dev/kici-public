import { describe, it, expect } from 'vitest';
import { LocalDirPayloadSource, type PayloadFs } from './payload-source.js';

/** Build a stub fs from a map of path → content (missing paths => not present). */
function stubFs(files: Record<string, string>): PayloadFs {
  return {
    exists: async (p) => p in files,
    readFile: async (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
  };
}

const DIR = '/payloads';

describe('LocalDirPayloadSource', () => {
  it('resolves a version-keyed tarball with its sidecar hash', async () => {
    const tarball = `${DIR}/1.2.3/kici-agent-linux-x64.tar.gz`;
    const src = new LocalDirPayloadSource(
      DIR,
      stubFs({
        [tarball]: 'tar-bytes',
        [`${tarball}.sha256`]: `abc123def  kici-agent-linux-x64.tar.gz\n`,
      }),
    );
    const staged = await src.resolve('linux-x64', '1.2.3');
    expect(staged.tarballPath).toBe(tarball);
    expect(staged.sha256).toBe('abc123def');
  });

  it('resolves sha256:null when no sidecar exists', async () => {
    const tarball = `${DIR}/9.9.9/kici-agent-linux-arm64.tar.gz`;
    const src = new LocalDirPayloadSource(DIR, stubFs({ [tarball]: 'tar-bytes' }));
    const staged = await src.resolve('linux-arm64', '9.9.9');
    expect(staged.tarballPath).toBe(tarball);
    expect(staged.sha256).toBeNull();
  });

  it('throws a self-describing error naming the version + the fix when the tarball is absent', async () => {
    const src = new LocalDirPayloadSource(DIR, stubFs({}));
    await expect(src.resolve('linux-x64', '4.5.6')).rejects.toThrow(/4\.5\.6/);
    await expect(src.resolve('linux-x64', '4.5.6')).rejects.toThrow(/linux-x64/);
    await expect(src.resolve('linux-x64', '4.5.6')).rejects.toThrow(/kici-admin agent package/);
  });
});
