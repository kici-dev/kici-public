import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalize } from './kici-admin.js';

/**
 * The entry-point guard in kici-admin.ts compares the invoked script path
 * (`process.argv[1]`) against this module's own resolved path
 * (`fileURLToPath(import.meta.url)`). On macOS the light-package launcher runs
 * `node /tmp/.../kici-admin.cjs`, but `/tmp` is a symlink to `/private/tmp`, so
 * the two sides only match once both are canonicalized through their symlinks.
 * These tests pin `canonicalize` to that behavior.
 */
describe('canonicalize (kici-admin entry guard)', () => {
  let realDir: string;
  let symlinkDir: string;
  let realFile: string;

  beforeAll(() => {
    realDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'kici-canon-'));
    realFile = path.join(realDir, 'kici-admin.cjs');
    fs.writeFileSync(realFile, '// fixture', 'utf-8');
    symlinkDir = path.join(fs.realpathSync(os.tmpdir()), `kici-canon-link-${process.pid}`);
    try {
      fs.unlinkSync(symlinkDir);
    } catch {
      /* not present */
    }
    fs.symlinkSync(realDir, symlinkDir, 'dir');
  });

  afterAll(() => {
    try {
      fs.unlinkSync(symlinkDir);
    } catch {
      /* ignore */
    }
    fs.rmSync(realDir, { recursive: true, force: true });
  });

  it('resolves a path reached through a symlinked directory to its real path', () => {
    const viaSymlink = path.join(symlinkDir, 'kici-admin.cjs');
    // The symlinked path and the real path are different strings...
    expect(viaSymlink).not.toBe(realFile);
    // ...but canonicalize collapses both to the same on-disk identity, which is
    // what lets the entry guard match a symlinked launcher invocation.
    expect(canonicalize(viaSymlink)).toBe(canonicalize(realFile));
    expect(canonicalize(viaSymlink)).toBe(realFile);
  });

  it('falls back to a plain resolve when the path does not exist on disk', () => {
    const missing = path.join(realDir, 'does-not-exist.cjs');
    expect(canonicalize(missing)).toBe(path.resolve(missing));
  });

  it('resolves a relative path to an absolute one', () => {
    expect(path.isAbsolute(canonicalize('some/relative/path'))).toBe(true);
  });
});
