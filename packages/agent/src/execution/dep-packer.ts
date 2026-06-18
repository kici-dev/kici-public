/**
 * Dependency tarball creation for build agents.
 *
 * After installing dependencies the build agent packs the dependency closure
 * into a gzip tarball for upload to the dep cache. The closure is packed
 * **repo-root-relative** (cwd = the clone root) so restore is a single layout
 * regardless of package manager:
 *
 * - npm: just `.kici/node_modules`.
 * - pnpm: `.kici/node_modules` plus the repo-root `node_modules/.pnpm` virtual
 *   store and the in-repo `workspace:` sibling package directories `.kici`
 *   depends on (with their built output). pnpm lays `.kici/node_modules` out as
 *   symlinks into the root store and into sibling dirs that live outside
 *   `.kici/`, so packing `.kici/node_modules` alone would capture dangling
 *   links — the store and siblings must travel together.
 * - yarn (classic + berry): the resolved node_modules root (standalone `.kici`
 *   → `.kici/node_modules`; hoisted workspace member → the repo-root
 *   `node_modules`) plus the in-repo sibling package directories `.kici` depends
 *   on (with their built output), whose symlinks would dangle otherwise. Berry
 *   runs with a forced `nodeLinker: node-modules`, so its tree has the same
 *   node_modules shape as classic and is packed identically (the flavor only
 *   changes how siblings are referenced — version range vs `workspace:`/`portal:`
 *   — not the packed layout).
 *
 * Uses tar.gz (Node.js built-in zlib, no external binary) in portable mode to
 * strip user/group info for cross-machine consistency; symlinks are preserved
 * as symlinks so the pnpm link graph restores intact.
 */

import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { c as tarCreate } from 'tar';
import { createLogger, sha256 } from '@kici-dev/shared';
import {
  detectPackageManagerFromManifests,
  PackageManager,
} from '@kici-dev/shared/package-manager';
import { collectInRepoSiblings, resolveYarnNodeModulesRoot } from './workspace-siblings.js';

const logger = createLogger({ prefix: 'dep-packer' });

/**
 * Pack the dependency closure into a gzip tarball and compute its SHA-256 hash.
 *
 * @param kiciDir - Path to the `.kici/` directory containing node_modules/.
 * @returns Object with the tarball Buffer and its SHA-256 hash string.
 * @throws Error if `.kici/node_modules` does not exist.
 */
export async function packNodeModules(kiciDir: string): Promise<{ tarball: Buffer; hash: string }> {
  const workDir = dirname(kiciDir);
  // Detect from the cloned repo's committed manifests (repo root, then .kici/),
  // never the agent's own launch env. Mirrors dep-installer's detection so the
  // packed layout matches how the deps were installed.
  const packageManager =
    (await detectPackageManagerFromManifests(workDir)) ??
    (await detectPackageManagerFromManifests(kiciDir)) ??
    PackageManager.Npm;

  // A yarn workspace member hoists deps to the repo-root node_modules (no
  // `.kici/node_modules`), so check the resolved root for yarn; npm/pnpm always
  // lay down `.kici/node_modules`.
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

  // portable: strip uid/gid/mtime for determinism. follow: false (default) so
  // pnpm's symlink graph is preserved — the store + siblings travel with it.
  const stream = tarCreate({ gzip: true, cwd: workDir, portable: true }, entries);

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  const tarball = Buffer.concat(chunks);
  const hash = sha256(tarball);

  const sizeMB = (tarball.length / (1024 * 1024)).toFixed(2);
  logger.info('Dependency closure packed', {
    sizeMB,
    hash: hash.slice(0, 12),
    durationMs: Date.now() - startTime,
  });

  return { tarball, hash };
}

/**
 * Compute the repo-root-relative tar entries for the dependency closure. npm
 * needs only `.kici/node_modules`. pnpm additionally needs the root store and
 * the in-repo workspace siblings `.kici` resolves. yarn (classic + berry) packs
 * the resolved node_modules root (standalone → `.kici/node_modules`; hoisted
 * workspace member → root `node_modules`) plus the in-repo siblings, which it
 * links but does not place in the store. Berry's forced node-modules linker
 * gives it the same packed shape as classic.
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

  // npm: just .kici/node_modules
  return [relative(workDir, join(kiciDir, 'node_modules'))];
}
