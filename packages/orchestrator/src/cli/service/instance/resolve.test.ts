import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  candidatePlatforms,
  formatRefusal,
  InstanceNotFoundError,
  listInstances,
  resolveInstance,
  resolveInstanceTarget,
  type ListedInstance,
} from './resolve.js';
import { writeManifest } from './manifest.js';
import { writeIndex } from './index-file.js';
import type { InstanceManifest, IndexEntry } from './types.js';
import type { DiscoveredInstance, ServiceManager, ServicePlatform } from '../types.js';
import { detectPlatform } from '../platform-detect.js';

vi.mock('../platform-detect.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform-detect.js')>();
  return { ...actual, detectPlatform: vi.fn(actual.detectPlatform) };
});

function fakeManager(
  scanResult: DiscoveredInstance[],
  platform: ServicePlatform = 'systemd',
  extra: Partial<ServiceManager> = {},
): ServiceManager {
  return {
    platform,
    install: vi.fn(),
    uninstall: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    status: vi.fn(),
    logs: vi.fn(),
    isInstalled: vi.fn(),
    list: vi.fn().mockResolvedValue(scanResult),
    ...extra,
  } as ServiceManager;
}

/** A discovered row with the fields every scan carries. */
function scanRow(
  name: string,
  platform: ServicePlatform,
  instanceDir?: string,
): DiscoveredInstance {
  return { name, platform, isUserLevel: true, component: 'orchestrator', instanceDir };
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
        managers: [fakeManager([])],
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
          managers: [fakeManager([])],
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
        managers: [
          fakeManager([
            { name: 'kici-foo', platform: 'systemd', isUserLevel: true, component: 'orchestrator' },
          ]),
        ],
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
        managers: [fakeManager([])],
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
          managers: [fakeManager(scan)],
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
          managers: [fakeManager([])],
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
        platform: 'systemd',
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
          managers: [manager],
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
          managers: [
            fakeManager([
              {
                name: 'kici-existing',
                platform: 'systemd',
                isUserLevel: true,
                component: 'orchestrator',
              },
            ]),
          ],
          isUserLevel: true,
        }),
      ).rejects.toThrow(/does-not-exist.*not found.*kici-existing/is);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('--name not found throws a typed InstanceNotFoundError carrying component + name', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      const err = await resolveInstance({
        component: 'orchestrator',
        opts: { name: 'does-not-exist' },
        cwd: '/elsewhere',
        kiciRoot: root,
        managers: [
          fakeManager([
            {
              name: 'kici-existing',
              platform: 'systemd',
              isUserLevel: true,
              component: 'orchestrator',
            },
          ]),
        ],
        isUserLevel: true,
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(InstanceNotFoundError);
      const e = err as InstanceNotFoundError;
      expect(e.component).toBe('orchestrator');
      expect(e.instanceName).toBe('does-not-exist');
      // Message is preserved (still lists candidates).
      expect(e.message).toMatch(/does-not-exist.*not found.*kici-existing/is);
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
        managers: [
          fakeManager([
            {
              name: 'kici-live',
              platform: 'systemd',
              isUserLevel: true,
              component: 'orchestrator',
            },
          ]),
        ],
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
        managers: [fakeManager([])],
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
        managers: [
          fakeManager([
            {
              name: 'kici-dogfood',
              platform: 'systemd',
              isUserLevel: true,
              component: 'orchestrator',
              instanceDir: '/home/u/kici-dogfood',
            },
          ]),
        ],
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
        managers: [
          fakeManager([
            {
              name: 'kici-dogfood',
              platform: 'systemd',
              isUserLevel: true,
              component: 'orchestrator',
              instanceDir: '/home/u/kici-dogfood',
            },
          ]),
        ],
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
        managers: [
          fakeManager([
            {
              name: 'kici-live',
              platform: 'systemd',
              isUserLevel: true,
              component: 'orchestrator',
            },
          ]),
        ],
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
        managers: [
          fakeManager([
            {
              name: 'kici-foo',
              platform: 'systemd',
              isUserLevel: true,
              component: 'orchestrator',
              instanceDir: '/scan/dir',
            },
          ]),
        ],
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
        managers: [
          fakeManager([
            {
              name: 'kici-orchestrator',
              platform: 'systemd',
              isUserLevel: true,
              component: 'orchestrator',
            },
          ]),
        ],
      });
      expect(found).toEqual([
        expect.objectContaining({ name: 'kici-orchestrator', source: 'scan' }),
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('candidatePlatforms', () => {
  // fails-when: candidatePlatforms ignores its override and re-derives the host.
  it('an explicit --platform forces exactly that one driver', () => {
    vi.mocked(detectPlatform).mockReturnValue('systemd');
    expect(candidatePlatforms('compose')).toEqual(['compose']);
    expect(candidatePlatforms('systemd')).toEqual(['systemd']);
  });

  // fails-when: discovery stays single-platform — the list would be ['systemd'].
  it('a systemd host is a candidate for both systemd and compose', () => {
    vi.mocked(detectPlatform).mockReturnValue('systemd');
    expect(candidatePlatforms()).toEqual(['systemd', 'compose']);
  });

  // breaks-if-wrong: a compose host must not list compose twice.
  it('a compose host lists compose once', () => {
    vi.mocked(detectPlatform).mockReturnValue('compose');
    expect(candidatePlatforms()).toEqual(['compose']);
  });
});

describe('listInstances — multi-driver scan', () => {
  // fails-when: listInstances scans one driver — 'compose-one' is missing.
  it('unions every supplied driver, so a compose install is seen on a systemd host', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      writeIndex(root, []);
      const found = await listInstances({
        component: 'orchestrator',
        isUserLevel: true,
        kiciRoot: root,
        managers: [
          fakeManager([scanRow('sysd-one', 'systemd', '/sysd')], 'systemd'),
          fakeManager([scanRow('compose-one', 'compose', '/compose')], 'compose'),
        ],
      });
      expect(found.map((f) => f.name).sort()).toEqual(['compose-one', 'sysd-one']);
      expect(found.find((f) => f.name === 'compose-one')?.platform).toBe('compose');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // fails-when: --name resolution runs against the host driver alone, so a
  // compose-only instance on a systemd host throws InstanceNotFoundError.
  it('--name resolves a compose-only instance on a systemd host', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      writeManifest(dir, makeManifest({ name: 'kici-compose', platform: 'compose' }));
      writeIndex(root, []);
      const r = await resolveInstance({
        component: 'orchestrator',
        opts: { name: 'kici-compose' },
        cwd: '/elsewhere',
        kiciRoot: root,
        managers: [
          fakeManager([], 'systemd'),
          fakeManager([scanRow('kici-compose', 'compose', dir)], 'compose'),
        ],
        isUserLevel: true,
      });
      expect(r.manifest.name).toBe('kici-compose');
      expect(r.manifest.platform).toBe('compose');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // fails-when: the reconcile key is (component, isUserLevel) alone — the
  // systemd scan rewrites the whole scope and 'compose-one' is deleted.
  it('a systemd scan leaves the compose index rows alone', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      writeIndex(root, [
        {
          component: 'orchestrator',
          name: 'sysd-one',
          platform: 'systemd',
          isUserLevel: true,
          instanceDir: '/sysd',
        },
        {
          component: 'orchestrator',
          name: 'compose-one',
          platform: 'compose',
          isUserLevel: true,
          instanceDir: '/compose',
        },
      ]);
      await listInstances({
        component: 'orchestrator',
        isUserLevel: true,
        kiciRoot: root,
        managers: [fakeManager([scanRow('sysd-one', 'systemd', '/sysd')], 'systemd')],
      });
      const idx: IndexEntry[] = JSON.parse(
        fs.readFileSync(path.join(root, 'instances.json'), 'utf-8'),
      );
      expect(idx.map((e) => e.name).sort()).toEqual(['compose-one', 'sysd-one']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // breaks-if-wrong: platform-scoping must not stop a driver pruning its OWN
  // dead rows — the backward self-heal is the whole point of the reconcile.
  it('a systemd scan still prunes a dead systemd row while sparing compose', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      writeIndex(root, [
        {
          component: 'orchestrator',
          name: 'sysd-dead',
          platform: 'systemd',
          isUserLevel: true,
          instanceDir: '/gone',
        },
        {
          component: 'orchestrator',
          name: 'compose-one',
          platform: 'compose',
          isUserLevel: true,
          instanceDir: '/compose',
        },
      ]);
      await listInstances({
        component: 'orchestrator',
        isUserLevel: true,
        kiciRoot: root,
        managers: [fakeManager([], 'systemd')],
      });
      const idx: IndexEntry[] = JSON.parse(
        fs.readFileSync(path.join(root, 'instances.json'), 'utf-8'),
      );
      expect(idx.map((e) => e.name)).toEqual(['compose-one']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('listInstances — an unavailable driver is not authoritative', () => {
  // fails-when: available() is ignored — the compose driver's empty scan reads
  // as "scanned, found nothing" and 'compose-one' is deleted.
  it('a compose driver that cannot reach its runtime keeps its index rows', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      writeIndex(root, [
        {
          component: 'orchestrator',
          name: 'compose-one',
          platform: 'compose',
          isUserLevel: true,
          instanceDir: '/compose',
        },
      ]);
      const down = fakeManager([], 'compose', {
        available: vi.fn().mockResolvedValue(false),
      });
      const found = await listInstances({
        component: 'orchestrator',
        isUserLevel: true,
        kiciRoot: root,
        managers: [fakeManager([], 'systemd'), down],
      });
      expect(found).toEqual([]);
      // The unreachable driver is not asked to enumerate what it cannot see.
      expect(down.list).not.toHaveBeenCalled();
      const idx: IndexEntry[] = JSON.parse(
        fs.readFileSync(path.join(root, 'instances.json'), 'utf-8'),
      );
      expect(idx.map((e) => e.name)).toEqual(['compose-one']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // available() and list() are two separate calls, so the registry can go down
  // in the gap. A driver that reports that as a throw must be dropped, not read
  // as an empty scan — and must not take the whole lifecycle command with it.
  //
  // fails-when: scanDrivers lets the rejection through. `listInstances` then
  // rejects and `kici-admin orchestrator status` dies resolving a name; drop
  // the `catch` and return `[]` instead and 'compose-one' is pruned.
  it('a compose driver whose scan throws keeps its index rows', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      writeIndex(root, [
        {
          component: 'orchestrator',
          name: 'compose-one',
          platform: 'compose',
          isUserLevel: true,
          instanceDir: '/compose',
        },
      ]);
      const wedged = fakeManager([], 'compose', {
        available: vi.fn().mockResolvedValue(true),
        list: vi.fn().mockRejectedValue(new Error('could not read the podman container registry')),
      });
      const found = await listInstances({
        component: 'orchestrator',
        isUserLevel: true,
        kiciRoot: root,
        managers: [fakeManager([], 'systemd'), wedged],
      });
      expect(found).toEqual([]);
      expect(wedged.list).toHaveBeenCalled();
      const idx: IndexEntry[] = JSON.parse(
        fs.readFileSync(path.join(root, 'instances.json'), 'utf-8'),
      );
      expect(idx.map((e) => e.name)).toEqual(['compose-one']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // breaks-if-wrong: the probe must not disable the reconcile. A driver that
  // IS available and honestly scans nothing still prunes its own rows.
  it('an available compose driver that finds nothing does prune its rows', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      writeIndex(root, [
        {
          component: 'orchestrator',
          name: 'compose-one',
          platform: 'compose',
          isUserLevel: true,
          instanceDir: '/compose',
        },
      ]);
      await listInstances({
        component: 'orchestrator',
        isUserLevel: true,
        kiciRoot: root,
        managers: [fakeManager([], 'compose', { available: vi.fn().mockResolvedValue(true) })],
      });
      const idx: IndexEntry[] = JSON.parse(
        fs.readFileSync(path.join(root, 'instances.json'), 'utf-8'),
      );
      expect(idx).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('listInstances — a dropped driver says so on stderr', () => {
  /** Collect `console.warn` for one call, restoring the original after. */
  async function warningsFrom(managers: ServiceManager[]): Promise<string[]> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.map(String).join(' '));
    try {
      await listInstances({
        component: 'orchestrator',
        isUserLevel: true,
        kiciRoot: root,
        managers,
      });
      return warns;
    } finally {
      console.warn = orig;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // fails-when: the `available() === false` branch returns null without warning
  // — `warns` is empty. This is the `chmod 000` / daemon-down shape an operator
  // otherwise reads as "not installed" rather than "could not look".
  it('names the platform when a driver reports itself unavailable', async () => {
    const warns = await warningsFrom([
      fakeManager([], 'compose', { available: vi.fn().mockResolvedValue(false) }),
    ]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('compose');
    expect(warns[0]).toContain('did not answer');
    expect(warns[0]).toContain('left untouched');
  });

  // fails-when: the `catch` swallows without warning — the reason string is
  // gone and `warns` is empty. The driver's own message must survive, since it
  // is the only thing naming WHICH read failed.
  it('names the platform and the reason when a scan throws', async () => {
    const warns = await warningsFrom([
      fakeManager([], 'systemd', {
        list: vi.fn().mockRejectedValue(new Error('EACCES: permission denied, scandir')),
      }),
    ]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('systemd');
    expect(warns[0]).toContain('EACCES: permission denied, scandir');
  });

  // breaks-if-wrong: a healthy scan must stay silent. A warning on every run
  // trains the operator to ignore the one that matters.
  it('says nothing when every driver answers', async () => {
    const warns = await warningsFrom([
      fakeManager([scanRow('sys-one', 'systemd', '/sys')], 'systemd'),
      fakeManager([], 'compose', { available: vi.fn().mockResolvedValue(true) }),
    ]);
    expect(warns).toEqual([]);
  });

  // fails-when: `available()` is awaited OUTSIDE the try — its rejection escapes
  // the per-driver handler, fails the whole `Promise.all`, and `listInstances`
  // rejects instead of returning the systemd scan. Asserting the systemd row
  // survives is what distinguishes "the rejection was handled" from "the whole
  // call blew up", which an empty-array assertion could not.
  it('a driver whose availability probe rejects drops only that driver', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    const orig = console.warn;
    const warns: string[] = [];
    console.warn = (...args: unknown[]) => warns.push(args.map(String).join(' '));
    try {
      const exploding = fakeManager([], 'compose', {
        available: vi.fn().mockRejectedValue(new Error('podman ps -q timed out')),
      });
      const found = await listInstances({
        component: 'orchestrator',
        isUserLevel: true,
        kiciRoot: root,
        managers: [fakeManager([scanRow('sys-one', 'systemd', '/sys')], 'systemd'), exploding],
      });
      expect(found.map((f) => f.name)).toEqual(['sys-one']);
      expect(exploding.list).not.toHaveBeenCalled();
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('podman ps -q timed out');
    } finally {
      console.warn = orig;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveInstanceTarget — the manager comes from the install', () => {
  /** A createManager spy that hands back a driver per platform. */
  function spyFactory(): {
    create: (p: ServicePlatform) => Promise<ServiceManager>;
    calls: ServicePlatform[];
  } {
    const calls: ServicePlatform[] = [];
    return {
      calls,
      create: async (p) => {
        calls.push(p);
        return fakeManager([], p);
      },
    };
  }

  // fails-when: the manager is built from detectPlatform() — pinned here to
  // 'systemd', while the manifest under --instance-dir says 'compose'. The two
  // sides cannot move together, so this reddens on exactly the manifest-vs-host
  // axis.
  it('a compose-manifest install on a systemd host selects the compose manager', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      vi.mocked(detectPlatform).mockReturnValue('systemd');
      writeManifest(dir, makeManifest({ platform: 'compose' }));
      const factory = spyFactory();
      const target = await resolveInstanceTarget({
        component: 'orchestrator',
        opts: { instanceDir: dir },
        cwd: '/elsewhere',
        kiciRoot: '/unused',
        isUserLevel: true,
        createManager: factory.create,
      });
      expect(target.platform).toBe('compose');
      expect(target.manager.platform).toBe('compose');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // breaks-if-wrong: the overwhelmingly common case must be untouched.
  it('a systemd-manifest install on a systemd host is unaffected', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      vi.mocked(detectPlatform).mockReturnValue('systemd');
      writeManifest(dir, makeManifest({ platform: 'systemd' }));
      const target = await resolveInstanceTarget({
        component: 'orchestrator',
        opts: { instanceDir: dir },
        cwd: '/elsewhere',
        kiciRoot: '/unused',
        isUserLevel: true,
        createManager: spyFactory().create,
      });
      expect(target.platform).toBe('systemd');
      expect(target.manager.platform).toBe('systemd');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // fails-when: the manifest wins over the flag — --platform stops being an
  // escape hatch to a single-driver run.
  it('--platform overrides the manifest for both discovery and operation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      vi.mocked(detectPlatform).mockReturnValue('systemd');
      writeManifest(dir, makeManifest({ platform: 'compose' }));
      const factory = spyFactory();
      const target = await resolveInstanceTarget({
        component: 'orchestrator',
        opts: { instanceDir: dir },
        cwd: '/elsewhere',
        kiciRoot: '/unused',
        isUserLevel: true,
        platformOverride: 'systemd',
        createManager: factory.create,
      });
      expect(target.platform).toBe('systemd');
      expect(factory.calls).toEqual(['systemd']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // fails-when: discovery is built from one driver — the --name lookup below
  // never sees the compose instance and throws InstanceNotFoundError.
  it('discovers through every candidate driver, then operates through one', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-r-'));
    try {
      vi.mocked(detectPlatform).mockReturnValue('systemd');
      writeManifest(dir, makeManifest({ name: 'kici-compose', platform: 'compose' }));
      writeIndex(root, []);
      const calls: ServicePlatform[] = [];
      const target = await resolveInstanceTarget({
        component: 'orchestrator',
        opts: { name: 'kici-compose' },
        cwd: '/elsewhere',
        kiciRoot: root,
        isUserLevel: true,
        createManager: async (p) => {
          calls.push(p);
          return fakeManager(p === 'compose' ? [scanRow('kici-compose', 'compose', dir)] : [], p);
        },
      });
      expect(calls).toEqual(['systemd', 'compose']);
      expect(target.platform).toBe('compose');
      expect(target.resolved.manifest.name).toBe('kici-compose');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
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
