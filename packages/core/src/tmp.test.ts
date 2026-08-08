import { afterEach, describe, it, expect } from 'vitest';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  kiciTmpBase,
  makeTempDir,
  makeTempFile,
  withTempDir,
  withTempFile,
  createTempScope,
} from './tmp.js';

describe('makeTempDir', () => {
  it('creates a kici-<label>- dir under tmpdir and returns a path + cleanup', async () => {
    const h = await makeTempDir('unit-a');
    // Against `kiciTmpBase()`, not `tmpdir()`: an ambient `KICI_TMPDIR` (the
    // E2E executor slots set one) legitimately moves the base, and this case
    // is about the dir landing under it — the resolution itself is covered by
    // the `KICI_TMPDIR resolution` block below, which controls the env var.
    expect(dirname(h.path)).toBe(kiciTmpBase());
    expect(basename(h.path)).toMatch(/^kici-unit-a-[A-Za-z0-9]{6}$/);
    expect((await stat(h.path)).isDirectory()).toBe(true);
    await h.cleanup();
    await expect(stat(h.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleanup is idempotent', async () => {
    const h = await makeTempDir('unit-b');
    await h.cleanup();
    await expect(h.cleanup()).resolves.toBeUndefined();
  });

  it('Symbol.asyncDispose removes the dir (await using)', async () => {
    let captured = '';
    {
      await using h = await makeTempDir('unit-c');
      captured = h.path;
      expect((await stat(captured)).isDirectory()).toBe(true);
    }
    await expect(stat(captured)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an invalid label', async () => {
    await expect(makeTempDir('BAD label')).rejects.toThrow(/label/i);
  });

  it('respects a custom base', async () => {
    const parent = await makeTempDir('unit-parent');
    const child = await makeTempDir('unit-child', { base: parent.path });
    expect(dirname(child.path)).toBe(parent.path);
    await parent.cleanup();
  });
});

describe('KICI_TMPDIR resolution', () => {
  const saved = process.env.KICI_TMPDIR;
  const custom = join(tmpdir(), `kici-core-tmpdir-test-${process.pid}`);

  afterEach(async () => {
    if (saved === undefined) delete process.env.KICI_TMPDIR;
    else process.env.KICI_TMPDIR = saved;
    await rm(custom, { recursive: true, force: true });
  });

  it('kiciTmpBase returns os.tmpdir() when KICI_TMPDIR is unset', () => {
    delete process.env.KICI_TMPDIR;
    expect(kiciTmpBase()).toBe(tmpdir());
  });

  it('makeTempDir writes under KICI_TMPDIR (creating it) when set', async () => {
    await rm(custom, { recursive: true, force: true }); // ensure it does not exist yet
    process.env.KICI_TMPDIR = custom;
    const h = await makeTempDir('unit-kici-tmpdir');
    expect(dirname(h.path)).toBe(custom);
    expect((await stat(custom)).isDirectory()).toBe(true); // was created on demand
    await h.cleanup();
  });

  it('makeTempFile writes under KICI_TMPDIR when set', async () => {
    process.env.KICI_TMPDIR = custom;
    const h = await makeTempFile('file-kici-tmpdir');
    expect(dirname(dirname(h.path))).toBe(custom);
    await h.cleanup();
  });

  it('an explicit opts.base wins over KICI_TMPDIR', async () => {
    process.env.KICI_TMPDIR = custom;
    const parent = await makeTempDir('unit-explicit-parent', { base: tmpdir() });
    const child = await makeTempDir('unit-explicit-child', { base: parent.path });
    expect(dirname(child.path)).toBe(parent.path);
    // KICI_TMPDIR must not be touched when an explicit base is supplied.
    await expect(stat(custom)).rejects.toMatchObject({ code: 'ENOENT' });
    await parent.cleanup();
  });
});

describe('makeTempFile', () => {
  it('creates a file inside a kici-<label>- holder dir and cleans the holder', async () => {
    const h = await makeTempFile('file-a', { suffix: '.txt' });
    expect(basename(h.path)).toMatch(/\.txt$/);
    expect((await stat(h.path)).isFile()).toBe(true);
    await h.cleanup();
    await expect(stat(h.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('withTempDir', () => {
  it('cleans up after the callback resolves', async () => {
    let seen = '';
    const out = await withTempDir('scoped-ok', async (p) => {
      seen = p;
      expect((await stat(p)).isDirectory()).toBe(true);
      return 42;
    });
    expect(out).toBe(42);
    await expect(stat(seen)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans up even when the callback throws', async () => {
    let seen = '';
    await expect(
      withTempDir('scoped-throw', async (p) => {
        seen = p;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(stat(seen)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('withTempFile', () => {
  it('cleans up the file and its holder dir after the callback resolves', async () => {
    let seen = '';
    const out = await withTempFile('file-scoped-ok', async (p) => {
      seen = p;
      expect((await stat(p)).isFile()).toBe(true);
      return 42;
    });
    expect(out).toBe(42);
    await expect(stat(seen)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(dirname(seen))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans up even when the callback throws', async () => {
    let seen = '';
    await expect(
      withTempFile('file-scoped-throw', async (p) => {
        seen = p;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(stat(seen)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(dirname(seen))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('createTempScope', () => {
  it('disposeAll removes every registered handle', async () => {
    const scope = createTempScope();
    const a = await scope.mktemp('scope-a');
    const b = await scope.mktemp('scope-b');
    await scope.disposeAll();
    await expect(stat(a.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(b.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a manually cleaned handle is skipped by disposeAll (idempotent)', async () => {
    const scope = createTempScope();
    const a = await scope.mktemp('scope-manual');
    await a.cleanup();
    await expect(scope.disposeAll()).resolves.toBeUndefined();
  });

  it('persist handles are NOT auto-registered', async () => {
    const scope = createTempScope();
    const p = await scope.mktemp('scope-persist', { persist: true });
    await scope.disposeAll();
    expect((await stat(p.path)).isDirectory()).toBe(true); // survived
    await p.cleanup();
  });

  it('mktempFile returns a live file that disposeAll removes', async () => {
    const scope = createTempScope();
    const f = await scope.mktempFile('scope-file', { suffix: '.txt' });
    expect(basename(f.path)).toMatch(/\.txt$/);
    expect((await stat(f.path)).isFile()).toBe(true);
    await scope.disposeAll();
    await expect(stat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a persist mktempFile is NOT auto-registered', async () => {
    const scope = createTempScope();
    const f = await scope.mktempFile('scope-file-persist', { persist: true });
    await scope.disposeAll();
    expect((await stat(f.path)).isFile()).toBe(true); // survived
    await f.cleanup();
  });

  it('disposeAll aggregates errors and drains all handles', async () => {
    const scope = createTempScope();
    const a = await scope.mktemp('scope-agg-a');
    const b = await scope.mktemp('scope-agg-b');
    // Force a's cleanup to throw once.
    const orig = a.cleanup.bind(a);
    (a as { cleanup: () => Promise<void> }).cleanup = async () => {
      throw new Error('cleanup-fail');
    };
    await expect(scope.disposeAll()).rejects.toBeInstanceOf(AggregateError);
    // b still got cleaned despite a throwing.
    await expect(stat(b.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await orig();
  });
});
