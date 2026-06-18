import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { mkdtemp, mkdir, writeFile, utimes, access, rm } from 'node:fs/promises';
import path from 'node:path';
import { join } from 'node:path';
import os from 'node:os';
import { tmpdir } from 'node:os';
import { materializeCheckout, gcStaleRunCheckouts } from './materializer.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const gcBases: string[] = [];

afterEach(async () => {
  await Promise.all(gcBases.splice(0).map((b) => rm(b, { recursive: true, force: true })));
});

describe('gcStaleRunCheckouts', () => {
  it('removes kici-run-* dirs older than 72h, spares younger and foreign dirs', async () => {
    const base = await mkdtemp(join(tmpdir(), 'materializer-gc-test-'));
    gcBases.push(base);
    const mk = async (name: string, ageMs: number) => {
      const p = join(base, name);
      await mkdir(p);
      await writeFile(join(p, 'f'), 'x');
      const then = (Date.now() - ageMs) / 1000;
      await utimes(p, then, then);
      return p;
    };
    const stale = await mk('kici-run-ab12cd', 4 * DAY_MS);
    const fresh = await mk('kici-run-ef34ab', 1 * DAY_MS);
    const foreign = await mk('kici-e2e-cache', 30 * DAY_MS);

    const removed = await gcStaleRunCheckouts(base);

    expect(removed).toEqual([stale]);
    const exists = (p: string) =>
      access(p).then(
        () => true,
        () => false,
      );
    expect(await exists(stale)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(foreign)).toBe(true);
  });
});

/**
 * Build a throwaway git repo exercising every overlay case the materializer
 * must reproduce: a committed-unchanged file, a tracked-dirty file, a deleted
 * committed file, an untracked-non-ignored file, a gitignored secret, a
 * .kiciignore'd local change, and an executable file.
 */
async function buildScratchRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-materializer-test-'));
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  execSync('git remote add origin https://example.com/repo.git', { cwd: dir, stdio: 'ignore' });

  await fs.writeFile(path.join(dir, 'unchanged.txt'), 'committed content\n');
  await fs.writeFile(path.join(dir, 'dirty.txt'), 'original\n');
  await fs.writeFile(path.join(dir, 'to-delete.txt'), 'doomed\n');
  await fs.writeFile(path.join(dir, 'script.sh'), '#!/bin/sh\necho hi\n');
  await fs.chmod(path.join(dir, 'script.sh'), 0o755);
  await fs.writeFile(path.join(dir, '.gitignore'), 'secret.env\n');
  await fs.writeFile(path.join(dir, '.kiciignore'), '*.log\n');
  execSync('git add -A', { cwd: dir, stdio: 'ignore' });
  execSync('git commit -m "initial"', { cwd: dir, stdio: 'ignore' });

  // Local working-tree state on top of the commit:
  await fs.writeFile(path.join(dir, 'dirty.txt'), 'dirty bytes\n'); // modified tracked
  await fs.unlink(path.join(dir, 'to-delete.txt')); // deleted tracked
  await fs.writeFile(path.join(dir, 'untracked.txt'), 'untracked\n'); // new untracked
  await fs.writeFile(path.join(dir, 'secret.env'), 'TOKEN=shh\n'); // gitignored
  await fs.writeFile(path.join(dir, 'app.log'), 'log line\n'); // .kiciignore'd local change

  return dir;
}

describe('materializeCheckout', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await buildScratchRepo();
  });

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('reproduces the working tree (committed + dirty + untracked) over a usable .git', async () => {
    const checkout = await materializeCheckout(repoDir);
    try {
      // Committed-unchanged file comes from the clone.
      expect(await fs.readFile(path.join(checkout.path, 'unchanged.txt'), 'utf-8')).toBe(
        'committed content\n',
      );
      // Tracked-dirty content reflects the working-tree bytes, not the commit.
      expect(await fs.readFile(path.join(checkout.path, 'dirty.txt'), 'utf-8')).toBe(
        'dirty bytes\n',
      );
      // Untracked-non-ignored file is present.
      expect(await fs.readFile(path.join(checkout.path, 'untracked.txt'), 'utf-8')).toBe(
        'untracked\n',
      );
      // Deleted committed file is removed from the checkout.
      await expect(fs.access(path.join(checkout.path, 'to-delete.txt'))).rejects.toThrow();
      // .git is usable and pinned to the source HEAD.
      const srcHead = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf-8' }).trim();
      const tmpHead = execSync('git rev-parse HEAD', {
        cwd: checkout.path,
        encoding: 'utf-8',
      }).trim();
      expect(tmpHead).toBe(srcHead);
    } finally {
      await checkout.cleanup();
    }
  });

  it('excludes gitignored secret files and .kiciignore matches', async () => {
    const checkout = await materializeCheckout(repoDir);
    try {
      // Gitignored secret is never copied — secrets come from the real .kici/.
      await expect(fs.access(path.join(checkout.path, 'secret.env'))).rejects.toThrow();
      // .kiciignore'd local change is excluded from the overlay. The file was
      // never committed (it's a local untracked change), so it must be absent.
      await expect(fs.access(path.join(checkout.path, 'app.log'))).rejects.toThrow();
    } finally {
      await checkout.cleanup();
    }
  });

  it('preserves the executable bit on overlay files', async () => {
    // Make the committed executable dirty so it goes through the overlay copy.
    await fs.writeFile(path.join(repoDir, 'script.sh'), '#!/bin/sh\necho changed\n');
    await fs.chmod(path.join(repoDir, 'script.sh'), 0o755);

    const checkout = await materializeCheckout(repoDir);
    try {
      const stat = await fs.stat(path.join(checkout.path, 'script.sh'));
      expect(stat.mode & 0o111).not.toBe(0);
    } finally {
      await checkout.cleanup();
    }
  });

  it('places the checkout under the runDir override', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-rundir-'));
    try {
      const checkout = await materializeCheckout(repoDir, { runDir: base });
      try {
        expect(checkout.path.startsWith(base)).toBe(true);
        expect(path.basename(checkout.path)).toMatch(/^kici-run-[0-9a-f]{6}$/);
      } finally {
        await checkout.cleanup();
      }
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('cleanup() removes the checkout directory', async () => {
    const checkout = await materializeCheckout(repoDir);
    expect(await fs.access(checkout.path).then(() => true)).toBe(true);
    await checkout.cleanup();
    await expect(fs.access(checkout.path)).rejects.toThrow();
  });

  it('recreates symlinks as links rather than dereferencing them', async () => {
    // A directory symlink (the shape `node_modules/@scope/pkg` takes) would
    // throw EISDIR if copied by dereferencing; a file symlink would lose its
    // link identity. Both are untracked here so they flow through the overlay.
    const realDir = path.join(repoDir, 'real-dir');
    await fs.mkdir(realDir);
    await fs.writeFile(path.join(realDir, 'inside.txt'), 'nested\n');
    await fs.symlink(realDir, path.join(repoDir, 'dir-link'));
    await fs.symlink('unchanged.txt', path.join(repoDir, 'file-link'));

    const checkout = await materializeCheckout(repoDir);
    try {
      const dirLink = await fs.lstat(path.join(checkout.path, 'dir-link'));
      expect(dirLink.isSymbolicLink()).toBe(true);
      expect(await fs.readlink(path.join(checkout.path, 'dir-link'))).toBe(realDir);

      const fileLink = await fs.lstat(path.join(checkout.path, 'file-link'));
      expect(fileLink.isSymbolicLink()).toBe(true);
      expect(await fs.readlink(path.join(checkout.path, 'file-link'))).toBe('unchanged.txt');
    } finally {
      await checkout.cleanup();
    }
  });

  it('throws an actionable error for a non-git directory', async () => {
    const nonGit = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-nongit-'));
    try {
      await expect(materializeCheckout(nonGit)).rejects.toThrow(/--in-place/);
    } finally {
      await fs.rm(nonGit, { recursive: true, force: true });
    }
  });
});
