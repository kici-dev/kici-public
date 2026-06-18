/**
 * Tests for platform detection and directory resolution.
 *
 * Mocks os.platform(), os.homedir(), fs.existsSync(), and process.env
 * to cover all platform/privilege combinations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import {
  detectPlatform,
  isRoot,
  getConfigDir,
  getLogDir,
  getCacheDir,
  kiciConfigRoot,
} from './platform-detect.js';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: {
      ...actual,
      platform: vi.fn(() => 'linux'),
      homedir: vi.fn(() => '/home/testuser'),
    },
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
    },
  };
});

const mockedPlatform = os.platform as ReturnType<typeof vi.fn>;
const mockedHomedir = os.homedir as ReturnType<typeof vi.fn>;
const mockedExistsSync = fs.existsSync as ReturnType<typeof vi.fn>;

describe('platform-detect', () => {
  let originalGetuid: (() => number) | undefined;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalGetuid = process.getuid;
    savedEnv = { ...process.env };
    // Reset to defaults
    mockedPlatform.mockReturnValue('linux');
    mockedHomedir.mockReturnValue('/home/testuser');
    mockedExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    if (originalGetuid) {
      process.getuid = originalGetuid;
    } else {
      delete (process as Record<string, unknown>).getuid;
    }
    process.env = savedEnv;
  });

  describe('detectPlatform', () => {
    it('returns override when provided', () => {
      expect(detectPlatform('compose')).toBe('compose');
    });

    it('returns windows on win32', () => {
      mockedPlatform.mockReturnValue('win32');
      expect(detectPlatform()).toBe('windows');
    });

    it('returns launchd on darwin', () => {
      mockedPlatform.mockReturnValue('darwin');
      expect(detectPlatform()).toBe('launchd');
    });

    it('returns systemd on linux when /run/systemd/system exists', () => {
      mockedPlatform.mockReturnValue('linux');
      mockedExistsSync.mockImplementation((p: unknown) => p === '/run/systemd/system');
      expect(detectPlatform()).toBe('systemd');
    });

    it('returns systemd on linux when /sys/fs/cgroup/systemd exists', () => {
      mockedPlatform.mockReturnValue('linux');
      mockedExistsSync.mockImplementation((p: unknown) => p === '/sys/fs/cgroup/systemd');
      expect(detectPlatform()).toBe('systemd');
    });

    it('returns compose on linux without systemd', () => {
      mockedPlatform.mockReturnValue('linux');
      mockedExistsSync.mockReturnValue(false);
      expect(detectPlatform()).toBe('compose');
    });
  });

  describe('isRoot', () => {
    it('returns true when UID is 0', () => {
      process.getuid = () => 0;
      mockedPlatform.mockReturnValue('linux');
      expect(isRoot()).toBe(true);
    });

    it('returns false when UID is non-zero', () => {
      process.getuid = () => 1000;
      mockedPlatform.mockReturnValue('linux');
      expect(isRoot()).toBe(false);
    });
  });

  describe('getConfigDir', () => {
    it('returns /etc/kici/<name>/ for system-level Linux', () => {
      mockedPlatform.mockReturnValue('linux');
      expect(getConfigDir('orchestrator', false)).toBe('/etc/kici/orchestrator/');
    });

    it('returns ~/.config/kici/<name>/ for user-level Linux', () => {
      mockedPlatform.mockReturnValue('linux');
      mockedHomedir.mockReturnValue('/home/testuser');
      expect(getConfigDir('orchestrator', true)).toBe('/home/testuser/.config/kici/orchestrator/');
    });

    it('returns ~/Library/Application Support/kici/<name>/ for user-level macOS', () => {
      mockedPlatform.mockReturnValue('darwin');
      mockedHomedir.mockReturnValue('/Users/testuser');
      expect(getConfigDir('orchestrator', true)).toBe(
        '/Users/testuser/Library/Application Support/kici/orchestrator/',
      );
    });

    it('returns /etc/kici/<name>/ for system-level macOS', () => {
      mockedPlatform.mockReturnValue('darwin');
      expect(getConfigDir('orchestrator', false)).toBe('/etc/kici/orchestrator/');
    });

    it('returns C:\\ProgramData\\kici\\<name>\\ for Windows', () => {
      mockedPlatform.mockReturnValue('win32');
      expect(getConfigDir('orchestrator', false)).toBe('C:\\ProgramData\\kici\\orchestrator\\');
    });

    it('returns %LOCALAPPDATA%\\kici\\<name>\\ for user-level Windows', () => {
      mockedPlatform.mockReturnValue('win32');
      process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';
      expect(getConfigDir('orchestrator', true)).toBe(
        'C:\\Users\\test\\AppData\\Local\\kici\\orchestrator\\',
      );
    });
  });

  describe('getLogDir', () => {
    it('returns /var/log/kici/<name>/ for system-level', () => {
      mockedPlatform.mockReturnValue('linux');
      expect(getLogDir('orchestrator', false)).toBe('/var/log/kici/orchestrator/');
    });

    it('returns ~/.local/share/kici/<name>/logs/ for user-level Linux', () => {
      mockedPlatform.mockReturnValue('linux');
      mockedHomedir.mockReturnValue('/home/testuser');
      expect(getLogDir('orchestrator', true)).toBe(
        '/home/testuser/.local/share/kici/orchestrator/logs/',
      );
    });

    it('returns ~/Library/Logs/kici/<name>/ for user-level macOS', () => {
      mockedPlatform.mockReturnValue('darwin');
      mockedHomedir.mockReturnValue('/Users/testuser');
      expect(getLogDir('orchestrator', true)).toBe(
        '/Users/testuser/Library/Logs/kici/orchestrator/',
      );
    });

    it('returns C:\\ProgramData\\kici\\<name>\\logs\\ for Windows', () => {
      mockedPlatform.mockReturnValue('win32');
      expect(getLogDir('orchestrator', false)).toBe('C:\\ProgramData\\kici\\orchestrator\\logs\\');
    });
  });

  describe('name-scoped config + log dirs', () => {
    // Different service names produce different per-instance dirs.
    it('different service names produce different configDir paths', () => {
      mockedPlatform.mockReturnValue('linux');
      mockedHomedir.mockReturnValue('/home/u');
      expect(getConfigDir('kici-foo', true)).toBe('/home/u/.config/kici/kici-foo/');
      expect(getConfigDir('kici-bar', true)).toBe('/home/u/.config/kici/kici-bar/');
    });

    // Linux user
    it('user-level Linux configDir uses the service name', () => {
      mockedHomedir.mockReturnValue('/home/u');
      mockedPlatform.mockReturnValue('linux');
      expect(getConfigDir('kici-foo', true)).toBe('/home/u/.config/kici/kici-foo/');
    });
    it('user-level Linux logDir uses the service name', () => {
      mockedHomedir.mockReturnValue('/home/u');
      mockedPlatform.mockReturnValue('linux');
      expect(getLogDir('kici-foo', true)).toBe('/home/u/.local/share/kici/kici-foo/logs/');
    });

    // Linux system
    it('system Linux configDir uses the service name', () => {
      mockedPlatform.mockReturnValue('linux');
      expect(getConfigDir('kici-foo', false)).toBe('/etc/kici/kici-foo/');
    });
    it('system Linux logDir uses the service name', () => {
      mockedPlatform.mockReturnValue('linux');
      expect(getLogDir('kici-foo', false)).toBe('/var/log/kici/kici-foo/');
    });

    // macOS user
    it('user-level macOS configDir uses the service name', () => {
      mockedHomedir.mockReturnValue('/Users/u');
      mockedPlatform.mockReturnValue('darwin');
      expect(getConfigDir('kici-foo', true)).toBe(
        '/Users/u/Library/Application Support/kici/kici-foo/',
      );
    });
    it('user-level macOS logDir uses the service name', () => {
      mockedHomedir.mockReturnValue('/Users/u');
      mockedPlatform.mockReturnValue('darwin');
      expect(getLogDir('kici-foo', true)).toBe('/Users/u/Library/Logs/kici/kici-foo/');
    });

    // macOS system
    it('system macOS configDir uses the service name', () => {
      mockedPlatform.mockReturnValue('darwin');
      expect(getConfigDir('kici-foo', false)).toBe('/etc/kici/kici-foo/');
    });
    it('system macOS logDir uses the service name', () => {
      mockedPlatform.mockReturnValue('darwin');
      expect(getLogDir('kici-foo', false)).toBe('/var/log/kici/kici-foo/');
    });

    // Windows user
    it('user-level Windows configDir uses the service name', () => {
      process.env.LOCALAPPDATA = 'C:\\Users\\u\\AppData\\Local';
      mockedPlatform.mockReturnValue('win32');
      expect(getConfigDir('kici-foo', true)).toBe('C:\\Users\\u\\AppData\\Local\\kici\\kici-foo\\');
    });
    it('user-level Windows logDir uses the service name', () => {
      mockedPlatform.mockReturnValue('win32');
      expect(getLogDir('kici-foo', true)).toBe('C:\\ProgramData\\kici\\kici-foo\\logs\\');
    });

    // Windows system
    it('system Windows configDir uses the service name', () => {
      mockedPlatform.mockReturnValue('win32');
      expect(getConfigDir('kici-foo', false)).toBe('C:\\ProgramData\\kici\\kici-foo\\');
    });
    it('system Windows logDir uses the service name', () => {
      mockedPlatform.mockReturnValue('win32');
      expect(getLogDir('kici-foo', false)).toBe('C:\\ProgramData\\kici\\kici-foo\\logs\\');
    });

    // kiciConfigRoot — the name-agnostic root for the instance index
    it('kiciConfigRoot returns the name-AGNOSTIC root on user Linux', () => {
      mockedHomedir.mockReturnValue('/home/u');
      mockedPlatform.mockReturnValue('linux');
      expect(kiciConfigRoot(true)).toBe('/home/u/.config/kici/');
    });
    it('kiciConfigRoot returns the name-AGNOSTIC root on system Linux', () => {
      mockedPlatform.mockReturnValue('linux');
      expect(kiciConfigRoot(false)).toBe('/etc/kici/');
    });
    it('kiciConfigRoot returns the name-AGNOSTIC root on user macOS', () => {
      mockedHomedir.mockReturnValue('/Users/u');
      mockedPlatform.mockReturnValue('darwin');
      expect(kiciConfigRoot(true)).toBe('/Users/u/Library/Application Support/kici/');
    });
    it('kiciConfigRoot returns the name-AGNOSTIC root on system macOS', () => {
      mockedPlatform.mockReturnValue('darwin');
      expect(kiciConfigRoot(false)).toBe('/etc/kici/');
    });
    it('kiciConfigRoot returns the name-AGNOSTIC root on user Windows', () => {
      process.env.LOCALAPPDATA = 'C:\\Users\\u\\AppData\\Local';
      mockedPlatform.mockReturnValue('win32');
      expect(kiciConfigRoot(true)).toBe('C:\\Users\\u\\AppData\\Local\\kici\\');
    });
    it('kiciConfigRoot returns the name-AGNOSTIC root on system Windows', () => {
      mockedPlatform.mockReturnValue('win32');
      expect(kiciConfigRoot(false)).toBe('C:\\ProgramData\\kici\\');
    });
    it('kiciConfigRoot honors KICI_CONFIG_ROOT over the platform default (both scopes)', () => {
      mockedPlatform.mockReturnValue('linux');
      mockedHomedir.mockReturnValue('/home/u');
      process.env.KICI_CONFIG_ROOT = '/tmp/kici-isolated';
      expect(kiciConfigRoot(true)).toBe('/tmp/kici-isolated/');
      expect(kiciConfigRoot(false)).toBe('/tmp/kici-isolated/');
    });
    it('kiciConfigRoot leaves an existing trailing separator on KICI_CONFIG_ROOT intact', () => {
      mockedPlatform.mockReturnValue('linux');
      process.env.KICI_CONFIG_ROOT = '/tmp/kici-isolated/';
      expect(kiciConfigRoot(true)).toBe('/tmp/kici-isolated/');
    });
    it('kiciConfigRoot ignores an empty KICI_CONFIG_ROOT and falls back to the default', () => {
      mockedPlatform.mockReturnValue('linux');
      mockedHomedir.mockReturnValue('/home/u');
      process.env.KICI_CONFIG_ROOT = '';
      expect(kiciConfigRoot(true)).toBe('/home/u/.config/kici/');
    });
  });

  describe('getCacheDir', () => {
    it('uses XDG_CACHE_HOME when set', () => {
      mockedPlatform.mockReturnValue('linux');
      process.env.XDG_CACHE_HOME = '/custom/cache';
      expect(getCacheDir()).toBe('/custom/cache/kici/deps/');
    });

    it('falls back to ~/.cache/kici/deps/ on Linux', () => {
      mockedPlatform.mockReturnValue('linux');
      delete process.env.XDG_CACHE_HOME;
      mockedHomedir.mockReturnValue('/home/testuser');
      expect(getCacheDir()).toBe('/home/testuser/.cache/kici/deps/');
    });

    it('returns ~/Library/Caches/kici/deps/ on macOS', () => {
      mockedPlatform.mockReturnValue('darwin');
      delete process.env.XDG_CACHE_HOME;
      mockedHomedir.mockReturnValue('/Users/testuser');
      expect(getCacheDir()).toBe('/Users/testuser/Library/Caches/kici/deps/');
    });

    it('returns %LOCALAPPDATA%\\kici\\deps\\ on Windows', () => {
      mockedPlatform.mockReturnValue('win32');
      delete process.env.XDG_CACHE_HOME;
      process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';
      expect(getCacheDir()).toBe('C:\\Users\\test\\AppData\\Local\\kici\\deps\\');
    });
  });
});
