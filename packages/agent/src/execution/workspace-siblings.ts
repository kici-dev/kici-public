/**
 * In-repo workspace-sibling discovery. A pnpm or yarn-classic workspace links a
 * `.kici/` member's `workspace:` (pnpm) or version-range (yarn) siblings as
 * symlinks to package dirs inside the clone but outside `.kici/` and the
 * `node_modules` store. The dep-cache packer must carry those dirs (or the
 * symlinks dangle), and the yarn install path must build them (yarn links a
 * sibling but does not build it).
 *
 * The seed `node_modules` is a parameter: pnpm and yarn-standalone seed at
 * `.kici/node_modules`, a yarn workspace member at the hoisted root.
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
 * Walk `seedNodeModules`, and transitively each sibling's `node_modules`,
 * returning each sibling dir once, repo-root-relative, in BFS order.
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
