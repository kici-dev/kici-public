import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyTreeIntoContainer } from './container-spawn.js';

describe('copyTreeIntoContainer', () => {
  it('streams the host tree to the requested container path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kici-spawn-copy-'));
    await writeFile(join(dir, 'README.md'), '# hi\n');
    const putArchive = vi.fn().mockResolvedValue(undefined);

    await copyTreeIntoContainer({ putArchive }, dir, '/workspace');

    expect(putArchive).toHaveBeenCalledTimes(1);
    expect((putArchive.mock.calls[0] as [unknown, { path: string }])[1].path).toBe('/workspace');
    await rm(dir, { recursive: true, force: true });
  });

  it('fails loudly, naming both paths, rather than leaving an empty workspace', async () => {
    const putArchive = vi.fn().mockRejectedValue(new Error('no space left on device'));
    await expect(copyTreeIntoContainer({ putArchive }, '/host/tree', '/workspace')).rejects.toThrow(
      /\/host\/tree.*\/workspace.*no space/s,
    );
  });
});
