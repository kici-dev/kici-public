/**
 * Pre-install validation for `.kici/` dependency specifiers.
 *
 * The agent clones a single source repository and installs its `.kici/`
 * dependencies with the repo's package manager. Local-protocol specifiers —
 * `workspace:`, `file:`, `link:`, `portal:` — resolve a dependency against
 * another package on the same filesystem rather than a registry. Whether they
 * are resolvable depends on the manager and the layout:
 *
 * - npm has no `workspace:` protocol and cannot resolve any of these from a
 *   registry, so they are rejected up front with an actionable message
 *   instead of the raw `EUNSUPPORTEDPROTOCOL` npm would emit.
 * - pnpm resolves `workspace:` against the repo's pnpm workspace (the agent
 *   clones the whole repo, so an in-repo sibling is present), and resolves
 *   `file:`/`link:`/`portal:` against a path — allowed when that path stays
 *   inside the cloned repo, rejected when it escapes the clone.
 * - yarn classic (v1) has no `workspace:` protocol and no `portal:` — it links
 *   in-repo siblings by version range, not by a local specifier — so both are
 *   rejected with guidance; `file:`/`link:` are allowed when the path stays
 *   inside the clone, rejected when it escapes.
 * - yarn berry (v2+) resolves `workspace:` against the repo-root package.json
 *   `workspaces` field and `portal:`/`file:`/`link:` against inside-repo paths,
 *   so those are allowed when present/inside the clone and rejected otherwise.
 *
 * This module performs that classification so unresolvable specifiers fail
 * fast with guidance rather than a cryptic install error.
 */

import { access, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { PackageManager, YarnFlavor } from '@kici-dev/shared/package-manager';

/** Local-protocol specifier prefixes that resolve against the filesystem. */
export enum LocalDepProtocol {
  Workspace = 'workspace:',
  File = 'file:',
  Link = 'link:',
  Portal = 'portal:',
}

const LOCAL_PROTOCOLS: readonly LocalDepProtocol[] = [
  LocalDepProtocol.Workspace,
  LocalDepProtocol.File,
  LocalDepProtocol.Link,
  LocalDepProtocol.Portal,
];

/** A dependency whose specifier uses a local (filesystem) protocol. */
export interface LocalProtocolDep {
  name: string;
  spec: string;
  protocol: LocalDepProtocol;
}

/** The dependency maps a package manager resolves in `.kici/package.json`. */
const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

interface PackageJsonShape {
  [field: string]: unknown;
}

/**
 * Scan a parsed `.kici/package.json` for dependency specifiers that use a
 * local protocol (`workspace:`/`file:`/`link:`/`portal:`). Returns one entry
 * per dependency, in field order. Returns an empty array when there are none.
 */
export function findLocalProtocolDeps(pkg: PackageJsonShape): LocalProtocolDep[] {
  const found: LocalProtocolDep[] = [];
  for (const field of DEP_FIELDS) {
    const deps = pkg[field];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof spec !== 'string') continue;
      const protocol = LOCAL_PROTOCOLS.find((proto) => spec.startsWith(proto));
      if (protocol) found.push({ name, spec, protocol });
    }
  }
  return found;
}

/** Parse `.kici/package.json`, returning `null` when it is missing or invalid. */
async function readKiciPackageJson(kiciDir: string): Promise<PackageJsonShape | null> {
  let raw: string;
  try {
    raw = await readFile(join(kiciDir, 'package.json'), 'utf-8');
  } catch {
    return null; // no package.json — nothing to validate
  }
  try {
    return JSON.parse(raw) as PackageJsonShape;
  } catch {
    return null; // malformed JSON — let the install surface the parse error
  }
}

/**
 * Whether `.kici/package.json` declares any local-protocol dependency. Used to
 * decide whether the agent must build the in-repo workspace dependency closure
 * after a pnpm install (so a `workspace:` sibling's build output exists before
 * the workflow that imports it loads).
 */
export async function kiciHasLocalProtocolDeps(kiciDir: string): Promise<boolean> {
  const pkg = await readKiciPackageJson(kiciDir);
  if (!pkg) return false;
  return findLocalProtocolDeps(pkg).length > 0;
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** Whether the repo-root package.json declares a non-empty `workspaces` array. */
async function rootHasWorkspaces(repoRoot: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf-8')) as {
      workspaces?: unknown;
    };
    const ws = pkg.workspaces;
    if (Array.isArray(ws)) return ws.length > 0;
    // yarn also accepts the object form { packages: [...] }.
    if (ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages)) {
      return (ws as { packages: unknown[] }).packages.length > 0;
    }
    return false;
  } catch {
    return false;
  }
}

/** Resolve a `file:`/`link:`/`portal:` spec to an absolute path under kiciDir. */
function resolveLocalPath(kiciDir: string, dep: LocalProtocolDep): string {
  const rawPath = dep.spec.slice(dep.protocol.length);
  return isAbsolute(rawPath) ? resolve(rawPath) : resolve(kiciDir, rawPath);
}

/** Whether `target` is `repoRoot` itself or a path inside it. */
function isInsideRepo(repoRoot: string, target: string): boolean {
  const rel = relative(repoRoot, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Classify each local-protocol dependency for the detected package manager and
 * return the ones that are unresolvable in the agent's single-clone model.
 */
async function findUnresolvableDeps(
  deps: readonly LocalProtocolDep[],
  packageManager: PackageManager,
  kiciDir: string,
  repoRoot: string,
  yarnFlavor: YarnFlavor,
): Promise<LocalProtocolDep[]> {
  if (packageManager === PackageManager.Npm) {
    // npm has no workspace protocol and cannot resolve any of these from a
    // registry — every local-protocol dep is unresolvable.
    return [...deps];
  }

  if (packageManager === PackageManager.Yarn && yarnFlavor === YarnFlavor.Berry) {
    // berry (node-modules linker) resolves `workspace:` against the root
    // package.json `workspaces` field and `portal:` against a path; `file:`/
    // `link:`/`portal:` are allowed only when they stay inside the clone.
    const hasWorkspaces = await rootHasWorkspaces(repoRoot);
    const unresolvable: LocalProtocolDep[] = [];
    for (const dep of deps) {
      if (dep.protocol === LocalDepProtocol.Workspace) {
        if (!hasWorkspaces) unresolvable.push(dep);
        continue;
      }
      if (!isInsideRepo(repoRoot, resolveLocalPath(kiciDir, dep))) unresolvable.push(dep);
    }
    return unresolvable;
  }

  if (packageManager === PackageManager.Yarn) {
    // yarn classic (v1) has no `workspace:` protocol and no `portal:`; it links
    // siblings by version range, not by a local specifier. `file:`/`link:`
    // resolve to a path — allowed only when it stays inside the clone.
    const unresolvable: LocalProtocolDep[] = [];
    for (const dep of deps) {
      if (dep.protocol === LocalDepProtocol.Workspace || dep.protocol === LocalDepProtocol.Portal) {
        unresolvable.push(dep);
        continue;
      }
      if (!isInsideRepo(repoRoot, resolveLocalPath(kiciDir, dep))) unresolvable.push(dep);
    }
    return unresolvable;
  }

  const hasWorkspaceFile = await fileExists(join(repoRoot, 'pnpm-workspace.yaml'));
  const unresolvable: LocalProtocolDep[] = [];
  for (const dep of deps) {
    if (dep.protocol === LocalDepProtocol.Workspace) {
      // pnpm resolves `workspace:` against the repo's pnpm workspace. Without a
      // pnpm-workspace.yaml there is no workspace to resolve against; with one,
      // pnpm itself reports a clear error if the named sibling is absent.
      if (!hasWorkspaceFile) unresolvable.push(dep);
      continue;
    }
    // file:/link:/portal: resolve to a path; allowed only when it stays inside
    // the cloned repo (the agent has nothing outside it).
    if (!isInsideRepo(repoRoot, resolveLocalPath(kiciDir, dep))) unresolvable.push(dep);
  }
  return unresolvable;
}

/** Build the actionable error for unresolvable local-protocol dependencies. */
export function formatUnresolvableDepError(
  offenders: readonly LocalProtocolDep[],
  packageManager: PackageManager,
  yarnFlavor: YarnFlavor,
): string {
  const list = offenders.map((o) => `${o.name}: ${o.spec}`).join(', ');
  if (packageManager === PackageManager.Npm) {
    return (
      'These .kici/ dependencies use local-protocol specifiers npm cannot ' +
      `resolve from a registry: ${list}. npm has no workspace protocol — pin a ` +
      'published version, publish the package to your registry, or use pnpm so ' +
      'an in-repo workspace sibling can be resolved.'
    );
  }
  if (packageManager === PackageManager.Yarn && yarnFlavor === YarnFlavor.Berry) {
    return (
      'These .kici/ dependencies cannot be resolved by yarn berry from the cloned ' +
      `repository: ${list}. A workspace: dependency requires a "workspaces" array ` +
      'in the repo-root package.json, and file:/link:/portal: paths must stay ' +
      'inside this repository.'
    );
  }
  if (packageManager === PackageManager.Yarn) {
    return (
      'These .kici/ dependencies use specifiers yarn classic cannot resolve: ' +
      `${list}. yarn classic has no workspace: or portal: protocol — reference an ` +
      'in-repo sibling by a version range (yarn links matching workspace members), ' +
      'use pnpm, or keep file:/link: paths inside this repository. (yarn berry ' +
      'support requires a yarn@2+ packageManager field or a .yarnrc.yml.)'
    );
  }
  return (
    'These .kici/ dependencies point outside the cloned repository, which the ' +
    `agent never has: ${list}. A workspace: dependency requires a pnpm-workspace.yaml ` +
    'at the repo root, and file:/link:/portal: paths must stay inside this repository.'
  );
}

/**
 * Throw an actionable error when `.kici/package.json` declares a local-protocol
 * dependency the detected package manager cannot resolve from the single cloned
 * repository. A missing or unparseable package.json is left for the install to
 * report.
 */
export async function assertResolvableDeps(args: {
  kiciDir: string;
  repoRoot: string;
  packageManager: PackageManager;
  yarnFlavor?: YarnFlavor;
}): Promise<void> {
  const pkg = await readKiciPackageJson(args.kiciDir);
  if (!pkg) return;

  const localDeps = findLocalProtocolDeps(pkg);
  if (localDeps.length === 0) return;

  const flavor = args.yarnFlavor ?? YarnFlavor.Classic;
  const offenders = await findUnresolvableDeps(
    localDeps,
    args.packageManager,
    args.kiciDir,
    args.repoRoot,
    flavor,
  );
  if (offenders.length === 0) return;

  throw new Error(formatUnresolvableDepError(offenders, args.packageManager, flavor));
}
