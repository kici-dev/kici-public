/**
 * In-repo workspace-sibling discovery for the agent's dependency handling.
 *
 * A pnpm or yarn-classic workspace lays out a `.kici/` member's `workspace:`
 * (pnpm) or version-range (yarn) siblings as symlinks pointing at package
 * directories that live inside the clone but outside `.kici/` and outside the
 * `node_modules` store. The dep-cache packer must travel those sibling dirs with
 * the closure (their symlinks would dangle otherwise), and the yarn install path
 * must build them (the install links a sibling but does not build it).
 *
 * `collectInRepoSiblings` walks a starting `node_modules` (and transitively each
 * discovered sibling's `node_modules`), returning each in-repo sibling directory
 * once, repo-root-relative, in breadth-first discovery order. The starting
 * `node_modules` is a parameter so it serves pnpm + yarn-standalone (seeded at
 * `.kici/node_modules`) and yarn-workspace-member (seeded at the hoisted root
 * `node_modules`).
 */

import { lstat, readdir, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/**
 * The directory yarn lays `.kici`'s dependencies into. A standalone `.kici`
 * (own lockfile, no parent workspace) gets `.kici/node_modules`; a workspace
 * member hoists everything to the repo-root `node_modules`, leaving no
 * `.kici/node_modules`.
 */
export function resolveYarnNodeModulesRoot(repoRoot: string, kiciDir: string): string {
  const kiciNm = join(kiciDir, 'node_modules');
  return existsSync(kiciNm) ? kiciNm : join(repoRoot, 'node_modules');
}

/**
 * Walk `seedNodeModules` (and transitively each in-repo sibling's
 * `node_modules`) collecting the repo-root-relative directories of workspace
 * siblings — package dirs that live inside the clone but outside `.kici/` and
 * outside the repo-root `node_modules/` store. Returns each dir once, in
 * discovery (BFS) order.
 */
export async function collectInRepoSiblings(
  workDir: string,
  kiciDir: string,
  seedNodeModules: string = join(kiciDir, 'node_modules'),
): Promise<string[]> {
  const repoRoot = resolve(workDir);
  const kiciResolved = resolve(kiciDir);
  const rootNodeModules = resolve(join(workDir, 'node_modules'));
  const found = new Set<string>();
  const visited = new Set<string>();
  const queue: string[] = [seedNodeModules];

  while (queue.length > 0) {
    const nmDir = queue.shift()!;
    const real = await realpath(nmDir).catch(() => null);
    if (!real || visited.has(real)) continue;
    visited.add(real);

    for (const target of await resolveNodeModulesLinks(nmDir)) {
      if (!isInside(repoRoot, target)) continue;
      if (isInside(kiciResolved, target) || isInside(rootNodeModules, target)) continue;
      const rel = relative(workDir, target);
      if (!found.has(rel)) {
        found.add(rel);
        queue.push(join(target, 'node_modules'));
      }
    }
  }
  return [...found];
}

/** Resolve every package symlink target under a `node_modules` dir (descending one level into `@scope` dirs). */
async function resolveNodeModulesLinks(nmDir: string): Promise<string[]> {
  const targets: string[] = [];
  for (const entry of await readdir(nmDir).catch(() => [])) {
    if (entry.startsWith('.')) continue; // .pnpm, .bin, .modules.yaml
    const entryPath = join(nmDir, entry);
    if (entry.startsWith('@')) {
      for (const scoped of await readdir(entryPath).catch(() => [])) {
        const target = await resolveIfSymlink(join(entryPath, scoped));
        if (target) targets.push(target);
      }
      continue;
    }
    const target = await resolveIfSymlink(entryPath);
    if (target) targets.push(target);
  }
  return targets;
}

/** Return the real path of `p` if it is a symlink, else null. */
async function resolveIfSymlink(p: string): Promise<string | null> {
  try {
    const stat = await lstat(p);
    if (!stat.isSymbolicLink()) return null;
    return await realpath(p);
  } catch {
    return null;
  }
}

/** Whether `target` is `root` itself or a path inside it. */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return (
    rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`) && !isAbsoluteRel(rel))
  );
}

function isAbsoluteRel(rel: string): boolean {
  return rel.length > 1 && rel[1] === ':'; // windows drive-relative guard
}
