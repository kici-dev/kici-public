/**
 * Verify that an npm lockfile pins every package the host install fetches,
 * when the agent's npm is too old to refuse non-registry sources by flag.
 *
 * npm before 11.15.0 has `--allow-git` but no `--allow-remote`, `--allow-file`
 * or `--allow-directory`. A registry package can declare its own dependency on
 * an `https://…/x.tgz` URL, and npm fetches that URL from the agent host,
 * outside the job network's egress filter, the moment it resolves the edge. So
 * with such an npm the host install runs `npm ci`, which installs what the
 * lockfile pins and never rewrites it.
 *
 * `npm ci` alone is not enough. Before it compares its result with the
 * lockfile, npm resolves every dependency edge the lockfile leaves open, and
 * resolving an edge fetches its target: a lockfile that omits a package, or
 * records a URL dependency with no locked package for it, makes npm download
 * that URL before it refuses the out-of-sync lockfile. And npm fetches a locked
 * package that has no `resolved` URL from whatever its `version` names: a
 * `http:host:port/x.tgz` URL, a directory or a tarball on the agent host. So the
 * host install runs only when npm's own lockfile reader finds no open edge, and
 * every locked package carries a semver version and a `resolved` tarball on an
 * allowed registry. A package inside a dependency's own tarball
 * (`bundleDependencies`) has no `resolved` of its own and needs only the
 * version.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { toErrorMessage } from '@kici-dev/shared';
import { PackageManager } from '@kici-dev/shared/package-manager';
import {
  HostInstallRefusal,
  type HostInstallPlan,
  type HostInstallRefused,
} from './host-install-eligibility.js';
import {
  NpmInstallCommand,
  npmInstallCommand,
  type HostInstallTool,
} from './host-isolated-install.js';
import { isRegistryTarball } from './npmrc-allowlist.js';

/** The parts of a dependency edge in npm's arborist tree this check reads. */
export interface LockEdge {
  name: string;
  /** npm's edge type: `prod`, `dev`, `optional`, `peer`, `peerOptional`, … */
  type: string;
  spec: string;
  /** The locked package the edge resolves to, or `null` when none. */
  to: unknown;
  /** Whether the locked package satisfies the edge's spec. */
  valid: boolean;
}

/** The parts of a package node in npm's arborist tree this check reads. */
export interface LockNode {
  /** The node's path in `node_modules`; `''` for the project itself. */
  location: string;
  /** The package ships its own `npm-shrinkwrap.json`. */
  hasShrinkwrap: boolean;
  /** The lockfile `resolved` URL npm fetches the package from, or `null`. */
  resolved: string | null;
  /** The locked version; `''` when the lockfile records none. */
  version: string;
  /** The package comes inside a dependency's own tarball (`bundleDependencies`). */
  inDepBundle: boolean;
  edgesOut: Map<string, LockEdge>;
}

/** npm's virtual tree: the project and every package the lockfile records. */
export interface LockTree {
  inventory: Map<string, LockNode>;
}

/** The lockfile reader and version parser of the npm that runs the install. */
export interface NpmLockReader {
  /** Loads the virtual tree of the project in a directory from its lockfile. */
  loadTree: (projectDir: string) => Promise<LockTree>;
  /** Whether a string is a valid semver version, by npm's own `semver`. */
  isVersion: (version: string) => boolean;
}

/** The edge type npm leaves unresolved on its own: an optional peer dependency. */
const PEER_OPTIONAL_EDGE = 'peerOptional';

/** The first lockfile version that records every package with its dependencies. */
const MIN_COMPLETE_LOCKFILE_VERSION = 2;

function refuse(refusal: HostInstallRefusal, detail: string): HostInstallRefused {
  return { eligible: false, refusal, detail };
}

/**
 * The lockfile reader (its `@npmcli/arborist`) and version parser (its
 * `semver`) of the npm at `npmCliPath`, so the check reads the lockfile exactly
 * as the `npm ci` it guards will. `null` when that npm ships either one in a
 * shape this check cannot use.
 */
export function npmLockReader(npmCliPath: string): NpmLockReader | null {
  try {
    const require = createRequire(npmCliPath);
    const Arborist = require('@npmcli/arborist') as unknown;
    const semver = require('semver') as { valid?: unknown };
    if (typeof Arborist !== 'function' || typeof semver.valid !== 'function') return null;
    const Ctor = Arborist as new (opts: { path: string }) => {
      loadVirtual(): Promise<LockTree>;
    };
    const valid = semver.valid as (version: string) => string | null;
    return {
      loadTree: (projectDir) => new Ctor({ path: projectDir }).loadVirtual(),
      isVersion: (version) => valid(version) !== null,
    };
  } catch {
    return null;
  }
}

/**
 * The first dependency edge `npm ci` would resolve itself, or a package that
 * brings its own shrinkwrap, which npm resolves once it unpacks it. `null` when
 * the lockfile pins everything.
 */
export function findUnpinnedDependency(tree: LockTree): string | null {
  for (const node of tree.inventory.values()) {
    const where = node.location || 'the project';
    if (node.hasShrinkwrap) {
      return `${where} ships its own npm-shrinkwrap.json, which npm resolves after unpacking it`;
    }
    for (const edge of node.edgesOut.values()) {
      if (!edge.to) {
        // breaks-if-wrong: a missing optional peer is never resolved by npm ci,
        // so a lockfile that leaves one out still installs on the host.
        if (edge.type === PEER_OPTIONAL_EDGE) continue;
        return `${where} depends on ${edge.name}@${edge.spec}, which the lockfile does not pin`;
      }
      if (!edge.valid) {
        return `${where} depends on ${edge.name}@${edge.spec}, which the locked ${edge.name} does not satisfy`;
      }
    }
  }
  return null;
}

/**
 * The first locked package npm could fetch from somewhere other than a tarball
 * on `registries`: a version that is not a semver version, a `resolved` URL
 * off the registries, or no `resolved` at all, in which case npm fetches what
 * the version names. A package bundled in a dependency's tarball arrives with
 * that tarball and needs no `resolved`. `null` when every package qualifies.
 */
export function findUnregisteredPackage(
  tree: LockTree,
  registries: readonly URL[],
  isVersion: (version: string) => boolean,
): string | null {
  for (const node of tree.inventory.values()) {
    if (node.location === '') continue;
    // fails-when: a package with no `resolved` and the version
    // `http:127.0.0.1:9/x.tgz` or `/host/dir` passes; npm ci fetches that URL
    // or copies that directory from the agent host.
    // breaks-if-wrong: a registry package npm wrote, `1.2.3` resolved from a
    // tarball on an allowed registry, passes.
    if (!isVersion(node.version)) {
      return `${node.location} has version ${JSON.stringify(node.version)}, not a semver version`;
    }
    if (node.resolved) {
      if (!isRegistryTarball(node.resolved, registries)) {
        return `${node.location} resolves from ${node.resolved}, not a tarball on an allowed registry`;
      }
      continue;
    }
    // breaks-if-wrong: a package bundled in its parent's tarball has no
    // `resolved` of its own and still passes.
    if (!node.inDepBundle) {
      return `${node.location} has no resolved URL, so npm fetches it from its version`;
    }
  }
  return null;
}

async function readLockfileVersion(path: string): Promise<number | null> {
  try {
    const lock = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown> | null;
    const packages = lock?.packages;
    const complete = packages !== null && typeof packages === 'object';
    return complete && typeof lock?.lockfileVersion === 'number' ? lock.lockfileVersion : null;
  } catch {
    return null;
  }
}

/**
 * Refuse a host install the resolved package manager cannot keep on the
 * allowed registries. Only an npm that runs `npm ci` needs this: its install
 * runs only with a version 2 or 3 lockfile that pins every package to a
 * registry tarball. `null` lets the install run.
 */
export async function checkLockedInstall(
  kiciDir: string,
  plan: HostInstallPlan,
  tool: HostInstallTool,
  loadReader: (npmCliPath: string) => NpmLockReader | null = npmLockReader,
): Promise<HostInstallRefused | null> {
  // breaks-if-wrong: pnpm and npm 11.15.0 or later refuse non-registry sources
  // themselves, so their install runs without a lockfile, as before.
  if (tool.packageManager !== PackageManager.Npm) return null;
  if (npmInstallCommand(tool.version) !== NpmInstallCommand.Ci) return null;

  // fails-when: npm older than 11.15.0 installs a project with no lockfile,
  // resolving a registry package's own URL dependency from the agent host.
  if (!plan.lockfile) {
    return refuse(
      HostInstallRefusal.LockfileRequired,
      `npm ${tool.version} cannot refuse URL, file or directory dependencies itself, so the host install runs npm ci, which needs a lockfile`,
    );
  }
  const lockfile = `.kici/${plan.lockfile}`;
  const version = await readLockfileVersion(join(kiciDir, plan.lockfile));
  // fails-when: a version 1 lockfile passes; npm ci rebuilds its dependency
  // edges from registry manifests, which this check never sees.
  if (version === null || version < MIN_COMPLETE_LOCKFILE_VERSION) {
    return refuse(
      HostInstallRefusal.LockfileUnpinned,
      `${lockfile} is not a lockfileVersion 2 or 3 lockfile, so npm ci resolves its packages from the registry`,
    );
  }
  const reader = loadReader(tool.script);
  if (!reader) {
    return refuse(
      HostInstallRefusal.LockfileUnpinned,
      `npm ${tool.version} ships no lockfile reader to check ${lockfile} with`,
    );
  }
  let open: string | null;
  try {
    const tree = await reader.loadTree(kiciDir);
    // fails-when: a lockfile that omits a package, or records a URL dependency
    // with no locked package for it, passes; npm ci fetches that URL from the
    // agent host before it refuses the lockfile.
    // breaks-if-wrong: a lockfile npm wrote for a registry-only project passes.
    open =
      findUnpinnedDependency(tree) ??
      findUnregisteredPackage(tree, plan.registries, reader.isVersion);
  } catch (err) {
    // fails-when: a tree shape this check does not expect throws, failing the
    // job instead of leaving the install to the container.
    return refuse(
      HostInstallRefusal.LockfileUnpinned,
      `npm could not read ${lockfile}: ${toErrorMessage(err)}`,
    );
  }
  return open ? refuse(HostInstallRefusal.LockfileUnpinned, `${lockfile}: ${open}`) : null;
}
