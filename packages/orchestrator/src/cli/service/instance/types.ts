/**
 * Instance types — the shared shape of a folder-anchored service instance,
 * its on-disk manifest, the reconciled cache index, and the per-driver
 * discovery result.
 *
 * A KiCI service instance is identified by (component, name, instanceDir).
 * The deploy folder holds the manifest; the index at <kiciRoot>/instances.json
 * is a reconciled cache of all installed instances on the host.
 */

import type { ServicePlatform } from '../types.js';

/** The two KiCI components managed by `kici-admin` service commands. */
export type Component = 'orchestrator' | 'agent';

/** Enumerable list — used for iteration and discovery. */
export const COMPONENTS: readonly Component[] = ['orchestrator', 'agent'] as const;

/** Narrow an arbitrary string to a Component. */
export function isComponent(value: string): value is Component {
  return value === 'orchestrator' || value === 'agent';
}

/**
 * The manifest written by `install` into the deploy folder
 * (`./.kici-orchestrator.json` or `./.kici-agent.json`).
 *
 * Holds everything `resolveInstance` needs to reconstruct a ServiceConfig
 * without re-deriving paths.
 */
export interface InstanceManifest {
  component: Component;
  name: string;
  platform: ServicePlatform;
  isUserLevel: boolean;
  envFilePath: string;
  configDir: string;
  logDir: string;
  installBase: string;
  createdAt: string;
  kiciVersion: string;
  /**
   * Installed version → the last applied migration at the moment that version
   * was running.
   *
   * A rollback flips a symlink, and the previous release's static migration
   * provider does not carry the newer migrations' names — so Kysely refuses to
   * start against a ledger that records them, and the documented recovery
   * produces a second outage. This map is what lets the switch check whether
   * the database is ahead of the version it is about to activate.
   *
   * Merged, never replaced, at every version change. Absent on every instance
   * installed before this field existed, which the guard treats as "unknown"
   * and warns about rather than refusing.
   */
  migrationHeads?: Record<string, string>;
}

/** A row in `<kiciRoot>/instances.json`. */
export interface IndexEntry {
  component: Component;
  name: string;
  platform: ServicePlatform;
  isUserLevel: boolean;
  instanceDir: string;
}

/** CLI options that influence target resolution. */
export interface ResolveOptions {
  instanceDir?: string;
  name?: string;
}

/** Fully-resolved target — what `resolveInstance` returns. */
export interface ResolvedInstance {
  manifest: InstanceManifest;
  manifestPath: string;
  instanceDir: string;
}
