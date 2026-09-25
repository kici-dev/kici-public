import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkdir, LOCAL_RUN_BRANCH } from './source-provider.js';

/** Create a throwaway git repo with one committed file. */
function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-src-repo-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@kici.dev']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(dir, 'committed.txt'), 'base\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  return dir;
}

describe('LocalSourceProvider resolveWorkdir', () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('--in-place returns the repo root with a no-op cleanup', async () => {
    const wd = await resolveWorkdir({ inPlace: true, repoRoot: repo });
    expect(wd.dir).toBe(repo);
    expect(wd.ref).toMatch(/^refs\/heads\//);
    expect(wd.sha).toMatch(/^[0-9a-f]{40}$/);
    await wd.cleanup();
    // The working tree survives cleanup.
    expect(fs.existsSync(path.join(repo, 'committed.txt'))).toBe(true);
  });

  it('isolated materializes a clone carrying the committed base tree', async () => {
    const wd = await resolveWorkdir({ inPlace: false, repoRoot: repo });
    expect(wd.dir).not.toBe(repo);
    expect(wd.branch).toBe(LOCAL_RUN_BRANCH);
    expect(wd.ref).toBe(`refs/heads/${LOCAL_RUN_BRANCH}`);
    expect(fs.readFileSync(path.join(wd.dir, 'committed.txt'), 'utf-8')).toBe('base\n');
    await wd.cleanup();
    expect(fs.existsSync(wd.dir)).toBe(false);
  });

  it('isolated commits the dirty + untracked overlay into the clone sha', async () => {
    // Dirty a tracked file and add an untracked one — neither committed.
    fs.writeFileSync(path.join(repo, 'committed.txt'), 'dirty\n');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n');

    const wd = await resolveWorkdir({ inPlace: false, repoRoot: repo });

    // The clone working tree carries the overlay …
    expect(fs.readFileSync(path.join(wd.dir, 'committed.txt'), 'utf-8')).toBe('dirty\n');
    expect(fs.readFileSync(path.join(wd.dir, 'untracked.txt'), 'utf-8')).toBe('new\n');
    // … and it is committed (clean tree, HEAD carries it — clone-by-sha sees it).
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: wd.dir,
      encoding: 'utf8',
    }).trim();
    expect(status).toBe('');
    const show = execFileSync('git', ['show', `${wd.sha}:untracked.txt`], {
      cwd: wd.dir,
      encoding: 'utf8',
    });
    expect(show).toBe('new\n');

    // The developer's working tree is never mutated.
    expect(fs.existsSync(path.join(repo, 'untracked.txt'))).toBe(true); // still there, but as their own file
    await wd.cleanup();
  });

  it('removes the isolated clone when applying the overlay fails', async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-src-tmpbase-'));
    const previousTmpdir = process.env.KICI_TMPDIR;
    process.env.KICI_TMPDIR = tmpBase;
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n');
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const copy = vi.spyOn(fsp, 'copyFile').mockRejectedValueOnce(denied);
    try {
      // fails-when: the cleanup races a sibling copy still writing into the clone, and its
      // ENOTEMPTY replaces the copy error
      await expect(resolveWorkdir({ inPlace: false, repoRoot: repo })).rejects.toThrow(/EACCES/);
      // The failed copy targeted a clone allocated under tmpBase, so an empty
      // tmpBase below means the clone was removed rather than never created there.
      expect(String(copy.mock.calls[0]?.[1])).toContain(tmpBase);
      // fails-when: the persist-mode clone is left behind when applying the overlay throws
      expect(fs.readdirSync(tmpBase).filter((name) => name.startsWith('kici-local-run-'))).toEqual(
        [],
      );
    } finally {
      copy.mockRestore();
      if (previousTmpdir === undefined) delete process.env.KICI_TMPDIR;
      else process.env.KICI_TMPDIR = previousTmpdir;
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  describe('symlinks, directories and nested repositories', () => {
    const git = (args: string[], cwd = repo) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    const scratch: string[] = [];
    afterEach(() => {
      for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    });

    /** Commit a real directory `lib/` and a directory `shared/` to link to. */
    function commitLibAndShared(libIsLink: boolean): void {
      fs.mkdirSync(path.join(repo, 'shared'));
      fs.writeFileSync(path.join(repo, 'shared/s.txt'), 's\n');
      if (libIsLink) {
        fs.symlinkSync('shared', path.join(repo, 'lib'));
      } else {
        fs.mkdirSync(path.join(repo, 'lib/sub'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'lib/a.txt'), 'a\n');
        fs.writeFileSync(path.join(repo, 'lib/sub/b.txt'), 'b\n');
      }
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'lib']);
    }

    it('turns a committed directory into the symlink the developer replaced it with', async () => {
      commitLibAndShared(false);
      fs.rmSync(path.join(repo, 'lib'), { recursive: true });
      fs.symlinkSync('shared', path.join(repo, 'lib'));

      // fails-when: the files under lib/ are read through the new link and copied into the clone's lib/
      const wd = await resolveWorkdir({ inPlace: false, repoRoot: repo });

      expect(fs.readlinkSync(path.join(wd.dir, 'lib'))).toBe('shared');
      expect(fs.readFileSync(path.join(wd.dir, 'shared/s.txt'), 'utf-8')).toBe('s\n');
      expect(wd.warnings).toEqual([]);
      await wd.cleanup();
    });

    it('turns a committed symlink into the directory the developer replaced it with', async () => {
      commitLibAndShared(true);
      fs.unlinkSync(path.join(repo, 'lib'));
      fs.mkdirSync(path.join(repo, 'lib'));
      fs.writeFileSync(path.join(repo, 'lib/x.txt'), 'x\n');

      // fails-when: the real directory `lib` is copied as a file (EISDIR)
      const wd = await resolveWorkdir({ inPlace: false, repoRoot: repo });

      expect(fs.lstatSync(path.join(wd.dir, 'lib')).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(wd.dir, 'lib/x.txt'), 'utf-8')).toBe('x\n');
      // Nothing was written through the old link.
      expect(fs.existsSync(path.join(wd.dir, 'shared/x.txt'))).toBe(false);
      await wd.cleanup();
    });

    it('skips a changed submodule and warns that its files are not copied', async () => {
      const sub = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-src-sub-'));
      scratch.push(sub);
      git(['init', '-q'], sub);
      git(
        ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one'],
        sub,
      );
      git(['-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', sub, 'vendor/sub']);
      git(['commit', '-q', '-m', 'submodule']);
      // Move the submodule checkout, so the superproject lists vendor/sub as changed.
      git(
        ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'two'],
        path.join(repo, 'vendor/sub'),
      );

      // fails-when: the submodule directory is copied as a file (EISDIR)
      const wd = await resolveWorkdir({ inPlace: false, repoRoot: repo });

      expect(wd.warnings).toEqual([
        'Not copying the files of these submodules: vendor/sub. ' +
          'The isolated checkout does not contain them.',
      ]);
      await wd.cleanup();
    });

    describe('a submodule the developer removed', () => {
      /** Commit a submodule at `vendor/sub` whose checkout is populated. */
      function commitSubmodule(): void {
        const sub = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-src-sub-'));
        scratch.push(sub);
        git(['init', '-q'], sub);
        git(
          [
            '-c',
            'user.email=t@t',
            '-c',
            'user.name=t',
            'commit',
            '-q',
            '--allow-empty',
            '-m',
            'one',
          ],
          sub,
        );
        git(['-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', sub, 'vendor/sub']);
        git(['commit', '-q', '-m', 'submodule']);
      }

      /** The paths the isolated checkout's committed HEAD tree records. */
      function committedPaths(dir: string): string[] {
        return execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
          cwd: dir,
          encoding: 'utf8',
        })
          .split('\n')
          .filter((line) => line.length > 0);
      }

      it('drops a submodule removed with rm -rf from a repository with a remote', async () => {
        commitSubmodule();
        git(['remote', 'add', 'origin', '/nonexistent/origin.git']);
        fs.rmSync(path.join(repo, 'vendor/sub'), { recursive: true, force: true });
        fs.rmSync(path.join(repo, 'committed.txt'));

        // fails-when: the clone's empty gitlink directory is removed as a file (ERR_FS_EISDIR)
        const wd = await resolveWorkdir({ inPlace: false, repoRoot: repo });

        expect(fs.existsSync(path.join(wd.dir, 'vendor/sub'))).toBe(false);
        expect(committedPaths(wd.dir)).not.toContain('vendor/sub');
        // breaks-if-wrong: a deleted regular file is still removed from the clone
        expect(fs.existsSync(path.join(wd.dir, 'committed.txt'))).toBe(false);
        expect(committedPaths(wd.dir)).not.toContain('committed.txt');
        await wd.cleanup();
      });

      it('drops a submodule removed with git rm from a repository with a remote', async () => {
        commitSubmodule();
        git(['remote', 'add', 'origin', '/nonexistent/origin.git']);
        git(['rm', '-q', 'vendor/sub']);

        // fails-when: the clone's empty gitlink directory is removed as a file (ERR_FS_EISDIR)
        const wd = await resolveWorkdir({ inPlace: false, repoRoot: repo });

        expect(fs.existsSync(path.join(wd.dir, 'vendor/sub'))).toBe(false);
        expect(committedPaths(wd.dir)).not.toContain('vendor/sub');
        // git rm also drops the entry from .gitmodules, which ships as a changed file.
        expect(fs.readFileSync(path.join(wd.dir, '.gitmodules'), 'utf-8')).not.toContain(
          'vendor/sub',
        );
        await wd.cleanup();
      });

      it('drops a submodule removed with rm -rf from a repository without a remote', async () => {
        commitSubmodule();
        fs.rmSync(path.join(repo, 'vendor/sub'), { recursive: true, force: true });

        // fails-when: the clone's empty gitlink directory is removed as a file (ERR_FS_EISDIR)
        const wd = await resolveWorkdir({ inPlace: false, repoRoot: repo });

        expect(fs.existsSync(path.join(wd.dir, 'vendor/sub'))).toBe(false);
        expect(committedPaths(wd.dir)).not.toContain('vendor/sub');
        // breaks-if-wrong: the rest of the tracked tree still ships
        expect(fs.readFileSync(path.join(wd.dir, 'committed.txt'), 'utf-8')).toBe('base\n');
        await wd.cleanup();
      });
    });

    it('skips an untracked nested repository and warns about it', async () => {
      git(['init', '-q', 'nested']);

      const wd = await resolveWorkdir({ inPlace: false, repoRoot: repo });

      expect(wd.warnings).toEqual([
        // fails-when: a nested repository is labeled as a submodule
        'Not copying the files of these nested git repositories: nested. ' +
          'The isolated checkout does not contain them.',
      ]);
      expect(fs.existsSync(path.join(wd.dir, 'nested'))).toBe(false);
      await wd.cleanup();
    });
  });

  it('throws when the path is not a git work tree', async () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-nonrepo-'));
    await expect(resolveWorkdir({ inPlace: true, repoRoot: nonRepo })).rejects.toThrow(
      /not inside a git work tree/,
    );
    fs.rmSync(nonRepo, { recursive: true, force: true });
  });
});
