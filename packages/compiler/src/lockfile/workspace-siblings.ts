/**
 * Static resolution of the in-repo `workspace:` sibling closure `.kici` depends
 * on, and a digest over its source.
 *
 * The deps tarball carries those sibling package directories **with their built
 * output** (`packKiciDeps`), while the pointer that names it is keyed on
 * `lockfileHash` — a hash of the package-manager lock file. Editing a sibling's
 * source moves no package-manager lock file, so a repo whose `.kici` depends on
 * an in-repo `workspace:` package restored that sibling's STALE build over the
 * fresh clone on every warm-cache run. `siblingsDigest` closes that: it enters
 * the dep pointer key, so a sibling edit is a pointer miss and the deps are
 * rebuilt.
 *
 * Resolution is **static** — manifests and `git ls-files`, never an installed
 * `node_modules`. The agent's own `collectInRepoSiblings` walks an installed
 * tree, which cannot be used here: `kici compile` would then emit a different
 * lock file before and after an install, and a lock file whose contents depend
 * on whether you have installed is not hermetic.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sha256 } from '@kici-dev/core';
import { parse as parseYaml } from 'yaml';

/** Dependency protocols that name a directory inside this repository. */
const IN_REPO_PROTOCOLS = ['workspace:', 'file:', 'link:', 'portal:'];

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

function readManifest(dir: string): Manifest | null {
  const file = path.join(dir, 'package.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as Manifest;
  } catch {
    return null;
  }
}

/** Every dependency specifier in a manifest, across all four dependency maps. */
function allSpecifiers(m: Manifest): Array<[string, string]> {
  return Object.entries({
    ...m.dependencies,
    ...m.devDependencies,
    ...m.optionalDependencies,
    ...m.peerDependencies,
  });
}

/**
 * The workspace globs declared at the repo root — `pnpm-workspace.yaml`'s
 * `packages:` first, then `package.json#workspaces` (npm / yarn / bun). Empty
 * when the repo declares no workspace, in which case a `workspace:` specifier
 * resolves to nothing and is skipped rather than guessed at.
 */
export function readWorkspaceGlobs(gitRoot: string): string[] {
  const pnpmFile = path.join(gitRoot, 'pnpm-workspace.yaml');
  if (existsSync(pnpmFile)) {
    try {
      const doc = parseYaml(readFileSync(pnpmFile, 'utf-8')) as { packages?: unknown };
      if (Array.isArray(doc?.packages)) return doc.packages.filter((p) => typeof p === 'string');
    } catch {
      // Fall through to the manifest form.
    }
  }
  const root = readManifest(gitRoot);
  const ws = root?.workspaces;
  if (Array.isArray(ws)) return ws;
  if (ws && Array.isArray(ws.packages)) return ws.packages;
  return [];
}

/**
 * Directories the workspace globs match, each carrying a manifest. Resolved with
 * `git ls-files` so the set is exactly what is tracked — the same authority the
 * digest itself uses, and one that needs no install.
 */
function workspacePackageDirs(gitRoot: string, globs: string[]): Map<string, string> {
  const byName = new Map<string, string>();
  if (globs.length === 0) return byName;
  let manifests: string[];
  try {
    manifests = execFileSync('git', ['ls-files', '--', '*package.json', 'package.json'], {
      cwd: gitRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return byName;
  }
  for (const rel of manifests) {
    const dir = path.dirname(rel);
    if (dir.split('/').includes('node_modules')) continue;
    const m = readManifest(path.join(gitRoot, dir));
    if (m?.name) byName.set(m.name, dir);
  }
  return byName;
}

/**
 * Resolve one specifier to a repo-relative directory, or null when it does not
 * name one. `file:` / `link:` / `portal:` carry the path; `workspace:` carries a
 * version range, so the package NAME is resolved through the workspace globs.
 */
function resolveSpecifier(
  pkgName: string,
  spec: string,
  fromDir: string,
  gitRoot: string,
  workspacePkgs: Map<string, string>,
): string | null {
  if (spec.startsWith('workspace:')) {
    return workspacePkgs.get(pkgName) ?? null;
  }
  for (const proto of ['file:', 'link:', 'portal:']) {
    if (!spec.startsWith(proto)) continue;
    const target = spec.slice(proto.length);
    const abs = path.resolve(gitRoot, fromDir, target);
    const rel = path.relative(gitRoot, abs).replaceAll('\\', '/');
    // A `file:` target outside the repo is not an in-repo sibling; it is also
    // not something `git ls-files` can digest, so it is skipped rather than
    // silently contributing nothing under a name that suggests it did.
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel;
  }
  return null;
}

/**
 * Every in-repo sibling directory `.kici` depends on, transitively, as sorted
 * repo-relative POSIX paths.
 *
 * `.kici` itself is excluded: its own source is already covered by
 * `contentHash`, and including it here would make a `.kici` edit invalidate the
 * dep cache for no reason.
 */
export function collectInRepoSiblings(gitRoot: string, kiciDir = '.kici'): string[] {
  const kiciManifest = readManifest(path.join(gitRoot, kiciDir));
  if (!kiciManifest) return [];

  const workspacePkgs = workspacePackageDirs(gitRoot, readWorkspaceGlobs(gitRoot));
  const found = new Set<string>();
  const queue: Array<{ dir: string; manifest: Manifest }> = [
    { dir: kiciDir, manifest: kiciManifest },
  ];
  const visited = new Set<string>([kiciDir]);

  while (queue.length > 0) {
    const { dir, manifest } = queue.shift()!;
    for (const [name, spec] of allSpecifiers(manifest)) {
      if (!IN_REPO_PROTOCOLS.some((p) => spec.startsWith(p))) continue;
      const target = resolveSpecifier(name, spec, dir, gitRoot, workspacePkgs);
      if (target === null || visited.has(target)) continue;
      visited.add(target);
      found.add(target);
      const m = readManifest(path.join(gitRoot, target));
      if (m) queue.push({ dir: target, manifest: m });
    }
  }
  return [...found].sort();
}

/**
 * SHA-256 over the git-tracked source of every resolved sibling directory, or
 * null when `.kici` depends on none.
 *
 * `git ls-files` is install-independent and is already the compiler's world (it
 * resolves `gitRoot` to generate the lock at all). Content is read as text and
 * `\0`-delimited against its path, exactly as the `.kici/` tree digest is, so a
 * rename cannot be disguised as a content edit.
 */
export function computeSiblingsDigest(gitRoot: string, kiciDir = '.kici'): string | null {
  const siblings = collectInRepoSiblings(gitRoot, kiciDir);
  if (siblings.length === 0) return null;

  const parts: string[] = [];
  for (const dir of siblings) {
    let files: string[];
    try {
      files = execFileSync('git', ['ls-files', '--', dir], {
        cwd: gitRoot,
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
      })
        .split('\n')
        .filter(Boolean)
        .sort();
    } catch {
      continue;
    }
    for (const rel of files) {
      let content = '';
      try {
        content = readFileSync(path.join(gitRoot, rel), 'utf-8');
      } catch {
        // Unreadable or deleted-but-tracked: contributes its path alone, which
        // still moves the digest when the file comes or goes.
      }
      parts.push(`${rel}\0${content.replaceAll('\r\n', '\n')}\0`);
    }
  }
  return parts.length > 0 ? sha256(parts.join('')) : null;
}
