import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  hashKiciSourceTree,
  findKiciDir,
  collectSourceSymlinks,
  findDigestReproducibilityWarnings,
  hashedSymlinkDriftNote,
  symlinkPackFault,
  KICI_DIGEST_DEFAULT_EXCLUSIONS,
  KICI_SOURCE_EXCLUDED_PREFIX,
  KICI_SOURCE_EXCLUDED_LOCK,
  KICI_SOURCE_EXCLUDED_TYPES_PREFIX,
} from './kici-source-digest.js';
import { findUncoveredRunRewrittenPaths } from './kici-ignore.js';

let root: string;
let kiciDir: string;

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(kiciDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-digest-'));
  kiciDir = path.join(root, '.kici');
  await write('workflows/deploy.ts', "import { run } from '../lib/deploy.js';\n");
  await write('lib/deploy.ts', 'export const run = () => 1;\n');
  await write('package.json', '{"name":"x"}\n');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('hashKiciSourceTree', () => {
  it('is stable across a no-op recompile', async () => {
    expect(await hashKiciSourceTree(kiciDir)).toBe(await hashKiciSourceTree(kiciDir));
  });

  it('moves when a NON-entry file changes', async () => {
    // The defect this closes: editing an imported helper left the entry-file
    // hash unchanged, so the source cache hit and the OLD helper ran green.
    const before = await hashKiciSourceTree(kiciDir);
    await write('lib/deploy.ts', 'export const run = () => 2;\n');
    expect(await hashKiciSourceTree(kiciDir)).not.toBe(before);
  });

  it('moves when a file is deleted', async () => {
    const before = await hashKiciSourceTree(kiciDir);
    await fs.rm(path.join(kiciDir, 'lib/deploy.ts'));
    expect(await hashKiciSourceTree(kiciDir)).not.toBe(before);
  });

  it('moves when a file is added', async () => {
    const before = await hashKiciSourceTree(kiciDir);
    await write('lib/extra.ts', 'export const x = 1;\n');
    expect(await hashKiciSourceTree(kiciDir)).not.toBe(before);
  });

  it('moves when a file is renamed, even with identical bytes', async () => {
    const before = await hashKiciSourceTree(kiciDir);
    await fs.rename(path.join(kiciDir, 'lib/deploy.ts'), path.join(kiciDir, 'lib/deploy2.ts'));
    expect(await hashKiciSourceTree(kiciDir)).not.toBe(before);
  });

  it('ignores .kici/node_modules, exactly as the tarball does', async () => {
    const before = await hashKiciSourceTree(kiciDir);
    await write('node_modules/dep/index.js', 'module.exports = 1;\n');
    expect(await hashKiciSourceTree(kiciDir)).toBe(before);
  });

  it('normalizes line endings so a CRLF checkout agrees with an LF one', async () => {
    const lf = await hashKiciSourceTree(kiciDir);
    await write('lib/deploy.ts', 'export const run = () => 1;\r\n');
    expect(await hashKiciSourceTree(kiciDir)).toBe(lf);
  });

  it('cannot disguise a rename as a content edit', async () => {
    // `a/bc` + `d` and `a/b` + `cd` must not concatenate to the same input.
    const a = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-digest-a-'));
    const b = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-digest-b-'));
    await fs.mkdir(path.join(a, '.kici'), { recursive: true });
    await fs.mkdir(path.join(b, '.kici'), { recursive: true });
    await fs.writeFile(path.join(a, '.kici', 'bc'), 'd');
    await fs.writeFile(path.join(b, '.kici', 'b'), 'cd');
    expect(await hashKiciSourceTree(path.join(a, '.kici'))).not.toBe(
      await hashKiciSourceTree(path.join(b, '.kici')),
    );
    await fs.rm(a, { recursive: true, force: true });
    await fs.rm(b, { recursive: true, force: true });
  });

  it('returns the empty string for a missing directory', async () => {
    expect(await hashKiciSourceTree(path.join(root, 'nope'))).toBe('');
  });

  it('names the exclusion as the tar member prefix', () => {
    // Byte-identical to the `filter` predicate in the agent's source-packer, so
    // the digest and the tarball cover the same set.
    expect(KICI_SOURCE_EXCLUDED_PREFIX).toBe('.kici/node_modules');
  });
});

describe('findKiciDir', () => {
  it('finds the .kici ancestor of a workflow file', () => {
    expect(findKiciDir(path.join(kiciDir, 'workflows/deploy.ts'))).toBe(kiciDir);
  });

  it('finds it from a deeply nested file', () => {
    expect(findKiciDir(path.join(kiciDir, 'a/b/c/d.ts'))).toBe(kiciDir);
  });

  it('returns null for a file outside any .kici directory', () => {
    expect(findKiciDir(path.join(root, 'kici.config.ts'))).toBeNull();
  });
});

describe('the compiler own output is excluded', () => {
  it('does not move when kici.lock.json changes', async () => {
    // Load-bearing, not a nicety: the compiler computes this digest, writes the
    // resulting contentHash INTO .kici/kici.lock.json, and the agent recomputes
    // it over the extracted tree. If the lock file were an input, the agent
    // would always see a tree the compiler never hashed and reject every run.
    await write('kici.lock.json', '{"schemaVersion":40,"contentHash":"aaa"}');
    const before = await hashKiciSourceTree(kiciDir);
    await write('kici.lock.json', '{"schemaVersion":40,"contentHash":"bbb"}');
    expect(await hashKiciSourceTree(kiciDir)).toBe(before);
  });

  it('does not move when the lock file appears or disappears', async () => {
    const withoutLock = await hashKiciSourceTree(kiciDir);
    await write('kici.lock.json', '{"schemaVersion":40}');
    expect(await hashKiciSourceTree(kiciDir)).toBe(withoutLock);
  });

  it('still covers a DIFFERENT json file at the same level', async () => {
    const before = await hashKiciSourceTree(kiciDir);
    await write('other.lock.json', '{"x":1}');
    expect(await hashKiciSourceTree(kiciDir)).not.toBe(before);
  });

  it('names the exclusion as the tar member path', () => {
    expect(KICI_SOURCE_EXCLUDED_LOCK).toBe('.kici/kici.lock.json');
  });

  it('does not move when the generated declarations appear or change', async () => {
    // `kici init` gitignores `.kici/types/`, so the declarations exist on the
    // machine that compiles and are absent from the clone the agent hashes. As
    // an input they made every stored contentHash unreachable: this repo's own
    // lock recorded the digest WITH `types/secrets.d.ts`, which no agent tree
    // can reproduce.
    const before = await hashKiciSourceTree(kiciDir);
    await write('types/secrets.d.ts', 'declare module "x" {}\n');
    expect(await hashKiciSourceTree(kiciDir)).toBe(before);
    await write('types/secrets.d.ts', 'declare module "y" {}\n');
    expect(await hashKiciSourceTree(kiciDir)).toBe(before);
  });

  it('names the declarations exclusion as the tar member prefix', () => {
    expect(KICI_SOURCE_EXCLUDED_TYPES_PREFIX).toBe('.kici/types/');
  });

  it('still covers a sibling directory whose name starts with "types"', async () => {
    // The prefix carries its trailing slash, so `.kici/types-of-thing/` is not
    // swallowed by the exclusion.
    const before = await hashKiciSourceTree(kiciDir);
    await write('types-of-thing/a.ts', 'export const a = 1;\n');
    expect(await hashKiciSourceTree(kiciDir)).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Symlink-aware classification.
//
// `Dirent.isDirectory()` reports on the link, so a symlinked
// `.kici/node_modules` used to read as a file, escape the directory-only
// `node_modules/` exclusion, and be hashed as `symlink:<target>` — a member the
// agent structurally cannot hold, because the tarball drops the path by prefix
// and the restore materialises a real directory. The producer and its verifier
// then disagreed about a tree nobody had edited, and every recompile reproduced
// the same lock.
// ---------------------------------------------------------------------------

/** Build one `.kici/` tree holding ordinary source plus every default exclusion. */
async function buildOrdinaryTree(repoRoot: string): Promise<string> {
  const dir = path.join(repoRoot, '.kici');
  await fs.mkdir(dir, { recursive: true });
  const put = async (rel: string, content: string): Promise<void> => {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  };
  await put('workflows/deploy.ts', "import { run } from '../lib/deploy.js';\n");
  await put('lib/deploy.ts', 'export const run = () => 1;\n');
  await put('package.json', '{"name":"x"}\n');
  await put('.npmrc', 'registry=https://example.test\n');
  await put('package-lock.json', '{"lockfileVersion":3}\n');
  await put('kici.lock.json', '{"schemaVersion":40,"contentHash":"aaa"}\n');
  await put('types/secrets.d.ts', 'declare module "s" {}\n');
  return dir;
}

/** The dependency tree as an ordinary repo has it, and as the agent restores it. */
async function addRealNodeModules(dir: string, at = 'node_modules'): Promise<void> {
  await fs.mkdir(path.join(dir, at, 'dep'), { recursive: true });
  await fs.writeFile(path.join(dir, at, 'dep', 'index.js'), 'module.exports = 1;\n');
  await fs.writeFile(path.join(dir, at, 'dep', 'package.json'), '{"name":"dep"}\n');
}

/** The same dependency tree, borrowed from a sibling through a link. */
async function addLinkedNodeModules(repoRoot: string, dir: string): Promise<void> {
  const shared = path.join(repoRoot, 'shared-node-modules');
  await fs.mkdir(path.join(shared, 'dep'), { recursive: true });
  await fs.writeFile(path.join(shared, 'dep', 'index.js'), 'module.exports = 1;\n');
  await fs.symlink('../shared-node-modules', path.join(dir, 'node_modules'));
}

/**
 * The digest of the golden fixture — an ordinary tree with a real
 * `node_modules` — RECORDED FROM THE IMPLEMENTATION THAT PREDATES symlink-aware
 * classification, and asserted by the one that follows it.
 *
 * If this constant ever has to move, every lock file in existence is stale and
 * the change is a `COMPILE_SCHEMA_VERSION` bump, not a maintenance edit.
 */
const ORDINARY_TREE_DIGEST = 'b8a007ebe22a1ac13c1771afe0a58c4a113f8199e21322a0143ec35a18bc5a1d';

describe('an ordinary tree hashes exactly as it always has', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-digest-golden-'));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('digests to the value recorded before symlink-aware classification', async () => {
    const dir = await buildOrdinaryTree(repoRoot);
    await addRealNodeModules(dir);
    expect(await hashKiciSourceTree(dir)).toBe(ORDINARY_TREE_DIGEST);
  });

  it('does NOT digest to that value once the fixture gains one file', async () => {
    // The golden constant is one-sided against a literal, so it is only worth
    // anything if an altered fixture fails it. Falsification runs through the
    // INPUT — never by reverting the walk, which would leave a concurrent build
    // hashing a tree missing the change under test.
    const dir = await buildOrdinaryTree(repoRoot);
    await addRealNodeModules(dir);
    await fs.writeFile(path.join(dir, 'lib', 'extra.ts'), 'export const x = 1;\n');
    expect(await hashKiciSourceTree(dir)).not.toBe(ORDINARY_TREE_DIGEST);
  });
});

describe('a symlinked node_modules hashes as the dependency tree it is', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-digest-link-'));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  /** Producer shape (symlink) and agent shape (real directory), side by side. */
  async function bothShapes(scaffold: boolean): Promise<{ linked: string; real: string }> {
    const linkedRoot = path.join(repoRoot, 'linked');
    const realRoot = path.join(repoRoot, 'real');
    const linked = await buildOrdinaryTree(linkedRoot);
    const real = await buildOrdinaryTree(realRoot);
    await addLinkedNodeModules(linkedRoot, linked);
    await addRealNodeModules(real);
    if (scaffold) {
      // What `kici init` leaves behind, which REPLACES the defaults — so a fix
      // that only edited the default set would not reach this cohort at all.
      const body = `${[...KICI_DIGEST_DEFAULT_EXCLUSIONS].join('\n')}\n`;
      await fs.writeFile(path.join(linked, '.kiciignore'), body);
      await fs.writeFile(path.join(real, '.kiciignore'), body);
    }
    return { linked, real };
  }

  it('agrees with the real-directory shape under the defaults', async () => {
    const { linked, real } = await bothShapes(false);
    // Equality across the two shapes, never a fixed hash: it is the
    // disagreement between producer and agent that was the bug.
    expect(await hashKiciSourceTree(linked)).toBe(await hashKiciSourceTree(real));
  });

  it('agrees with the real-directory shape under a scaffolded .kiciignore', async () => {
    const { linked, real } = await bothShapes(true);
    expect(await hashKiciSourceTree(linked)).toBe(await hashKiciSourceTree(real));
  });

  it('reaches the ordinary tree digest, so nothing else about the tree moved', async () => {
    const { linked } = await bothShapes(false);
    expect(await hashKiciSourceTree(linked)).toBe(ORDINARY_TREE_DIGEST);
  });

  it('excludes the link from the member set, so no symlink is left to hash', async () => {
    const { linked } = await bothShapes(false);
    expect(await collectSourceSymlinks(linked)).toEqual([]);
  });
});

describe('classification resolves a link; the walk never follows one', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-digest-matrix-'));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  async function tree(name: string): Promise<{ root: string; dir: string }> {
    const root = path.join(repoRoot, name);
    const dir = await buildOrdinaryTree(root);
    return { root, dir };
  }

  // Every constant below was recorded from the implementation that predates
  // symlink-aware classification. They pin the shapes the change must NOT
  // touch — and they are what reddens if anyone ever turns the classification
  // stat into a traversal, because a traversal replaces the link member with
  // the members behind it.
  it('leaves an unrelated symlinked directory a member, target string and all', async () => {
    const { root, dir } = await tree('T5');
    await addRealNodeModules(dir);
    await fs.mkdir(path.join(root, 'ext'), { recursive: true });
    await fs.writeFile(path.join(root, 'ext', 'a.ts'), 'export const a = 1;\n');
    await fs.symlink('../ext', path.join(dir, 'shared'));

    expect(await hashKiciSourceTree(dir)).toBe(
      '65fa2f9bf66fb59e2a5e05dc7459d9b20c6a79360ffae25a215b8feeab9d47da',
    );
    expect(await collectSourceSymlinks(dir)).toEqual([
      { member: '.kici/shared', target: '../ext' },
    ]);
  });

  it('moves when an uncovered symlink is repointed, since the target is the content', async () => {
    const { root, dir } = await tree('T5b');
    await fs.mkdir(path.join(root, 'ext'), { recursive: true });
    await fs.mkdir(path.join(root, 'ext2'), { recursive: true });
    await fs.symlink('../ext', path.join(dir, 'shared'));
    const before = await hashKiciSourceTree(dir);
    await fs.rm(path.join(dir, 'shared'));
    await fs.symlink('../ext2', path.join(dir, 'shared'));
    expect(await hashKiciSourceTree(dir)).not.toBe(before);
  });

  it('hashes a dangling symlink stably rather than throwing', async () => {
    const { dir } = await tree('T6');
    await addRealNodeModules(dir);
    await fs.symlink('./nowhere', path.join(dir, 'ghost'));
    expect(await hashKiciSourceTree(dir)).toBe(
      '25baa6e8073416fdacd9f04c063eafa0e520444013af6432463820f73b70d26b',
    );
  });

  it('terminates on a self-referential symlink and hashes it stably', async () => {
    // The kernel's own ELOOP surfaces as a failed stat, which classifies the
    // entry as a file — the same thing it contributes. A resolving walk that
    // recursed here produced 329 members from an eight-file tree.
    const { dir } = await tree('T7');
    await addRealNodeModules(dir);
    await fs.symlink('./loop', path.join(dir, 'loop'));
    expect(await hashKiciSourceTree(dir)).toBe(
      '4bbfd5d7100e566569e1cef243cb41ad574365bc68c6789ec723a25128ef218c',
    );
  });

  it('covers a nested symlinked node_modules, matching the real-directory shape', async () => {
    // The one shape whose hash the change moves. It reaches the value the same
    // tree has when the dependency directory is real — which is the value an
    // agent computes — so the move is toward reproducibility, not away.
    const linkedRoot = path.join(repoRoot, 'T4-linked');
    const realRoot = path.join(repoRoot, 'T4-real');
    const linked = await buildOrdinaryTree(linkedRoot);
    const real = await buildOrdinaryTree(realRoot);
    for (const [root, dir] of [
      [linkedRoot, linked],
      [realRoot, real],
    ] as const) {
      await addRealNodeModules(dir);
      await fs.mkdir(path.join(dir, 'pkg'), { recursive: true });
      await fs.writeFile(path.join(dir, 'pkg', 'index.ts'), 'export const p = 1;\n');
      await fs.mkdir(path.join(dir, 'sib'), { recursive: true });
      await fs.writeFile(path.join(dir, 'sib', 'a.js'), 'module.exports = 2;\n');
      void root;
    }
    await fs.symlink('../sib', path.join(linked, 'pkg', 'node_modules'));
    await addRealNodeModules(real, path.join('pkg', 'node_modules'));

    expect(await hashKiciSourceTree(linked)).toBe(await hashKiciSourceTree(real));
    expect(await hashKiciSourceTree(linked)).not.toBe(
      '54014e7e4a7ec84a882eab71a1a56a5afd8ad0b3a82a02c4f76abbf8ea0b1138',
    );
  });

  it('emits no run-rewritten warning for the default exclusion set', async () => {
    expect(findUncoveredRunRewrittenPaths([...KICI_DIGEST_DEFAULT_EXCLUSIONS])).toEqual([]);
  });
});

describe('symlinkPackFault', () => {
  // Measured against the packer's tarCreate options and the restore's
  // tarExtract options: an absolute target loses its leading slash, and a
  // target resolving above the archive root is dropped outright.
  it.each([
    ['.kici/x', '../sib', null],
    ['.kici/x', './y', null],
    ['.kici/x', 'y', null],
    ['.kici/pkg/nm', '../../sib', null],
    ['.kici/x', '../../sib', 'escapes'],
    ['.kici/x', '../../../sib', 'escapes'],
    ['.kici/pkg/nm', '../../../sib', 'escapes'],
    ['.kici/x', '/opt/kici', 'absolute'],
    ['.kici/x', 'C:\\opt', 'absolute'],
  ])('%s -> %s is %s', (member, target, expected) => {
    expect(symlinkPackFault(member, target)).toBe(expected);
  });
});

describe('findDigestReproducibilityWarnings', () => {
  let repoRoot: string;
  let dir: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-digest-warn-'));
    dir = await buildOrdinaryTree(repoRoot);
    await addRealNodeModules(dir);
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('says nothing about a clean tree', async () => {
    // A warning that always fires is decoration.
    expect(await findDigestReproducibilityWarnings(dir)).toEqual([]);
  });

  it('says nothing about a symlink whose target the tarball carries unchanged', async () => {
    await fs.mkdir(path.join(repoRoot, 'ext'), { recursive: true });
    await fs.symlink('../ext', path.join(dir, 'shared'));
    expect(await findDigestReproducibilityWarnings(dir)).toEqual([]);
  });

  it('names a symlink whose target escapes the tarball root', async () => {
    await fs.symlink('../../../elsewhere', path.join(dir, 'shared'));
    const warnings = await findDigestReproducibilityWarnings(dir);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('.kici/shared');
    expect(warnings[0]).toContain('resolves outside the source tarball');
  });

  it('names a symlink whose target is absolute', async () => {
    await fs.symlink('/opt/kici/shared', path.join(dir, 'shared'));
    const warnings = await findDigestReproducibilityWarnings(dir);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("strips the leading '/'");
  });

  it('names a node_modules the exclusion misses because it is not a directory', async () => {
    // The residual the classification fix cannot reach: a dangling link stats
    // as nothing, so it stays a file, escapes `node_modules/`, and is hashed —
    // while the tarball omits the path by prefix. Probing the PATTERNS reports
    // this tree as covered, which is why the check walks the tree.
    //
    // A real compile reaches this: dependencies hoisted to the repository root
    // with a stale `.kici/node_modules` link left behind still resolve, because
    // Node walks past the broken entry and keeps looking upward.
    await fs.rm(path.join(dir, 'node_modules'), { recursive: true, force: true });
    await fs.symlink('../vanished', path.join(dir, 'node_modules'));

    expect(findUncoveredRunRewrittenPaths([...KICI_DIGEST_DEFAULT_EXCLUSIONS])).toEqual([]);
    const warnings = await findDigestReproducibilityWarnings(dir);
    expect(warnings.some((w) => w.includes('.kici/node_modules'))).toBe(true);
  });

  it('leaves a run-rewritten path the pattern check already named to that check', async () => {
    // Both checks fire on the same fault otherwise, and the customer reads the
    // same problem twice.
    await fs.writeFile(path.join(dir, '.kiciignore'), 'types/\n');
    expect(await findDigestReproducibilityWarnings(dir)).toEqual([]);
  });
});

describe('hashedSymlinkDriftNote', () => {
  it('adds nothing when the hashed tree carries no symlink', () => {
    expect(hashedSymlinkDriftNote([])).toBe('');
  });

  it('names each link, because "run kici compile" cannot resolve this drift', () => {
    const note = hashedSymlinkDriftNote([{ member: '.kici/shared', target: '../../x' }]);
    expect(note).toContain('.kici/shared -> ../../x');
    expect(note).toContain('recompiling');
  });
});
