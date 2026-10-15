/**
 * Packs a build agent's installed dependency closure into a gzip tarball for
 * the dep cache, **repo-root-relative** (cwd = clone root), so restore is one
 * layout for every package manager (entries: `closureEntries`). pnpm and yarn
 * link `.kici/node_modules` into the root store and in-repo siblings outside
 * `.kici/`, so those travel with it or the links dangle.
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
import { collectInRepoSiblings, resolveYarnNodeModulesRoot } from './workspace-siblings.js';

const logger = createLogger({ prefix: 'dep-packer' });

/**
 * Pack the dependency closure and compute its SHA-256 hash.
 *
 * @throws Error if the node_modules root (`.kici/node_modules`, or a hoisted
 *   yarn member's repo-root `node_modules`) does not exist.
 */
export async function packNodeModules(kiciDir: string): Promise<{ tarball: Buffer; hash: string }> {
  const workDir = dirname(kiciDir);
  // Mirrors dep-installer's manifest-only detection, so the layout matches the install.
  const packageManager =
    (await detectPackageManagerFromManifests(workDir)) ??
    (await detectPackageManagerFromManifests(kiciDir)) ??
    PackageManager.Npm;

  // A yarn workspace member hoists to the repo-root node_modules.
  const nmRoot =
    packageManager === PackageManager.Yarn
      ? resolveYarnNodeModulesRoot(workDir, kiciDir)
      : join(kiciDir, 'node_modules');
  if (!existsSync(nmRoot)) {
    throw new Error(`node_modules not found at ${nmRoot}`);
  }

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
 * Repo-root-relative entries. npm: `.kici/node_modules`. pnpm: that plus the
 * root `node_modules/.pnpm` store and in-repo siblings. yarn: the resolved
 * node_modules root plus in-repo siblings; berry's forced node-modules linker
 * packs the same shape as classic.
 */
async function closureEntries(
  workDir: string,
  kiciDir: string,
  packageManager: PackageManager,
): Promise<string[]> {
  if (packageManager === PackageManager.Pnpm) {
    const entries = [relative(workDir, join(kiciDir, 'node_modules'))];
    if (existsSync(join(workDir, 'node_modules', '.pnpm'))) {
      entries.push(join('node_modules', '.pnpm'));
    }
    for (const sibling of await collectInRepoSiblings(workDir, kiciDir)) {
      entries.push(sibling);
    }
    return entries;
  }

  if (packageManager === PackageManager.Yarn) {
    const nmRoot = resolveYarnNodeModulesRoot(workDir, kiciDir);
    const entries = [relative(workDir, nmRoot)];
    for (const sibling of await collectInRepoSiblings(workDir, kiciDir, nmRoot)) {
      entries.push(sibling);
    }
    return entries;
  }

  return [relative(workDir, join(kiciDir, 'node_modules'))];
}
