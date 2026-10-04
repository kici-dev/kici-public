import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LabelSetConfig, ScalerEntry } from './types.js';
import { RUNTIME_INIT_LABEL } from '@kici-dev/shared/container-runtime';

const mockStart = vi.fn().mockResolvedValue(undefined);
const mockRemove = vi.fn().mockResolvedValue(undefined);
// `ensureRuntimeVolume` probes the runtime volume's completion marker with a
// short-lived container, so every container this fake hands back needs to be
// waitable. Exit 0 = the marker is there = the volume is reused as-is.
const mockWait = vi.fn().mockResolvedValue({ StatusCode: 0 });
const mockCreateContainer = vi.fn().mockResolvedValue({
  id: 'container-perjob-abc',
  start: mockStart,
  remove: mockRemove,
  wait: mockWait,
});
const mockGetContainer = vi.fn().mockReturnValue({ remove: mockRemove });
const mockListContainers = vi.fn().mockResolvedValue([]);
const mockGetImage = vi.fn().mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) });
const mockVolumeRemove = vi.fn().mockResolvedValue(undefined);
const mockGetVolume = vi
  .fn()
  .mockReturnValue({ inspect: vi.fn().mockResolvedValue({}), remove: mockVolumeRemove });

const mockInfo = vi.fn().mockResolvedValue({ SecurityOptions: ['name=seccomp,profile=default'] });
vi.mock('dockerode', () => ({
  default: vi.fn().mockImplementation(function () {
    return {
      info: mockInfo,
      createContainer: mockCreateContainer,
      getContainer: mockGetContainer,
      getImage: mockGetImage,
      getVolume: mockGetVolume,
      listContainers: mockListContainers,
      createVolume: vi.fn().mockResolvedValue({}),
      pull: vi.fn().mockResolvedValue({}),
      modem: { followProgress: vi.fn((_s, cb) => cb(null)) },
    };
  }),
}));

const mockDetectRuntime = vi.fn();
const mockEnsureIsolatedNetwork = vi.fn().mockResolvedValue('net-abc');
vi.mock('./container-backend.js', () => ({
  detectRuntime: mockDetectRuntime,
  ensureIsolatedNetwork: mockEnsureIsolatedNetwork,
  ISOLATED_NETWORK_NAME: 'kici-agent-net',
  ISOLATED_NETWORK_GATEWAY: '172.30.0.1',
}));

const mockAddHostIsolationRules = vi.fn().mockResolvedValue(undefined);
const mockAddIsolationRules = vi.fn().mockResolvedValue(undefined);
const mockRemoveIsolationRules = vi.fn().mockResolvedValue(undefined);
const mockEnsureKiciTable = vi.fn().mockResolvedValue(undefined);
const mockProbeNftables = vi.fn<(opts?: { requireSudo?: boolean }) => Promise<string | null>>();
vi.mock('@kici-dev/shared/net', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kici-dev/shared/net')>()),
  ensureKiciTable: (...args: unknown[]) => mockEnsureKiciTable(...args),
  probeNftables: (opts?: { requireSudo?: boolean }) => mockProbeNftables(opts),
  addIsolationRules: (...args: unknown[]) => mockAddIsolationRules(...args),
  addHostIsolationRules: (...args: unknown[]) => mockAddHostIsolationRules(...args),
  removeIsolationRules: (...args: unknown[]) => mockRemoveIsolationRules(...args),
}));

const { BareMetalScalerBackend } = await import('./bare-metal-backend.js');

// Job-image mode is opt-in via the label set's shape: an `image` and NO
// `binaryPath`, so there is no local binary this pool could spawn instead.
const labelSets: LabelSetConfig[] = [{ labels: ['linux'], image: 'quay.io/kici-dev/kici-agent:1' }];

function makeBackend() {
  return new BareMetalScalerBackend({
    name: 'test-bare-metal',
    labelSets,
    maxAgents: 5,
  });
}

const jobContainer = {
  image: 'reg.internal:5000/acme/ci:1.2',
  authconfig: { username: 'bot', password: 's3cr3t', serveraddress: 'reg.internal:5000' },
};

describe('BareMetalScalerBackend container mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateContainer.mockResolvedValue({
      id: 'container-perjob-abc',
      start: mockStart,
      remove: mockRemove,
      wait: mockWait,
    });
    mockWait.mockResolvedValue({ StatusCode: 0 });
    mockGetContainer.mockReturnValue({
      remove: mockRemove,
      inspect: vi.fn().mockResolvedValue({
        NetworkSettings: { Networks: { 'kici-agent-net': { IPAddress: '172.30.0.9' } } },
      }),
    });
    mockEnsureIsolatedNetwork.mockResolvedValue('net-abc');
    mockAddIsolationRules.mockResolvedValue(undefined);
    mockRemoveIsolationRules.mockResolvedValue(undefined);
    mockEnsureKiciTable.mockResolvedValue(undefined);
    mockProbeNftables.mockResolvedValue(null);
    mockGetImage.mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) });
    mockGetVolume.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({}),
      remove: mockVolumeRemove,
    });
    mockDetectRuntime.mockResolvedValue({ runtime: 'podman', socketPath: '/run/podman.sock' });
    mockListContainers.mockResolvedValue([]);
  });

  describe('reapUnowned()', () => {
    it('removes the container of an agent the backend no longer tracks', async () => {
      // The leak: an orchestrator restart empties the in-memory map, so
      // `destroy()` returns at its first line while the container keeps running,
      // and the container backend's startup sweep never runs in a
      // bare-metal-only deployment.
      const backend = makeBackend();
      mockListContainers.mockResolvedValue([{ Id: 'container-orphan-1' }]);

      expect(await backend.reapUnowned('scaler-bare-metal-deadbeef')).toBe(true);

      // The listing is what proves the container is on THIS host, and both
      // labels must match — the agent id alone could name a sibling scaler's.
      expect(mockListContainers).toHaveBeenCalledWith({
        all: true,
        filters: {
          label: ['kici-agent-id=scaler-bare-metal-deadbeef', 'kici-scaler-name=test-bare-metal'],
        },
      });
      expect(mockGetContainer).toHaveBeenCalledWith('container-orphan-1');
      expect(mockRemove).toHaveBeenCalledWith({ force: true });
    });

    it('touches nothing when this host runs no container for the id', async () => {
      // THE DANGEROUS DIRECTION. A refused agent's compute lives on whichever
      // host spawned it, and the coordinator it reaches may not be that host.
      // The container listing is host-local, so a wrongly-routed id matches
      // nothing rather than reaching a peer's machine.
      const backend = makeBackend();

      expect(await backend.reapUnowned('scaler-bare-metal-elsewhere')).toBe(false);
      expect(mockGetContainer).not.toHaveBeenCalled();
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it('defers to destroy() while the backend still tracks the agent', async () => {
      const backend = makeBackend();
      await backend.spawn(['linux'], 'agent-1', 'ws://orch/ws', () => {}, undefined, {
        boundJobId: 'job-1',
        container: jobContainer,
      });
      vi.clearAllMocks();
      mockListContainers.mockResolvedValue([{ Id: 'container-perjob-abc' }]);

      expect(await backend.reapUnowned('agent-1')).toBe(false);
      expect(mockListContainers).not.toHaveBeenCalled();
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it('reclaims nothing when no container runtime is available', async () => {
      // A process-mode-only host has no runtime socket at all. Its agents are
      // deliberately out of reach here: their PID lives in the in-memory entry
      // alone, so a restart leaves nothing durable to key a reclaim off.
      const backend = makeBackend();
      mockDetectRuntime.mockResolvedValue(null);

      expect(await backend.reapUnowned('scaler-bare-metal-deadbeef')).toBe(false);
      expect(mockListContainers).not.toHaveBeenCalled();
    });
  });

  it('applies the configured limits, the isolated network and a pid ceiling', async () => {
    // This path used to write its own HostConfig with no Memory, no NanoCpus
    // and no hardening — and `effectiveLimits` was not even a parameter, so a
    // job could take the host down with the memory limit its operator had set.
    // It also sat on the runtime's default bridge with full LAN, RFC1918 and
    // cloud-metadata reach.
    const backend = makeBackend();

    await backend.spawn(
      ['linux'],
      'agent-1',
      'ws://orch/ws',
      () => {},
      { cpus: 2, memBytes: 4 * 1024 * 1024 * 1024 },
      { boundJobId: 'job-1', container: jobContainer },
    );

    const created = mockCreateContainer.mock.calls.at(-1)![0] as {
      HostConfig: Record<string, unknown>;
      NetworkingConfig?: { EndpointsConfig?: Record<string, unknown> };
    };
    expect(created.HostConfig.Memory).toBe(4 * 1024 * 1024 * 1024);
    expect(created.HostConfig.NanoCpus).toBe(2e9);
    expect(created.HostConfig.PidsLimit).toBe(4096);
    // Not capability-dropped: KICI_JOB_IMAGE_AGENT=1 means the steps run in
    // THIS container. See container-hostconfig.ts.
    expect(created.HostConfig.CapDrop).toBeUndefined();
    expect(created.HostConfig.SecurityOpt).toBeUndefined();
    expect(created.NetworkingConfig?.EndpointsConfig).toHaveProperty('kici-agent-net');
    expect(mockAddIsolationRules).toHaveBeenCalledWith(
      '172.30.0.9',
      '172.30.0.1',
      undefined,
      'saddr',
      { requireSudo: false },
    );
  });

  it('tracks the agent before starting it, and untracks a container that fails to start', async () => {
    // A throw from `start()` used to leave a started container that nothing
    // tracked, and `cleanupOrphans` does not cover bare-metal at all.
    const backend = makeBackend();
    // Fail only the AGENT container's start: `ensureRuntimeVolume` probes the
    // volume with a container of its own first, and a `…Once` would be spent
    // on that instead.
    mockCreateContainer.mockImplementation(async (spec: { Labels?: Record<string, string> }) => ({
      id: 'container-perjob-abc',
      start: spec.Labels?.['kici-agent-id']
        ? vi.fn().mockRejectedValue(new Error('no such image'))
        : mockStart,
      remove: mockRemove,
      wait: mockWait,
    }));

    await expect(
      backend.spawn(['linux'], 'agent-1', 'ws://orch/ws', () => {}, undefined, {
        boundJobId: 'job-1',
        container: jobContainer,
      }),
    ).rejects.toThrow('no such image');

    expect(backend.getActiveCount()).toBe(0);
    expect(mockRemove).toHaveBeenCalledWith({ force: true });
  });

  it('runs the agent inside the job image, on the injected node', async () => {
    const backend = makeBackend();

    const managed = await backend.spawn(['linux'], 'agent-1', 'ws://orch/ws', () => {}, undefined, {
      boundJobId: 'job-1',
      container: jobContainer,
    });

    // Last, not first: the runtime-volume marker probe creates a container of
    // its own before the agent container.
    const created = mockCreateContainer.mock.calls.at(-1)![0] as {
      Image: string;
      Cmd: string[];
      HostConfig: { Binds: string[] };
    };
    expect(created.Image).toBe('reg.internal:5000/acme/ci:1.2');
    // The image is not required to ship Node, so a bare `node` would resolve to
    // nothing.
    expect(created.Cmd[0]).toBe('/opt/kici/node/bin/node');
    // The agent must be INSIDE the runtime tree: only /opt/kici is mounted into
    // the job container, so a path under /app would not exist there.
    expect(created.Cmd[1]).toBe('/opt/kici/app/packages/agent/dist/server.js');
    expect(created.HostConfig.Binds.some((b) => b.endsWith(':/opt/kici:ro'))).toBe(true);
    expect(managed.backendRef).toBe('container-perjob-abc');
    expect(mockStart).toHaveBeenCalled();
  });

  it('starts the agent under the runtime tini when the agent image names it', async () => {
    // fails-when: container mode ignores the agent image's init label, so the
    // agent inside the job's own image is PID 1.
    mockGetImage.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({
        Id: 'sha256:' + 'c'.repeat(64),
        Config: { Labels: { [RUNTIME_INIT_LABEL]: 'tini' } },
      }),
    });
    const backend = makeBackend();
    await backend.spawn(['linux'], 'agent-1', 'ws://orch/ws', () => {}, undefined, {
      boundJobId: 'job-1',
      container: jobContainer,
    });
    const created = mockCreateContainer.mock.calls.at(-1)![0] as { Cmd: string[] };
    expect(created.Cmd.slice(0, 4)).toEqual([
      '/opt/kici/bin/tini',
      '-s',
      '--',
      '/opt/kici/node/bin/node',
    ]);
  });

  it('fails fast, naming the routing label, when no runtime exists', async () => {
    mockDetectRuntime.mockResolvedValue(null);
    const backend = makeBackend();

    // Routing should have kept this job away from a runtime-less pool, so
    // reaching here means the requirement was bypassed.
    await expect(
      backend.spawn(['linux'], 'agent-2', 'ws://orch/ws', () => {}, undefined, {
        container: jobContainer,
      }),
    ).rejects.toThrow(/requires a container runtime.*kici:runtime:docker/s);
  });

  it('removes the container on destroy rather than signalling a PID', async () => {
    const backend = makeBackend();
    await backend.spawn(['linux'], 'agent-3', 'ws://orch/ws', () => {}, undefined, {
      container: jobContainer,
    });

    await backend.destroy('agent-3');

    expect(mockGetContainer).toHaveBeenCalledWith('container-perjob-abc');
    expect(mockRemove).toHaveBeenCalledWith({ force: true });
  });

  it('keeps the local-process path for a pool that declares a binary', async () => {
    // A `container:` job on a classic bare-metal pool already worked the other
    // way round — a local agent nesting a job container. Opting it into
    // job-image mode automatically would flip the topology of working jobs.
    const backend = new BareMetalScalerBackend({
      name: 'classic',
      labelSets: [{ labels: ['linux'], binaryPath: '/usr/bin/kici-agent' }],
      maxAgents: 5,
    });

    await backend
      .spawn(['linux'], 'agent-4', 'ws://orch/ws', () => {}, undefined, {
        container: jobContainer,
      })
      .catch(() => undefined);

    expect(mockCreateContainer).not.toHaveBeenCalled();
  });

  it('does not touch a container runtime for an ordinary process spawn', async () => {
    const backend = makeBackend();
    // No container on the spawn context => the historical local-process path,
    // which must not require (or probe for) a runtime at all.
    await backend
      .spawn(['linux'], 'agent-5', 'ws://orch/ws', () => {}, undefined, { boundJobId: 'job-9' })
      .catch(() => undefined);

    expect(mockCreateContainer).not.toHaveBeenCalled();
  });
});

/** Run `fn` as if the orchestrator ran on `platform`, restoring it afterwards. */
async function onPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

/** Every argument list the nft helpers were called with during the test. */
function nftCalls(): unknown[][] {
  return [
    ...mockEnsureKiciTable.mock.calls,
    ...mockRemoveIsolationRules.mock.calls,
    ...mockAddIsolationRules.mock.calls,
    ...mockAddHostIsolationRules.mock.calls,
  ];
}

describe('BareMetalScalerBackend container mode — nft privileges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateContainer.mockResolvedValue({
      id: 'container-perjob-abc',
      start: mockStart,
      remove: mockRemove,
      wait: mockWait,
    });
    mockWait.mockResolvedValue({ StatusCode: 0 });
    mockGetContainer.mockReturnValue({
      remove: mockRemove,
      inspect: vi.fn().mockResolvedValue({
        NetworkSettings: { Networks: { 'kici-agent-net': { IPAddress: '172.30.0.9' } } },
      }),
    });
    mockGetImage.mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) });
    mockGetVolume.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({}),
      remove: mockVolumeRemove,
    });
    mockDetectRuntime.mockResolvedValue({ runtime: 'docker', socketPath: '/var/run/docker.sock' });
    mockEnsureIsolatedNetwork.mockResolvedValue('net-abc');
    mockEnsureKiciTable.mockResolvedValue(undefined);
    mockAddIsolationRules.mockResolvedValue(undefined);
    mockAddHostIsolationRules.mockResolvedValue(undefined);
    mockRemoveIsolationRules.mockResolvedValue(undefined);
    mockInfo.mockResolvedValue({ SecurityOptions: ['name=seccomp,profile=default'] });
    mockProbeNftables.mockResolvedValue(null);
  });

  it('runs every nft call of a job-image agent through sudo -n when requireSudo is set', async () => {
    // fails-when: any nft call on the job-image path drops the scaler's
    // requireSudo, so a non-root orchestrator still runs a bare `nft`.
    const backend = new BareMetalScalerBackend({
      name: 'rootless',
      labelSets,
      maxAgents: 5,
      requireSudo: true,
    });

    await backend.spawn(['linux'], 'agent-s1', 'ws://172.30.0.1:4000/ws', () => {}, undefined, {
      container: jobContainer,
    });
    await backend.destroy('agent-s1');

    // Positive control: each helper ran, so the property below covers them all.
    expect(mockEnsureKiciTable).toHaveBeenCalled();
    expect(mockAddIsolationRules).toHaveBeenCalled();
    expect(mockAddHostIsolationRules).toHaveBeenCalled();
    expect(mockRemoveIsolationRules).toHaveBeenCalledTimes(2); // pre-clean + destroy
    for (const args of nftCalls()) expect(args.at(-1)).toEqual({ requireSudo: true });
  });

  it('ensures the kici table before the first per-container rule', async () => {
    // fails-when: the first rule is inserted into a forward chain nothing
    // created — nft fails with "No such file or directory" on a fresh host.
    const backend = makeBackend();
    await backend.spawn(['linux'], 'agent-s2', 'ws://orch/ws', () => {}, undefined, {
      container: jobContainer,
    });
    expect(mockEnsureKiciTable.mock.invocationCallOrder[0]!).toBeLessThan(
      mockRemoveIsolationRules.mock.invocationCallOrder[0]!,
    );
  });

  it('cleans up a failed spawn through sudo -n too', async () => {
    mockAddIsolationRules.mockRejectedValueOnce(new Error('nft: insert failed'));
    const backend = new BareMetalScalerBackend({
      name: 'rootless',
      labelSets,
      maxAgents: 5,
      requireSudo: true,
    });

    await expect(
      backend.spawn(['linux'], 'agent-s3', 'ws://orch/ws', () => {}, undefined, {
        container: jobContainer,
      }),
    ).rejects.toThrow('nft: insert failed');
    expect(mockRemoveIsolationRules).toHaveBeenLastCalledWith('172.30.0.9', { requireSudo: true });
  });

  it('runs a root config with no requireSudo through a bare nft, as before', async () => {
    // breaks-if-wrong: a root orchestrator with no requireSudo must not start
    // prefixing sudo, which would fail on a host with no sudoers rule.
    const backend = makeBackend();
    await backend.spawn(['linux'], 'agent-s4', 'ws://orch/ws', () => {}, undefined, {
      container: jobContainer,
    });
    expect(nftCalls().length).toBeGreaterThan(0);
    for (const args of nftCalls()) expect(args.at(-1)).toEqual({ requireSudo: false });
  });

  it('maps the scaler extraHosts into the agent container', async () => {
    const backend = new BareMetalScalerBackend({
      name: 'hosts',
      labelSets,
      maxAgents: 5,
      extraHosts: ['registry.example.internal:host-gateway'],
    });
    await backend.spawn(['linux'], 'agent-s5', 'ws://orch/ws', () => {}, undefined, {
      container: jobContainer,
    });
    const created = mockCreateContainer.mock.calls.at(-1)![0] as {
      HostConfig: { ExtraHosts?: string[] };
    };
    expect(created.HostConfig.ExtraHosts).toEqual(['registry.example.internal:host-gateway']);
  });

  it('refuses a rootless runtime before it pulls or starts anything', async () => {
    // fails-when: a rootless runtime is accepted — its networks live in their
    // own namespace, so the host rules would be written and match nothing.
    mockInfo.mockResolvedValue({
      SecurityOptions: ['name=seccomp,profile=default', 'name=rootless'],
    });
    await expect(
      makeBackend().spawn(['linux'], 'agent-r1', 'ws://orch/ws', () => {}, undefined, {
        container: jobContainer,
      }),
    ).rejects.toThrow(/rootless/);
    expect(mockCreateContainer).not.toHaveBeenCalled();
    expect(nftCalls()).toHaveLength(0);
  });

  it('fails closed, and removes the container, when it has no address on the agent network', async () => {
    // fails-when: the spawn keeps a running container that no rule covers.
    mockGetContainer.mockReturnValue({
      remove: mockRemove,
      inspect: vi.fn().mockResolvedValue({ NetworkSettings: { Networks: {} } }),
    });
    await expect(
      makeBackend().spawn(['linux'], 'agent-n1', 'ws://orch/ws', () => {}, undefined, {
        container: jobContainer,
      }),
    ).rejects.toThrow(/no address on kici-agent-net/);
    expect(mockRemove).toHaveBeenCalledWith({ force: true });
    expect(mockAddIsolationRules).not.toHaveBeenCalled();
  });

  it('sets no ExtraHosts when the scaler declares none', async () => {
    await makeBackend().spawn(['linux'], 'agent-s6', 'ws://orch/ws', () => {}, undefined, {
      container: jobContainer,
    });
    const created = mockCreateContainer.mock.calls.at(-1)![0] as {
      HostConfig: Record<string, unknown>;
    };
    expect(created.HostConfig).not.toHaveProperty('ExtraHosts');
  });
});

describe('BareMetalScalerBackend.create — the load-time nft check', () => {
  const imageOnly: LabelSetConfig[] = [
    { labels: ['proc'], binaryPath: '/usr/bin/kici-agent' },
    { labels: ['img'], image: 'quay.io/kici-dev/kici-agent:1' },
  ];
  const processOnly: LabelSetConfig[] = [{ labels: ['proc'], binaryPath: '/usr/bin/kici-agent' }];
  const notRoot = 'Error: Operation not permitted (you must be root)';

  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectRuntime.mockResolvedValue({ runtime: 'docker', socketPath: '/var/run/docker.sock' });
    mockInfo.mockResolvedValue({ SecurityOptions: [] });
    mockEnsureKiciTable.mockResolvedValue(undefined);
    mockProbeNftables.mockResolvedValue(null);
  });

  it('refuses a job-image label set when this orchestrator cannot run nft', async () => {
    // fails-when: the load-time check passes a config that cannot run, so every
    // spawn of this scaler fails instead of the orchestrator refusing to start.
    mockProbeNftables.mockResolvedValue(notRoot);
    const err = await onPlatform('linux', () =>
      BareMetalScalerBackend.create({ name: 'img-pool', labelSets: imageOnly, maxAgents: 2 }),
    ).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect(mockProbeNftables).toHaveBeenCalledWith({ requireSudo: false });
    const message = (err as Error).message;
    expect(message).toContain('Bare-metal scaler "img-pool"');
    expect(message).toContain('labelSets[1]');
    expect(message).not.toContain('labelSets[0]');
    expect(message).toContain(notRoot);
    expect(message).toContain('CAP_NET_ADMIN');
    expect(message).toContain('"requireSudo: true"');
    expect(message).toContain('NOPASSWD: /usr/sbin/nft');
    expect(mockEnsureKiciTable).not.toHaveBeenCalled();
  });

  it('probes through sudo -n, and names the sudoers rule, when requireSudo is set', async () => {
    mockProbeNftables.mockResolvedValue('sudo: a password is required');
    const err = await onPlatform('linux', () =>
      BareMetalScalerBackend.create({
        name: 'img-pool',
        labelSets: imageOnly,
        maxAgents: 2,
        requireSudo: true,
      }),
    ).catch((e: unknown) => e as Error);

    expect(mockProbeNftables).toHaveBeenCalledWith({ requireSudo: true });
    expect((err as Error).message).toContain('through "sudo -n"');
    expect((err as Error).message).toContain('sudo: a password is required');
    expect((err as Error).message).toContain('NOPASSWD: /usr/sbin/nft');
  });

  it('loads a rootless job-image config with requireSudo and ensures the table through sudo', async () => {
    const backend = await onPlatform('linux', () =>
      BareMetalScalerBackend.create({
        name: 'img-pool',
        labelSets: imageOnly,
        maxAgents: 2,
        requireSudo: true,
      }),
    );
    expect(backend).toBeInstanceOf(BareMetalScalerBackend);
    expect(mockEnsureKiciTable).toHaveBeenCalledWith({ requireSudo: true });
  });

  it('loads a root job-image config with no requireSudo, unchanged', async () => {
    // breaks-if-wrong: a root (or CAP_NET_ADMIN) orchestrator that works today
    // must load: its probe passes and nft runs without sudo.
    const backend = await onPlatform('linux', () =>
      BareMetalScalerBackend.create({ name: 'img-pool', labelSets: imageOnly, maxAgents: 2 }),
    );
    expect(backend).toBeInstanceOf(BareMetalScalerBackend);
    expect(mockProbeNftables).toHaveBeenCalledWith({ requireSudo: false });
    expect(mockEnsureKiciTable).toHaveBeenCalledWith({ requireSudo: false });
  });

  it('refuses when the table cannot be created even though listing works', async () => {
    mockEnsureKiciTable.mockRejectedValue(new Error('Error: Operation not permitted'));
    await expect(
      onPlatform('linux', () =>
        BareMetalScalerBackend.create({ name: 'img-pool', labelSets: imageOnly, maxAgents: 2 }),
      ),
    ).rejects.toThrow(/Bare-metal scaler "img-pool".*Operation not permitted.*CAP_NET_ADMIN/s);
  });

  it('never refuses a process-only scaler, whatever nft says', async () => {
    // breaks-if-wrong: process mode runs no nft, so a host without nft (or a
    // non-root orchestrator) must keep loading a process-only pool.
    mockProbeNftables.mockResolvedValue(notRoot);
    const backend = await onPlatform('linux', () =>
      BareMetalScalerBackend.create({ name: 'proc-pool', labelSets: processOnly, maxAgents: 2 }),
    );
    expect(backend).toBeInstanceOf(BareMetalScalerBackend);
    expect(mockEnsureKiciTable).not.toHaveBeenCalled();
  });

  it('names sudo as the missing binary when requireSudo is set', async () => {
    mockProbeNftables.mockResolvedValue(
      'Command `sudo -n nft list tables` could not start: spawn sudo ENOENT',
    );
    const err = await onPlatform('linux', () =>
      BareMetalScalerBackend.create({
        name: 'img-pool',
        labelSets: imageOnly,
        maxAgents: 2,
        requireSudo: true,
      }),
    ).catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain('sudo or nft is not installed');
  });

  it('refuses a job-image scaler at load when the reachable runtime is rootless', async () => {
    mockDetectRuntime.mockResolvedValue({
      runtime: 'podman',
      socketPath: '/run/user/1000/podman/podman.sock',
    });
    mockInfo.mockResolvedValue({ SecurityOptions: ['name=rootless'] });
    await expect(
      onPlatform('linux', () =>
        BareMetalScalerBackend.create({ name: 'img-pool', labelSets: imageOnly, maxAgents: 2 }),
      ),
    ).rejects.toThrow(/img-pool.*rootless.*rootful Docker or Podman socket/s);
  });

  it('loads a job-image scaler when the runtime is rootful, unreachable or absent', async () => {
    // breaks-if-wrong: a rootful runtime, or one not up yet at load, must not
    // block startup; every spawn checks again.
    mockDetectRuntime.mockResolvedValue({ runtime: 'docker', socketPath: '/var/run/docker.sock' });
    mockInfo.mockResolvedValue({ SecurityOptions: ['name=seccomp,profile=builtin'] });
    const create = () =>
      onPlatform('linux', () =>
        BareMetalScalerBackend.create({ name: 'img-pool', labelSets: imageOnly, maxAgents: 2 }),
      );
    await expect(create()).resolves.toBeInstanceOf(BareMetalScalerBackend);
    mockInfo.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(create()).resolves.toBeInstanceOf(BareMetalScalerBackend);
    mockDetectRuntime.mockResolvedValue(null);
    await expect(create()).resolves.toBeInstanceOf(BareMetalScalerBackend);
  });

  it('says nft may be missing from PATH when the probe cannot start it', async () => {
    mockProbeNftables.mockResolvedValue(
      'Command `nft list tables` could not start: spawn nft ENOENT',
    );
    const err = await onPlatform('linux', () =>
      BareMetalScalerBackend.create({ name: 'img-pool', labelSets: imageOnly, maxAgents: 2 }),
    ).catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain("not on the orchestrator's PATH");
    expect((err as Error).message).toContain('"requireSudo: true"');
  });

  it('refuses a job-image label set on a host without nftables, without running anything', async () => {
    const err = await onPlatform('darwin', () =>
      BareMetalScalerBackend.create({ name: 'mac', labelSets: imageOnly, maxAgents: 2 }),
    ).catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain('nftables is available on Linux only');
    expect(mockProbeNftables).not.toHaveBeenCalled();
  });

  describe('reload', () => {
    const entry = (requireSudo: boolean) => ({ requireSudo }) as unknown as ScalerEntry;

    it('refuses to add a job-image label set when the load probe failed', async () => {
      // fails-when: a reload adds a job-image set to a scaler created on a host
      // that cannot run nft, bypassing the load-time refusal.
      mockProbeNftables.mockResolvedValue(notRoot);
      const backend = await onPlatform('linux', () =>
        BareMetalScalerBackend.create({ name: 'proc-pool', labelSets: processOnly, maxAgents: 2 }),
      );
      const result = backend.reload(imageOnly, { entry: entry(false) });
      expect(result.valid).toBe(false);
      expect(result.valid ? '' : result.errors.join('\n')).toContain('CAP_NET_ADMIN');
      expect(backend.labelSets).toBe(processOnly);
    });

    it('accepts a job-image label set when the load probe passed', async () => {
      // breaks-if-wrong: a root orchestrator adding a job-image set by reload
      // works today and must keep working.
      const backend = await onPlatform('linux', () =>
        BareMetalScalerBackend.create({ name: 'proc-pool', labelSets: processOnly, maxAgents: 2 }),
      );
      expect(backend.reload(imageOnly, { entry: entry(false) })).toEqual({ valid: true });
      expect(backend.labelSets).toBe(imageOnly);
    });

    it('refuses a requireSudo change while a label set runs job images', async () => {
      const backend = await onPlatform('linux', () =>
        BareMetalScalerBackend.create({ name: 'img-pool', labelSets: imageOnly, maxAgents: 2 }),
      );
      const result = backend.reload(imageOnly, { entry: entry(true) });
      expect(result.valid).toBe(false);
      expect(result.valid ? '' : result.errors.join('\n')).toContain(
        'requireSudo cannot change on reload',
      );
    });

    it('accepts a requireSudo change on a process-only scaler', async () => {
      mockProbeNftables.mockResolvedValue(notRoot);
      const backend = await onPlatform('linux', () =>
        BareMetalScalerBackend.create({ name: 'proc-pool', labelSets: processOnly, maxAgents: 2 }),
      );
      expect(backend.reload(processOnly, { entry: entry(true) })).toEqual({ valid: true });
    });
  });
});
