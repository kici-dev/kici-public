/** Init-system detection and the per-platform config, log and cache directories. */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { ServicePlatform } from './types.js';

/**
 * Linux without systemd falls back to Docker/Podman Compose.
 *
 * @param override - Forces a platform (the --platform flag).
 */
export function detectPlatform(override?: ServicePlatform): ServicePlatform {
  if (override) return override;

  const plat = os.platform();

  if (plat === 'win32') return 'windows';
  if (plat === 'darwin') return 'launchd';

  if (fs.existsSync('/run/systemd/system') || fs.existsSync('/sys/fs/cgroup/systemd')) {
    return 'systemd';
  }

  return 'compose';
}

/** Root on Unix (UID 0) or admin on Windows. */
export function isRoot(): boolean {
  if (os.platform() === 'win32') {
    // `net session` succeeds only as admin.
    try {
      const { execSync } = require('node:child_process');
      execSync('net session', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/**
 * The config root holding every per-instance subdir for this privilege level,
 * plus the instance index (`<kiciRoot>/instances.json`).
 *
 * `KICI_CONFIG_ROOT` overrides it for both scopes, so a test harness or
 * sandboxed run gets an isolated index; a shared `~/.config/kici/` lets
 * concurrent installs clobber each other's index.
 */
export function kiciConfigRoot(isUserLevel: boolean): string {
  const override = process.env.KICI_CONFIG_ROOT;
  if (override) {
    const sep = os.platform() === 'win32' ? '\\' : '/';
    return override.endsWith(sep) ? override : override + sep;
  }

  const plat = os.platform();

  if (plat === 'win32') {
    if (isUserLevel) {
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      return localAppData + '\\kici\\';
    }
    return 'C:\\ProgramData\\kici\\';
  }

  if (!isUserLevel) {
    return '/etc/kici/';
  }

  if (plat === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'kici') + '/';
  }

  return path.join(os.homedir(), '.config', 'kici') + '/';
}

/**
 * `<kiciConfigRoot>/<serviceName>/`: the home of everything one instance owns
 * (env file, unit references).
 */
export function getConfigDir(serviceName: string, isUserLevel: boolean): string {
  const root = kiciConfigRoot(isUserLevel);
  const sep = os.platform() === 'win32' ? '\\' : '/';
  return root + serviceName + sep;
}

/** One log directory per instance, named by `serviceName`. */
export function getLogDir(serviceName: string, isUserLevel: boolean): string {
  const plat = os.platform();

  if (plat === 'win32') {
    return 'C:\\ProgramData\\kici\\' + serviceName + '\\logs\\';
  }

  if (!isUserLevel) {
    return '/var/log/kici/' + serviceName + '/';
  }

  if (plat === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Logs', 'kici', serviceName) + '/';
  }

  return path.join(os.homedir(), '.local', 'share', 'kici', serviceName, 'logs') + '/';
}

/** The lazy-dependency download cache; `$XDG_CACHE_HOME` wins on every platform. */
export function getCacheDir(): string {
  const plat = os.platform();

  if (process.env.XDG_CACHE_HOME) {
    return path.join(process.env.XDG_CACHE_HOME, 'kici', 'deps') + '/';
  }

  if (plat === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return localAppData + '\\kici\\deps\\';
  }

  if (plat === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'kici', 'deps') + '/';
  }

  return path.join(os.homedir(), '.cache', 'kici', 'deps') + '/';
}
