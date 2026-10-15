/**
 * The source tree a same-repo workflow's `filter` is evaluated against.
 *
 * Kept out of `job-runner.test.ts`, which globally mocks
 * `../checkout/git-clone.js` and `node:fs/promises`: these tests need a real
 * tree to land on disk where the filter looks.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JobDispatch } from '@kici-dev/engine';
import { ensureFilterSourceDir, buildInitFilterInput } from './job-runner.js';

const dirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A real one-commit git repo, so a `file://` clone materializes a real tree. */
async function makeSourceRepo(): Promise<{ path: string; sha: string }> {
  const repo = await tempDir('kici-filter-src-');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf-8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'Dockerfile'), 'FROM scratch\n');
  mkdirSync(join(repo, '.kici'), { recursive: true });
  writeFileSync(join(repo, '.kici', 'marker'), 'x\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return { path: repo, sha: git('rev-parse', 'HEAD').trim() };
}

/** A workDir in the shape a cached-tarball restore leaves: `.kici/` and nothing else. */
async function makeTarballWorkDir(): Promise<string> {
  const workDir = await tempDir('kici-filter-work-');
  mkdirSync(join(workDir, '.kici'), { recursive: true });
  return workDir;
}

function dispatchStub(over: Record<string, unknown>): JobDispatch {
  return {
    runId: 'run-1',
    jobId: 'job-1',
    jobName: 'build',
    jobConfig: {},
    repoUrl: '',
    ref: '',
    sha: '',
    ...over,
  } as unknown as JobDispatch;
}

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('ensureFilterSourceDir', () => {
  it('reuses workDir when no source tarball was attached', async () => {
    // The job already cloned into workDir. The repoUrl is unreachable, so an
    // unconditional clone would fail instead of returning.
    const workDir = await tempDir('kici-filter-work-');
    const resolved = await ensureFilterSourceDir(
      dispatchStub({ repoUrl: 'file:///nonexistent-must-not-be-cloned' }),
      workDir,
    );
    expect(resolved).toBe(workDir);
  });

  it('clones the source repo into a sibling dir when only .kici/ was restored', async () => {
    const repo = await makeSourceRepo();
    const workDir = await makeTarballWorkDir();
    // Positive control: the file a filter reads is genuinely absent from workDir.
    expect(existsSync(join(workDir, 'Dockerfile'))).toBe(false);

    const resolved = await ensureFilterSourceDir(
      dispatchStub({ sourceTarUrl: 'https://cache/src.tgz', repoUrl: `file://${repo.path}` }),
      workDir,
    );

    expect(resolved).not.toBe(workDir);
    expect(existsSync(join(resolved, 'Dockerfile'))).toBe(true);
  });

  it('throws rather than handing the filter a directory with no repo in it', async () => {
    // A source-cache hit with no repo url: workDir holds `.kici/` alone, so
    // returning it would make every filter path test a confident wrong "absent".
    const workDir = await makeTarballWorkDir();
    await expect(
      ensureFilterSourceDir(
        dispatchStub({ sourceTarUrl: 'https://cache/src.tgz', repoUrl: '' }),
        workDir,
      ),
    ).rejects.toThrow(/no repo url to clone from/);
  });
});

describe('buildInitFilterInput', () => {
  it('addresses the source tree with the repo pair, the diff, and the shell', async () => {
    const repo = await makeSourceRepo();
    const workDir = await makeTarballWorkDir();

    const input = await buildInitFilterInput(
      dispatchStub({
        sourceTarUrl: 'https://cache/src.tgz',
        repoUrl: `file://${repo.path}`,
        ref: 'main',
        sha: repo.sha,
      }),
      { type: 'push', changedFiles: ['a.ts'], changedFilesStatus: 'fetched' },
      workDir,
      () => {},
    );

    expect(input.sourceRepo).toEqual(input.workflowRepo);
    // …but two objects, so a filter mutating `sourceRepo` cannot change `workflowRepo`.
    expect(input.sourceRepo).not.toBe(input.workflowRepo);
    expect(input.sourceRepo.ref).toBe('main');
    expect(input.sourceRepo.sha).toBe(repo.sha);
    // The path is the clone, not the `.kici`-only workDir.
    expect(existsSync(join(input.sourceRepo.path, 'Dockerfile'))).toBe(true);
    // The orchestrator's already-fetched diff is the fast path.
    expect(input.changedFilesStatus).toBe('fetched');
    expect(input.changedFiles).toEqual(['a.ts']);
    // The shell a filter shells out through is rooted at that same tree.
    const shell = input.$;
    expect(shell).toBeDefined();
    expect((await shell!`pwd`).stdout.trim()).toBe(input.sourceRepo.path);
  });

  it('reports an unavailable diff rather than an empty one for a diff-less event', async () => {
    const repo = await makeSourceRepo();
    const workDir = await makeTarballWorkDir();

    const input = await buildInitFilterInput(
      dispatchStub({
        sourceTarUrl: 'https://cache/src.tgz',
        repoUrl: `file://${repo.path}`,
        ref: 'main',
      }),
      // No fast-path list, and a schedule event has nothing git can diff.
      { type: 'schedule' },
      workDir,
      () => {},
    );

    // `unavailable` makes `ctx.changedFiles` throw instead of reading as empty,
    // so a path filter cannot silently suppress the workflow.
    expect(input.changedFilesStatus).toBe('unavailable');
    expect(input.changedFiles).toEqual([]);
  });

  it('routes the filter shell output through the caller-supplied sink', async () => {
    const repo = await makeSourceRepo();
    const workDir = await makeTarballWorkDir();
    const seen: string[] = [];

    const input = await buildInitFilterInput(
      dispatchStub({ sourceTarUrl: 'https://cache/src.tgz', repoUrl: `file://${repo.path}` }),
      { type: 'push', changedFiles: [], changedFilesStatus: 'fetched' },
      workDir,
      (line) => seen.push(line),
    );

    await input.$!`echo hello-from-filter`;
    expect(seen.join('\n')).toContain('hello-from-filter');
  });
});
