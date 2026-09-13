/**
 * Platform detection and directory resolution for KiCI service management.
 *
 * Detects the init system (systemd, launchd, Windows Services, or Compose fallback)
 * and resolves platform-appropriate directories for config, logs, and cache.
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { ServicePlatform } from './types.js';

/**
 * Detect the service management platform.
 *
 * Auto-detection order:
 * - win32 -> 'windows'
 * - darwin -> 'launchd'
 * - linux with /run/systemd/system or /sys/fs/cgroup/systemd -> 'systemd'
 * - linux without systemd -> 'compose' (Docker/Podman Compose fallback)
 *
 * @param override - Force a specific platform (e.g., from --platform flag)
 */
export function detectPlatform(override?: ServicePlatform): ServicePlatform {
  if (override) return override;

  const plat = os.platform();

  if (plat === 'win32') return 'windows';
  if (plat === 'darwin') return 'launchd';

  // Linux: check for systemd
  if (fs.existsSync('/run/systemd/system') || fs.existsSync('/sys/fs/cgroup/systemd')) {
    return 'systemd';
  }

  return 'compose';
}

/**
 * Check if the current process has root/admin privileges.
 *
 * - Unix: UID === 0
 * - Windows: attempts `net session` (succeeds only as admin)
 */
export function isRoot(): boolean {
  if (os.platform() === 'win32') {
    // On Windows, `net session` only succeeds when running as admin.
    // Since we can't easily test this in unit tests, we check for it
    // but the actual Windows check would use child_process.
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
 * Name-agnostic KiCI config root — the directory that contains every
 * per-instance config subdir for this privilege level.
 *
 * Paths follow platform conventions:
 * - System Linux/macOS: /etc/kici/
 * - User Linux: ~/.config/kici/
 * - User macOS: ~/Library/Application Support/kici/
 * - System Windows: C:\ProgramData\kici\
 * - User Windows: %LOCALAPPDATA%\kici\
 *
 * Used by the instance index (`<kiciRoot>/instances.json`) which lives
 * outside any per-instance subdir, and as the base for {@link getConfigDir}.
 *
 * `KICI_CONFIG_ROOT` overrides the platform default for both privilege scopes.
 * It exists so a test harness (or a sandboxed run) can point the instance index
 * at an isolated directory instead of sharing the host's `~/.config/kici/` —
 * which otherwise lets concurrent installs clobber each other's index.
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

  // Linux user-level
  return path.join(os.homedir(), '.config', 'kici') + '/';
}

/**
 * Get the configuration directory for a specific KiCI service instance.
 *
 * Returns `<kiciConfigRoot>/<serviceName>/`. The name-scoped subdir is the
 * folder-anchored home for everything belonging to one installed instance
 * (env file, generated unit references, future per-instance state).
 *
 * Examples:
 * - System Linux: /etc/kici/<name>/
 * - User Linux: ~/.config/kici/<name>/
 * - User macOS: ~/Library/Application Support/kici/<name>/
 * - System Windows: C:\ProgramData\kici\<name>\
 * - User Windows: %LOCALAPPDATA%\kici\<name>\
 */
export function getConfigDir(serviceName: string, isUserLevel: boolean): string {
  const root = kiciConfigRoot(isUserLevel);
  const sep = os.platform() === 'win32' ? '\\' : '/';
  return root + serviceName + sep;
}

/**
 * Get the log directory for a specific KiCI service instance.
 *
 * The per-platform layout matches the existing matrix; the service name is
 * injected as the per-instance segment so each instance has its own log dir:
 * - System Linux/macOS: /var/log/kici/<name>/
 * - User Linux: ~/.local/share/kici/<name>/logs/
 * - User macOS: ~/Library/Logs/kici/<name>/
 * - Windows: C:\ProgramData\kici\<name>\logs\
 */
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

  // Linux user-level
  return path.join(os.homedir(), '.local', 'share', 'kici', serviceName, 'logs') + '/';
}

/**
 * Get the cache directory for lazy dependency downloads.
 *
 * Resolution order:
 * 1. $XDG_CACHE_HOME/kici/deps/ (if set)
 * 2. Platform default:
 *    - Linux: ~/.cache/kici/deps/
 *    - macOS: ~/Library/Caches/kici/deps/
 *    - Windows: %LOCALAPPDATA%\kici\deps\
 */
export function getCacheDir(): string {
  const plat = os.platform();

  // XDG_CACHE_HOME takes precedence on any platform
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

  // Linux fallback
  return path.join(os.homedir(), '.cache', 'kici', 'deps') + '/';
}
