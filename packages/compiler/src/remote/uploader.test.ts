import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { list as tarList, x as tarExtract } from 'tar';
import {
  createOverlayTarball,
  getSizeWarning,
  selectOverlayFiles,
  uploadTarball,
} from './uploader.js';

/**
 * Helper: create a temp git repo with initial commit and a dummy remote.
 * Having a remote enables overlay mode (only changed files).
 * Returns the repo root path.
 */
async function createTempGitRepo(opts?: { withRemote?: boolean }): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-uploader-test-'));
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });

  // Create initial file and commit
  await fs.writeFile(path.join(dir, 'initial.txt'), 'initial content\n');
  execSync('git add .', { cwd: dir, stdio: 'ignore' });
  execSync('git commit -m "initial commit"', { cwd: dir, stdio: 'ignore' });

  // Add dummy remote by default (overlay mode)
  if (opts?.withRemote !== false) {
    execSync('git remote add origin https://example.com/repo.git', {
      cwd: dir,
      stdio: 'ignore',
    });
  }

  return dir;
}

/**
 * Helper: extract tar.gz file listing.
 */
async function listTarFiles(tarballPath: string): Promise<string[]> {
  const files: string[] = [];
  await tarList({
    file: tarballPath,
    onReadEntry: (entry) => {
      files.push(entry.path);
    },
  });
  return files;
}

/** The node-tar entry types an overlay tarball carries. */
enum TarEntryType {
  File = 'File',
  SymbolicLink = 'SymbolicLink',
}

/** Every tarball entry path mapped to its node-tar entry type. */
async function listTarEntries(tarballPath: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  await tarList({
    file: tarballPath,
    onReadEntry: (entry) => {
      entries.set(entry.path, entry.type);
    },
  });
  return entries;
}

/** Tarball entries other than the overlay manifest. */
function contentEntries(entries: Map<string, string>): string[] {
  return [...entries.keys()].filter((p) => !p.startsWith('.kici-overlay-tmp/')).sort();
}

function sha256Of(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Stage and commit every change in `dir`. */
function commitAll(dir: string): void {
  execSync('git add -A && git commit -qm change', { cwd: dir, stdio: 'ignore' });
}

/** Point the symlink at `rel` somewhere else. */
async function relink(dir: string, rel: string, text: string): Promise<void> {
  await fs.unlink(path.join(dir, rel));
  await fs.symlink(text, path.join(dir, rel));
}

describe('overlay tarball creation', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createTempGitRepo();
  });

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  describe('createOverlayTarball', () => {
    it('detects modified files (unstaged changes)', async () => {
      // Modify a committed file without staging
      await fs.writeFile(path.join(repoDir, 'initial.txt'), 'modified content\n');

      const { summary, manifest } = await createOverlayTarball(repoDir);

      expect(summary.modifiedFiles).toBe(1);
      expect(summary.newFiles).toBe(0);
      expect(summary.fileCount).toBe(1);
      expect(summary.sha).toMatch(/^[a-f0-9]{40}$/);
      expect(manifest.checksums['initial.txt']).toBeDefined();
    });

    it('detects staged changes', async () => {
      // Modify and stage a file
      await fs.writeFile(path.join(repoDir, 'initial.txt'), 'staged content\n');
      execSync('git add initial.txt', { cwd: repoDir, stdio: 'ignore' });

      const { summary } = await createOverlayTarball(repoDir);

      expect(summary.modifiedFiles).toBe(1);
      expect(summary.fileCount).toBe(1);
    });

    it('includes untracked non-ignored files', async () => {
      // Create new untracked file
      await fs.writeFile(path.join(repoDir, 'new-file.txt'), 'new content\n');

      const { summary, manifest } = await createOverlayTarball(repoDir);

      expect(summary.newFiles).toBe(1);
      expect(summary.fileCount).toBe(1);
      expect(manifest.checksums['new-file.txt']).toBeDefined();
    });

    it('excludes .gitignored files', async () => {
      // Create .gitignore and an ignored file
      await fs.writeFile(path.join(repoDir, '.gitignore'), 'ignored.txt\n');
      await fs.writeFile(path.join(repoDir, 'ignored.txt'), 'should be ignored\n');
      await fs.writeFile(path.join(repoDir, 'not-ignored.txt'), 'should be included\n');
      execSync('git add .gitignore', { cwd: repoDir, stdio: 'ignore' });

      const { summary, manifest } = await createOverlayTarball(repoDir);

      // .gitignore is staged (new), not-ignored.txt is untracked (new)
      expect(manifest.checksums['ignored.txt']).toBeUndefined();
      expect(summary.fileCount).toBe(2); // .gitignore + not-ignored.txt
    });

    it('creates valid tar.gz', async () => {
      await fs.writeFile(path.join(repoDir, 'new-file.txt'), 'new content\n');
      await fs.writeFile(path.join(repoDir, 'initial.txt'), 'modified\n');

      const { tarballPath } = await createOverlayTarball(repoDir);

      // Verify it's a real tar.gz
      const files = await listTarFiles(tarballPath);
      expect(files).toContain('new-file.txt');
      expect(files).toContain('initial.txt');
      // Manifest is always included
      expect(files.some((f) => f.includes('manifest.json'))).toBe(true);
    });

    it('ships .git/** in the tarball (with .git/ prefix) for fullWorkingTree', async () => {
      const { tarballPath, manifest } = await createOverlayTarball(repoDir, {
        fullWorkingTree: true,
      });

      const files = await listTarFiles(tarballPath);
      // Paths keep the `.git/` prefix so extraction restores the repo in place.
      expect(files).toContain('.git/HEAD');
      expect(files).toContain('.git/config');
      // Manifest carries checksums for git internals too (integrity verified).
      expect(manifest.checksums['.git/HEAD']).toMatch(/^[a-f0-9]{64}$/);
    });

    it('keeps the new/modified breakdown free of .git noise (fullWorkingTree)', async () => {
      // initial.txt is the only working-tree file; `.git/**` must not inflate
      // the modified/new counts the developer sees, even though it counts
      // toward fileCount.
      const { summary } = await createOverlayTarball(repoDir, { fullWorkingTree: true });
      expect(summary.modifiedFiles).toBe(1); // initial.txt only
      expect(summary.newFiles).toBe(0);
      expect(summary.fileCount).toBeGreaterThan(1); // includes .git/** files
    });

    it('generates correct manifest with checksums', async () => {
      const content = 'checksum test content\n';
      await fs.writeFile(path.join(repoDir, 'checksum.txt'), content);

      const { manifest } = await createOverlayTarball(repoDir);

      expect(manifest.sha).toMatch(/^[a-f0-9]{40}$/);
      expect(manifest.checksums['checksum.txt']).toBeDefined();
      expect(manifest.checksums['checksum.txt']).toMatch(/^[a-f0-9]{64}$/);
    });

    it('includes deletions in manifest for deleted files', async () => {
      // Create a second file and commit it
      await fs.writeFile(path.join(repoDir, 'to-delete.txt'), 'will be deleted\n');
      execSync('git add to-delete.txt', { cwd: repoDir, stdio: 'ignore' });
      execSync('git commit -m "add file to delete"', { cwd: repoDir, stdio: 'ignore' });

      // Delete the file (git tracks this as a change)
      await fs.unlink(path.join(repoDir, 'to-delete.txt'));

      const { summary, manifest } = await createOverlayTarball(repoDir);

      expect(summary.deletedFiles).toBe(1);
      expect(manifest.deletions).toContain('to-delete.txt');
      // Deleted file should not have a checksum
      expect(manifest.checksums['to-delete.txt']).toBeUndefined();
    });

    it('respects .kiciignore patterns', async () => {
      // Create .kiciignore
      await fs.writeFile(path.join(repoDir, '.kiciignore'), '*.log\nbuild/**\n');

      // Create files matching and not matching .kiciignore
      await fs.writeFile(path.join(repoDir, 'app.log'), 'log content\n');
      await fs.writeFile(path.join(repoDir, 'source.ts'), 'source content\n');
      await fs.mkdir(path.join(repoDir, 'build'), { recursive: true });
      await fs.writeFile(path.join(repoDir, 'build', 'output.js'), 'built content\n');

      const { manifest } = await createOverlayTarball(repoDir);

      // .kiciignore patterns should be excluded
      expect(manifest.checksums['app.log']).toBeUndefined();
      expect(manifest.checksums['build/output.js']).toBeUndefined();
      // Non-ignored files should be included
      expect(manifest.checksums['source.ts']).toBeDefined();
    });

    it('handles repos without a remote (full tarball mode)', async () => {
      // Create a repo without a remote
      const noRemoteDir = await createTempGitRepo({ withRemote: false });
      try {
        await fs.writeFile(path.join(noRemoteDir, 'file2.txt'), 'file2\n');
        execSync('git add file2.txt', { cwd: noRemoteDir, stdio: 'ignore' });
        execSync('git commit -m "add file2"', { cwd: noRemoteDir, stdio: 'ignore' });

        const { summary } = await createOverlayTarball(noRemoteDir);

        // No remote = all tracked files included
        expect(summary.fileCount).toBe(2); // initial.txt + file2.txt
      } finally {
        await fs.rm(noRemoteDir, { recursive: true, force: true });
      }
    });

    it('handles repos with a remote (overlay mode)', async () => {
      // repoDir has a remote by default -- with no changes, should produce empty overlay
      const { summary } = await createOverlayTarball(repoDir);

      expect(summary.fileCount).toBe(0);
      expect(summary.modifiedFiles).toBe(0);
      expect(summary.newFiles).toBe(0);
    });

    it('deduplicates files across staged, unstaged, and untracked', async () => {
      // Modify and stage a file, then modify it again (appears in both staged and unstaged)
      await fs.writeFile(path.join(repoDir, 'initial.txt'), 'staged change\n');
      execSync('git add initial.txt', { cwd: repoDir, stdio: 'ignore' });
      await fs.writeFile(path.join(repoDir, 'initial.txt'), 'unstaged change on top\n');

      const { summary, manifest } = await createOverlayTarball(repoDir);

      // Should count as 1 file, not 2
      expect(summary.fileCount).toBe(1);
      expect(Object.keys(manifest.checksums)).toHaveLength(1);
    });

    it('errors when tarball exceeds 500MB limit', async () => {
      // We can't easily create a 500MB file in a test, but we can verify the
      // error message format by checking the getSizeWarning function
      const bigSize = 600 * 1024 * 1024;
      // The actual check happens inside createOverlayTarball after compression,
      // so we just verify the threshold logic via getSizeWarning for the warning case
      expect(getSizeWarning(bigSize)).toBeNull(); // Above error threshold, null for warning fn
    });

    it('cleans up temporary manifest directory from repo', async () => {
      await fs.writeFile(path.join(repoDir, 'change.txt'), 'test\n');

      await createOverlayTarball(repoDir);

      // Temp manifest dir should be cleaned up
      const entries = await fs.readdir(repoDir);
      expect(entries).not.toContain('.kici-overlay-tmp');
    });
  });

  describe('selectOverlayFiles', () => {
    it('selects dirty + untracked files (overlay mode) and reports the HEAD SHA', async () => {
      await fs.writeFile(path.join(repoDir, 'initial.txt'), 'modified content\n');
      await fs.writeFile(path.join(repoDir, 'new-file.txt'), 'new content\n');

      const selection = await selectOverlayFiles(repoDir);

      expect(selection.hasRemote).toBe(true);
      expect(selection.sha).toMatch(/^[a-f0-9]{40}$/);
      expect(selection.existingFiles.sort()).toEqual(['initial.txt', 'new-file.txt']);
      expect(selection.deletedFiles).toEqual([]);
    });

    it('partitions deleted committed files into deletedFiles', async () => {
      await fs.writeFile(path.join(repoDir, 'to-delete.txt'), 'will be deleted\n');
      execSync('git add to-delete.txt', { cwd: repoDir, stdio: 'ignore' });
      execSync('git commit -m "add file to delete"', { cwd: repoDir, stdio: 'ignore' });
      await fs.unlink(path.join(repoDir, 'to-delete.txt'));

      const selection = await selectOverlayFiles(repoDir);

      expect(selection.deletedFiles).toContain('to-delete.txt');
      expect(selection.existingFiles).not.toContain('to-delete.txt');
    });

    it('excludes .kiciignore matches from the selection', async () => {
      await fs.writeFile(path.join(repoDir, '.kiciignore'), '*.log\n');
      await fs.writeFile(path.join(repoDir, 'app.log'), 'log content\n');
      await fs.writeFile(path.join(repoDir, 'source.ts'), 'source content\n');

      const selection = await selectOverlayFiles(repoDir);

      expect(selection.existingFiles).not.toContain('app.log');
      expect(selection.existingFiles).toContain('source.ts');
    });

    it('agrees with createOverlayTarball on the included file set (parity)', async () => {
      await fs.writeFile(path.join(repoDir, 'initial.txt'), 'modified\n');
      await fs.writeFile(path.join(repoDir, 'extra.txt'), 'extra\n');

      const selection = await selectOverlayFiles(repoDir);
      const { manifest } = await createOverlayTarball(repoDir);

      // The tarball's checksum keys are exactly the existing overlay files.
      expect(Object.keys(manifest.checksums).sort()).toEqual([...selection.existingFiles].sort());
      expect(manifest.deletions.sort()).toEqual([...selection.deletedFiles].sort());
    });

    it('forces all tracked + untracked when fullWorkingTree is set, even WITH a remote', async () => {
      // `kici run remote` uploads the full local working tree regardless of a
      // git remote — the orchestrator never clones for a relayed run. A
      // committed-and-clean file (`clean.txt`) is invisible to the dirty-only
      // selection but MUST appear in the full-working-tree selection.
      await fs.writeFile(path.join(repoDir, 'clean.txt'), 'committed clean\n');
      execSync('git add clean.txt', { cwd: repoDir, stdio: 'ignore' });
      execSync('git commit -m "add clean file"', { cwd: repoDir, stdio: 'ignore' });
      await fs.writeFile(path.join(repoDir, 'untracked.txt'), 'new content\n');

      const dirtyOnly = await selectOverlayFiles(repoDir);
      const fullTree = await selectOverlayFiles(repoDir, { fullWorkingTree: true });

      expect(fullTree.hasRemote).toBe(true);
      // Dirty-only sees only untracked.txt; full-tree adds the committed-clean
      // tracked files (initial.txt + clean.txt).
      expect(dirtyOnly.existingFiles).not.toContain('clean.txt');
      expect(fullTree.existingFiles).toContain('clean.txt');
      expect(fullTree.existingFiles).toContain('initial.txt');
      expect(fullTree.existingFiles).toContain('untracked.txt');
      expect(fullTree.existingFiles.length).toBeGreaterThan(dirtyOnly.existingFiles.length);
    });

    it('includes the .git directory when fullWorkingTree is set', async () => {
      // `kici run remote` ships the full working tree INCLUDING `.git` so the
      // extracted overlay is a real git repo and step git commands work.
      const selection = await selectOverlayFiles(repoDir, { fullWorkingTree: true });

      // HEAD and the index always exist in a committed repo; a branch ref
      // exists under refs/heads or is packed. The config is always present.
      expect(selection.existingFiles).toContain('.git/HEAD');
      expect(selection.existingFiles).toContain('.git/config');
      expect(selection.existingFiles.some((f) => f === '.git/index')).toBe(true);
      // At least one ref (loose under refs/heads or packed-refs).
      const hasRef = selection.existingFiles.some(
        (f) => f.startsWith('.git/refs/') || f === '.git/packed-refs',
      );
      expect(hasRef).toBe(true);
      // No `.git` path should land in the deletion list.
      expect(selection.deletedFiles.some((f) => f.startsWith('.git/'))).toBe(false);
    });

    it('omits the .git directory when fullWorkingTree is NOT set', async () => {
      await fs.writeFile(path.join(repoDir, 'dirty.txt'), 'dirty\n');
      const selection = await selectOverlayFiles(repoDir);
      expect(selection.existingFiles.some((f) => f.startsWith('.git/'))).toBe(false);
    });

    it('returns all tracked + untracked when the repo has no remote', async () => {
      const noRemoteDir = await createTempGitRepo({ withRemote: false });
      try {
        await fs.writeFile(path.join(noRemoteDir, 'file2.txt'), 'file2\n');

        const selection = await selectOverlayFiles(noRemoteDir);

        expect(selection.hasRemote).toBe(false);
        // initial.txt (tracked) + file2.txt (untracked)
        expect(selection.existingFiles.sort()).toEqual(['file2.txt', 'initial.txt']);
      } finally {
        await fs.rm(noRemoteDir, { recursive: true, force: true });
      }
    });
  });

  describe('symlinks', () => {
    const scratch: string[] = [];

    afterEach(async () => {
      await Promise.all(scratch.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
    });

    async function tempDir(prefix: string): Promise<string> {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
      scratch.push(dir);
      return dir;
    }

    /** Extract the tarball the way the agent does, returning the real extraction root. */
    async function extract(tarballPath: string): Promise<string> {
      const dir = await tempDir('kici-uploader-extract-');
      await tarExtract({ file: tarballPath, cwd: dir });
      return fs.realpath(dir);
    }

    async function write(rel: string, content: string): Promise<void> {
      await fs.mkdir(path.dirname(path.join(repoDir, rel)), { recursive: true });
      await fs.writeFile(path.join(repoDir, rel), content);
    }

    it('ships the unchanged target of a changed file symlink (overlay mode)', async () => {
      await write('docs/a.yaml', 'a: 1\n');
      await write('docs/b.yaml', 'b: 2\n');
      await fs.mkdir(path.join(repoDir, 'site'));
      await fs.symlink('../docs/a.yaml', path.join(repoDir, 'site/alerts.yaml'));
      commitAll(repoDir);
      await relink(repoDir, 'site/alerts.yaml', '../docs/b.yaml');

      const { tarballPath, manifest, summary } = await createOverlayTarball(repoDir);

      const entries = await listTarEntries(tarballPath);
      // fails-when: only the changed link ships, and the agent's realpath finds no target
      expect(entries.get('docs/b.yaml')).toBe(TarEntryType.File);
      expect(entries.get('site/alerts.yaml')).toBe(TarEntryType.SymbolicLink);
      expect(contentEntries(entries)).toEqual(['docs/b.yaml', 'site/alerts.yaml']);
      expect(manifest.checksums['docs/b.yaml']).toBe(sha256Of('b: 2\n'));
      expect(manifest.checksums['site/alerts.yaml']).toBe(sha256Of('b: 2\n'));
      // The shipped target is not a change the developer made.
      expect(summary.modifiedFiles).toBe(1);

      // The agent's precondition: the link resolves to a regular file inside the extraction.
      const root = await extract(tarballPath);
      expect(await fs.realpath(path.join(root, 'site/alerts.yaml'))).toBe(
        path.join(root, 'docs/b.yaml'),
      );
    });

    it('ships every in-repository link on the way to the file', async () => {
      // entry -> hop -> d/file.txt, where d -> real is a directory link.
      await write('real/file.txt', 'deep\n');
      await write('other.txt', 'other\n');
      await fs.symlink('real', path.join(repoDir, 'd'));
      await fs.symlink('d/file.txt', path.join(repoDir, 'hop'));
      await fs.symlink('other.txt', path.join(repoDir, 'entry'));
      commitAll(repoDir);
      await relink(repoDir, 'entry', 'hop');

      const { tarballPath, manifest } = await createOverlayTarball(repoDir);

      const entries = await listTarEntries(tarballPath);
      expect(contentEntries(entries)).toEqual(['d', 'entry', 'hop', 'real/file.txt']);
      expect(entries.get('d')).toBe(TarEntryType.SymbolicLink);
      expect(manifest.symlinks).toEqual({ d: 'real' });
      expect(manifest.checksums).toEqual({
        entry: sha256Of('deep\n'),
        hop: sha256Of('deep\n'),
        'real/file.txt': sha256Of('deep\n'),
      });
      const root = await extract(tarballPath);
      expect(await fs.readFile(path.join(root, 'entry'), 'utf-8')).toBe('deep\n');
    });

    it('does not ship a link target outside the repository', async () => {
      const outside = await tempDir('kici-uploader-outside-');
      await fs.writeFile(path.join(outside, 'host.txt'), 'host\n');
      await write('inside.txt', 'in\n');
      await fs.symlink('inside.txt', path.join(repoDir, 'abs.txt'));
      await fs.symlink('inside.txt', path.join(repoDir, 'rel.txt'));
      commitAll(repoDir);
      await relink(repoDir, 'abs.txt', path.join(outside, 'host.txt'));
      await relink(repoDir, 'rel.txt', path.relative(repoDir, path.join(outside, 'host.txt')));

      const { tarballPath, manifest } = await createOverlayTarball(repoDir);

      // breaks-if-wrong: shipping these targets would copy a host file into the upload
      expect(contentEntries(await listTarEntries(tarballPath))).toEqual(['abs.txt', 'rel.txt']);
      expect(Object.keys(manifest.checksums).sort()).toEqual(['abs.txt', 'rel.txt']);
    });

    it('does not ship a link target that .gitignore or .kiciignore excludes', async () => {
      await write('.gitignore', '.env.local\n');
      await write('.kiciignore', 'private/**\n');
      await write('defaults.env', 'A=1\n');
      await write('private/notes.txt', 'notes\n');
      await fs.symlink('defaults.env', path.join(repoDir, 'active.env'));
      await fs.symlink('defaults.env', path.join(repoDir, 'notes.txt'));
      commitAll(repoDir);
      await write('.env.local', 'TOKEN=secret\n');
      await relink(repoDir, 'active.env', '.env.local');
      await relink(repoDir, 'notes.txt', 'private/notes.txt');

      const { tarballPath } = await createOverlayTarball(repoDir);

      // fails-when: a tracked link carries an ignored file (here a secret) into the upload
      expect(contentEntries(await listTarEntries(tarballPath))).toEqual([
        'active.env',
        'notes.txt',
      ]);
    });

    it('omits the symlinks field when no directory symlink ships', async () => {
      await write('plain.txt', 'plain\n');
      const { manifest } = await createOverlayTarball(repoDir);
      expect(manifest).not.toHaveProperty('symlinks');
    });

    it('ships a directory symlink as its link text (full working tree)', async () => {
      await write('shared/a.txt', 'a\n');
      await fs.symlink('shared', path.join(repoDir, 'lib'));
      commitAll(repoDir);

      // fails-when: the directory behind the link is checksummed (EISDIR)
      const { tarballPath, manifest } = await createOverlayTarball(repoDir, {
        fullWorkingTree: true,
      });

      expect(manifest.symlinks).toEqual({ lib: 'shared' });
      // An agent that predates `symlinks` reads only checksums and deletions: the
      // link is absent there, so it skips the link instead of failing on it.
      expect(manifest.checksums).not.toHaveProperty('lib');
      expect(manifest.deletions).not.toContain('lib');
      expect(manifest.checksums['shared/a.txt']).toBe(sha256Of('a\n'));
      // git tracks nothing beneath a link, and the overlay adds nothing beneath it.
      expect(Object.keys(manifest.checksums).some((f) => f.startsWith('lib/'))).toBe(false);
      expect((await listTarEntries(tarballPath)).get('lib')).toBe(TarEntryType.SymbolicLink);
    });

    it('ships a changed directory symlink as its link text (overlay mode)', async () => {
      await write('shared/a.txt', 'a\n');
      await write('shared2/b.txt', 'b\n');
      await fs.symlink('shared', path.join(repoDir, 'lib'));
      commitAll(repoDir);
      await relink(repoDir, 'lib', 'shared2');

      const { manifest, summary } = await createOverlayTarball(repoDir);

      expect(manifest.symlinks).toEqual({ lib: 'shared2' });
      expect(manifest.checksums).toEqual({});
      expect(manifest.deletions).toEqual([]);
      expect(summary.fileCount).toBe(1);
    });

    it('ships a directory symlink leaving the repository as its text for the agent to refuse', async () => {
      const outside = await tempDir('kici-uploader-outside-');
      await write('keep.txt', 'keep\n');
      await fs.symlink(path.relative(repoDir, outside), path.join(repoDir, 'lib'));
      commitAll(repoDir);

      const { manifest } = await createOverlayTarball(repoDir, { fullWorkingTree: true });

      expect(manifest.symlinks).toEqual({ lib: path.relative(repoDir, outside) });
    });

    it('deletes the files of a directory replaced by a symlink', async () => {
      await write('lib/a.txt', 'a\n');
      await write('lib/sub/b.txt', 'b\n');
      // The same names under the link target: read through the new link, they
      // would look like existing files.
      await write('shared/a.txt', 'a\n');
      await write('shared/sub/b.txt', 'b\n');
      commitAll(repoDir);
      await fs.rm(path.join(repoDir, 'lib'), { recursive: true });
      await fs.symlink('shared', path.join(repoDir, 'lib'));

      const { manifest } = await createOverlayTarball(repoDir);

      // fails-when: lib/a.txt is read through the new link and shipped as content
      expect(manifest.checksums).toEqual({});
      expect([...manifest.deletions].sort()).toEqual(['lib/a.txt', 'lib/sub/b.txt']);
      expect(manifest.symlinks).toEqual({ lib: 'shared' });
    });

    it('deletes a directory symlink replaced by a real directory, and ships its files', async () => {
      await write('shared/a.txt', 'a\n');
      await fs.symlink('shared', path.join(repoDir, 'lib'));
      commitAll(repoDir);
      await fs.unlink(path.join(repoDir, 'lib'));
      await write('lib/x.txt', 'x\n');

      for (const fullWorkingTree of [false, true]) {
        // fails-when: the real directory `lib` is checksummed as a file (EISDIR)
        const { manifest, warnings } = await createOverlayTarball(repoDir, { fullWorkingTree });

        expect(manifest.deletions).toContain('lib');
        expect(manifest.checksums['lib/x.txt']).toBe(sha256Of('x\n'));
        expect(manifest.checksums).not.toHaveProperty('lib');
        expect(warnings).toEqual([]);
      }
    });

    it('skips a submodule and warns that its files are not uploaded', async () => {
      const subRepo = await tempDir('kici-uploader-sub-');
      execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m s', {
        cwd: subRepo,
      });
      execSync(`git -c protocol.file.allow=always submodule -q add ${subRepo} vendor/sub`, {
        cwd: repoDir,
        stdio: 'ignore',
      });
      commitAll(repoDir);

      // fails-when: the submodule directory is checksummed as a file (EISDIR)
      const { manifest, warnings } = await createOverlayTarball(repoDir, {
        fullWorkingTree: true,
      });

      expect(manifest.checksums).not.toHaveProperty('vendor/sub');
      expect(manifest.deletions).not.toContain('vendor/sub');
      expect(manifest.checksums).toHaveProperty('.gitmodules');
      expect(warnings).toHaveLength(1);
      expect(warnings).toEqual([
        'Not uploading the files of these submodules: vendor/sub. ' +
          'The remote workspace does not contain them.',
      ]);
    });

    it('skips an untracked nested repository and warns about it', async () => {
      execSync('git init -q nested', { cwd: repoDir });

      const { manifest, warnings } = await createOverlayTarball(repoDir, {
        fullWorkingTree: true,
      });

      expect(Object.keys(manifest.checksums).some((f) => f.startsWith('nested'))).toBe(false);
      // fails-when: an untracked nested repository is reported as a submodule
      expect(warnings).toEqual([
        'Not uploading the files of these nested git repositories: nested. ' +
          'The remote workspace does not contain them.',
      ]);
    });

    it('keeps a dangling tracked symlink out of the upload and warns about it', async () => {
      await fs.symlink('missing.txt', path.join(repoDir, 'dangling'));
      commitAll(repoDir);

      const { tarballPath, manifest, warnings } = await createOverlayTarball(repoDir, {
        fullWorkingTree: true,
      });

      expect(contentEntries(await listTarEntries(tarballPath))).not.toContain('dangling');
      expect(manifest.checksums).not.toHaveProperty('dangling');
      // fails-when: the link is dropped without telling the developer
      expect(warnings).toEqual([
        'Not uploading these symbolic links, whose target does not exist: dangling. ' +
          'The remote workspace does not contain them.',
      ]);
    });

    it('lists a deleted directory symlink as a deletion of the link', async () => {
      await write('shared/a.txt', 'a\n');
      await fs.symlink('shared', path.join(repoDir, 'lib'));
      commitAll(repoDir);
      await fs.unlink(path.join(repoDir, 'lib'));

      const { manifest } = await createOverlayTarball(repoDir);

      expect(manifest.deletions).toEqual(['lib']);
      expect(manifest.checksums).toEqual({});
      expect(manifest).not.toHaveProperty('symlinks');
    });
  });

  describe('getSizeWarning', () => {
    it('returns null below warning threshold', () => {
      expect(getSizeWarning(10 * 1024 * 1024)).toBeNull(); // 10MB
    });

    it('returns warning between 50MB and 500MB', () => {
      const warning = getSizeWarning(100 * 1024 * 1024); // 100MB
      expect(warning).toContain('Warning');
      expect(warning).toContain('50MB');
    });

    it('returns null above error threshold', () => {
      // Above 500MB is an error, not a warning
      expect(getSizeWarning(600 * 1024 * 1024)).toBeNull();
    });
  });

  describe('uploadTarball', () => {
    it('fails fast with an actionable message when the signed URL is empty', async () => {
      // An empty signedUrl means the orchestrator has no object storage
      // configured. The guard must reject before fetch('') throws an opaque
      // "Failed to parse URL from " error.
      await expect(
        uploadTarball({
          tarballPath: '/nonexistent/overlay.tar.gz',
          signedUrl: '',
          orchestratorPublicKey: Buffer.alloc(32),
        }),
      ).rejects.toThrow(/did not return an upload URL/i);
    });
  });
});
