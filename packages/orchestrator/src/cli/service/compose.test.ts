/**
 * Tests for the Docker/Podman Compose service manager.
 *
 * Mocks child_process.execSync and fs operations to test compose file
 * generation and lifecycle commands without requiring Docker/Podman.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServiceConfig } from './types.js';
import { DEFAULT_RESTART_POLICY } from './types.js';

// Mock child_process
const mockExecSync = vi.fn();
vi.mock('node:child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// Mock fs
const mockExistsSync = vi.fn(() => false);
const mockMkdirSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockUnlinkSync = vi.fn();
const mockRmSync = vi.fn();
const mockReadFileSync = vi.fn(() => '');
// Drive the digest-pinned image ref deterministically so the compose output
// asserts the `:<version>@sha256:` form without depending on the on-disk
// installer-image-digests.json (node:fs is mocked below).
const DIGEST = 'a'.repeat(64);
vi.mock('./image-digests.js', () => ({
  resolveImageRef: (name: string) => `quay.io/kici-dev/${name}:0.1.15@sha256:${DIGEST}`,
}));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: (...args: unknown[]) => mockExistsSync(...args),
      mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
      writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
      unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
      rmSync: (...args: unknown[]) => mockRmSync(...args),
      readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    },
  };
});

const testConfig: ServiceConfig = {
  name: 'kici-orchestrator',
  displayName: 'KiCI Orchestrator',
  description: 'KiCI orchestrator service',
  executablePath: '/usr/local/bin/kici-orchestrator',
  envFilePath: '/etc/kici/kici-orchestrator.env',
  workingDirectory: '/var/lib/kici',
  isUserLevel: false,
  restartPolicy: DEFAULT_RESTART_POLICY,
};

describe('ComposeServiceManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    // Default: podman compose available
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('podman compose version')) {
        return Buffer.from('podman compose version v2.0.0');
      }
      if (typeof cmd === 'string' && cmd.includes('docker compose version')) {
        return Buffer.from('Docker Compose version v2.24.0');
      }
      return Buffer.from('');
    });
  });

  describe('runtime detection', () => {
    it('detects podman compose first', async () => {
      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      await mgr.install(testConfig);

      // The compose file write should have been called
      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    it('falls back to docker compose when podman unavailable', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('podman compose version')) {
          throw new Error('not found');
        }
        if (typeof cmd === 'string' && cmd.includes('docker compose version')) {
          return Buffer.from('Docker Compose version v2.24.0');
        }
        return Buffer.from('');
      });

      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      await mgr.install(testConfig);

      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    it('throws when neither runtime is available', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (
          typeof cmd === 'string' &&
          (cmd.includes('podman compose version') || cmd.includes('docker compose version'))
        ) {
          throw new Error('not found');
        }
        return Buffer.from('');
      });

      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();

      await expect(mgr.install(testConfig)).rejects.toThrow(/no container runtime.*found/i);
    });
  });

  describe('install', () => {
    it('generates a compose YAML file', async () => {
      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      await mgr.install(testConfig);

      expect(mockWriteFileSync).toHaveBeenCalled();
      const [filePath, content] = mockWriteFileSync.mock.calls[0];
      expect(filePath).toContain('compose.yaml');
      expect(content).toContain('kici-orchestrator');
      expect(content).toContain('restart');
    });

    it('pins the image by manifest-list digest from quay.io/kici-dev (not GHCR or any other registry)', async () => {
      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      await mgr.install(testConfig);

      const [, content] = mockWriteFileSync.mock.calls[0];
      expect(content).toContain(
        `image: quay.io/kici-dev/kici-orchestrator:0.1.15@sha256:${DIGEST}`,
      );
      expect(content).not.toContain('ghcr.io');
      expect(content).not.toContain('docker.io/kici-dev');
    });

    it('derives the image name from config.name (e.g., kici-agent maps to kici-agent)', async () => {
      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      const agentConfig: ServiceConfig = { ...testConfig, name: 'kici-agent' };
      await mgr.install(agentConfig);

      const [, content] = mockWriteFileSync.mock.calls[0];
      expect(content).toContain(`image: quay.io/kici-dev/kici-agent:0.1.15@sha256:${DIGEST}`);
    });

    it('includes env_file in compose YAML', async () => {
      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      await mgr.install(testConfig);

      const [, content] = mockWriteFileSync.mock.calls[0];
      expect(content).toContain('env_file');
      expect(content).toContain('kici-orchestrator.env');
    });

    it('includes volume mounts for working directory', async () => {
      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      await mgr.install(testConfig);

      const [, content] = mockWriteFileSync.mock.calls[0];
      expect(content).toContain('volumes');
    });

    it('creates compose file directory', async () => {
      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      await mgr.install(testConfig);

      expect(mockMkdirSync).toHaveBeenCalledWith(expect.stringContaining('/etc/kici'), {
        recursive: true,
      });
    });
  });

  describe('start', () => {
    it('runs compose up -d', async () => {
      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      await mgr.start(testConfig);

      const upCall = mockExecSync.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('up -d'),
      );
      expect(upCall).toBeDefined();
    });
  });

  describe('stop', () => {
    it('runs compose down', async () => {
      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      await mgr.stop(testConfig);

      const downCall = mockExecSync.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('down'),
      );
      expect(downCall).toBeDefined();
    });
  });

  describe('restart', () => {
    it('runs compose restart', async () => {
      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      await mgr.restart(testConfig);

      const restartCall = mockExecSync.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('restart'),
      );
      expect(restartCall).toBeDefined();
    });
  });

  describe('status', () => {
    it('parses running container status from JSON', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('ps --format json')) {
          return Buffer.from(
            JSON.stringify({
              Name: 'kici-orchestrator',
              State: 'running',
              Status: 'Up 5 minutes',
            }),
          );
        }
        if (typeof cmd === 'string' && cmd.includes('compose version')) {
          return Buffer.from('podman compose version v2.0.0');
        }
        return Buffer.from('');
      });

      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      const s = await mgr.status(testConfig);

      expect(s.state).toBe('running');
    });

    it('returns stopped when container is not running', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('ps --format json')) {
          return Buffer.from(
            JSON.stringify({
              Name: 'kici-orchestrator',
              State: 'exited',
              Status: 'Exited (0) 5 minutes ago',
            }),
          );
        }
        if (typeof cmd === 'string' && cmd.includes('compose version')) {
          return Buffer.from('podman compose version v2.0.0');
        }
        return Buffer.from('');
      });

      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      const s = await mgr.status(testConfig);

      expect(s.state).toBe('stopped');
    });

    it('returns unknown on query failure', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('ps --format json')) {
          throw new Error('no such service');
        }
        if (typeof cmd === 'string' && cmd.includes('compose version')) {
          return Buffer.from('podman compose version v2.0.0');
        }
        return Buffer.from('');
      });

      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      const s = await mgr.status(testConfig);

      expect(s.state).toBe('unknown');
    });
  });

  describe('uninstall', () => {
    it('runs compose down and removes compose file', async () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        if (typeof p === 'string' && p.includes('compose.yaml')) return true;
        return false;
      });

      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      await mgr.uninstall(testConfig);

      const downCall = mockExecSync.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('down'),
      );
      expect(downCall).toBeDefined();
      expect(mockUnlinkSync).toHaveBeenCalled();
    });
  });

  describe('isInstalled', () => {
    it('returns true when compose file exists', async () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        if (typeof p === 'string' && p.includes('compose.yaml')) return true;
        return false;
      });

      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      expect(await mgr.isInstalled(testConfig)).toBe(true);
    });

    it('returns false when compose file does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      expect(await mgr.isInstalled(testConfig)).toBe(false);
    });
  });

  describe('logs', () => {
    it('runs compose logs', async () => {
      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      await mgr.logs(testConfig, {});

      const logsCall = mockExecSync.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('logs'),
      );
      expect(logsCall).toBeDefined();
    });

    it('adds --follow flag when follow option is set', async () => {
      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      await mgr.logs(testConfig, { follow: true });

      const logsCall = mockExecSync.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === 'string' &&
          (c[0] as string).includes('logs') &&
          (c[0] as string).includes('--follow'),
      );
      expect(logsCall).toBeDefined();
    });
  });

  describe('component label + list()', () => {
    it('embeds dev.kici.component label in the compose YAML when component is set', async () => {
      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      await mgr.install({ ...testConfig, component: 'orchestrator' });

      const [, content] = mockWriteFileSync.mock.calls[0];
      expect(content).toMatch(/dev\.kici\.component:\s*['"]?orchestrator['"]?/);
    });

    it('omits the dev.kici.component label when component is not set', async () => {
      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      await mgr.install(testConfig);

      const [, content] = mockWriteFileSync.mock.calls[0];
      expect(content).not.toContain('dev.kici.component');
    });

    it('embeds dev.kici.instance-dir label in the compose YAML when instanceDir is set', async () => {
      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      await mgr.install({ ...testConfig, component: 'orchestrator', instanceDir: '/srv/kici-x' });

      const [, content] = mockWriteFileSync.mock.calls[0];
      expect(content).toMatch(/dev\.kici\.instance-dir:\s*['"]?\/srv\/kici-x['"]?/);
    });

    it('omits the dev.kici.instance-dir label when instanceDir is not set', async () => {
      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      await mgr.install({ ...testConfig, component: 'orchestrator' });

      const [, content] = mockWriteFileSync.mock.calls[0];
      expect(content).not.toContain('dev.kici.instance-dir');
    });

    it('recovers instanceDir from the dev.kici.instance-dir label', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('podman compose version')) {
          return Buffer.from('podman compose version v2.0.0');
        }
        if (typeof cmd === 'string' && cmd.includes('ps -a --filter label=dev.kici.component')) {
          return Buffer.from(
            '{"Names":"kici-bar","Labels":"dev.kici.component=orchestrator,dev.kici.instance-dir=/srv/kici-bar"}',
          );
        }
        return Buffer.from('');
      });

      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      const result = await mgr.list(true);

      expect(result).toContainEqual({
        name: 'kici-bar',
        platform: 'compose',
        isUserLevel: true,
        component: 'orchestrator',
        instanceDir: '/srv/kici-bar',
      });
    });

    it('parses podman ps JSON rows and yields DiscoveredInstance entries', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('podman compose version')) {
          return Buffer.from('podman compose version v2.0.0');
        }
        if (typeof cmd === 'string' && cmd.includes('ps -a --filter label=dev.kici.component')) {
          return Buffer.from(
            [
              '{"Names":"kici-bar","Labels":"dev.kici.component=agent,other.label=x"}',
              '{"Names":"kici-baz","Labels":"unrelated.label=y"}',
            ].join('\n'),
          );
        }
        return Buffer.from('');
      });

      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      const result = await mgr.list(true);

      expect(result).toContainEqual({
        name: 'kici-bar',
        platform: 'compose',
        isUserLevel: true,
        component: 'agent',
      });
      expect(result.find((r) => r.name === 'kici-baz')).toBeUndefined();
    });

    it('returns an empty array when the runtime probe throws', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (
          typeof cmd === 'string' &&
          (cmd.includes('podman compose version') || cmd.includes('docker compose version'))
        ) {
          throw new Error('not found');
        }
        return Buffer.from('');
      });

      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      const result = await mgr.list(true);

      expect(result).toEqual([]);
    });

    it('returns an empty array when podman ps emits no rows', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('podman compose version')) {
          return Buffer.from('podman compose version v2.0.0');
        }
        if (typeof cmd === 'string' && cmd.includes('ps -a --filter label=dev.kici.component')) {
          return Buffer.from('');
        }
        return Buffer.from('');
      });

      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      const result = await mgr.list(true);

      expect(result).toEqual([]);
    });
  });

  describe('readLaunchSpec', () => {
    it('returns null (compose is image-tag pinned)', async () => {
      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      expect(await mgr.readLaunchSpec(testConfig)).toBeNull();
    });
  });
});
