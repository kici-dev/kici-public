import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectInRepoSiblings,
  computeSiblingsDigest,
  readWorkspaceGlobs,
} from './workspace-siblings.js';

let root: string;

function write(rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

/** Track everything, so `git ls-files` can see it. */
function commitAll(): void {
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-siblings-'));
  git('init', '-q');
  write('pnpm-workspace.yaml', 'packages:\n  - ".kici"\n  - "libs/*"\n');
  write('package.json', '{"name":"root","private":true}');
  write(
    '.kici/package.json',
    '{"name":"kici-workflows","dependencies":{"@acme/lib":"workspace:*"}}',
  );
  write(
    'libs/lib/package.json',
    '{"name":"@acme/lib","dependencies":{"@acme/deep":"workspace:*"}}',
  );
  write('libs/lib/src/index.ts', 'export const x = 1;\n');
  write('libs/deep/package.json', '{"name":"@acme/deep"}');
  write('libs/deep/src/index.ts', 'export const y = 1;\n');
  commitAll();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('readWorkspaceGlobs', () => {
  it('reads pnpm-workspace.yaml packages', () => {
    expect(readWorkspaceGlobs(root)).toEqual(['.kici', 'libs/*']);
  });

  it('falls back to package.json#workspaces', () => {
    fs.rmSync(path.join(root, 'pnpm-workspace.yaml'));
    write('package.json', '{"name":"root","workspaces":["libs/*"]}');
    expect(readWorkspaceGlobs(root)).toEqual(['libs/*']);
  });

  it('returns nothing when the repo declares no workspace', () => {
    fs.rmSync(path.join(root, 'pnpm-workspace.yaml'));
    write('package.json', '{"name":"root"}');
    expect(readWorkspaceGlobs(root)).toEqual([]);
  });
});

describe('collectInRepoSiblings', () => {
  it('resolves a workspace: dependency transitively, excluding .kici itself', () => {
    // `.kici`'s own source is already covered by `contentHash`; including it
    // here would make a `.kici` edit invalidate the dep cache for no reason.
    expect(collectInRepoSiblings(root)).toEqual(['libs/deep', 'libs/lib']);
  });

  it('resolves a file: specifier by path', () => {
    write('.kici/package.json', '{"name":"k","dependencies":{"@acme/lib":"file:../libs/lib"}}');
    commitAll();
    expect(collectInRepoSiblings(root)).toContain('libs/lib');
  });

  it('ignores a registry dependency', () => {
    write('.kici/package.json', '{"name":"k","dependencies":{"zod":"^3.0.0"}}');
    commitAll();
    expect(collectInRepoSiblings(root)).toEqual([]);
  });

  it('ignores a file: target outside the repo', () => {
    write('.kici/package.json', '{"name":"k","dependencies":{"x":"file:../../elsewhere"}}');
    commitAll();
    expect(collectInRepoSiblings(root)).toEqual([]);
  });

  it('terminates on a dependency cycle between siblings', () => {
    write(
      'libs/deep/package.json',
      '{"name":"@acme/deep","dependencies":{"@acme/lib":"workspace:*"}}',
    );
    commitAll();
    expect(collectInRepoSiblings(root)).toEqual(['libs/deep', 'libs/lib']);
  });

  it('returns nothing when .kici has no manifest', () => {
    fs.rmSync(path.join(root, '.kici/package.json'));
    expect(collectInRepoSiblings(root)).toEqual([]);
  });
});

describe('computeSiblingsDigest', () => {
  it('moves when a sibling source file changes', () => {
    // The defect: the dep pointer was keyed on `lockfileHash` alone, and editing
    // a sibling moves no package-manager lock file — so a warm dep cache
    // restored the sibling's STALE built output over the fresh clone.
    const before = computeSiblingsDigest(root);
    write('libs/lib/src/index.ts', 'export const x = 2;\n');
    commitAll();
    expect(computeSiblingsDigest(root)).not.toBe(before);
  });

  it('moves when a TRANSITIVE sibling changes', () => {
    const before = computeSiblingsDigest(root);
    write('libs/deep/src/index.ts', 'export const y = 2;\n');
    commitAll();
    expect(computeSiblingsDigest(root)).not.toBe(before);
  });

  it('is stable across a no-op recompile', () => {
    expect(computeSiblingsDigest(root)).toBe(computeSiblingsDigest(root));
  });

  it('ignores an untracked file, so an uncommitted scratch file is not an input', () => {
    const before = computeSiblingsDigest(root);
    write('libs/lib/scratch.txt', 'notes\n');
    expect(computeSiblingsDigest(root)).toBe(before);
  });

  it('ignores a change outside the sibling closure', () => {
    const before = computeSiblingsDigest(root);
    write('unrelated/thing.ts', 'export const z = 1;\n');
    commitAll();
    expect(computeSiblingsDigest(root)).toBe(before);
  });

  it('is null when .kici depends on no in-repo sibling', () => {
    // The common case: most locks carry no siblingsDigest, so their dep pointer
    // keys exactly as before and existing entries stay live.
    write('.kici/package.json', '{"name":"k","dependencies":{"zod":"^3.0.0"}}');
    commitAll();
    expect(computeSiblingsDigest(root)).toBeNull();
  });

  it('does not need an install to answer', () => {
    // Walking an installed node_modules would make `kici compile` emit a
    // different lock before and after an install — a non-hermetic lock file.
    expect(fs.existsSync(path.join(root, 'node_modules'))).toBe(false);
    expect(computeSiblingsDigest(root)).toBeTruthy();
  });
});
