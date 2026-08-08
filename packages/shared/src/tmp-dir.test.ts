import { existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { kiciMkdtemp, kiciTmpBase } from './tmp-dir.js';

describe('kiciTmpBase', () => {
  const saved = process.env.KICI_TMPDIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.KICI_TMPDIR;
    else process.env.KICI_TMPDIR = saved;
  });

  it('returns os.tmpdir() when KICI_TMPDIR is unset', () => {
    delete process.env.KICI_TMPDIR;
    expect(kiciTmpBase()).toBe(os.tmpdir());
  });

  it('returns KICI_TMPDIR and creates it when set', () => {
    const base = path.join(os.tmpdir(), `kici-tmpbase-test-${process.pid}`);
    rmSync(base, { recursive: true, force: true });
    process.env.KICI_TMPDIR = base;
    expect(kiciTmpBase()).toBe(base);
    expect(existsSync(base)).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });

  it('kiciMkdtemp creates a unique dir under the base with the prefix', () => {
    delete process.env.KICI_TMPDIR;
    const dir = kiciMkdtemp('kici-tmp-unit-');
    try {
      expect(dir.startsWith(path.join(os.tmpdir(), 'kici-tmp-unit-'))).toBe(true);
      expect(existsSync(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
