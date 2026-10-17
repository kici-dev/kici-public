/**
 * Static resolution of the in-repo sibling closure `.kici` depends on (the
 * workspace packages it reaches by an in-repo protocol, or by version range as
 * an npm or yarn workspace member), and a digest over its source.
 *
 * The deps tarball carries those siblings **with their built output**
 * (`packKiciDeps`), but its pointer is keyed on `lockfileHash`, which a sibling
 * source edit does not move: a warm-cache run would restore the sibling's STALE
 * build over the fresh clone. `siblingsDigest` enters the pointer key, so a
 * sibling edit is a pointer miss and the deps rebuild.
 *
 * Resolution is **static** (manifests and `git ls-files`, never `node_modules`),
 * unlike the agent's own `collectInRepoSiblings`: a lock file that differs
 * before and after an install is not hermetic.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sha256 } from '@kici-dev/core';
import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';

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

function allSpecifiers(m: Manifest): Array<[string, string]> {
  return Object.entries({
    ...m.dependencies,
    ...m.devDependencies,
    ...m.optionalDependencies,
    ...m.peerDependencies,
  });
}

/**
 * `pnpm-workspace.yaml`'s `packages:` first, then `package.json#workspaces`
 * (npm / yarn / bun). Empty when no workspace is declared, so a `workspace:`
 * specifier is skipped rather than guessed at.
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

/** A workspace glob or member path as globs are matched: POSIX, no `./`, no trailing `/`. */
function normalizeWorkspacePath(p: string): string {
  return p.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * Whether `memberDir` (repo-relative) is a member of the workspace declared at
 * `gitRoot`: a positive workspace glob matches it and no `!` glob excludes it.
 * Wildcards do not match a leading dot (`dot: false`), so a `*` glob never
 * counts as registering `.kici`. An explicit entry next to a dot-matching glob
 * is harmless, so reading "not a member" in that case only adds an entry.
 */
export function isWorkspaceMember(gitRoot: string, memberDir = '.kici'): boolean {
  const member = normalizeWorkspacePath(memberDir);
  let included = false;
  for (const raw of readWorkspaceGlobs(gitRoot)) {
    const negated = raw.startsWith('!');
    const glob = normalizeWorkspacePath(negated ? raw.slice(1) : raw);
    if (!picomatch.isMatch(member, glob, { dot: false })) continue;
    if (negated) return false;
    included = true;
  }
  return included;
}

/**
 * Package name → directory for every tracked `package.json` outside
 * `node_modules`; empty when no workspace glob is declared. The globs gate the
 * lookup but are not matched against each directory. `git ls-files` is the
 * digest's own authority and needs no install.
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
 * A repo-relative directory, or null. `file:` / `link:` / `portal:` carry the
 * path; `workspace:` carries a version range, so the package NAME resolves
 * through the workspace packages.
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
    // A target outside the repo is no sibling and `git ls-files` cannot digest
    // it: skip it rather than let it contribute nothing under its name.
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel;
  }
  return null;
}

/**
 * The transitive in-repo siblings of `.kici`, as sorted repo-relative POSIX
 * paths. A sibling is reached through a `workspace:` / `file:` / `link:` /
 * `portal:` specifier, or, when `.kici` is a member of an npm or yarn
 * workspace, through a plain version range naming a workspace package (those
 * managers link it by name). `.kici` itself is excluded: `contentHash` covers it, and including it
 * would make a `.kici` edit invalidate the dep cache.
 */
export function collectInRepoSiblings(gitRoot: string, kiciDir = '.kici'): string[] {
  const kiciManifest = readManifest(path.join(gitRoot, kiciDir));
  if (!kiciManifest) return [];

  const workspacePkgs = workspacePackageDirs(gitRoot, readWorkspaceGlobs(gitRoot));
  // npm and yarn (classic and berry) link a workspace package into a member by
  // name when its version satisfies the declared range; pnpm links only a
  // `workspace:` specifier and resolves a plain range from the registry.
  const linksByName =
    isWorkspaceMember(gitRoot, kiciDir) && !existsSync(path.join(gitRoot, 'pnpm-workspace.yaml'));
  const found = new Set<string>();
  const queue: Array<{ dir: string; manifest: Manifest }> = [
    { dir: kiciDir, manifest: kiciManifest },
  ];
  const visited = new Set<string>([kiciDir]);

  while (queue.length > 0) {
    const { dir, manifest } = queue.shift()!;
    for (const [name, spec] of allSpecifiers(manifest)) {
      const inRepoProtocol = IN_REPO_PROTOCOLS.some((p) => spec.startsWith(p));
      const target = inRepoProtocol
        ? resolveSpecifier(name, spec, dir, gitRoot, workspacePkgs)
        : linksByName && !spec.startsWith('npm:')
          ? (workspacePkgs.get(name) ?? null)
          : null;
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
 * SHA-256 over the git-tracked source of every sibling, or null when there is
 * none. Content is read as text and `\0`-delimited against its path, as the
 * `.kici/` tree digest is, so a rename cannot pass as a content edit.
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
        // Unreadable or deleted-but-tracked: its path alone still moves the digest.
      }
      parts.push(`${rel}\0${content.replaceAll('\r\n', '\n')}\0`);
    }
  }
  return parts.length > 0 ? sha256(parts.join('')) : null;
}
