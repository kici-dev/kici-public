import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalize, buildProgram, CLI_VERSION } from './kici-admin.js';

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

/**
 * `--version` used to report a hardcoded `0.0.1` placeholder, so a support
 * bundle or an issue report carried no usable version context for the admin
 * CLI. The version now comes from the build-injected package version.
 */
describe('kici-admin --version', () => {
  it('reports CLI_VERSION rather than a literal placeholder', () => {
    expect(buildProgram().version()).toBe(CLI_VERSION);
  });

  it('does not pass a bare version literal to Commander', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, 'kici-admin.ts'), 'utf-8');
    // Positive control: the registration this assertion is about is present,
    // so an empty match below means "no literal", not "file not read".
    expect(src).toMatch(/\.version\(/);
    expect(src).not.toMatch(/\.version\(\s*['"]/);
  });
});
