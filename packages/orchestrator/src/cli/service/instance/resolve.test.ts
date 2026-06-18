import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatRefusal, listInstances, resolveInstance, type ListedInstance } from './resolve.js';
import { writeManifest } from './manifest.js';
import { writeIndex } from './index-file.js';
import type { InstanceManifest, IndexEntry } from './types.js';
import type { DiscoveredInstance, ServiceManager } from '../types.js';

function fakeManager(scanResult: DiscoveredInstance[]): ServiceManager {
  return {
    install: vi.fn(),
    uninstall: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    status: vi.fn(),
    logs: vi.fn(),
    isInstalled: vi.fn(),
    list: vi.fn().mockResolvedValue(scanResult),
  } as ServiceManager;
}

function makeManifest(overrides: Partial<InstanceManifest> = {}): InstanceManifest {
  return {
    component: 'orchestrator',
    name: 'kici-test',
    platform: 'systemd',
    isUserLevel: true,
    envFilePath: '/x/kici-test.env',
    configDir: '/x/',
    logDir: '/x/logs/',
    installBase: '/opt/kici/kici-test/',
    createdAt: '2026-05-28T00:00:00Z',
    kiciVersion: '0.1.13',
    ...overrides,
  };
}

describe('resolveInstance — priority order', () => {
  it('--instance-dir wins: reads manifest from given path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      const m = makeManifest();
      writeManifest(dir, m);
      const r = await resolveInstance({
        component: 'orchestrator',
        opts: { instanceDir: dir },
        cwd: '/elsewhere',
        kiciRoot: '/unused',
        manager: fakeManager([]),
        isUserLevel: true,
      });
      expect(r.manifest).toEqual(m);
      expect(r.instanceDir).toBe(path.resolve(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--instance-dir without a manifest throws naming the path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      await expect(
        resolveInstance({
          component: 'orchestrator',
          opts: { instanceDir: dir },
          cwd: '/elsewhere',
          kiciRoot: '/unused',
          manager: fakeManager([]),
          isUserLevel: true,
        }),
      ).rejects.toThrow(new RegExp(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--name resolves via reconciled list when manifest is readable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      const m = makeManifest({ name: 'kici-foo' });
      writeManifest(dir, m);
      writeIndex(root, [
        {
          component: 'orchestrator',
          name: 'kici-foo',
          platform: 'systemd',
          isUserLevel: true,
          instanceDir: dir,
        },
      ] satisfies IndexEntry[]);
      const r = await resolveInstance({
        component: 'orchestrator',
        opts: { name: 'kici-foo' },
        cwd: '/elsewhere',
        kiciRoot: root,
        manager: fakeManager([
          { name: 'kici-foo', platform: 'systemd', isUserLevel: true, component: 'orchestrator' },
        ]),
        isUserLevel: true,
      });
      expect(r.manifest.name).toBe('kici-foo');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CWD manifest is used when no flags', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      const m = makeManifest({ name: 'cwd-target' });
      writeManifest(dir, m);
      const r = await resolveInstance({
        component: 'orchestrator',
        opts: {},
        cwd: dir,
        kiciRoot: '/unused',
        manager: fakeManager([]),
        isUserLevel: true,
      });
      expect(r.manifest.name).toBe('cwd-target');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses and lists candidates when nothing resolves', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      const scan: DiscoveredInstance[] = [
        {
          name: 'kici-orchestrator',
          platform: 'systemd',
          isUserLevel: true,
          component: 'orchestrator',
        },
      ];
      await expect(
        resolveInstance({
          component: 'orchestrator',
          opts: {},
          cwd: '/no-manifest-here',
          kiciRoot: root,
          manager: fakeManager(scan),
          isUserLevel: true,
        }),
      ).rejects.toThrow(/no instance.*candidates.*kici-orchestrator/is);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refusal message lists 0 candidates plainly when none', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      await expect(
        resolveInstance({
          component: 'agent',
          opts: {},
          cwd: '/no-manifest-here',
          kiciRoot: root,
          manager: fakeManager([]),
          isUserLevel: true,
        }),
      ).rejects.toThrow(/no agent instances installed/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes isUserLevel through to manager.list (system-level)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      const listSpy = vi.fn().mockResolvedValue([]);
      const manager = {
        install: vi.fn(),
        uninstall: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        restart: vi.fn(),
        status: vi.fn(),
        logs: vi.fn(),
        isInstalled: vi.fn(),
        list: listSpy,
      } as unknown as ServiceManager;
      await expect(
        resolveInstance({
          component: 'orchestrator',
          opts: {},
          cwd: '/no-manifest',
          kiciRoot: root,
          manager,
          isUserLevel: false,
        }),
      ).rejects.toThrow();
      expect(listSpy).toHaveBeenCalledWith(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('--name not found refuses with list', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      await expect(
        resolveInstance({
          component: 'orchestrator',
          opts: { name: 'does-not-exist' },
          cwd: '/elsewhere',
          kiciRoot: root,
          manager: fakeManager([
            {
              name: 'kici-existing',
              platform: 'systemd',
              isUserLevel: true,
              component: 'orchestrator',
            },
          ]),
          isUserLevel: true,
        }),
      ).rejects.toThrow(/does-not-exist.*not found.*kici-existing/is);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('listInstances — reconcile cache vs scan', () => {
  it('drops index entries whose unit no longer exists (self-heal rewrites index)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      writeIndex(root, [
        {
          component: 'orchestrator',
          name: 'kici-dead',
          platform: 'systemd',
          isUserLevel: true,
          instanceDir: '/gone',
        },
        {
          component: 'orchestrator',
          name: 'kici-live',
          platform: 'systemd',
          isUserLevel: true,
          instanceDir: '/here',
        },
      ]);
      const found = await listInstances({
        component: 'orchestrator',
        isUserLevel: true,
        kiciRoot: root,
        manager: fakeManager([
          { name: 'kici-live', platform: 'systemd', isUserLevel: true, component: 'orchestrator' },
        ]),
      });
      expect(found.map((f) => f.name)).toEqual(['kici-live']);
      const idx = JSON.parse(fs.readFileSync(path.join(root, 'instances.json'), 'utf-8'));
      expect(idx).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('self-heal preserves entries for OTHER component/scope combinations', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      // Pre-seed: 1 dead orchestrator+user, 1 live agent+user, 1 live orchestrator+system
      writeIndex(root, [
        {
          component: 'orchestrator',
          name: 'kici-dead',
          platform: 'systemd',
          isUserLevel: true,
          instanceDir: '/gone',
        },
        {
          component: 'agent',
          name: 'kici-agent-live',
          platform: 'systemd',
          isUserLevel: true,
          instanceDir: '/here',
        },
        {
          component: 'orchestrator',
          name: 'kici-sys',
          platform: 'systemd',
          isUserLevel: false,
          instanceDir: '/sys',
        },
      ]);
      // Listing orchestrator+user with scan returning none → prune kici-dead;
      // agent and orchestrator-system entries MUST survive.
      const found = await listInstances({
        component: 'orchestrator',
        isUserLevel: true,
        kiciRoot: root,
        manager: fakeManager([]),
      });
      expect(found).toEqual([]);
      const idx = JSON.parse(fs.readFileSync(path.join(root, 'instances.json'), 'utf-8'));
      expect(idx).toHaveLength(2);
      expect(idx.find((e: { name: string }) => e.name === 'kici-agent-live')).toBeDefined();
      expect(idx.find((e: { name: string }) => e.name === 'kici-sys')).toBeDefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('recovers instanceDir from the scan when the index entry is missing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      writeIndex(root, []);
      const found = await listInstances({
        component: 'orchestrator',
        isUserLevel: true,
        kiciRoot: root,
        manager: fakeManager([
          {
            name: 'kici-dogfood',
            platform: 'systemd',
            isUserLevel: true,
            component: 'orchestrator',
            instanceDir: '/home/u/kici-dogfood',
          },
        ]),
      });
      expect(found).toEqual([
        expect.objectContaining({ name: 'kici-dogfood', instanceDir: '/home/u/kici-dogfood' }),
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('self-heals the index from a scan-recovered instanceDir (lost-index recovery)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      writeIndex(root, []);
      await listInstances({
        component: 'orchestrator',
        isUserLevel: true,
        kiciRoot: root,
        manager: fakeManager([
          {
            name: 'kici-dogfood',
            platform: 'systemd',
            isUserLevel: true,
            component: 'orchestrator',
            instanceDir: '/home/u/kici-dogfood',
          },
        ]),
      });
      const idx = JSON.parse(fs.readFileSync(path.join(root, 'instances.json'), 'utf-8'));
      expect(idx).toEqual([
        {
          component: 'orchestrator',
          name: 'kici-dogfood',
          platform: 'systemd',
          isUserLevel: true,
          instanceDir: '/home/u/kici-dogfood',
        },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not rewrite the index when scan recovers no new instanceDir (idempotent)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      writeIndex(root, [
        {
          component: 'orchestrator',
          name: 'kici-live',
          platform: 'systemd',
          isUserLevel: true,
          instanceDir: '/here',
        },
      ]);
      const before = fs.statSync(path.join(root, 'instances.json')).mtimeMs;
      await new Promise((r) => setTimeout(r, 5));
      await listInstances({
        component: 'orchestrator',
        isUserLevel: true,
        kiciRoot: root,
        manager: fakeManager([
          { name: 'kici-live', platform: 'systemd', isUserLevel: true, component: 'orchestrator' },
        ]),
      });
      const after = fs.statSync(path.join(root, 'instances.json')).mtimeMs;
      expect(after).toBe(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers the index instanceDir over the scan-recovered one', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      writeIndex(root, [
        {
          component: 'orchestrator',
          name: 'kici-foo',
          platform: 'systemd',
          isUserLevel: true,
          instanceDir: '/index/dir',
        },
      ]);
      const found = await listInstances({
        component: 'orchestrator',
        isUserLevel: true,
        kiciRoot: root,
        manager: fakeManager([
          {
            name: 'kici-foo',
            platform: 'systemd',
            isUserLevel: true,
            component: 'orchestrator',
            instanceDir: '/scan/dir',
          },
        ]),
      });
      expect(found[0].instanceDir).toBe('/index/dir');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('surfaces scan-only units (no index entry — e.g. dogfood pre-migration)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      writeIndex(root, []);
      const found = await listInstances({
        component: 'orchestrator',
        isUserLevel: true,
        kiciRoot: root,
        manager: fakeManager([
          {
            name: 'kici-orchestrator',
            platform: 'systemd',
            isUserLevel: true,
            component: 'orchestrator',
          },
        ]),
      });
      expect(found).toEqual([
        expect.objectContaining({ name: 'kici-orchestrator', source: 'scan' }),
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('formatRefusal', () => {
  it('renders a candidate table', () => {
    const candidates: ListedInstance[] = [
      {
        component: 'orchestrator',
        name: 'kici-a',
        platform: 'systemd',
        isUserLevel: true,
        instanceDir: '/a',
        source: 'index+scan',
      },
      {
        component: 'orchestrator',
        name: 'kici-b',
        platform: 'systemd',
        isUserLevel: true,
        source: 'scan',
      },
    ];
    const txt = formatRefusal('orchestrator', candidates);
    expect(txt).toMatch(/kici-a.*systemd.*\/a/);
    expect(txt).toMatch(/kici-b.*systemd.*\(no manifest\)/);
  });
});
