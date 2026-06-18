import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, utimes, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach } from 'vitest';
import { gcStaleTmpDirs } from './tmp-gc.js';

const RUN_PATTERN = /^kici-run-[0-9a-f]{6}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const bases: string[] = [];

async function makeBase(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'tmp-gc-test-'));
  bases.push(base);
  return base;
}

/** Create a child dir (or file) and backdate its mtime by `ageMs`. */
async function seed(base: string, name: string, ageMs: number, kind: 'dir' | 'file' = 'dir') {
  const p = join(base, name);
  if (kind === 'dir') {
    await mkdir(p);
    await writeFile(join(p, 'payload.txt'), 'x');
  } else {
    await writeFile(p, 'x');
  }
  const then = (Date.now() - ageMs) / 1000;
  await utimes(p, then, then);
  return p;
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

afterEach(async () => {
  await Promise.all(bases.splice(0).map((b) => rm(b, { recursive: true, force: true })));
});

describe('gcStaleTmpDirs', () => {
  it('removes old matching directories and returns their paths', async () => {
    const base = await makeBase();
    const old = await seed(base, 'kici-run-ab12cd', 4 * DAY_MS);
    const removed = await gcStaleTmpDirs({ base, pattern: RUN_PATTERN, maxAgeMs: 3 * DAY_MS });
    expect(removed).toEqual([old]);
    expect(await exists(old)).toBe(false);
  });

  it('spares young matching directories', async () => {
    const base = await makeBase();
    const young = await seed(base, 'kici-run-ef34ab', 1 * DAY_MS);
    const removed = await gcStaleTmpDirs({ base, pattern: RUN_PATTERN, maxAgeMs: 3 * DAY_MS });
    expect(removed).toEqual([]);
    expect(await exists(young)).toBe(true);
  });

  it('spares old NON-matching directories (kici-e2e-cache, kici-data)', async () => {
    const base = await makeBase();
    const cache = await seed(base, 'kici-e2e-cache', 30 * DAY_MS);
    const data = await seed(base, 'kici-data', 30 * DAY_MS);
    const removed = await gcStaleTmpDirs({ base, pattern: RUN_PATTERN, maxAgeMs: 3 * DAY_MS });
    expect(removed).toEqual([]);
    expect(await exists(cache)).toBe(true);
    expect(await exists(data)).toBe(true);
  });

  it('skips plain files even when the name matches', async () => {
    const base = await makeBase();
    const file = await seed(base, 'kici-run-99aabb', 30 * DAY_MS, 'file');
    const removed = await gcStaleTmpDirs({ base, pattern: RUN_PATTERN, maxAgeMs: 3 * DAY_MS });
    expect(removed).toEqual([]);
    expect(await exists(file)).toBe(true);
  });

  it('is a no-op on a missing base', async () => {
    const removed = await gcStaleTmpDirs({
      base: join(tmpdir(), 'tmp-gc-test-does-not-exist'),
      pattern: RUN_PATTERN,
      maxAgeMs: DAY_MS,
    });
    expect(removed).toEqual([]);
  });

  it('logs removals through the injected logger', async () => {
    const base = await makeBase();
    await seed(base, 'kici-run-aa11bb', 4 * DAY_MS);
    const lines: string[] = [];
    await gcStaleTmpDirs({
      base,
      pattern: RUN_PATTERN,
      maxAgeMs: 3 * DAY_MS,
      log: (m) => lines.push(m),
    });
    expect(lines.some((l) => l.includes('kici-run-aa11bb'))).toBe(true);
  });
});
