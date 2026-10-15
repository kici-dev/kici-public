/** Service management entry point: re-exports and the per-platform ServiceManager factory. */

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
export { DEFAULT_RESTART_POLICY, SERVICE_TEXT } from './types.js';
export {
  detectPlatform,
  isRoot,
  kiciConfigRoot,
  getConfigDir,
  getLogDir,
  getCacheDir,
} from './platform-detect.js';
export { resolveUserLevel, type PrivilegeOpts } from './privilege.js';
export { restrictEnvFileAccess } from './windows-acl.js';
export {
  ENV_FILE_LOADER_EXPORT,
  envFileRefusal,
  launchReadsEnvFile,
  launchedRelease,
} from './windows-env-file.js';

// Folder-anchored instance targeting.
export type {
  Component,
  InstanceManifest,
  IndexEntry,
  ResolveOptions,
  ResolvedInstance,
} from './instance/types.js';
export { COMPONENTS, isComponent } from './instance/types.js';

export {
  manifestFilename,
  manifestPath,
  readManifest,
  writeManifest,
  readKiciVersion,
  resolveVersionFromLaunchSpec,
  resolveLauncherVersion,
  writeInstallManifest,
  type InstallManifestWrite,
  resolveNpmInstallTarget,
  type NpmInstallTarget,
} from './instance/manifest.js';

export {
  indexPath,
  readIndex,
  writeIndex,
  appendIndexEntry,
  removeIndexEntry,
} from './instance/index-file.js';

export {
  candidatePlatforms,
  listInstances,
  resolveInstance,
  resolveInstanceTarget,
  formatRefusal,
  InstanceNotFoundError,
} from './instance/resolve.js';
export type {
  ListedInstance,
  ResolveArgs,
  ListInstancesArgs,
  ResolveTargetArgs,
  ResolvedTarget,
} from './instance/resolve.js';

import type { ServiceManager, ServicePlatform } from './types.js';

/** Dynamic imports load only the target platform's driver. */
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
