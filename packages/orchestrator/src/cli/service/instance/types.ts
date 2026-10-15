/**
 * A service instance is identified by (component, name, instanceDir). The
 * deploy folder holds the manifest; `<kiciRoot>/instances.json` is a
 * reconciled cache of the host's installed instances.
 */

import type { ServicePlatform } from '../types.js';

export type Component = 'orchestrator' | 'agent';

export const COMPONENTS: readonly Component[] = ['orchestrator', 'agent'] as const;

export function isComponent(value: string): value is Component {
  return value === 'orchestrator' || value === 'agent';
}

/**
 * The `./.kici-<component>.json` that `install` writes into the deploy folder:
 * everything `resolveInstance` needs to rebuild a ServiceConfig without
 * re-deriving paths.
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
   * Installed version → the last migration applied while it ran. A version
   * switch checks it to refuse activating a version the database is ahead of
   * (see `schemaGuardVerdict`). Merged, never replaced, at every version
   * change; absent on older installs, which the guard warns about rather than
   * refuses.
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

export interface ResolveOptions {
  instanceDir?: string;
  name?: string;
}

/** What `resolveInstance` returns. */
export interface ResolvedInstance {
  manifest: InstanceManifest;
  manifestPath: string;
  instanceDir: string;
}
