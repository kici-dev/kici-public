import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { list as tarList, x as tarExtract } from 'tar';
import {
  assertOverlayWithinLimit,
  createOverlayTarball,
  gcStaleOverlayDirs,
  getSizeWarning,
  OVERLAY_TMP_GC_MAX_AGE_MS,
  selectOverlayFiles,
  uploadTarball,
} from './uploader.js';
import { GitTagMode } from './shipped-git/git-ship-types.js';

/** A temp repo with one commit and, by default, a dummy remote, which enables overlay mode. */
async function createTempGitRepo(opts?: { withRemote?: boolean }): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-uploader-test-'));
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });

  await fs.writeFile(path.join(dir, 'initial.txt'), 'initial content\n');
  execSync('git add .', { cwd: dir, stdio: 'ignore' });
  execSync('git commit -m "initial commit"', { cwd: dir, stdio: 'ignore' });

  if (opts?.withRemote !== false) {
    execSync('git remote add origin https://example.com/repo.git', {
      cwd: dir,
      stdio: 'ignore',
    });
  }

  return dir;
}

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

function commitAll(dir: string): void {
  execSync('git add -A && git commit -qm change', { cwd: dir, stdio: 'ignore' });
}

/** Point the symlink at `rel` somewhere else. */
async function relink(dir: string, rel: string, text: string): Promise<void> {
  await fs.unlink(path.join(dir, rel));
  await fs.symlink(text, path.join(dir, rel));
}

async function writeIn(dir: string, rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), content);
}

/** Extraction directories, removed after each test. */
const extractDirs: string[] = [];

async function extractTarball(tarballPath: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-uploader-extract-'));
  extractDirs.push(dir);
  await tarExtract({ file: tarballPath, cwd: dir });
  return dir;
}

/** The manifest the agent reads from the tarball. */
async function readTarManifest(tarballPath: string): Promise<unknown> {
  const root = await extractTarball(tarballPath);
  return JSON.parse(
    await fs.readFile(path.join(root, '.kici-overlay-tmp', 'manifest.json'), 'utf-8'),
  );
}

/**
 * Checks the tarball as the agent does: hash each checksummed entry through its
 * real path, which must stay inside the extraction root.
 */
async function expectAgentVerifies(tarballPath: string): Promise<void> {
  const root = await fs.realpath(await extractTarball(tarballPath));
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, '.kici-overlay-tmp', 'manifest.json'), 'utf-8'),
  ) as { checksums: Record<string, string> };
  for (const [file, expected] of Object.entries(manifest.checksums)) {
    const real = await fs.realpath(path.join(root, file));
    expect(real.startsWith(`${root}/`), file).toBe(true);
    const actual = crypto
      .createHash('sha256')
      .update(await fs.readFile(real))
      .digest('hex');
    expect(actual, file).toBe(expected);
  }
}

describe('overlay tarball creation', () => {
  let repoDir: string;
  /** `KICI_TMPDIR` for each test, so every `kici-overlay-*` dir lands here and goes with it. */
  let overlayTmpBase: string;

  beforeEach(async () => {
    overlayTmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-uploader-tmpbase-'));
    vi.stubEnv('KICI_TMPDIR', overlayTmpBase);
    repoDir = await createTempGitRepo();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(repoDir, { recursive: true, force: true });
    await fs.rm(overlayTmpBase, { recursive: true, force: true });
    for (const dir of extractDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });

  describe('createOverlayTarball', () => {
    it('detects modified files (unstaged changes)', async () => {
      await fs.writeFile(path.join(repoDir, 'initial.txt'), 'modified content\n');

      const { summary, manifest } = await createOverlayTarball(repoDir);

      expect(summary.modifiedFiles).toBe(1);
      expect(summary.newFiles).toBe(0);
      expect(summary.fileCount).toBe(1);
      expect(summary.sha).toMatch(/^[a-f0-9]{40}$/);
      expect(manifest.checksums['initial.txt']).toBeDefined();
    });

    it('detects staged changes', async () => {
      await fs.writeFile(path.join(repoDir, 'initial.txt'), 'staged content\n');
      execSync('git add initial.txt', { cwd: repoDir, stdio: 'ignore' });

      const { summary } = await createOverlayTarball(repoDir);

      expect(summary.modifiedFiles).toBe(1);
      expect(summary.fileCount).toBe(1);
    });

    it('includes untracked non-ignored files', async () => {
      await fs.writeFile(path.join(repoDir, 'new-file.txt'), 'new content\n');

      const { summary, manifest } = await createOverlayTarball(repoDir);

      expect(summary.newFiles).toBe(1);
      expect(summary.fileCount).toBe(1);
      expect(manifest.checksums['new-file.txt']).toBeDefined();
    });

    it('excludes .gitignored files', async () => {
      await fs.writeFile(path.join(repoDir, '.gitignore'), 'ignored.txt\n');
      await fs.writeFile(path.join(repoDir, 'ignored.txt'), 'should be ignored\n');
      await fs.writeFile(path.join(repoDir, 'not-ignored.txt'), 'should be included\n');
      execSync('git add .gitignore', { cwd: repoDir, stdio: 'ignore' });

      const { summary, manifest } = await createOverlayTarball(repoDir);

      expect(manifest.checksums['ignored.txt']).toBeUndefined();
      expect(summary.fileCount).toBe(2); // .gitignore + not-ignored.txt
    });

    it('creates valid tar.gz', async () => {
      await fs.writeFile(path.join(repoDir, 'new-file.txt'), 'new content\n');
      await fs.writeFile(path.join(repoDir, 'initial.txt'), 'modified\n');

      const { tarballPath } = await createOverlayTarball(repoDir);

      const files = await listTarFiles(tarballPath);
      expect(files).toContain('new-file.txt');
      expect(files).toContain('initial.txt');
      expect(files.some((f) => f.includes('manifest.json'))).toBe(true);
    });

    it('ships no .git without the git option', async () => {
      const { tarballPath, manifest, git } = await createOverlayTarball(repoDir, {
        fullWorkingTree: true,
      });
      // fails-when: the developer's raw .git ships again
      expect((await listTarFiles(tarballPath)).filter((f) => f.startsWith('.git'))).toEqual([]);
      expect(manifest.git).toBeUndefined();
      expect(git).toBeUndefined();
    });

    it('ships the built .git with checksums and the git record', async () => {
      const { tarballPath, manifest, git, summary } = await createOverlayTarball(repoDir, {
        fullWorkingTree: true,
        git: { depth: 1, tags: GitTagMode.Default },
      });

      const files = await listTarFiles(tarballPath);
      // Paths keep the `.git/` prefix so extraction restores the repo in place.
      expect(files).toContain('.git/HEAD');
      expect(files).toContain('.git/config');
      expect(files).toContain('.git/index');
      expect(manifest.checksums['.git/HEAD']).toMatch(/^[a-f0-9]{64}$/);
      expect(manifest.git).toEqual({ fetchDepth: 1, allTags: false });
      expect(summary.sha).toBe(git?.workspaceSha);
      expect(summary.fileCount).toBe(1 + (git?.files.length ?? 0)); // initial.txt + .git/**
      // fails-when: the developer's config (its user.email) ships instead of the generated one
      const root = await extractTarball(tarballPath);
      expect(await fs.readFile(path.join(root, '.git', 'config'), 'utf-8')).not.toContain(
        'test@test.com',
      );
      // breaks-if-wrong: every shipped `.git` file still verifies as the agent checks it
      await expectAgentVerifies(tarballPath);
    });

    it('keeps the new/modified breakdown free of .git paths', async () => {
      const { summary } = await createOverlayTarball(repoDir, {
        fullWorkingTree: true,
        git: { depth: 1, tags: GitTagMode.Default },
      });
      expect(summary.modifiedFiles).toBe(1); // initial.txt only
      expect(summary.newFiles).toBe(0);
      expect(summary.fileCount).toBeGreaterThan(1); // includes .git/** files
    });

    it('warns and ships no .git when .kici is not at the repository top level', async () => {
      await writeIn(repoDir, 'sub/a.txt', 'a\n');
      commitAll(repoDir);
      const { manifest, warnings, git } = await createOverlayTarball(path.join(repoDir, 'sub'), {
        fullWorkingTree: true,
        git: { depth: 1, tags: GitTagMode.Default },
      });
      expect(git).toBeUndefined();
      expect(manifest.git).toBeUndefined();
      expect(warnings.some((w) => w.includes('not at the repository top level'))).toBe(true);
    });

    it('keeps only the shipped repository beside the tarball once the tarball holds it', async () => {
      await fs.writeFile(path.join(repoDir, 'initial.txt'), 'dirty\n');
      const { tarballPath, git, tempDir } = await createOverlayTarball(repoDir, {
        fullWorkingTree: true,
        git: { depth: 0, tags: GitTagMode.Default, commit: true },
      });
      extractDirs.push(tempDir.path);
      expect(tempDir.path).toBe(path.dirname(tarballPath));
      expect(git?.synthetic).toBe(true);
      expect(git?.files.length).toBeGreaterThan(0);
      // fails-when: the build scratch (the synthetic commit's objects, the checkout bytes) outlives the tarball
      expect((await fs.readdir(path.dirname(tarballPath))).sort()).toEqual([
        'overlay.tar.gz',
        'ship',
      ]);
      // breaks-if-wrong: the caller diffs the synthetic commit against these objects
      expect(git?.root).toBe(path.join(path.dirname(tarballPath), 'ship'));
      expect(
        execSync(`git cat-file -t ${git?.workspaceSha}`, { cwd: git?.root, encoding: 'utf8' }),
      ).toBe('commit\n');
      expect((await listTarFiles(tarballPath)).some((f) => f === '.git/HEAD')).toBe(true);
      // fails-when: the returned handle does not own the dir, so the caller's cleanup leaves it
      await tempDir.cleanup();
      await expect(fs.access(tempDir.path)).rejects.toThrow();
    });

    it('removes the overlay temp dir when the .git build fails', async () => {
      const kiciTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-uploader-tmpbase-'));
      extractDirs.push(kiciTmp);
      // A blob-less partial clone whose history holds a blob its checkout never fetched.
      execSync('git config uploadpack.allowFilter true', { cwd: repoDir, stdio: 'ignore' });
      await fs.writeFile(path.join(repoDir, 'initial.txt'), 'rewritten\n');
      commitAll(repoDir);
      const partialDir = path.join(kiciTmp, 'partial');
      execSync(`git clone -q --filter=blob:none file://${repoDir} ${partialDir}`, {
        stdio: 'ignore',
      });
      const overlayBase = path.join(kiciTmp, 'base');
      vi.stubEnv('KICI_TMPDIR', overlayBase);
      try {
        await expect(
          createOverlayTarball(partialDir, {
            fullWorkingTree: true,
            git: { depth: 0, tags: GitTagMode.Default },
          }),
        ).rejects.toThrow('is a partial clone');
      } finally {
        vi.unstubAllEnvs();
      }
      // fails-when: a failed build leaves the overlay dir (and its .git copy) behind
      expect(await fs.readdir(overlayBase)).toEqual([]);
    });

    it('warns when a shallow local repository holds less history than requested', async () => {
      await fs.writeFile(path.join(repoDir, 'initial.txt'), 'second\n');
      commitAll(repoDir);
      const shallowDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-uploader-shallow-'));
      extractDirs.push(shallowDir);
      execSync(`git clone -q --depth 1 file://${repoDir} ${shallowDir}/repo`, { stdio: 'ignore' });
      const { warnings, manifest } = await createOverlayTarball(`${shallowDir}/repo`, {
        fullWorkingTree: true,
        git: { depth: 0, tags: GitTagMode.Default },
      });
      // fails-when: the shallow-source warning never reaches the CLI's warning list
      expect(warnings.filter((w) => w.includes('git fetch --unshallow'))).toHaveLength(1);
      expect(manifest.git).toEqual({ fetchDepth: 1, allTags: true });
    });

    it('refuses a repository with no commit with the actionable error', async () => {
      const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-uploader-unborn-'));
      extractDirs.push(emptyDir);
      execSync('git init -q', { cwd: emptyDir, stdio: 'ignore' });
      await fs.writeFile(path.join(emptyDir, 'a.txt'), 'a\n');
      // fails-when: git's raw "ambiguous argument 'HEAD'" error surfaces instead
      await expect(
        createOverlayTarball(emptyDir, {
          fullWorkingTree: true,
          git: { depth: 1, tags: GitTagMode.Default },
        }),
      ).rejects.toThrow(`kici run remote needs at least one commit in ${emptyDir}`);
    });

    it('does not grow with unreachable objects or reflogs in the source', async () => {
      const gitOpt = { depth: 1, tags: GitTagMode.Default };
      const base = await createOverlayTarball(repoDir, { fullWorkingTree: true, git: gitOpt });
      for (let i = 0; i < 10; i++) {
        execSync('git hash-object -w --stdin', {
          cwd: repoDir,
          input: crypto.randomBytes(1024 * 1024),
          stdio: ['pipe', 'ignore', 'ignore'],
        });
      }
      for (let i = 0; i < 50; i++) {
        execSync(`git update-ref -m e2e-${i} HEAD HEAD`, { cwd: repoDir, stdio: 'ignore' });
      }
      const after = await createOverlayTarball(repoDir, { fullWorkingTree: true, git: gitOpt });
      // fails-when: the raw .git (or any unreachable object or reflog) ships again — checksums gain .git/objects/xx/* and size grows by ~10 MB
      expect(after.manifest.checksums).toEqual(base.manifest.checksums);
      expect(Math.abs(after.summary.compressedSize - base.summary.compressedSize)).toBeLessThan(
        1024,
      );
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
      await fs.writeFile(path.join(repoDir, 'to-delete.txt'), 'will be deleted\n');
      execSync('git add to-delete.txt', { cwd: repoDir, stdio: 'ignore' });
      execSync('git commit -m "add file to delete"', { cwd: repoDir, stdio: 'ignore' });

      await fs.unlink(path.join(repoDir, 'to-delete.txt'));

      const { summary, manifest } = await createOverlayTarball(repoDir);

      expect(summary.deletedFiles).toBe(1);
      expect(manifest.deletions).toContain('to-delete.txt');
      expect(manifest.checksums['to-delete.txt']).toBeUndefined();
    });

    it('respects .kiciignore patterns', async () => {
      await fs.writeFile(path.join(repoDir, '.kiciignore'), '*.log\nbuild/**\n');

      await fs.writeFile(path.join(repoDir, 'app.log'), 'log content\n');
      await fs.writeFile(path.join(repoDir, 'source.ts'), 'source content\n');
      await fs.mkdir(path.join(repoDir, 'build'), { recursive: true });
      await fs.writeFile(path.join(repoDir, 'build', 'output.js'), 'built content\n');

      const { manifest } = await createOverlayTarball(repoDir);

      expect(manifest.checksums['app.log']).toBeUndefined();
      expect(manifest.checksums['build/output.js']).toBeUndefined();
      expect(manifest.checksums['source.ts']).toBeDefined();
    });

    it('handles repos without a remote (full tarball mode)', async () => {
      const noRemoteDir = await createTempGitRepo({ withRemote: false });
      try {
        await fs.writeFile(path.join(noRemoteDir, 'file2.txt'), 'file2\n');
        execSync('git add file2.txt', { cwd: noRemoteDir, stdio: 'ignore' });
        execSync('git commit -m "add file2"', { cwd: noRemoteDir, stdio: 'ignore' });

        const { summary } = await createOverlayTarball(noRemoteDir);

        expect(summary.fileCount).toBe(2); // initial.txt + file2.txt
      } finally {
        await fs.rm(noRemoteDir, { recursive: true, force: true });
      }
    });

    it('handles repos with a remote (overlay mode)', async () => {
      // A remote and no changes: an empty overlay.
      const { summary } = await createOverlayTarball(repoDir);

      expect(summary.fileCount).toBe(0);
      expect(summary.modifiedFiles).toBe(0);
      expect(summary.newFiles).toBe(0);
    });

    it('deduplicates files across staged, unstaged, and untracked', async () => {
      // Staged, then modified again: listed by both diffs.
      await fs.writeFile(path.join(repoDir, 'initial.txt'), 'staged change\n');
      execSync('git add initial.txt', { cwd: repoDir, stdio: 'ignore' });
      await fs.writeFile(path.join(repoDir, 'initial.txt'), 'unstaged change on top\n');

      const { summary, manifest } = await createOverlayTarball(repoDir);

      expect(summary.fileCount).toBe(1);
      expect(Object.keys(manifest.checksums)).toHaveLength(1);
    });

    it('refuses an overlay above 500 MB with actionable advice', () => {
      // fails-when: the message names a flag that does not exist, or the limit stops being enforced
      expect(() => assertOverlayWithinLimit(600 * 1024 * 1024)).toThrow(/\.kiciignore/);
      expect(() => assertOverlayWithinLimit(600 * 1024 * 1024)).toThrow(/--git-depth/);
      expect(() => assertOverlayWithinLimit(600 * 1024 * 1024)).not.toThrow(/dangerously/);
      // breaks-if-wrong: a 499 MB overlay still uploads
      expect(() => assertOverlayWithinLimit(499 * 1024 * 1024)).not.toThrow();
    });

    it('never writes into the working tree', async () => {
      await fs.writeFile(path.join(repoDir, 'change.txt'), 'test\n');
      const before = await fs.readdir(repoDir);

      // fails-when: the manifest is staged inside repoRoot (mkdir → EACCES on a
      // read-only root), which is what strands `.kici-overlay-tmp` when the CLI dies
      await fs.chmod(repoDir, 0o555);
      try {
        const { tarballPath, manifest } = await createOverlayTarball(repoDir);
        expect(await fs.readdir(repoDir)).toEqual(before);
        expect(await readTarManifest(tarballPath)).toEqual(manifest);
      } finally {
        await fs.chmod(repoDir, 0o755);
      }
    });

    it('ships the fresh manifest and never a stale .kici-overlay-tmp copy', async () => {
      // A copy left behind by a CLI killed mid-pack, committed and then modified.
      await writeIn(repoDir, '.kici-overlay-tmp/manifest.json', '{"sha":"stale"}\n');
      await writeIn(repoDir, '.kici-overlay-tmp/extra.txt', 'stale\n');
      commitAll(repoDir);
      await writeIn(repoDir, '.kici-overlay-tmp/manifest.json', '{"sha":"staler"}\n');
      await writeIn(repoDir, '.kici-overlay-tmp/untracked.txt', 'stale\n');
      await fs.writeFile(path.join(repoDir, 'initial.txt'), 'changed\n');

      for (const fullWorkingTree of [false, true]) {
        // fails-when: the reserved directory is selected, so its manifest.json
        // ships twice under one path and its checksum names the stale bytes
        const { tarballPath, manifest } = await createOverlayTarball(repoDir, { fullWorkingTree });
        const paths = await listTarFiles(tarballPath);
        expect(paths.filter((p) => p.startsWith('.kici-overlay-tmp'))).toEqual([
          '.kici-overlay-tmp/manifest.json',
        ]);
        expect(
          Object.keys(manifest.checksums).filter((p) => p.startsWith('.kici-overlay-tmp')),
        ).toEqual([]);
        expect(manifest.deletions).toEqual([]);
        expect(await readTarManifest(tarballPath)).toEqual(manifest);
        // breaks-if-wrong: the ordinary change still ships and verifies
        await expectAgentVerifies(tarballPath);
        expect(manifest.checksums['initial.txt']).toBe(sha256Of('changed\n'));
      }
    });

    it('ships a manifest-only tarball when the overlay is only deletions', async () => {
      await fs.unlink(path.join(repoDir, 'initial.txt'));

      const { tarballPath, manifest } = await createOverlayTarball(repoDir);

      expect(await listTarFiles(tarballPath)).toEqual(['.kici-overlay-tmp/manifest.json']);
      expect(manifest.deletions).toEqual(['initial.txt']);
      expect(await readTarManifest(tarballPath)).toEqual(manifest);
    });

    it('produces a tarball the agent verifies, symlinks and hard links included', async () => {
      await writeIn(repoDir, 'src/a.ts', 'export const a = 1;\n');
      await writeIn(repoDir, 'docs/real.md', 'real\n');
      await fs.symlink('../docs/real.md', path.join(repoDir, 'src/link.md'));
      await fs.link(path.join(repoDir, 'src/a.ts'), path.join(repoDir, 'src/a-twin.ts'));

      const { tarballPath, manifest } = await createOverlayTarball(repoDir, {
        fullWorkingTree: true,
      });

      expect(manifest.checksums['src/link.md']).toBe(sha256Of('real\n'));
      expect(manifest.checksums['src/a-twin.ts']).toBe(sha256Of('export const a = 1;\n'));
      // breaks-if-wrong: every repository entry still ships beside the manifest
      await expectAgentVerifies(tarballPath);
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
      // The orchestrator never clones for a relayed run, so a committed, clean
      // file MUST appear in the full-working-tree selection.
      await fs.writeFile(path.join(repoDir, 'clean.txt'), 'committed clean\n');
      execSync('git add clean.txt', { cwd: repoDir, stdio: 'ignore' });
      execSync('git commit -m "add clean file"', { cwd: repoDir, stdio: 'ignore' });
      await fs.writeFile(path.join(repoDir, 'untracked.txt'), 'new content\n');

      const dirtyOnly = await selectOverlayFiles(repoDir);
      const fullTree = await selectOverlayFiles(repoDir, { fullWorkingTree: true });

      expect(fullTree.hasRemote).toBe(true);
      expect(dirtyOnly.existingFiles).not.toContain('clean.txt');
      expect(fullTree.existingFiles).toContain('clean.txt');
      expect(fullTree.existingFiles).toContain('initial.txt');
      expect(fullTree.existingFiles).toContain('untracked.txt');
      expect(fullTree.existingFiles.length).toBeGreaterThan(dirtyOnly.existingFiles.length);
    });

    it('omits the .git directory with or without fullWorkingTree', async () => {
      await fs.writeFile(path.join(repoDir, 'dirty.txt'), 'dirty\n');
      for (const fullWorkingTree of [false, true]) {
        // fails-when: the selection walks the developer's .git again
        const selection = await selectOverlayFiles(repoDir, { fullWorkingTree });
        expect(selection.existingFiles).toContain('dirty.txt');
        expect(selection.existingFiles.some((f) => f.startsWith('.git/'))).toBe(false);
      }
    });

    it.skipIf(process.platform === 'win32')(
      'selects a name with spaces, ü and a newline verbatim',
      async () => {
        const name = 'dir with space/ü\nname.txt';
        await writeIn(repoDir, name, 'odd\n');
        await writeIn(repoDir, 'tracked ü.txt', 'tracked\n');
        commitAll(repoDir);
        await fs.writeFile(path.join(repoDir, 'tracked ü.txt'), 'changed\n');
        await writeIn(repoDir, 'untracked ü\n.txt', 'new\n');
        for (const fullWorkingTree of [false, true]) {
          const selection = await selectOverlayFiles(repoDir, { fullWorkingTree });
          // fails-when: git C-quotes the name ("\303\274\n…"), so it reads as a deletion
          expect(selection.existingFiles).toEqual(
            expect.arrayContaining(['tracked ü.txt', 'untracked ü\n.txt']),
          );
          expect(selection.deletedFiles).toEqual([]);
        }
        const full = await selectOverlayFiles(repoDir, { fullWorkingTree: true });
        expect(full.existingFiles).toContain(name);
      },
    );

    it("fails with git's message when a listing fails", async () => {
      // A corrupt index: HEAD still resolves, but every index read fails.
      const badIndex = path.join(repoDir, '.git', 'corrupt-index');
      await fs.writeFile(badIndex, 'garbage\n');
      vi.stubEnv('GIT_INDEX_FILE', badIndex);
      try {
        for (const fullWorkingTree of [false, true]) {
          // fails-when: the failed listing returns [], so the selection silently ships nothing
          await expect(selectOverlayFiles(repoDir, { fullWorkingTree })).rejects.toThrow(
            /failed in .*: fatal: .*corrupt-index: index file smaller than expected/,
          );
        }
      } finally {
        vi.unstubAllEnvs();
      }
      // breaks-if-wrong: a healthy repository still lists
      expect((await selectOverlayFiles(repoDir, { fullWorkingTree: true })).existingFiles).toEqual([
        'initial.txt',
      ]);
    });

    it('lists both paths of a staged rename, the old one as deleted', async () => {
      execSync('git mv initial.txt renamed.txt', { cwd: repoDir, stdio: 'ignore' });
      const selection = await selectOverlayFiles(repoDir);
      // fails-when: rename detection lists only the new path, so the old file stays in the clone
      expect(selection.existingFiles).toEqual(['renamed.txt']);
      expect(selection.deletedFiles).toEqual(['initial.txt']);
    });

    it('returns all tracked + untracked when the repo has no remote', async () => {
      const noRemoteDir = await createTempGitRepo({ withRemote: false });
      try {
        await fs.writeFile(path.join(noRemoteDir, 'file2.txt'), 'file2\n');

        const selection = await selectOverlayFiles(noRemoteDir);

        expect(selection.hasRemote).toBe(false);
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

    function write(rel: string, content: string): Promise<void> {
      return writeIn(repoDir, rel, content);
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

    it.each([
      ['overlay mode', false, ['inside.txt', 'kept.txt']],
      ['full working tree', true, ['initial.txt', 'inside.txt', 'kept.txt']],
    ])(
      'skips a link to a file outside the repository with a warning (%s)',
      async (_mode, fullWorkingTree, expectedShipped) => {
        const outside = await tempDir('kici-uploader-outside-');
        await fs.writeFile(path.join(outside, 'host.txt'), 'host\n');
        await write('inside.txt', 'in\n');
        await fs.symlink('inside.txt', path.join(repoDir, 'abs.txt'));
        await fs.symlink('inside.txt', path.join(repoDir, 'rel.txt'));
        await fs.symlink('inside.txt', path.join(repoDir, 'kept.txt'));
        commitAll(repoDir);
        await relink(repoDir, 'abs.txt', path.join(outside, 'host.txt'));
        await relink(repoDir, 'rel.txt', path.relative(repoDir, path.join(outside, 'host.txt')));
        // Changed, so overlay mode ships it too.
        await relink(repoDir, 'kept.txt', './inside.txt');

        const { tarballPath, manifest, warnings } = await createOverlayTarball(repoDir, {
          fullWorkingTree,
        });

        const shipped = contentEntries(await listTarEntries(tarballPath));
        // fails-when: the link ships with no target and the agent fails the run with "file not found"
        expect(shipped).not.toContain('abs.txt');
        expect(shipped).not.toContain('rel.txt');
        expect(manifest.checksums).not.toHaveProperty('abs.txt');
        expect(manifest.checksums).not.toHaveProperty('rel.txt');
        // breaks-if-wrong: an in-repository link to a shipped file still ships with its target
        // fails-when: an extra file ships, such as a skipped link or its outside target
        expect(shipped).toEqual(expectedShipped);
        expect(manifest.checksums['kept.txt']).toBe(sha256Of('in\n'));
        expect(manifest.deletions).toEqual([]);
        expect(warnings).toEqual([
          'Not uploading these symbolic links, whose target is outside the repository, an absolute path, ' +
            'or excluded by .gitignore or .kiciignore: abs.txt, rel.txt. The remote workspace does not contain them.',
        ]);
        await expectAgentVerifies(tarballPath);
      },
    );

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

      const { tarballPath, manifest, warnings } = await createOverlayTarball(repoDir);

      // fails-when: a tracked link carries an ignored file (here a secret) into the upload,
      // or ships without it and the agent fails the run with "file not found"
      expect(contentEntries(await listTarEntries(tarballPath))).toEqual([]);
      expect(manifest.checksums).toEqual({});
      expect(warnings).toEqual([
        'Not uploading these symbolic links, whose target is outside the repository, an absolute path, ' +
          'or excluded by .gitignore or .kiciignore: active.env, notes.txt. The remote workspace does not contain them.',
      ]);
      await expectAgentVerifies(tarballPath);
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

    it.each([
      ['absolute', true],
      ['relative ..', false],
    ])(
      'skips a directory symlink to a target outside the repository with a warning (%s text)',
      async (_kind, absolute) => {
        const outside = await tempDir('kici-uploader-outside-');
        await writeIn(outside, 'pkg/index.js', 'module.exports = 1;\n');
        await write('keep.txt', 'keep\n');
        await write('shared/a.txt', 'a\n');
        await fs.symlink('shared', path.join(repoDir, 'lib'));
        commitAll(repoDir);
        const text = absolute ? outside : path.relative(repoDir, outside);
        // Untracked, as a symlinked node_modules that `node_modules/` does not ignore.
        await fs.symlink(text, path.join(repoDir, 'node_modules'));

        const { tarballPath, manifest, warnings } = await createOverlayTarball(repoDir, {
          fullWorkingTree: true,
        });

        const entries = await listTarEntries(tarballPath);
        // fails-when: the link ships, dangles on the agent, and a write through it fails (ENOTDIR)
        expect(entries.has('node_modules')).toBe(false);
        expect(manifest.symlinks).toEqual({ lib: 'shared' });
        expect(Object.keys(manifest.checksums).some((f) => f.startsWith('node_modules'))).toBe(
          false,
        );
        // breaks-if-wrong: an in-repository directory link still ships as a link
        expect(entries.get('lib')).toBe(TarEntryType.SymbolicLink);
        expect(warnings).toEqual([
          'Not uploading these symbolic links, whose target is outside the repository, an absolute path, ' +
            'or excluded by .gitignore or .kiciignore: node_modules. The remote workspace does not contain them.',
        ]);
        await expectAgentVerifies(tarballPath);
      },
    );

    it('skips a directory symlink that leaves the repository through another link', async () => {
      const outside = await tempDir('kici-uploader-outside-');
      await write('keep.txt', 'keep\n');
      await fs.symlink(outside, path.join(repoDir, 'store'));
      // `deps` reads inside as written, but resolves through `store` to the host.
      await fs.symlink('store', path.join(repoDir, 'deps'));

      const { manifest, warnings } = await createOverlayTarball(repoDir, {
        fullWorkingTree: true,
      });

      // fails-when: only the link's own text is checked, so `deps -> store -> /outside` ships
      expect(manifest).not.toHaveProperty('symlinks');
      expect(warnings).toEqual([
        'Not uploading these symbolic links, whose target is outside the repository, an absolute path, ' +
          'or excluded by .gitignore or .kiciignore: deps, store. The remote workspace does not contain them.',
      ]);
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

    it('packs a committed pnpm node_modules tree with hard-linked files', async () => {
      // pnpm hard-links identical files, both to each other and to its store
      // outside the repository, and links each package in by a relative
      // directory symlink into `.pnpm`.
      const store = await tempDir('kici-uploader-store-');
      const pkgDir = 'node_modules/.pnpm/pkg@1.0.0/node_modules/pkg';
      await write(`${pkgDir}/shared.d.ts`, 'export {};\n');
      const names: string[] = [];
      for (let i = 0; i < 12; i++) {
        const own = `${pkgDir}/f${String(i).padStart(2, '0')}a.js`;
        const twin = `${pkgDir}/f${String(i).padStart(2, '0')}b.d.ts`;
        await write(own, `module ${i}\n`);
        await fs.link(path.join(repoDir, `${pkgDir}/shared.d.ts`), path.join(repoDir, twin));
        names.push(own, twin);
      }
      await fs.writeFile(path.join(store, 'stored.js'), 'stored\n');
      await fs.link(path.join(store, 'stored.js'), path.join(repoDir, `${pkgDir}/stored.js`));
      await fs.symlink('.pnpm/pkg@1.0.0/node_modules/pkg', path.join(repoDir, 'node_modules/pkg'));
      await fs.symlink(
        path.relative(path.join(repoDir, pkgDir), path.join(store, 'stored.js')),
        path.join(repoDir, `${pkgDir}/outside.js`),
      );
      await fs.symlink('loop', path.join(repoDir, 'node_modules/loop'));
      commitAll(repoDir);

      // fails-when: node-tar parks the hard-linked files and its job table fills
      // with entries that are never piped, so this promise never settles
      const { tarballPath, manifest, warnings } = await createOverlayTarball(repoDir, {
        fullWorkingTree: true,
      });

      const entries = await listTarEntries(tarballPath);
      // breaks-if-wrong: each hard-linked path must still ship as its own content
      for (const name of [...names, `${pkgDir}/shared.d.ts`, `${pkgDir}/stored.js`]) {
        expect(entries.get(name), name).toBe(TarEntryType.File);
      }
      expect(manifest.checksums[`${pkgDir}/f05b.d.ts`]).toBe(sha256Of('export {};\n'));
      expect(manifest.checksums[`${pkgDir}/stored.js`]).toBe(sha256Of('stored\n'));
      expect(manifest.symlinks).toEqual({ 'node_modules/pkg': '.pnpm/pkg@1.0.0/node_modules/pkg' });
      expect(entries.has(`${pkgDir}/outside.js`)).toBe(false);
      expect(warnings).toEqual([
        'Not uploading these symbolic links, whose target does not exist: node_modules/loop. ' +
          'The remote workspace does not contain them.',
        'Not uploading these symbolic links, whose target is outside the repository, an absolute path, ' +
          `or excluded by .gitignore or .kiciignore: ${pkgDir}/outside.js. The remote workspace does not contain them.`,
      ]);

      const root = await extract(tarballPath);
      expect(await fs.readFile(path.join(root, `${pkgDir}/f11b.d.ts`), 'utf-8')).toBe(
        'export {};\n',
      );
    }, 30_000);
  });

  describe('overlay temp dir ownership', () => {
    const exists = (p: string) =>
      fs.access(p).then(
        () => true,
        () => false,
      );

    it('packs each tarball into its own fresh kici-overlay dir that holds nothing else', async () => {
      const first = await createOverlayTarball(repoDir);
      const second = await createOverlayTarball(repoDir);
      const dirs = [path.dirname(first.tarballPath), path.dirname(second.tarballPath)];
      for (const dir of dirs) expect(path.dirname(dir)).toBe(overlayTmpBase);
      try {
        // fails-when: two runs share a dir, or the dir is a shared base (tmpdir, the repo)
        expect(dirs[0]).not.toBe(dirs[1]);
        for (const dir of dirs) {
          expect(path.basename(dir)).toMatch(/^kici-overlay-/);
          expect(await fs.readdir(dir)).toEqual(['overlay.tar.gz']);
        }
      } finally {
        for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('the returned tempDir handle removes the dir that holds the tarball', async () => {
      const { tarballPath, tempDir } = await createOverlayTarball(repoDir);

      // fails-when: the handle points anywhere but the tarball's own dir
      expect(tempDir.path).toBe(path.dirname(tarballPath));
      await tempDir.cleanup();

      expect(await exists(path.dirname(tarballPath))).toBe(false);
      // breaks-if-wrong: the repo the overlay was packed from is untouched
      expect(await exists(path.join(repoDir, 'initial.txt'))).toBe(true);
    });

    describe('gcStaleOverlayDirs', () => {
      async function agedDir(name: string, ageMs: number): Promise<string> {
        const dir = path.join(overlayTmpBase, name);
        await fs.mkdir(dir);
        await fs.writeFile(path.join(dir, 'overlay.tar.gz'), 'tarball');
        const when = new Date(Date.now() - ageMs);
        await fs.utimes(dir, when, when);
        return dir;
      }
      const stale = OVERLAY_TMP_GC_MAX_AGE_MS + 60 * 60 * 1000;

      it('removes an overlay dir older than a day from the KICI_TMPDIR base', async () => {
        const old = await agedDir('kici-overlay-Ab12Cd', stale);

        // fails-when: the GC scans another root, or never removes an overlay dir
        expect(await gcStaleOverlayDirs()).toEqual([old]);
        expect(await exists(old)).toBe(false);
      });

      it('keeps a fresh overlay dir, which a concurrent kici run may still be uploading', async () => {
        // breaks-if-wrong: a kici run in another terminal must keep its live tarball
        const fresh = await agedDir('kici-overlay-Ef34Gh', 60 * 60 * 1000);

        expect(await gcStaleOverlayDirs()).toEqual([]);
        expect(await exists(fresh)).toBe(true);
      });

      it('removes an aged dir that createOverlayTarball really made', async () => {
        const { tarballPath } = await createOverlayTarball(repoDir);
        const dir = path.dirname(tarballPath);
        expect(path.dirname(dir)).toBe(overlayTmpBase);
        const when = new Date(Date.now() - stale);
        await fs.utimes(dir, when, when);

        // fails-when: the GC pattern drifts from makeTempDir's overlay dir name (never reaped).
        expect(await gcStaleOverlayDirs()).toEqual([dir]);
        expect(await exists(dir)).toBe(false);
      });

      it('keeps every other dir of the same age', async () => {
        const others = [
          await agedDir('kici-local-run-Ij56Kl', stale),
          await agedDir('kici-overlay-tmp', stale),
          await agedDir('kici-overlay-Mn78Op-keep', stale),
          await agedDir('kici-pnpm-store-Qr90St', stale),
          await agedDir('overlay-Uv12Wx', stale),
        ];

        // fails-when: the pattern matches more than kici-overlay-<six chars>
        expect(await gcStaleOverlayDirs()).toEqual([]);
        for (const dir of others) expect(await exists(dir)).toBe(true);
      });
    });

    it('removes its temp dir when the tarball exceeds the size limit', async () => {
      const realStat = fs.stat;
      let tarballDir: string | undefined;
      const spy = vi.spyOn(fs, 'stat').mockImplementation(async (p, ...rest) => {
        const stats = await realStat(p, ...(rest as []));
        if (String(p).endsWith('overlay.tar.gz')) {
          tarballDir = path.dirname(String(p));
          return Object.assign(stats, { size: 600 * 1024 * 1024 });
        }
        return stats;
      });
      try {
        await expect(createOverlayTarball(repoDir)).rejects.toThrow(/above the 500MB limit/);
      } finally {
        spy.mockRestore();
      }

      expect(tarballDir).toMatch(/kici-overlay-/);
      // fails-when: the size check throws after packing and leaves the oversized tarball behind
      expect(await exists(tarballDir!)).toBe(false);
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
      // The guard must reject before fetch('') throws an opaque "Failed to parse URL from ".
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
