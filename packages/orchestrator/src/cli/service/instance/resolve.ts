/**
 * resolveInstance — the single entry point every lifecycle command uses to
 * decide which installed service it's operating on.
 *
 * Priority:
 *   1. --instance-dir <path>       → read manifest at <path>
 *   2. --name <name>               → match against listInstances() result
 *   3. CWD manifest                → read ./.kici-<component>.json
 *   4. otherwise                   → refuse with a candidate list (throws)
 *
 * listInstances reconciles the on-disk index (cache) with the drivers'
 * native scans (source of truth). The reconciled result is rewritten back to
 * the index to self-heal stale entries.
 *
 * Discovery is platform-plural and operation is platform-singular. A host can
 * hold both a systemd install and a compose install, so finding an instance
 * scans every candidate driver; acting on the one that was found uses the
 * single driver its manifest names.
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
 * The drivers that can plausibly hold an install on this host.
 *
 * `--platform` forces one driver, so an operator keeps an escape hatch to
 * today's exact single-driver behaviour on every path. Otherwise the host's own
 * init system is joined by compose, which runs on any host with a container
 * runtime — a compose install on a systemd box is the case the single-driver
 * scan could not see.
 */
export function candidatePlatforms(override?: ServicePlatform): ServicePlatform[] {
  if (override) return [override];
  const host = detectPlatform();
  return host === 'compose' ? ['compose'] : [host, 'compose'];
}

/** Build a driver per candidate platform. */
async function candidateManagers(override?: ServicePlatform): Promise<ServiceManager[]> {
  return Promise.all(candidatePlatforms(override).map((p) => defaultCreateManager(p)));
}

export interface ListInstancesArgs {
  component: Component;
  isUserLevel: boolean;
  kiciRoot: string;
  /**
   * The drivers to scan. Omit to scan every candidate driver for this host.
   * Each driver is authoritative only over its own platform's index rows.
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
 * A driver reporting `available() === false` is omitted entirely rather than
 * contributing an empty scan: its registry is unreachable, so it has nothing to
 * say about whether its instances still exist.
 *
 * A driver whose scan throws is omitted on the same terms. `available()` is a
 * separate call, so a registry can go down in the gap between the two, and a
 * driver that reports a failed read as an error rather than as `[]` must not
 * have that error read as an empty scan — nor propagate out of a lifecycle
 * command that only wanted to resolve a name.
 *
 * Both drops are ANNOUNCED on stderr, naming the platform and the reason. A
 * dropped driver silently shortens the candidate list, so an operator whose
 * instance is missing would otherwise read "not installed" for what is really
 * "could not look" — and before this branch the throwing case was not swallowed
 * at all, so the error at least reached them. The warning is what keeps the
 * distinction the operator docs promise (`service-installation.md`) legible.
 *
 * `available()` is called INSIDE the same try: it runs a probe of its own
 * (compose shells out to the container runtime), so it can reject, and a
 * rejection there must drop this one driver rather than fail the whole
 * `Promise.all` and take every other platform's scan down with it.
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
 * rewrite the index so it mirrors the scanned instances that have a known
 * instanceDir. Two self-heal directions happen here:
 *
 *   - backward: drop index entries whose unit no longer exists.
 *   - forward: adopt an instanceDir a driver recovered from the unit marker
 *     when the index entry is missing or carries no dir — so a lost or emptied
 *     index rebuilds itself from the init system on the next read.
 *
 * The init system is therefore the source of truth for the name→folder mapping
 * (via the X-KiCI-InstanceDir / KiCIInstanceDir / dev.kici.instance-dir / [KiCI-DIR]
 * markers), and the index is a pure cache. Returns the merged list filtered to
 * the requested component + isUserLevel.
 *
 * The rewrite is scoped to the platforms that were actually scanned. A driver
 * speaks for its own platform's rows and for no others, so a systemd scan
 * cannot delete a compose install's row, and a driver that could not reach its
 * registry deletes nothing at all.
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
        // The driver is the authority on its own platform, so a row it returns is
        // stamped with it — which is what keeps every reconciled row inside the
        // scanned scope below.
        platform: scan.platform,
        component,
        // Prefer the index's recorded dir; fall back to the dir the driver
        // recovered from the unit marker.
        instanceDir: idx?.instanceDir ?? s.instanceDir,
        source: idx ? 'index+scan' : 'scan',
      });
    }
  }

  // The desired index state for the scanned platforms of this component+scope:
  // one entry per scanned instance whose instanceDir is known. Dead entries
  // (unit gone) drop out because they aren't in the scan; scan-recovered dirs
  // get adopted.
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

/** Order-insensitive equality of two index-entry sets (by their full identity). */
function sameIndexSet(a: IndexEntry[], b: IndexEntry[]): boolean {
  if (a.length !== b.length) return false;
  const key = (e: IndexEntry) =>
    `${e.component}\0${e.name}\0${e.platform}\0${e.isUserLevel}\0${e.instanceDir}`;
  const setA = new Set(a.map(key));
  return b.every((e) => setA.has(key(e)));
}

/**
 * Thrown by resolveInstance when `--name <n>` is given but no installed
 * instance matches. Lifecycle commands catch this to treat stop/uninstall of
 * a never-installed instance as an idempotent no-op. Distinct from the
 * ambiguous-refusal and missing-manifest errors, which stay hard failures.
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
  /**
   * Every driver discovery should scan. Omit to scan every candidate driver
   * for this host.
   */
  managers?: ServiceManager[];
  /**
   * Privilege scope to resolve against. Must match the caller's resolved
   * --system / --user-level decision so candidate lists and name lookups see
   * the correct set of installed instances.
   */
  isUserLevel: boolean;
}

/**
 * Resolve the target instance for the current lifecycle invocation.
 * Throws with a refusal/candidate-listing error when ambiguous.
 */
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

/**
 * Format the refusal message and candidate table.
 *
 * When candidates is empty, returns the "no instances installed" guidance.
 * When candidates exist, lists them with their instanceDir (or "(no manifest)").
 */
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

/** What {@link resolveInstanceTarget} is asked. */
export interface ResolveTargetArgs {
  component: Component;
  opts: ResolveOptions;
  cwd: string;
  kiciRoot: string;
  /**
   * Privilege scope to resolve against. Must match the caller's resolved
   * --system / --user-level decision.
   */
  isUserLevel: boolean;
  /**
   * The `--platform` flag. When set it forces the driver for both discovery and
   * operation, which is the operator's escape hatch to a single-driver run.
   */
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
 * Resolve the target instance and the driver that manages it.
 *
 * The question a lifecycle command asks is about the install, not the host: a
 * compose install stays a compose install on a systemd box. So discovery scans
 * every candidate driver, and the manifest that discovery produced then names
 * the single driver the command operates through. The two need not be the same
 * object, and only the second has to be right.
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
