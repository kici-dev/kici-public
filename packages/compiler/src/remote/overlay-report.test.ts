import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOverlayTarball } from './uploader.js';
import { buildOverlayReport } from './overlay-report.js';
import { GitTagMode } from './shipped-git/git-ship-types.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kici-overlay-report-'));
  cleanup.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

/** A 1-commit shallow clone of a 3-commit repository: the local history is the limit. */
function shallowOneCommitRepo(): string {
  const src = tempDir();
  git(src, ['init', '-q', '-b', 'main']);
  for (let i = 1; i <= 3; i++) {
    writeFileSync(path.join(src, `f${i}.txt`), `${i}\n`);
    git(src, ['add', '-A']);
    git(src, ['commit', '-qm', `c${i}`]);
  }
  const clone = path.join(tempDir(), 'clone');
  git(os.tmpdir(), ['clone', '-q', '--depth', '1', pathToFileURL(src).href, clone]);
  return clone;
}

describe('buildOverlayReport', () => {
  it('reports the requested depth and what a shallow local repository shipped', async () => {
    const repo = shallowOneCommitRepo();
    const requirement = { depth: 0, tags: GitTagMode.Default, reasons: ['--git-depth 0'] };
    const overlay = await createOverlayTarball(repo, {
      fullWorkingTree: true,
      git: { depth: 0, tags: GitTagMode.Default, commit: true, syntheticTags: [] },
    });
    cleanup.push(path.dirname(overlay.tarballPath));

    const report = buildOverlayReport(overlay.summary, requirement, overlay.git);

    expect(report.git?.depth).toBe(0);
    expect(report.git?.tags).toBe(GitTagMode.Default);
    // fails-when: the report copies the requested depth (0) into what shipped, hiding
    // that the shallow local repository held a single commit
    expect(report.git?.shipped.fetchDepth).toBe(1);
    // fails-when: depth 0 with default tags reads as "default tags" although every tag shipped
    expect(report.git?.shipped.allTags).toBe(true);
    expect(report.compressedSize).toBe(overlay.summary.compressedSize);
  });

  it('omits git when no .git shipped', () => {
    const requirement = { depth: 1, tags: GitTagMode.Default, reasons: [] };
    expect(
      buildOverlayReport({ compressedSize: 10, fileCount: 2 }, requirement, undefined),
    ).toEqual({ compressedSize: 10, fileCount: 2 });
  });
});
