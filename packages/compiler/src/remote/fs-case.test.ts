import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCaseInsensitiveDir } from './fs-case.js';

/** Error the mocked `stat` raises for the twin lookup, when set. */
const twinLookup = vi.hoisted(() => ({ error: null as NodeJS.ErrnoException | null }));

// Real `stat` everywhere except the probe's twin lookup, which cannot be made to
// fail with a non-ENOENT errno through the filesystem alone.
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    stat: async (path: Parameters<typeof original.stat>[0]) => {
      if (twinLookup.error && String(path).includes('.KICI-CASE-PROBE-')) throw twinLookup.error;
      return original.stat(path);
    },
  };
});

const scratch: string[] = [];
afterEach(async () => {
  twinLookup.error = null;
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

async function freshDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'fs-case-'));
  scratch.push(d);
  return d;
}

describe('isCaseInsensitiveDir', () => {
  // Which branch the probe takes is a property of the executor's filesystem, so
  // the answer itself is never asserted — only that one is produced.
  it('answers with a boolean', async () => {
    const dir = await freshDir();
    expect(typeof (await isCaseInsensitiveDir(dir))).toBe('boolean');
  });

  it('leaves no probe entry behind', async () => {
    const dir = await freshDir();
    await isCaseInsensitiveDir(dir);
    expect(await readdir(dir)).toEqual([]);
  });

  it('creates a missing nested directory', async () => {
    const dir = join(await freshDir(), 'a', 'b');
    await isCaseInsensitiveDir(dir);
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it('rejects when the probe cannot be written', async () => {
    const dir = await freshDir();
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'x');
    await expect(isCaseInsensitiveDir(join(blocker, 'out'))).rejects.toThrow();
  });

  it('rejects when the twin lookup fails for a reason other than absence', async () => {
    const dir = await freshDir();
    twinLookup.error = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });

    // Answering "case-sensitive" here would let a colliding set overwrite
    // itself, so an unanswerable probe reaches the caller as a rejection.
    await expect(isCaseInsensitiveDir(dir)).rejects.toThrow('EIO');
    expect(await readdir(dir)).toEqual([]);
  });
});
