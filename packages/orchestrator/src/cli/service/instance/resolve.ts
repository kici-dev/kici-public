/**
 * resolveInstance picks the installed service every lifecycle command acts on.
 *
 * Priority:
 *   1. --instance-dir <path>       → read manifest at <path>
 *   2. --name <name>               → match against listInstances() result
 *   3. CWD manifest                → read ./.kici-<component>.json
 *   4. otherwise                   → refuse with a candidate list (throws)
 *
 * Discovery is platform-plural and operation is platform-singular: a host can
 * hold both a systemd and a compose install, so finding an instance scans every
 * candidate driver, and acting on it uses the single driver its manifest names.
 */

import path from 'node:path';
import type { DiscoveredInstance, ServiceManager, ServicePlatform } from '../types.js';
import { detectPlatform } from '../platform-detect.js';
import { manifestPath, readManifest } from './manifest.js';
import { readIndex, writeIndex } from './index-file.js';
import type { Component, IndexEntry, ResolveOptions, ResolvedInstance } from './types.js';

/** A reconciled view of a discovered instance: driver scan + (maybe) index entry. */
export interface ListedInstance extends DiscoveredInstance {
  instanceDir?: string;
  source: 'index' | 'scan' | 'index+scan';
}

/**
 * The drivers that can plausibly hold an install on this host. `--platform`
 * forces one driver, the operator's single-driver escape hatch. Otherwise the
 * host's init system is joined by compose, which runs on any host with a
 * container runtime, so a compose install on a systemd box is found.
 */
export function candidatePlatforms(override?: ServicePlatform): ServicePlatform[] {
  if (override) return [override];
  const host = detectPlatform();
  return host === 'compose' ? ['compose'] : [host, 'compose'];
}

async function candidateManagers(override?: ServicePlatform): Promise<ServiceManager[]> {
  return Promise.all(candidatePlatforms(override).map((p) => defaultCreateManager(p)));
}

export interface ListInstancesArgs {
  component: Component;
  isUserLevel: boolean;
  kiciRoot: string;
  /**
   * Omit to scan every candidate driver for this host. Each driver is
   * authoritative only over its own platform's index rows.
   */
  managers?: ServiceManager[];
}

/** A driver's scan, plus the platform it speaks for even when it found nothing. */
interface DriverScan {
  platform: ServicePlatform;
  rows: DiscoveredInstance[];
}

/**
 * Scan every driver that can answer, dropping the ones that cannot.
 *
 * A driver whose `available()` is false is omitted rather than contributing an
 * empty scan: an unreachable registry says nothing about whether its instances
 * exist. A driver whose scan throws is omitted on the same terms, since the
 * registry can go down between the two calls; the error must neither read as an
 * empty scan nor escape a command that only wanted to resolve a name.
 *
 * Both drops are ANNOUNCED on stderr with the platform and reason, so an
 * operator reads "could not look" rather than "not installed" — the
 * distinction `service-installation.md` promises.
 *
 * `available()` runs INSIDE the same try: its own probe (compose shells out to
 * the container runtime) can reject, and that must drop only this driver, not
 * fail the whole `Promise.all`.
 */
async function scanDrivers(
  managers: ServiceManager[],
  isUserLevel: boolean,
): Promise<DriverScan[]> {
  const scans = await Promise.all(
    managers.map(async (m) => {
      try {
        if (m.available && !(await m.available())) {
          console.warn(
            `[kici] the ${m.platform} service registry did not answer; skipping it. ` +
              `${m.platform} instances are not listed, and their index entries are left untouched.`,
          );
          return null;
        }
        return { platform: m.platform, rows: await m.list(isUserLevel) };
      } catch (err) {
        console.warn(
          `[kici] could not read the ${m.platform} service registry ` +
            `(${err instanceof Error ? err.message : String(err)}); skipping it. ` +
            `${m.platform} instances are not listed, and their index entries are left untouched.`,
        );
        return null;
      }
    }),
  );
  return scans.filter((s): s is DriverScan => s !== null);
}

/**
 * Reconcile <kiciRoot>/instances.json with the drivers' native scans, then
 * rewrite the index to mirror the scanned instances with a known instanceDir:
 *
 *   - backward: drop index entries whose unit no longer exists.
 *   - forward: adopt an instanceDir a driver recovered from the unit marker
 *     when the index entry is missing or has no dir, so a lost or emptied
 *     index rebuilds itself on the next read.
 *
 * The init system is the source of truth for the name→folder mapping (via the
 * X-KiCI-InstanceDir / KiCIInstanceDir / dev.kici.instance-dir / [KiCI-DIR]
 * markers); the index is a pure cache. Returns the list filtered to the
 * requested component + isUserLevel.
 *
 * The rewrite is scoped to the scanned platforms: a systemd scan cannot delete
 * a compose install's row, and a driver that could not reach its registry
 * deletes nothing.
 */
export async function listInstances(args: ListInstancesArgs): Promise<ListedInstance[]> {
  const { component, isUserLevel, kiciRoot } = args;
  const managers = args.managers ?? (await candidateManagers());
  const scans = await scanDrivers(managers, isUserLevel);
  const scannedPlatforms = new Set(scans.map((s) => s.platform));

  const index = readIndex(kiciRoot);
  const relevantIndex = index.filter(
    (e) => e.component === component && e.isUserLevel === isUserLevel,
  );
  // Keyed by platform as well as name: a union scan can legitimately hold two
  // instances of the same name on different platforms.
  const indexByKey = new Map(relevantIndex.map((e) => [`${e.platform}\0${e.name}`, e]));

  const listed: ListedInstance[] = [];
  for (const scan of scans) {
    for (const s of scan.rows) {
      if (s.component !== component) continue;
      const idx = indexByKey.get(`${scan.platform}\0${s.name}`);
      listed.push({
        ...s,
        // Stamping the driver's platform keeps every reconciled row inside the
        // scanned scope below.
        platform: scan.platform,
        component,
        instanceDir: idx?.instanceDir ?? s.instanceDir,
        source: idx ? 'index+scan' : 'scan',
      });
    }
  }

  // Dead entries (unit gone) drop out because they aren't in the scan;
  // scan-recovered dirs get adopted.
  const reconciled: IndexEntry[] = [];
  for (const l of listed) {
    if (!l.instanceDir) continue;
    reconciled.push({
      component,
      name: l.name,
      platform: l.platform,
      isUserLevel,
      instanceDir: l.instanceDir,
    });
  }

  const inScope = (e: IndexEntry) =>
    e.component === component && e.isUserLevel === isUserLevel && scannedPlatforms.has(e.platform);

  if (!sameIndexSet(relevantIndex.filter(inScope), reconciled)) {
    writeIndex(kiciRoot, [...index.filter((e) => !inScope(e)), ...reconciled]);
  }

  return listed;
}

/** Order-insensitive equality by full identity. */
function sameIndexSet(a: IndexEntry[], b: IndexEntry[]): boolean {
  if (a.length !== b.length) return false;
  const key = (e: IndexEntry) =>
    `${e.component}\0${e.name}\0${e.platform}\0${e.isUserLevel}\0${e.instanceDir}`;
  const setA = new Set(a.map(key));
  return b.every((e) => setA.has(key(e)));
}

/**
 * Thrown when `--name <n>` matches no installed instance. Lifecycle commands
 * catch it so stop/uninstall of a never-installed instance is an idempotent
 * no-op; the ambiguous-refusal and missing-manifest errors stay hard failures.
 */
export class InstanceNotFoundError extends Error {
  readonly component: Component;
  readonly instanceName: string;
  constructor(component: Component, instanceName: string, message: string) {
    super(message);
    this.name = 'InstanceNotFoundError';
    this.component = component;
    this.instanceName = instanceName;
  }
}

export interface ResolveArgs {
  component: Component;
  opts: ResolveOptions;
  cwd: string;
  kiciRoot: string;
  /** Omit to scan every candidate driver for this host. */
  managers?: ServiceManager[];
  /**
   * Must match the caller's resolved --system / --user-level decision so
   * candidate lists and name lookups see the right installed instances.
   */
  isUserLevel: boolean;
}

/** Throws a refusal listing the candidates when ambiguous. */
export async function resolveInstance(args: ResolveArgs): Promise<ResolvedInstance> {
  const { component, opts, cwd, kiciRoot, isUserLevel, managers } = args;

  if (opts.instanceDir) {
    const dir = path.resolve(opts.instanceDir);
    const m = readManifest(dir, component);
    if (!m) {
      throw new Error(
        `No ${component} manifest at ${manifestPath(dir, component)}. ` +
          `Did you install with --instance-dir ${dir}?`,
      );
    }
    return { manifest: m, manifestPath: manifestPath(dir, component), instanceDir: dir };
  }

  if (opts.name) {
    const candidates = await listInstances({
      component,
      isUserLevel,
      kiciRoot,
      managers,
    });
    const match = candidates.find((c) => c.name === opts.name);
    if (!match) {
      throw new InstanceNotFoundError(
        component,
        opts.name,
        formatNameNotFound(component, opts.name, candidates),
      );
    }
    if (!match.instanceDir) {
      throw new Error(
        `${component} instance "${opts.name}" exists in the init system but has no manifest. ` +
          `Pass --instance-dir <deploy folder> instead.`,
      );
    }
    const manifest = readManifest(match.instanceDir, component);
    if (!manifest) {
      throw new Error(
        `Manifest for ${component} instance "${opts.name}" missing at ${manifestPath(
          match.instanceDir,
          component,
        )}.`,
      );
    }
    return {
      manifest,
      manifestPath: manifestPath(match.instanceDir, component),
      instanceDir: match.instanceDir,
    };
  }

  const cwdManifest = readManifest(cwd, component);
  if (cwdManifest) {
    return {
      manifest: cwdManifest,
      manifestPath: manifestPath(cwd, component),
      instanceDir: path.resolve(cwd),
    };
  }

  const candidates = await listInstances({
    component,
    isUserLevel,
    kiciRoot,
    managers,
  });
  throw new Error(formatRefusal(component, candidates));
}

export function formatRefusal(component: Component, candidates: ListedInstance[]): string {
  if (candidates.length === 0) {
    return (
      `No ${component} instances installed on this host. ` +
      `Run \`kici-admin ${component} install --instance-dir <deploy folder>\` first.`
    );
  }
  const rows = candidates
    .map((c) => `  - ${c.name}  ${c.platform}  ${c.instanceDir ?? '(no manifest)'}`)
    .join('\n');
  return (
    `No instance specified and no manifest in CWD. ` +
    `Candidates on this host:\n${rows}\n` +
    `Pass --instance-dir <path> or --name <name>, or cd into the deploy folder.`
  );
}

function formatNameNotFound(
  component: Component,
  name: string,
  candidates: ListedInstance[],
): string {
  const rows = candidates.length
    ? candidates
        .map((c) => `  - ${c.name}  ${c.platform}  ${c.instanceDir ?? '(no manifest)'}`)
        .join('\n')
    : '  (none)';
  return `${component} instance "${name}" not found. Installed:\n${rows}`;
}

export interface ResolveTargetArgs {
  component: Component;
  opts: ResolveOptions;
  cwd: string;
  kiciRoot: string;
  /** Must match the caller's resolved --system / --user-level decision. */
  isUserLevel: boolean;
  /** `--platform`: forces the driver for both discovery and operation. */
  platformOverride?: ServicePlatform;
  /** Driver factory. Defaults to the service barrel's createServiceManager. */
  createManager?: (platform: ServicePlatform) => Promise<ServiceManager>;
}

/** The instance a lifecycle command operates on, and the driver that can do it. */
export interface ResolvedTarget {
  resolved: ResolvedInstance;
  manager: ServiceManager;
  /** The install's own platform — `platformOverride ?? manifest.platform`. */
  platform: ServicePlatform;
}

/**
 * Resolve the target instance and its driver. A compose install stays a compose
 * install on a systemd box, so discovery scans every candidate driver and the
 * found manifest names the single driver the command operates through.
 */
export async function resolveInstanceTarget(args: ResolveTargetArgs): Promise<ResolvedTarget> {
  const create = args.createManager ?? defaultCreateManager;
  const platforms = candidatePlatforms(args.platformOverride);
  const managers = await Promise.all(platforms.map((p) => create(p)));

  const resolved = await resolveInstance({
    component: args.component,
    opts: args.opts,
    cwd: args.cwd,
    kiciRoot: args.kiciRoot,
    isUserLevel: args.isUserLevel,
    managers,
  });

  const platform = args.platformOverride ?? resolved.manifest.platform;
  const discovered = platforms.indexOf(platform);
  const manager = discovered >= 0 ? managers[discovered]! : await create(platform);

  return { resolved, manager, platform };
}

/** The production driver factory, imported at call time to keep the barrel cycle open. */
async function defaultCreateManager(platform: ServicePlatform): Promise<ServiceManager> {
  const { createServiceManager } = await import('../index.js');
  return createServiceManager(platform);
}
