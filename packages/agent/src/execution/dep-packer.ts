/**
 * Packs a build agent's installed dependency closure into a gzip tarball for
 * the dep cache, **repo-root-relative** (cwd = clone root), so restore is one
 * layout for every package manager (entries: `closureEntries`). pnpm links
 * `.kici/node_modules` into the root store; npm and yarn hoist a workspace
 * member's tree to the repo-root `node_modules`; every manager links in-repo
 * siblings outside `.kici/`. Those travel with it or the links dangle.
 *
 * Portable mode strips user/group info; symlinks stay symlinks so the pnpm link
 * graph restores intact; hard links are packed as regular files.
 */

import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createLogger } from '@kici-dev/shared';
import {
  detectPackageManagerFromManifests,
  PackageManager,
} from '@kici-dev/shared/package-manager';
import { packGzipTarball } from './tar-pack.js';
import {
  collectInRepoSiblings,
  collectSiblingsFromRoots,
  resolveKiciNodeModulesLayout,
} from './workspace-siblings.js';

const logger = createLogger({ prefix: 'dep-packer' });

/**
 * Pack the dependency closure and compute its SHA-256 hash.
 *
 * @throws Error if no node_modules root `.kici` resolves from exists
 *   (`.kici/node_modules`, or a hoisted npm or yarn member's repo-root
 *   `node_modules`).
 */
export async function packNodeModules(kiciDir: string): Promise<{ tarball: Buffer; hash: string }> {
  const workDir = dirname(kiciDir);
  // Mirrors dep-installer's manifest-only detection, so the layout matches the install.
  const packageManager =
    (await detectPackageManagerFromManifests(workDir)) ??
    (await detectPackageManagerFromManifests(kiciDir)) ??
    PackageManager.Npm;

  const entries = await closureEntries(workDir, kiciDir, packageManager);

  logger.info('Packing dependency closure into tarball', { dir: workDir, packageManager, entries });
  const startTime = Date.now();

  // Not byte-reproducible: mtimes are packed, so two installs of one lockfile
  // differ in `depsHash`. Fine, because the cache is content-addressed and every
  // upload re-publishes the `<lockfileHash>.hash` pointer.
  const { tarball, hash } = await packGzipTarball(workDir, entries);

  const sizeMB = (tarball.length / (1024 * 1024)).toFixed(2);
  logger.info('Dependency closure packed', {
    sizeMB,
    hash: hash.slice(0, 12),
    durationMs: Date.now() - startTime,
  });

  return { tarball, hash };
}

/**
 * Repo-root-relative entries. pnpm: `.kici/node_modules`, the root
 * `node_modules/.pnpm` store and in-repo siblings. npm and yarn (classic and
 * berry, whose forced node-modules linker packs the same shape): the
 * node_modules roots `.kici` resolves from (`.kici/node_modules` standalone;
 * the hoisted repo-root `node_modules` of a workspace member; both when the
 * manager nested a conflicting version under `.kici/`) plus the in-repo
 * siblings linked from them. npm takes the repo-root `node_modules` only when
 * it links `.kici`, so a standalone npm `.kici` never packs the repo's own
 * dependencies.
 */
async function closureEntries(
  workDir: string,
  kiciDir: string,
  packageManager: PackageManager,
): Promise<string[]> {
  const kiciNm = join(kiciDir, 'node_modules');
  if (packageManager === PackageManager.Pnpm) {
    if (!existsSync(kiciNm)) throw new Error(`node_modules not found at ${kiciNm}`);
    const entries = [relative(workDir, kiciNm)];
    if (existsSync(join(workDir, 'node_modules', '.pnpm'))) {
      entries.push(join('node_modules', '.pnpm'));
    }
    for (const sibling of await collectInRepoSiblings(workDir, kiciDir)) entries.push(sibling);
    return entries;
  }

  const layout = await resolveKiciNodeModulesLayout(workDir, kiciDir);
  const roots =
    packageManager === PackageManager.Npm && !layout.hoistedMember
      ? layout.roots.filter((nm) => nm === kiciNm)
      : layout.roots;
  if (roots.length === 0) {
    throw new Error(`node_modules not found at ${kiciNm} or ${join(workDir, 'node_modules')}`);
  }
  return [
    ...roots.map((nm) => relative(workDir, nm)),
    ...(await collectSiblingsFromRoots(workDir, kiciDir, roots)),
  ];
}
