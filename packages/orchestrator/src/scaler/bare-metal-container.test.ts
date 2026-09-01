import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LabelSetConfig } from './types.js';

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

vi.mock('dockerode', () => ({
  default: vi.fn().mockImplementation(function () {
    return {
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
vi.mock('./container-backend.js', () => ({ detectRuntime: mockDetectRuntime }));

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
    mockGetContainer.mockReturnValue({ remove: mockRemove });
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
