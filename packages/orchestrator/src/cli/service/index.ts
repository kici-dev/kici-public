/**
 * Service management entry point.
 *
 * Re-exports all types and provides a factory function that returns
 * the correct ServiceManager implementation for the detected (or
 * specified) platform. Uses dynamic imports to avoid loading all
 * platform-specific code on every platform.
 */

export type {
  ServiceManager,
  ServiceConfig,
  LaunchSpec,
  ServiceStatus,
  ServiceState,
  ServicePlatform,
  RestartPolicy,
  LogOptions,
} from './types.js';
export { DEFAULT_RESTART_POLICY } from './types.js';
export {
  detectPlatform,
  isRoot,
  kiciConfigRoot,
  getConfigDir,
  getLogDir,
  getCacheDir,
} from './platform-detect.js';
export { resolveUserLevel, type PrivilegeOpts } from './privilege.js';

// Instance types + helpers (folder-anchored targeting).
export type {
  Component,
  InstanceManifest,
  IndexEntry,
  ResolveOptions,
  ResolvedInstance,
} from './instance/types.js';
export { COMPONENTS, isComponent } from './instance/types.js';

// Manifest read/write.
export {
  manifestFilename,
  manifestPath,
  readManifest,
  writeManifest,
  readKiciVersion,
  resolveVersionFromLaunchSpec,
} from './instance/manifest.js';

// Reconciled instance index cache.
export {
  indexPath,
  readIndex,
  writeIndex,
  appendIndexEntry,
  removeIndexEntry,
} from './instance/index-file.js';

// Resolve dispatcher + reconciled listing + refusal formatter.
export { listInstances, resolveInstance, formatRefusal } from './instance/resolve.js';
export type { ListedInstance, ResolveArgs, ListInstancesArgs } from './instance/resolve.js';

import type { ServiceManager, ServicePlatform } from './types.js';

/**
 * Create a ServiceManager for the given platform.
 *
 * Uses dynamic imports so only the relevant platform code is loaded.
 * For example, on Linux only the systemd module is imported, not
 * Windows or launchd code.
 *
 * @param platform - Target platform (from detectPlatform() or --platform flag)
 * @returns The appropriate ServiceManager implementation
 */
export async function createServiceManager(platform: ServicePlatform): Promise<ServiceManager> {
  switch (platform) {
    case 'systemd': {
      const { SystemdServiceManager } = await import('./systemd.js');
      return new SystemdServiceManager();
    }
    case 'launchd': {
      const { LaunchdServiceManager } = await import('./launchd.js');
      return new LaunchdServiceManager();
    }
    case 'windows': {
      const { WindowsServiceManager } = await import('./windows.js');
      return new WindowsServiceManager();
    }
    case 'compose': {
      const { ComposeServiceManager } = await import('./compose.js');
      return new ComposeServiceManager();
    }
    default: {
      const _exhaustive: never = platform;
      throw new Error(`Unsupported platform: ${_exhaustive}`);
    }
  }
}
