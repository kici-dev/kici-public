/**
 * In-repo workspace-sibling discovery and the layout of `.kici`'s installed
 * tree. A pnpm, npm or yarn workspace links a `.kici/` member's `workspace:`
 * (pnpm, yarn berry) or version-range (npm, yarn) siblings as symlinks to
 * package dirs inside the clone but outside `.kici/` and the `node_modules`
 * store. The dep-cache packer must carry those dirs (or the symlinks dangle),
 * and the npm and yarn install paths must build them (those managers link a
 * sibling but do not build it).
 *
 * The seed `node_modules` is a parameter: pnpm and a standalone `.kici` seed at
 * `.kici/node_modules`, an npm or yarn workspace member at the hoisted root.
 */

import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';

/**
 * The workspace globs declared at `repoRoot`: `pnpm-workspace.yaml` `packages:`
 * first, then the root `package.json` `workspaces` (array or `{ packages }`).
 */
async function workspaceGlobs(repoRoot: string): Promise<string[]> {
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((g): g is string => typeof g === 'string') : [];
  try {
    const doc = parseYaml(await readFile(join(repoRoot, 'pnpm-workspace.yaml'), 'utf-8')) as {
      packages?: unknown;
    } | null;
    if (Array.isArray(doc?.packages)) return strings(doc.packages);
  } catch {
    // No (readable) pnpm-workspace.yaml: the manifest form decides.
  }
  try {
    const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf-8')) as {
      workspaces?: unknown;
    };
    const ws = pkg.workspaces as { packages?: unknown } | unknown[] | undefined;
    return Array.isArray(ws) ? strings(ws) : strings(ws?.packages);
  } catch {
    return [];
  }
}

/**
 * Whether `kiciDir` is a member of the workspace declared at `repoRoot`: a
 * positive glob matches its repo-relative path and no `!` glob excludes it.
 * Wildcards do not match a leading dot, the same rule the compiler applies.
 */
export async function isKiciWorkspaceMember(repoRoot: string, kiciDir: string): Promise<boolean> {
  const norm = (p: string): string =>
    p.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const member = norm(relative(repoRoot, kiciDir));
  let included = false;
  for (const raw of await workspaceGlobs(repoRoot)) {
    const negated = raw.startsWith('!');
    if (!picomatch.isMatch(member, norm(negated ? raw.slice(1) : raw), { dot: false })) continue;
    if (negated) return false;
    included = true;
  }
  return included;
}

/** Where `.kici`'s installed dependency tree lives. */
export interface KiciNodeModulesLayout {
  /** The node_modules dirs holding `.kici`'s dependencies, `.kici/node_modules` first. */
  roots: string[];
  /** The repo-root node_modules links `.kici` itself: a hoisted npm or yarn workspace member. */
  hoistedMember: boolean;
}

/**
 * Locate `.kici`'s dependency tree. A standalone `.kici` has `.kici/node_modules`.
 * An npm or yarn workspace member is hoisted to the repo-root node_modules, and
 * the manager links `.kici` itself into that directory. When the manager nests
 * a conflicting version under `.kici/` too, both directories hold part of the
 * tree. Without `.kici/node_modules`, a root node_modules is used even when it
 * does not link `.kici`, which is how a hoisted yarn tree is found.
 */
export async function resolveKiciNodeModulesLayout(
  repoRoot: string,
  kiciDir: string,
): Promise<KiciNodeModulesLayout> {
  const kiciNm = join(kiciDir, 'node_modules');
  const rootNm = join(repoRoot, 'node_modules');
  const hoistedMember = existsSync(rootNm) && (await linksTo(rootNm, kiciDir));
  if (!existsSync(kiciNm)) return { roots: existsSync(rootNm) ? [rootNm] : [], hoistedMember };
  return { roots: hoistedMember ? [kiciNm, rootNm] : [kiciNm], hoistedMember };
}

/** Whether `.kici`'s dependencies are already installed (or restored) on disk. */
export async function kiciDepsPresent(repoRoot: string, kiciDir: string): Promise<boolean> {
  if (existsSync(join(kiciDir, 'node_modules'))) return true;
  return (await resolveKiciNodeModulesLayout(repoRoot, kiciDir)).hoistedMember;
}

/**
 * The in-repo siblings `.kici` declares, transitively, resolved by package name
 * through `roots` (each sibling's own `node_modules` first), repo-root-relative,
 * in BFS order. A hoisted npm or yarn root `node_modules` links EVERY workspace
 * package, so following its symlinks would build and pack packages `.kici` never
 * imports, which `siblingsDigest` does not cover. Walking the declared
 * dependencies keeps this closure equal to the one the compiler digests.
 */
export async function collectSiblingsFromRoots(
  workDir: string,
  kiciDir: string,
  roots: readonly string[],
): Promise<string[]> {
  const repoRoot = resolve(workDir);
  const kiciResolved = resolve(kiciDir);
  const rootNodeModules = resolve(join(workDir, 'node_modules'));
  const found: string[] = [];
  const seen = new Set<string>();
  const queue: Array<{ dir: string; lookup: string[] }> = [{ dir: kiciDir, lookup: [...roots] }];
  while (queue.length > 0) {
    const { dir, lookup } = queue.shift()!;
    for (const name of await declaredDependencyNames(dir)) {
      const target = await resolveLinkedPackage(name, lookup);
      if (!target || seen.has(target) || !isInside(repoRoot, target)) continue;
      if (isInside(kiciResolved, target) || isInside(rootNodeModules, target)) continue;
      seen.add(target);
      found.push(relative(workDir, target));
      queue.push({ dir: target, lookup: [join(target, 'node_modules'), ...roots] });
    }
  }
  return found;
}

/** Every dependency name a package.json declares, in any dependency map. */
async function declaredDependencyNames(dir: string): Promise<string[]> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    const maps = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
    return [...new Set(maps.flatMap((m) => Object.keys(pkg[m] ?? {})))];
  } catch {
    return [];
  }
}

/**
 * The real path of the symlink `name` resolves to in the first `node_modules`
 * of `lookup` that has an entry for it, or null when that entry is an installed
 * (non-symlink) package or no entry exists.
 */
async function resolveLinkedPackage(
  name: string,
  lookup: readonly string[],
): Promise<string | null> {
  for (const nm of lookup) {
    const entry = join(nm, name);
    if (!existsSync(entry)) continue;
    return resolveIfSymlink(entry);
  }
  return null;
}

/** Whether a package symlink directly under `nmDir` (or one `@scope` down) resolves to `target`. */
async function linksTo(nmDir: string, target: string): Promise<boolean> {
  const real = await realpath(target).catch(() => null);
  return real !== null && (await resolveNodeModulesLinks(nmDir)).includes(real);
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
