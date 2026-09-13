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

    it("grants the orchestrator more stop grace than compose's 10s default", async () => {
      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      await mgr.install(testConfig);

      // Compose kills at 10s by default, while the orchestrator's own
      // graceful-shutdown budget is 30s — so without this it is SIGKILLed
      // partway through, before it broadcasts `peer.leaving` or closes its
      // agent sockets.
      const [, content] = mockWriteFileSync.mock.calls[0];
      expect(content).toContain('stop_grace_period: 45s');
    });

    it('grants the agent a stop grace above its own force-exit budget', async () => {
      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      const agentConfig: ServiceConfig = { ...testConfig, name: 'kici-agent', component: 'agent' };
      await mgr.install(agentConfig);

      // The agent force-exits at 10s and then waits ~1s for abort handlers, so
      // compose's 10s default kills it before its own timer can fire.
      const [, content] = mockWriteFileSync.mock.calls[0];
      expect(content).toContain('stop_grace_period: 20s');
    });

    it('infers the agent grace from the service name when component is absent', async () => {
      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      await mgr.install({ ...testConfig, name: 'kici-agent' });

      const [, content] = mockWriteFileSync.mock.calls[0];
      expect(content).toContain('stop_grace_period: 20s');
    });

    it('falls back to the longer grace for an unrecognised service name', async () => {
      const { ComposeServiceManager } = await import('./compose.js');
      const mgr = new ComposeServiceManager();
      await mgr.install({ ...testConfig, name: 'kici-something-new' });

      // Over-waiting costs seconds; under-waiting corrupts the shutdown.
      const [, content] = mockWriteFileSync.mock.calls[0];
      expect(content).toContain('stop_grace_period: 45s');
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

    // The two runtimes serialize a `ps` row differently, so each parse path
    // gets its own fixture, copied verbatim from the real command output:
    //   podman ps -a --filter label=dev.kici.component --format '{{json .}}'
    //   docker ps -a --filter label=dev.kici.component --format '{{json .}}'
    // A single docker-shaped fixture cannot exhibit a podman-only defect, which
    // is how an object-shaped `Labels` went unread on every podman host.
    //
    // fails-when: `list()` reads `Labels` only as a string — the podman case
    // then yields no rows at all, and only the docker case stays green.
    it('parses podman ps JSON rows (object Labels, array Names)', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('podman compose version')) {
          return Buffer.from('podman compose version v2.0.0');
        }
        if (typeof cmd === 'string' && cmd.includes('ps -a --filter label=dev.kici.component')) {
          return Buffer.from(
            [
              '{"AutoRemove":false,"Command":["sleep","30"],"Id":"e4b50cfb9ff7","Image":"docker.io/library/alpine:3","IsInfra":false,"Labels":{"dev.kici.component":"agent","dev.kici.instance-dir":"/srv/kici-bar","other.label":"x"},"Mounts":[],"Names":["kici-bar"],"Namespaces":{},"Networks":[],"Pid":106785,"Pod":"","PodName":"","Ports":null,"Restarts":0,"Size":null,"State":"running","Status":""}',
              '{"Id":"bced3b442449","Image":"docker.io/library/postgres:18.4-alpine","IsInfra":false,"Labels":{"unrelated.label":"y"},"Names":["kici-baz"],"State":"running"}',
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
        instanceDir: '/srv/kici-bar',
      });
      expect(result.find((r) => r.name === 'kici-baz')).toBeUndefined();
    });

    // breaks-if-wrong: teaching the parser the podman shape must not cost it
    // the docker one — the sibling that keeps both paths pinned.
    it('parses docker ps JSON rows (comma-joined Labels, string Names)', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('podman compose version')) {
          throw new Error('podman: command not found');
        }
        if (typeof cmd === 'string' && cmd.includes('docker compose version')) {
          return Buffer.from('Docker Compose version v2.40.0');
        }
        if (typeof cmd === 'string' && cmd.includes('ps -a --filter label=dev.kici.component')) {
          return Buffer.from(
            [
              '{"Command":"\\"sleep 30\\"","HealthStatus":"none","ID":"c46cb92339ea","Image":"alpine:3","Labels":"dev.kici.component=agent,dev.kici.instance-dir=/srv/kici-bar,other.label=x","LocalVolumes":"0","Mounts":"","Names":"kici-bar","Networks":"bridge","Platform":null,"Ports":"","Size":"0B","State":"running","Status":"Up"}',
              '{"ID":"9f0ce04851ec","Image":"alpine:3","Labels":"unrelated.label=y","Names":"kici-baz","State":"created","Status":"Created"}',
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
        instanceDir: '/srv/kici-bar',
      });
      expect(result.find((r) => r.name === 'kici-baz')).toBeUndefined();
    });

    it('throws rather than reporting an empty registry when the scan fails', async () => {
      // fails-when: `list()` catches the `ps -a` failure and returns `[]`. The
      // reconcile cannot tell that from a registry holding no KiCI containers,
      // so it prunes every compose row on the host.
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('podman compose version')) {
          return Buffer.from('podman compose version v2.0.0');
        }
        if (typeof cmd === 'string' && cmd.includes('ps -a --filter label=dev.kici.component')) {
          throw new Error('Cannot connect to the Docker daemon');
        }
        return Buffer.from('');
      });

      const { ComposeServiceManager } = await import('./compose.js');
      await expect(new ComposeServiceManager().list(true)).rejects.toThrow(
        /could not read the podman container registry/,
      );
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

  // Discovery reads `available() === false` as "leave this platform's index rows
  // alone", so the answer decides whether a live compose install survives a
  // reconcile. Every reconcile test drives a double, which pins the contract and
  // says nothing about whether this implementation meets it.
  describe('available', () => {
    it('is true when a container runtime answers', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('podman compose version')) {
          return Buffer.from('podman compose version v2.0.0');
        }
        return Buffer.from('');
      });

      const { ComposeServiceManager } = await import('./compose.js');
      expect(await new ComposeServiceManager().available()).toBe(true);
    });

    // The defect this probe exists to catch. `docker compose version` is
    // answered by the compose client alone — with dockerd stopped it still
    // exits 0 — so a probe that only proves the client runs reports available
    // for a host whose registry cannot be read at all.
    //
    // fails-when: `available()` probes only `<runtime> compose version`. It
    // then returns true here, the scan comes back empty, and the reconcile
    // prunes a live compose install out of `instances.json`.
    it('is false when the client runs but the registry does not answer', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('podman compose version')) {
          return Buffer.from('podman compose version v2.0.0');
        }
        if (typeof cmd === 'string' && / ps -q$/.test(cmd)) {
          throw new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock');
        }
        return Buffer.from('');
      });

      const { ComposeServiceManager } = await import('./compose.js');
      expect(await new ComposeServiceManager().available()).toBe(false);
    });

    // breaks-if-wrong: the probe must not read a healthy-but-empty registry as
    // unavailable. That would suppress the scan on every host with no running
    // containers, and a genuinely-removed compose instance would never be
    // pruned from the index.
    it('is true when the registry answers with no running containers', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('podman compose version')) {
          return Buffer.from('podman compose version v2.0.0');
        }
        if (typeof cmd === 'string' && / ps -q$/.test(cmd)) {
          return Buffer.from('');
        }
        return Buffer.from('');
      });

      const { ComposeServiceManager } = await import('./compose.js');
      expect(await new ComposeServiceManager().available()).toBe(true);
    });

    // fails-when: the registry probe drops its `timeout`, letting a hung
    // daemon hold open the very commands the bound was added for.
    it('bounds the registry probe too', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('podman compose version')) {
          return Buffer.from('podman compose version v2.0.0');
        }
        return Buffer.from('');
      });

      const { ComposeServiceManager } = await import('./compose.js');
      await new ComposeServiceManager().available();

      const probes = mockExecSync.mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && / ps -q$/.test(cmd),
      );
      expect(probes.length).toBe(1);
      expect(probes[0][1]).toMatchObject({ timeout: 10_000, killSignal: 'SIGKILL' });
    });

    it('is false when neither runtime is installed', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('command not found');
      });

      const { ComposeServiceManager } = await import('./compose.js');
      expect(await new ComposeServiceManager().available()).toBe(false);
    });

    // A hung daemon surfaces as the ETIMEDOUT execSync throws once it kills the
    // child. It must read as "unavailable", never propagate as a crash out of a
    // lifecycle command that only wanted to resolve a name.
    it('is false, not a throw, when the runtime probe times out', async () => {
      mockExecSync.mockImplementation(() => {
        const err = new Error('spawnSync /bin/sh ETIMEDOUT') as Error & { code?: string };
        err.code = 'ETIMEDOUT';
        throw err;
      });

      const { ComposeServiceManager } = await import('./compose.js');
      await expect(new ComposeServiceManager().available()).resolves.toBe(false);
    });

    // The bound itself. `install` and every `--name` resolution now reach these
    // two probes, so an unbounded one lets a wedged daemon hold a command open
    // forever.
    //
    // fails-when: either probe drops its `timeout`, or the value moves off the
    // 10s budget the constant documents.
    it('bounds both runtime probes with a timeout', async () => {
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
      await new ComposeServiceManager().list(true);

      const probes = mockExecSync.mock.calls.filter(
        ([cmd]) =>
          typeof cmd === 'string' &&
          (cmd.includes('compose version') || cmd.includes('ps -a --filter')),
      );
      expect(probes.length).toBe(2);
      for (const [, options] of probes) {
        expect(options).toMatchObject({ timeout: 10_000, killSignal: 'SIGKILL' });
      }
    });
  });
});
