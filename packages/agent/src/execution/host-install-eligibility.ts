/**
 * Decide whether a container job's `.kici/` install may run on the agent host.
 *
 * The host install exists so a registry the job network cannot reach still
 * works. It must never run code the repository controls on the agent host, so
 * this module is a positive allowlist: a checkout qualifies only when every
 * input the install reads is a plain, registry-only npm or pnpm project. Any
 * other shape — yarn, a workspace, a pnpm hook, a git / file / tarball-URL
 * dependency, a workflow or repository registry or a lockfile URL outside the
 * origins the operator allows, a symlinked manifest, an `.npmrc` with a
 * control character — is refused, and the job container installs the
 * dependencies as it always has.
 *
 * The host install runs outside the job network's egress filter, so every
 * origin it contacts must be one the operator chose: the public npm registry,
 * the `KICI_HOST_INSTALL_REGISTRIES` origins, and the registries in the agent
 * user's own `~/.npmrc`. A workflow's `registries:` block and `.kici/.npmrc`
 * are repository input and never widen that set.
 *
 * Every read here is of data files (JSON / YAML / `.npmrc`); nothing in the
 * checkout is executed or imported. `.npmrc` files are read with npm's own
 * parser (`npmrc-allowlist.ts`), so this check and the install see the same
 * keys.
 */

import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  PackageManager,
  detectPackageManagerFromManifests,
} from '@kici-dev/shared/package-manager';
import type { NpmRegistrySpec } from './npm-registry-config.js';
import {
  allowedRegistries,
  authEnvReferences,
  isEnvVarName,
  isOperatorNpmrcKey,
  isRegistryKey,
  isRegistryTarball,
  isRepoNpmrcKey,
  isToolReadEnvName,
  loadNpmIni,
  npmrcKeys,
  parseRepoNpmrc,
  pickAllowed,
  registryOrigin,
  type IniCodec,
  type NpmrcEntries,
} from './npmrc-allowlist.js';
import { rootHasWorkspaces } from './validate-kici-deps.js';

/** Why a checkout is not eligible for the host install. */
export enum HostInstallRefusal {
  /** `.kici`, its manifest, lockfile or `.npmrc` is a symlink. */
  Symlink = 'symlink',
  /** The project is managed by yarn, or carries yarn configuration. */
  YarnProject = 'yarn-project',
  /** `.kici` sits in a pnpm or npm workspace, or declares one itself. */
  WorkspaceLayout = 'workspace-layout',
  /** A pnpm hook source: a pnpmfile, a pnpmfile setting, config dependencies. */
  PnpmHooks = 'pnpm-hooks',
  /** A `pnpm` field key outside the data-only allowlist. */
  PnpmManifestSettings = 'pnpm-manifest-settings',
  /** A git, file, link, workspace, tarball or URL dependency or override. */
  NonRegistryDependency = 'non-registry-dependency',
  /** The manifest or lockfile does not parse. */
  UnreadableManifest = 'unreadable-manifest',
  /** An `.npmrc` (or a workflow registry) carries a control character. */
  UnsafeNpmrc = 'unsafe-npmrc',
  /** A workflow or `.kici/.npmrc` registry is on an origin the operator does not allow. */
  UnmanagedRegistry = 'unmanaged-registry',
  /** The agent's npm, whose parser reads every `.npmrc`, is not available. */
  NpmrcParserUnavailable = 'npmrc-parser-unavailable',
  /** A kept registry-auth value references a variable npm, pnpm or Node reads. */
  ToolEnvReference = 'tool-env-reference',
  /** The agent's npm runs `npm ci`, which needs a lockfile, and the project has none. */
  LockfileRequired = 'lockfile-required',
  /** The lockfile leaves a dependency for `npm ci` to resolve, which fetches it. */
  LockfileUnpinned = 'lockfile-unpinned',
}

/** What the host install stages and the `.npmrc` it writes. */
export interface HostInstallPlan {
  packageManager: PackageManager.Npm | PackageManager.Pnpm;
  /** Basename of the lockfile inside `.kici/`, or `null` when there is none. */
  lockfile: string | null;
  /**
   * The registries the install may fetch package tarballs from: npm's public
   * registry, the `KICI_HOST_INSTALL_REGISTRIES` origins and the registries in
   * the agent user's own `~/.npmrc`.
   */
  registries: readonly URL[];
  /** npm's parser and the allowlisted entries the install's `.npmrc` is written from. */
  npmrc: { ini: IniCodec; operator: NpmrcEntries; repo: NpmrcEntries };
}

export type HostInstallEligibility =
  | { eligible: true; plan: HostInstallPlan }
  | { eligible: false; refusal: HostInstallRefusal; detail: string };

export interface HostInstallEligibilityOptions {
  /** The job's workflow-declared registries (from its `registries:`); each must be on an allowed origin. */
  workflowRegistries?: readonly NpmRegistrySpec[];
  /** The operator's `KICI_HOST_INSTALL_REGISTRIES` origins, already normalized. */
  hostInstallRegistries?: readonly string[];
  /** npm's `.npmrc` parser; defaults to the one bundled with the agent's npm. */
  ini?: IniCodec | null;
  /** The operator's `.npmrc` text; defaults to the agent user's `~/.npmrc`. */
  operatorNpmrc?: string | null;
}

/** Files whose presence alone makes a pnpm install run repository code. */
const PNPMFILES = ['.pnpmfile.cjs', '.pnpmfile.mjs', '.pnpmfile.js'] as const;

/** Files that mark a yarn project, whatever the lockfile says. */
const YARN_MARKERS = ['.yarnrc', '.yarnrc.yml', 'yarn.lock', '.pnp.cjs'] as const;

/** `.npmrc` keys that load pnpm hooks or config packages. */
const PNPM_HOOK_NPMRC_KEYS = new Set([
  'pnpmfile',
  'global-pnpmfile',
  'config-dependencies',
  'hooks',
]);

/** `package.json#pnpm` keys that are data only and cannot load code. */
const ALLOWED_PNPM_MANIFEST_KEYS = new Set([
  'overrides',
  'onlyBuiltDependencies',
  'neverBuiltDependencies',
  'ignoredBuiltDependencies',
  'allowedDeprecatedVersions',
  'peerDependencyRules',
  'packageExtensions',
  'auditConfig',
]);

/** The dependency maps an install resolves from `package.json`. */
const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/** Lockfiles per manager, in the order the manager itself prefers them. */
const LOCKFILES: Record<HostInstallPlan['packageManager'], readonly string[]> = {
  [PackageManager.Npm]: ['npm-shrinkwrap.json', 'package-lock.json'],
  [PackageManager.Pnpm]: ['pnpm-lock.yaml'],
};

/** Any control character, or whitespace, in a workflow registry field. */
const UNSAFE_REGISTRY_FIELD = /[\s\u0000-\u001f\u007f]/;

/** A refusal: the job container installs instead, and `detail` says why. */
export type HostInstallRefused = Extract<HostInstallEligibility, { eligible: false }>;

type Refused = HostInstallRefused;

function refuse(refusal: HostInstallRefusal, detail: string): Refused {
  return { eligible: false, refusal, detail };
}

/** `lstat` without throwing: `null` when the path does not exist. */
async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Whether a dependency specifier resolves from a registry: a version, a semver
 * range, a dist-tag, or an `npm:` alias of one. Everything else — git hosts,
 * URLs, paths, tarballs, `workspace:` / `file:` / `link:` / `portal:` /
 * `patch:` / `runtime:` protocols, `user/repo` shorthands — is not.
 */
export function isRegistrySpec(spec: string): boolean {
  if (spec.startsWith('npm:')) {
    const aliased = spec.slice('npm:'.length);
    const at = aliased.lastIndexOf('@');
    if (at <= 0) return /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(aliased);
    const name = aliased.slice(0, at);
    if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name)) return false;
    return isRegistrySpec(aliased.slice(at + 1));
  }
  const trimmed = spec.trim();
  // Paths, home-relative paths and tarball file names are file dependencies.
  if (trimmed.startsWith('.') || /\.(tgz|tar\.gz|tar)$/i.test(trimmed)) return false;
  // A colon is a protocol (git+, http:, file:, workspace:, github:, C:\…); a
  // slash is a path or a `user/repo` git shorthand; `#` is a git ref.
  if (/[:/\\#]/.test(trimmed)) return false;
  // Versions, ranges (`^1.2.3`, `>=1 <2 || 3.x`, `1.0.0 - 2.0.0`) and dist-tags.
  return /^[\w\s.*^~<>=|+-]*$/.test(trimmed);
}

/** The first non-registry dependency in a parsed `package.json`, if any. */
function findNonRegistryDependency(pkg: Record<string, unknown>): string | null {
  for (const field of DEP_FIELDS) {
    const deps = pkg[field];
    if (deps === undefined) continue;
    if (!deps || typeof deps !== 'object') return `${field} is not an object`;
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof spec !== 'string' || !isRegistrySpec(spec)) {
        return `${field}.${name} = ${JSON.stringify(spec)}`;
      }
    }
  }
  return null;
}

/**
 * The first non-registry spec in an override map: npm `overrides` (nested
 * objects, the `.` key, and `$name` references to a direct dependency), and the
 * flat `resolutions` / `pnpm.overrides` maps.
 */
export function findNonRegistryOverride(overrides: unknown, path: string): string | null {
  if (overrides === undefined) return null;
  if (typeof overrides === 'string') {
    // `$name` points at a direct dependency's spec, which is checked on its own.
    const ok = /^\$[\w@/.-]+$/.test(overrides) || isRegistrySpec(overrides);
    return ok ? null : `${path} = ${JSON.stringify(overrides)}`;
  }
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return `${path} is not an override map`;
  }
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    const found = findNonRegistryOverride(value, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

/**
 * Whether an npm lockfile `version` names a non-registry source: anything but a
 * version, a range, a dist-tag or an `npm:` alias. npm fetches a locked package
 * that has no `resolved` URL from what its version names, so
 * `http:127.0.0.1:9/x.tgz` or a host path is a source, not a version.
 */
function isExoticNpmLockValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  // fails-when: `http:127.0.0.1:9/x.tgz` or `/host/dir` passes as a version, so
  // npm fetches that URL or copies that directory from the agent host.
  // breaks-if-wrong: `1.2.3`, and a v1 alias `npm:foo@1.2.3`, still pass.
  return typeof value !== 'string' || !isRegistrySpec(value);
}

/**
 * The first non-registry entry of an npm `package-lock.json` /
 * `npm-shrinkwrap.json`: a link, a `resolved` URL that is not a tarball on
 * one of `registries`, or a `version` that names a git, URL or path source.
 * Covers the v2/v3 `packages` map and the v1 `dependencies` tree.
 */
export function findNonRegistryNpmLockEntry(
  lock: Record<string, unknown>,
  registries: readonly URL[],
): string | null {
  const badResolved = (resolved: unknown) =>
    resolved !== undefined && !isRegistryTarball(String(resolved), registries);
  const packages = lock.packages;
  if (packages && typeof packages === 'object') {
    for (const [key, raw] of Object.entries(packages as Record<string, unknown>)) {
      if (key === '') continue;
      const entry = (raw ?? {}) as Record<string, unknown>;
      if (entry.link === true) return `${key} is a link`;
      if (badResolved(entry.resolved)) return `${key} resolved from ${String(entry.resolved)}`;
      if (isExoticNpmLockValue(entry.version)) return `${key} version ${String(entry.version)}`;
    }
  }
  const walk = (deps: unknown, path: string): string | null => {
    if (!deps || typeof deps !== 'object') return null;
    for (const [name, raw] of Object.entries(deps as Record<string, unknown>)) {
      const entry = (raw ?? {}) as Record<string, unknown>;
      if (isExoticNpmLockValue(entry.version))
        return `${path}${name} version ${String(entry.version)}`;
      if (badResolved(entry.resolved))
        return `${path}${name} resolved from ${String(entry.resolved)}`;
      const nested = walk(entry.dependencies, `${path}${name} > `);
      if (nested) return nested;
    }
    return null;
  };
  return walk(lock.dependencies, '');
}

/**
 * The first non-registry entry of a `pnpm-lock.yaml`: a package resolved by
 * anything but an integrity hash and, optionally, a tarball on one of
 * `registries` (git, a directory, a tarball elsewhere), an importer dependency
 * on a link / file / URL, or a lockfile that records a pnpmfile or patches.
 */
export function findNonRegistryPnpmLockEntry(
  lock: Record<string, unknown>,
  registries: readonly URL[],
): string | null {
  if (lock.pnpmfileChecksum !== undefined) return 'the lockfile records a pnpmfile';
  if (lock.patchedDependencies !== undefined) return 'the lockfile records patched dependencies';
  const packages = (lock.packages ?? {}) as Record<string, unknown>;
  for (const [key, raw] of Object.entries(packages)) {
    const resolution = ((raw ?? {}) as { resolution?: Record<string, unknown> }).resolution;
    if (!resolution || typeof resolution !== 'object') return `${key} has no resolution`;
    const extra = Object.keys(resolution).filter((k) => k !== 'integrity' && k !== 'tarball');
    if (extra.length > 0 || typeof resolution.integrity !== 'string') {
      return `${key} resolves via ${Object.keys(resolution).join(', ')}`;
    }
    if (
      resolution.tarball !== undefined &&
      !isRegistryTarball(String(resolution.tarball), registries)
    ) {
      return `${key} resolves from ${String(resolution.tarball)}`;
    }
  }
  const importers = (lock.importers ?? {}) as Record<string, unknown>;
  for (const [importer, raw] of Object.entries(importers)) {
    const project = (raw ?? {}) as Record<string, unknown>;
    for (const field of DEP_FIELDS) {
      const deps = (project[field] ?? {}) as Record<string, unknown>;
      for (const [name, dep] of Object.entries(deps)) {
        const version = typeof dep === 'string' ? dep : (dep as { version?: unknown })?.version;
        if (
          typeof version === 'string' &&
          (version.includes('://') || /^(link|file|git|workspace):/.test(version))
        ) {
          return `${importer} ${field}.${name} = ${version}`;
        }
      }
    }
  }
  return null;
}

async function parseJsonFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf-8'));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Refuse a symlinked `.kici`, or a symlink at any file the install reads. */
async function checkNoSymlinks(workflowDir: string, kiciDir: string): Promise<Refused | null> {
  const kici = await lstatOrNull(kiciDir);
  if (!kici || kici.isSymbolicLink() || !kici.isDirectory()) {
    return refuse(HostInstallRefusal.Symlink, '.kici is not a plain directory');
  }
  const read = ['package.json', '.npmrc', ...LOCKFILES.npm, ...LOCKFILES.pnpm];
  for (const name of read) {
    const stat = await lstatOrNull(join(kiciDir, name));
    // breaks-if-wrong: a missing optional file (no lockfile, no .npmrc) is not a refusal.
    if (stat && !stat.isFile()) {
      return refuse(HostInstallRefusal.Symlink, `.kici/${name} is not a plain file`);
    }
  }
  for (const name of ['package.json', '.npmrc']) {
    const stat = await lstatOrNull(join(workflowDir, name));
    if (stat && !stat.isFile()) {
      return refuse(HostInstallRefusal.Symlink, `the repository ${name} is not a plain file`);
    }
  }
  return null;
}

/**
 * Parse a repository `.npmrc` with npm's parser: `{}` when absent, a refusal
 * when it carries a control character or sets a pnpm hook key.
 */
async function readRepoNpmrc(
  path: string,
  label: string,
  ini: IniCodec,
): Promise<{ entries: Record<string, unknown> } | Refused> {
  const text = await readOptional(path);
  if (text === null) return { entries: {} };
  const parsed = parseRepoNpmrc(text, ini);
  if (!parsed.ok) return refuse(HostInstallRefusal.UnsafeNpmrc, `${label}: ${parsed.reason}`);
  const hook = npmrcKeys(parsed.entries).find((k) => PNPM_HOOK_NPMRC_KEYS.has(k));
  if (hook) return refuse(HostInstallRefusal.PnpmHooks, `${label} sets ${hook}`);
  return { entries: parsed.entries };
}

/** Refuse yarn, workspaces and every pnpm hook file, in `.kici` and at the root. */
async function checkToolingShape(
  workflowDir: string,
  kiciDir: string,
  pm: PackageManager,
  pkg: Record<string, unknown>,
): Promise<Refused | null> {
  // fails-when: a yarn project reaches the host install, where yarn berry would
  // load the repository's yarnPath / plugins.
  // breaks-if-wrong: an npm or pnpm project must pass this check.
  if (pm !== PackageManager.Npm && pm !== PackageManager.Pnpm) {
    return refuse(HostInstallRefusal.YarnProject, `the project is managed by ${pm}`);
  }
  for (const dir of [kiciDir, workflowDir]) {
    for (const marker of YARN_MARKERS) {
      if (await lstatOrNull(join(dir, marker))) {
        return refuse(HostInstallRefusal.YarnProject, `${marker} is present`);
      }
    }
    if (await lstatOrNull(join(dir, 'pnpm-workspace.yaml'))) {
      return refuse(HostInstallRefusal.WorkspaceLayout, 'pnpm-workspace.yaml is present');
    }
    for (const pnpmfile of PNPMFILES) {
      if (await lstatOrNull(join(dir, pnpmfile))) {
        return refuse(HostInstallRefusal.PnpmHooks, `${pnpmfile} is present`);
      }
    }
  }
  if (pkg.workspaces !== undefined || (await rootHasWorkspaces(workflowDir))) {
    return refuse(HostInstallRefusal.WorkspaceLayout, 'a package.json declares workspaces');
  }
  const pnpmField = pkg.pnpm;
  if (pnpmField !== undefined) {
    if (!pnpmField || typeof pnpmField !== 'object') {
      return refuse(HostInstallRefusal.PnpmManifestSettings, 'package.json#pnpm is not an object');
    }
    const unexpected = Object.keys(pnpmField).filter((k) => !ALLOWED_PNPM_MANIFEST_KEYS.has(k));
    if (unexpected.length > 0) {
      return refuse(
        HostInstallRefusal.PnpmManifestSettings,
        `package.json#pnpm sets ${unexpected.join(', ')}`,
      );
    }
  }
  return null;
}

/** Refuse a non-registry spec in a dependency field or any override map. */
function checkManifestSpecs(pkg: Record<string, unknown>): Refused | null {
  const found =
    findNonRegistryDependency(pkg) ??
    findNonRegistryOverride(pkg.overrides, 'overrides') ??
    findNonRegistryOverride(pkg.resolutions, 'resolutions') ??
    findNonRegistryOverride(
      (pkg.pnpm as Record<string, unknown> | undefined)?.overrides,
      'pnpm.overrides',
    );
  return found
    ? refuse(HostInstallRefusal.NonRegistryDependency, `.kici/package.json ${found}`)
    : null;
}

/** Find the lockfile to stage and refuse any non-registry entry in it. */
async function checkLockfile(
  kiciDir: string,
  pm: HostInstallPlan['packageManager'],
  registries: readonly URL[],
): Promise<{ lockfile: string | null } | Refused> {
  for (const name of LOCKFILES[pm]) {
    const path = join(kiciDir, name);
    if (!(await lstatOrNull(path))) continue;
    let lock: Record<string, unknown> | null;
    try {
      lock =
        pm === PackageManager.Pnpm
          ? (parseYaml(await readFile(path, 'utf-8')) as Record<string, unknown> | null)
          : await parseJsonFile(path);
    } catch {
      lock = null;
    }
    if (!lock || typeof lock !== 'object') {
      return refuse(HostInstallRefusal.UnreadableManifest, `.kici/${name} does not parse`);
    }
    const exotic =
      pm === PackageManager.Pnpm
        ? findNonRegistryPnpmLockEntry(lock, registries)
        : findNonRegistryNpmLockEntry(lock, registries);
    if (exotic) return refuse(HostInstallRefusal.NonRegistryDependency, `.kici/${name}: ${exotic}`);
    return { lockfile: name };
  }
  return { lockfile: null };
}

/**
 * Refuse a workflow-declared registry (the job's `registries:`) whose origin
 * is not in `allowed`. The workflow chose it, and its token would be sent
 * there from outside the job network's egress filter.
 */
function checkWorkflowRegistries(
  workflow: readonly NpmRegistrySpec[],
  allowed: ReadonlySet<string>,
): Refused | null {
  for (const registry of workflow) {
    const origin = registryOrigin(registry.url);
    // fails-when: a workflow `registries:` entry on the agent loopback or LAN
    // passes, so the host npm contacts an origin the repository chose.
    // breaks-if-wrong: an entry on an origin in KICI_HOST_INSTALL_REGISTRIES,
    // or on npm's public registry, passes.
    if (!origin || !allowed.has(origin)) {
      return refuse(
        HostInstallRefusal.UnmanagedRegistry,
        `the job's registries: names ${registry.url}, not an origin the operator allows for the host install (KICI_HOST_INSTALL_REGISTRIES)`,
      );
    }
  }
  return null;
}

/**
 * Refuse a `registry` or `@scope:registry` in `.kici/.npmrc` whose origin is
 * not in `allowed`, so the install contacts only origins the operator chose.
 */
function checkRepoRegistries(repo: NpmrcEntries, allowed: ReadonlySet<string>): Refused | null {
  for (const [key, value] of Object.entries(repo)) {
    if (!isRegistryKey(key)) continue;
    const origin = typeof value === 'string' ? registryOrigin(value) : null;
    // fails-when: a repository registry on the agent loopback or LAN passes, so
    // the host npm contacts an origin the repository chose.
    // breaks-if-wrong: a registry on an allowed origin, or npm's public one, passes.
    if (!origin || !allowed.has(origin)) {
      return refuse(
        HostInstallRefusal.UnmanagedRegistry,
        `.kici/.npmrc sets ${key} = ${JSON.stringify(value)}, not an origin the operator allows for the host install (KICI_HOST_INSTALL_REGISTRIES)`,
      );
    }
  }
  return null;
}

/**
 * Refuse a kept registry-auth value that references a variable npm, pnpm or
 * Node reads. The install passes an install secret only under a name such a
 * value references, so this keeps a secret named `HTTPS_PROXY` or
 * `NODE_OPTIONS` out of the install's environment.
 */
function checkAuthEnvReferences(npmrc: HostInstallPlan['npmrc']): Refused | null {
  // Only portable variable names are tested: `authEnvReferences` also yields the
  // whole reference text, such as `NPM_TOKEN?`, which no install secret is named.
  const toolRead = [...authEnvReferences([npmrc.operator, npmrc.repo])]
    .filter(isEnvVarName)
    .filter(isToolReadEnvName);
  // fails-when: `//r/:_authToken=${HTTPS_PROXY}` passes, so an install secret
  // named HTTPS_PROXY routes the host install through a proxy the workflow chose.
  // breaks-if-wrong: `${NPM_TOKEN}`, `${NPM_TOKEN?}` and `${NODE_AUTH_TOKEN}` pass.
  if (toolRead.length === 0) return null;
  return refuse(
    HostInstallRefusal.ToolEnvReference,
    `an .npmrc auth value references ${toolRead.join(', ')}, which npm, pnpm or Node reads`,
  );
}

/** The allowlisted `.npmrc` inputs, or a refusal from either repository `.npmrc`. */
async function resolveNpmrc(
  workflowDir: string,
  kiciDir: string,
  opts: HostInstallEligibilityOptions,
): Promise<HostInstallPlan['npmrc'] | Refused> {
  const ini = opts.ini === undefined ? loadNpmIni() : opts.ini;
  if (!ini) {
    return refuse(HostInstallRefusal.NpmrcParserUnavailable, "the agent's npm is not available");
  }
  const workflow = opts.workflowRegistries ?? [];
  if (
    workflow.some(
      (r) => UNSAFE_REGISTRY_FIELD.test(r.url) || UNSAFE_REGISTRY_FIELD.test(r.scope ?? ''),
    )
  ) {
    return refuse(
      HostInstallRefusal.UnsafeNpmrc,
      "a registry URL or scope in the job's registries: is not a plain value",
    );
  }
  const kiciNpmrc = await readRepoNpmrc(join(kiciDir, '.npmrc'), '.kici/.npmrc', ini);
  if ('refusal' in kiciNpmrc) return kiciNpmrc;
  const rootNpmrc = await readRepoNpmrc(join(workflowDir, '.npmrc'), 'the repository .npmrc', ini);
  if ('refusal' in rootNpmrc) return rootNpmrc;
  const operatorText =
    opts.operatorNpmrc === undefined
      ? await readOptional(join(homedir(), '.npmrc'))
      : opts.operatorNpmrc;
  return {
    ini,
    // The operator's file is not refused for its bytes: only parsed pairs are
    // kept, and each kept value is checked for control characters.
    operator: pickAllowed(operatorText ? ini.decode(operatorText) : {}, isOperatorNpmrcKey),
    repo: pickAllowed(kiciNpmrc.entries, isRepoNpmrcKey),
  };
}

/**
 * Decide whether the `.kici/` of `workflowDir` may be installed on the host.
 * Package-manager detection matches the in-container install: the repository
 * root's manifests first, then `.kici/`, then npm.
 */
export async function checkHostInstallEligibility(
  workflowDir: string,
  opts: HostInstallEligibilityOptions = {},
): Promise<HostInstallEligibility> {
  const kiciDir = join(workflowDir, '.kici');
  const symlink = await checkNoSymlinks(workflowDir, kiciDir);
  if (symlink) return symlink;

  const pkg = await parseJsonFile(join(kiciDir, 'package.json'));
  if (!pkg)
    return refuse(HostInstallRefusal.UnreadableManifest, '.kici/package.json does not parse');

  const pm =
    (await detectPackageManagerFromManifests(workflowDir)) ??
    (await detectPackageManagerFromManifests(kiciDir)) ??
    PackageManager.Npm;
  const shape = await checkToolingShape(workflowDir, kiciDir, pm, pkg);
  if (shape) return shape;
  const packageManager = pm as HostInstallPlan['packageManager'];

  const specs = checkManifestSpecs(pkg);
  if (specs) return specs;

  const npmrc = await resolveNpmrc(workflowDir, kiciDir, opts);
  if ('refusal' in npmrc) return npmrc;
  const toolEnv = checkAuthEnvReferences(npmrc);
  if (toolEnv) return toolEnv;

  const registries = allowedRegistries([npmrc.operator], opts.hostInstallRegistries ?? []);
  const origins = new Set(registries.map((u) => u.origin));
  const unallowed =
    checkWorkflowRegistries(opts.workflowRegistries ?? [], origins) ??
    checkRepoRegistries(npmrc.repo, origins);
  if (unallowed) return unallowed;
  const lock = await checkLockfile(kiciDir, packageManager, registries);
  if ('refusal' in lock) return lock;
  return {
    eligible: true,
    plan: { packageManager, lockfile: lock.lockfile, registries, npmrc },
  };
}
