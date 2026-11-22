import { afterEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeTempDir } from '@kici-dev/core/tmp';
import { createOverlayTarball } from './uploader.js';
import { GitTagMode } from './shipped-git/git-ship-types.js';

vi.mock('@kici-dev/core/tmp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kici-dev/core/tmp')>();
  return { ...actual, makeTempDir: vi.fn(actual.makeTempDir) };
});

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.mocked(makeTempDir).mockClear();
  for (const dir of roots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('createOverlayTarball temp dirs', () => {
  it('removes the overlay temp dir when creating the .git temp dir fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-uploader-tmpfail-'));
    roots.push(root);
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    execSync('git init -q && git config user.email t@t && git config user.name T', { cwd: repo });
    await fs.writeFile(path.join(repo, 'a.txt'), 'a\n');
    execSync('git add -A && git commit -qm one', { cwd: repo });
    const overlayBase = path.join(root, 'base');
    vi.stubEnv('KICI_TMPDIR', overlayBase);

    const actual = await vi.importActual<typeof import('@kici-dev/core/tmp')>('@kici-dev/core/tmp');
    vi.mocked(makeTempDir).mockImplementation(async (label, opts) => {
      if (label === 'shipped-git') throw new Error('no space left for the .git temp dir');
      return actual.makeTempDir(label, opts);
    });

    await expect(
      createOverlayTarball(repo, {
        fullWorkingTree: true,
        git: { depth: 1, tags: GitTagMode.Default },
      }),
    ).rejects.toThrow('no space left for the .git temp dir');
    // breaks-if-wrong: the failure happened after the overlay dir existed
    expect(vi.mocked(makeTempDir).mock.calls.map(([label]) => label)).toEqual([
      'overlay',
      'shipped-git',
    ]);
    // fails-when: the overlay temp dir is created outside the guarded block and leaks
    expect(await fs.readdir(overlayBase)).toEqual([]);
  });
});
