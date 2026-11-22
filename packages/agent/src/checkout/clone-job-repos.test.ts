import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('./git-clone.js', () => ({ gitClone: vi.fn() }));

import { gitClone } from './git-clone.js';
import {
  cloneJobRepos,
  type CloneJobReposDirs,
  type CloneJobReposRequest,
} from './clone-job-repos.js';

let root: string;
let dirs: CloneJobReposDirs;
let logs: string[];

const request = (overrides: Partial<CloneJobReposRequest> = {}): CloneJobReposRequest => ({
  repoUrl: 'https://example.com/org/source.git',
  ref: 'main',
  sha: 'abc123',
  ...overrides,
});

const deps = (isGlobal = false) => ({
  isGlobal,
  log: (line: string) => logs.push(line),
  excludeScratchFromGit: vi.fn(async () => {}),
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kici-cjr-'));
  const workDir = join(root, 'work');
  dirs = { workDir, workflowDir: workDir, sourceDir: workDir };
  logs = [];
  vi.mocked(gitClone).mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('cloneJobRepos checkout options', () => {
  it('passes fetchDepth and fetchTags to the single-repo clone', async () => {
    await cloneJobRepos(
      request({ checkoutOptions: { fetchDepth: 0, fetchTags: true } }),
      dirs,
      deps(),
    );
    // fails-when: the clone ignores the job's checkout options and stays at depth 1
    expect(gitClone).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gitClone).mock.calls[0][0]).toMatchObject({
      repoUrl: 'https://example.com/org/source.git',
      workDir: dirs.workDir,
      depth: 0,
      fetchTags: true,
    });
  });

  it('clones at depth 1 with git default tags when the job sets no options', async () => {
    await cloneJobRepos(request(), dirs, deps());
    // breaks-if-wrong: a job without options keeps today's shallow clone
    const options = vi.mocked(gitClone).mock.calls[0][0];
    expect(options.depth).toBe(1);
    expect(options.fetchTags).toBeUndefined();
  });

  it('applies the options to the source clone only for a global workflow', async () => {
    const global = {
      workDir: join(root, 'work'),
      workflowDir: join(root, 'work', 'workflow'),
      sourceDir: join(root, 'work', 'source'),
    };
    await cloneJobRepos(
      request({
        workflowRepoUrl: 'https://example.com/org/workflows.git',
        workflowRef: 'main',
        workflowSha: 'def456',
        checkoutOptions: { fetchDepth: 20, fetchTags: true },
      }),
      global,
      deps(true),
    );
    const calls = vi.mocked(gitClone).mock.calls.map((c) => c[0]);
    const workflowCall = calls.find((c) => c.workDir === global.workflowDir)!;
    const sourceCall = calls.find((c) => c.workDir === global.sourceDir)!;
    // fails-when: the workflow repo clone also takes the source job's depth and tags
    expect(workflowCall).not.toHaveProperty('depth');
    expect(workflowCall).not.toHaveProperty('fetchTags');
    expect(sourceCall).toMatchObject({ depth: 20, fetchTags: true });
  });
});

describe('cloneJobRepos checkout: false', () => {
  it('checkout: false with a cached source clones nothing and creates the work dir', async () => {
    await cloneJobRepos(request({ checkout: false, sourceCached: true }), dirs, deps());
    // fails-when: checkout: false still runs gitClone (the bug this branch fixes)
    expect(gitClone).not.toHaveBeenCalled();
    expect(existsSync(dirs.workDir)).toBe(true);
    expect(logs).toContain(
      'checkout: false — skipping the clone; .kici/ restores from the cached workflow source',
    );
  });

  it('checkout: false with .kici/ already in the work dir clones nothing', async () => {
    // The in-place and host-checkout paths: the tree is already there.
    await mkdir(join(dirs.workDir, '.kici'), { recursive: true });
    await cloneJobRepos(request({ checkout: false }), dirs, deps());
    expect(gitClone).not.toHaveBeenCalled();
  });

  it('checkout: false with no cached source fetches only .kici/', async () => {
    vi.mocked(gitClone).mockImplementation(async (options) => {
      await mkdir(join(options.workDir, '.kici', 'workflows'), { recursive: true });
      await mkdir(join(options.workDir, '.git'), { recursive: true });
      await writeFile(join(options.workDir, '.kici', 'workflows', 'x.ts'), 'export {}');
      await writeFile(join(options.workDir, 'README.md'), '# repo');
    });
    await cloneJobRepos(request({ checkout: false }), dirs, deps());
    // breaks-if-wrong: an orchestrator without the source cache can still load the workflow
    expect(gitClone).toHaveBeenCalledTimes(1);
    const options = vi.mocked(gitClone).mock.calls[0][0];
    expect(options).toMatchObject({
      repoUrl: 'https://example.com/org/source.git',
      ref: 'main',
      sha: 'abc123',
      depth: 1,
    });
    expect(options.workDir).not.toBe(dirs.workDir);
    expect(readdirSync(dirs.workDir)).toEqual(['.kici']);
    expect(existsSync(join(dirs.workDir, '.kici', 'workflows', 'x.ts'))).toBe(true);
    expect(existsSync(join(dirs.workDir, '.git'))).toBe(false);
    // The temporary clone is removed.
    expect(existsSync(options.workDir)).toBe(false);
    expect(logs).toContain(
      'checkout: false — this orchestrator caches no workflow source, so only .kici/ was fetched',
    );
  });

  it('checkout: false for a global workflow fetches .kici/ from the workflow repo', async () => {
    const global = {
      workDir: join(root, 'work'),
      workflowDir: join(root, 'work', 'workflow'),
      sourceDir: join(root, 'work', 'source'),
    };
    vi.mocked(gitClone).mockImplementation(async (options) => {
      await mkdir(join(options.workDir, '.kici'), { recursive: true });
      await writeFile(join(options.workDir, '.kici', 'package.json'), '{}');
    });
    await cloneJobRepos(
      request({
        checkout: false,
        workflowRepoUrl: 'https://example.com/org/workflows.git',
        workflowRef: 'wf-main',
        workflowSha: 'def456',
      }),
      global,
      deps(true),
    );
    expect(vi.mocked(gitClone).mock.calls[0][0]).toMatchObject({
      repoUrl: 'https://example.com/org/workflows.git',
      ref: 'wf-main',
      sha: 'def456',
    });
    expect(existsSync(join(global.workflowDir, '.kici', 'package.json'))).toBe(true);
  });

  it('checkout: false in full-repo mode creates the work dir and clones nothing', async () => {
    await cloneJobRepos(request({ checkout: false, fullRepo: true }), dirs, deps());
    expect(gitClone).not.toHaveBeenCalled();
    expect(existsSync(dirs.workDir)).toBe(true);
  });
});
