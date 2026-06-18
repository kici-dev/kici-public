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
 * listInstances reconciles the on-disk index (cache) with the driver's
 * native scan (source of truth). The reconciled result is rewritten back to
 * the index to self-heal stale entries.
 */

import path from 'node:path';
import type { DiscoveredInstance, ServiceManager } from '../types.js';
import { manifestPath, readManifest } from './manifest.js';
import { readIndex, writeIndex } from './index-file.js';
import type { Component, IndexEntry, ResolveOptions, ResolvedInstance } from './types.js';

/** A reconciled view of a discovered instance: driver scan + (maybe) index entry. */
export interface ListedInstance extends DiscoveredInstance {
  instanceDir?: string;
  source: 'index' | 'scan' | 'index+scan';
}

export interface ListInstancesArgs {
  component: Component;
  isUserLevel: boolean;
  kiciRoot: string;
  manager: ServiceManager;
}

/**
 * Reconcile <kiciRoot>/instances.json with the driver's native scan, then
 * rewrite the index so it mirrors the scanned instances that have a known
 * instanceDir. Two self-heal directions happen here:
 *
 *   - backward: drop index entries whose unit no longer exists.
 *   - forward: adopt an instanceDir the driver recovered from the unit marker
 *     when the index entry is missing or carries no dir — so a lost or emptied
 *     index rebuilds itself from the init system on the next read.
 *
 * The init system is therefore the source of truth for the name→folder mapping
 * (via the X-KiCI-InstanceDir / KiCIInstanceDir / dev.kici.instance-dir / [KiCI-DIR]
 * markers), and the index is a pure cache. Returns the merged list filtered to
 * the requested component + isUserLevel.
 */
export async function listInstances(args: ListInstancesArgs): Promise<ListedInstance[]> {
  const { component, isUserLevel, kiciRoot, manager } = args;
  const scan = await manager.list(isUserLevel);
  const scanForComponent = scan.filter((s) => s.component === component);

  const index = readIndex(kiciRoot);
  const relevantIndex = index.filter(
    (e) => e.component === component && e.isUserLevel === isUserLevel,
  );
  const indexByName = new Map(relevantIndex.map((e) => [e.name, e]));

  const listed = scanForComponent.map((s) => {
    const idx = indexByName.get(s.name);
    return {
      ...s,
      component,
      // Prefer the index's recorded dir; fall back to the dir the driver
      // recovered from the unit marker.
      instanceDir: idx?.instanceDir ?? s.instanceDir,
      source: idx ? 'index+scan' : 'scan',
    } satisfies ListedInstance;
  });

  // The desired index state for this component+scope: one entry per scanned
  // instance whose instanceDir is known. Dead entries (unit gone) drop out
  // because they aren't in the scan; scan-recovered dirs get adopted.
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

  if (!sameIndexSet(relevantIndex, reconciled)) {
    const others = index.filter(
      (e) => !(e.component === component && e.isUserLevel === isUserLevel),
    );
    writeIndex(kiciRoot, [...others, ...reconciled]);
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

export interface ResolveArgs {
  component: Component;
  opts: ResolveOptions;
  cwd: string;
  kiciRoot: string;
  manager: ServiceManager;
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
  const { component, opts, cwd, kiciRoot, manager, isUserLevel } = args;

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
      manager,
    });
    const match = candidates.find((c) => c.name === opts.name);
    if (!match) {
      throw new Error(formatNameNotFound(component, opts.name, candidates));
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
    manager,
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
