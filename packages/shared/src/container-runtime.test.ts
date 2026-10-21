import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  agentImageId,
  agentImageLabels,
  pullImageIfMissing,
  runtimeInjectBind,
  injectedAgentCommand,
  ensureRuntimeVolume,
  runtimeVolumeName,
  RUNTIME_MOUNT,
  RUNTIME_NODE_MOUNT,
  RuntimeSubtree,
  RUNTIME_INIT_LABEL,
  RUNTIME_TINI_PATH,
  RuntimeInit,
  runtimeInitCommand,
} from './container-runtime.js';

function mockDocker(opts: { present?: boolean } = {}) {
  const inspect = opts.present
    ? vi.fn().mockResolvedValue({})
    : vi.fn().mockRejectedValue(new Error('no such image'));
  const getImage = vi.fn().mockReturnValue({ inspect });
  const pull = vi.fn().mockResolvedValue({});
  const followProgress = vi.fn((_s: unknown, cb: (e: Error | null) => void) => cb(null));
  return {
    docker: { getImage, pull, modem: { followProgress } } as never,
    getImage,
    pull,
  };
}

describe('pullImageIfMissing', () => {
  it('skips the pull when the image is already local', async () => {
    const { docker, pull } = mockDocker({ present: true });
    expect(await pullImageIfMissing({ docker, image: 'python:3.12-slim' })).toBe(false);
    expect(pull).not.toHaveBeenCalled();
  });

  it('pulls with credentials when they are supplied', async () => {
    const { docker, pull } = mockDocker();
    const authconfig = {
      username: 'bot',
      password: 's3cr3t',
      serveraddress: 'reg.internal:5000',
    };

    expect(await pullImageIfMissing({ docker, image: 'reg.internal:5000/a/b:1', authconfig })).toBe(
      true,
    );
    // Without auth a private registry returns a 401 that reads like a missing image.
    expect(pull).toHaveBeenCalledWith('reg.internal:5000/a/b:1', { authconfig });
  });

  it('pulls anonymously when no credentials are supplied', async () => {
    const { docker, pull } = mockDocker();
    await pullImageIfMissing({ docker, image: 'python:3.12-slim' });
    expect(pull).toHaveBeenCalledWith('python:3.12-slim', {});
  });

  it('always pulls under the Always policy, even when the image is local', async () => {
    const { docker, pull } = mockDocker({ present: true });
    expect(
      await pullImageIfMissing({ docker, image: 'acme/ci:latest', pullPolicy: 'Always' }),
    ).toBe(true);
    // A moving tag sets Always; skipping the pull would run stale bytes under it.
    expect(pull).toHaveBeenCalled();
  });

  it('never pulls under the Never policy, even when the image is absent', async () => {
    const { docker, pull } = mockDocker();
    expect(
      await pullImageIfMissing({ docker, image: 'locally-built:1', pullPolicy: 'Never' }),
    ).toBe(false);
    // Never: the operator guarantees the image is present (air-gapped host, local build).
    expect(pull).not.toHaveBeenCalled();
  });

  it('refuses before starting a long pull when already aborted', async () => {
    const { docker, pull } = mockDocker();
    const ac = new AbortController();
    ac.abort(new Error('deadline passed'));

    await expect(
      pullImageIfMissing({ docker, image: 'python:3.12-slim', signal: ac.signal }),
    ).rejects.toThrow(/deadline passed/);
    expect(pull).not.toHaveBeenCalled();
  });

  it('reports progress so a caller can surface it as a scaler event', async () => {
    const { docker } = mockDocker();
    const onProgress = vi.fn();
    await pullImageIfMissing({ docker, image: 'python:3.12-slim', onProgress });
    expect(onProgress).toHaveBeenCalledWith('pulling image python:3.12-slim');
  });
});

describe('runtimeInjectBind', () => {
  it('mounts the runtime read-only at /opt/kici', () => {
    // Writable would let a job rewrite the interpreter its later steps run under.
    expect(runtimeInjectBind('/var/lib/kici/runtime')).toBe(
      `/var/lib/kici/runtime:${RUNTIME_MOUNT}:ro`,
    );
  });
});

describe('injectedAgentCommand', () => {
  it('names both halves absolutely, since the image ships neither', () => {
    // breaks-if-wrong: an agent image with no init label starts as before.
    expect(injectedAgentCommand()).toEqual([
      `${RUNTIME_MOUNT}/node/bin/node`,
      `${RUNTIME_MOUNT}/app/packages/agent/dist/server.js`,
    ]);
  });

  it('starts the agent under the init it is given', () => {
    expect(injectedAgentCommand(['/opt/kici/bin/tini', '-s', '--'])).toEqual([
      '/opt/kici/bin/tini',
      '-s',
      '--',
      '/opt/kici/node/bin/node',
      '/opt/kici/app/packages/agent/dist/server.js',
    ]);
  });
});

describe('runtimeInitCommand', () => {
  it('starts an injected agent under the runtime tini when the image names it', () => {
    // fails-when: the label is ignored, so an agent started inside a job's
    // own image is PID 1 and never reaps a step's orphans.
    expect(runtimeInitCommand({ [RUNTIME_INIT_LABEL]: 'tini' })).toEqual([
      '/opt/kici/bin/tini',
      '-s',
      '--',
    ]);
  });

  it('adds no init for an agent image that names none', () => {
    // breaks-if-wrong: an agent image built before the label must start
    // exactly as it did; its runtime tree has no /opt/kici/bin/tini.
    expect(runtimeInitCommand(undefined)).toEqual([]);
    expect(runtimeInitCommand(null)).toEqual([]);
    expect(runtimeInitCommand({ 'org.opencontainers.image.version': '0.14.2' })).toEqual([]);
  });

  it('adds no init for a value this release does not know', () => {
    expect(runtimeInitCommand({ [RUNTIME_INIT_LABEL]: 'catatonit' })).toEqual([]);
  });

  it('agrees with what the agent image ships', () => {
    // fails-when: the Dockerfile's label, install path or entrypoint drifts
    // from what the scalers start: the injected command would name a file
    // the runtime tree does not carry.
    const dockerfile = readFileSync(
      path.resolve(import.meta.dirname, '../../agent/Dockerfile'),
      'utf8',
    );
    expect(dockerfile).toContain(`LABEL ${RUNTIME_INIT_LABEL}="${RuntimeInit.enum.tini}"`);
    expect(dockerfile).toMatch(
      new RegExp(`install -o root -g root -m 0755 /usr/bin/tini-static ${RUNTIME_TINI_PATH}\\b`),
    );
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "-s", "--"]');
    expect(dockerfile).toContain('CMD ["node", "packages/agent/dist/server.js"]');
  });
});

describe('agentImageLabels', () => {
  it('reads the labels of the agent image', async () => {
    const inspect = vi
      .fn()
      .mockResolvedValue({ Config: { Labels: { [RUNTIME_INIT_LABEL]: 'tini' } } });
    const getImage = vi.fn().mockReturnValue({ inspect });
    expect(await agentImageLabels({ getImage } as never, 'kici-agent:x')).toEqual({
      [RUNTIME_INIT_LABEL]: 'tini',
    });
    expect(getImage).toHaveBeenCalledWith('kici-agent:x');
  });

  it('reads an image with no labels as none', async () => {
    // Docker reports an unlabelled image's Labels as null.
    const inspect = vi.fn().mockResolvedValue({ Config: { Labels: null } });
    const getImage = vi.fn().mockReturnValue({ inspect });
    expect(await agentImageLabels({ getImage } as never, 'kici-agent:x')).toBeUndefined();
  });
});

describe('agentImageId', () => {
  it('returns the image ID', async () => {
    const inspect = vi.fn().mockResolvedValue({ Id: 'sha256:abc' });
    const getImage = vi.fn().mockReturnValue({ inspect });
    expect(await agentImageId({ getImage } as never, 'kici-agent:x')).toBe('sha256:abc');
    expect(getImage).toHaveBeenCalledWith('kici-agent:x');
  });

  // fails-when: a missing image throws into the spawn path instead of reading as unknown
  it('returns null when the image is absent', async () => {
    const inspect = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('no such image'), { statusCode: 404 }));
    const getImage = vi.fn().mockReturnValue({ inspect });
    expect(await agentImageId({ getImage } as never, 'kici-agent:x')).toBeNull();
  });
});

interface FakeContainerArg {
  Cmd: string[];
  User?: string;
  Labels?: Record<string, string>;
  HostConfig: { Binds: string[] };
}

function runtimeDocker(
  opts: {
    volumeExists?: boolean;
    /** Whether the existing volume carries the completion marker. */
    volumePopulated?: boolean;
    copyExit?: number;
    imageId?: string;
    logs?: string;
    /**
     * Holds the populator's exit status, so a second caller can arrive
     * mid-populate. Without it the calls never overlap and a concurrency
     * assertion passes with no mutex present.
     */
    populateGate?: Promise<{ StatusCode: number }>;
  } = {},
) {
  const volumeInspect = opts.volumeExists
    ? vi.fn().mockResolvedValue({})
    : vi.fn().mockRejectedValue(new Error('no such volume'));
  // Records teardown ORDER: "the populator is gone before the volume is reaped".
  const teardownOrder: string[] = [];
  const volumeRemove = vi.fn().mockImplementation(() => {
    teardownOrder.push('volume');
    return Promise.resolve(undefined);
  });
  const getVolume = vi.fn().mockReturnValue({ inspect: volumeInspect, remove: volumeRemove });
  const createVolume = vi.fn().mockResolvedValue({});
  const start = vi.fn().mockResolvedValue(undefined);
  const wait = vi
    .fn()
    .mockImplementation(
      () => opts.populateGate ?? Promise.resolve({ StatusCode: opts.copyExit ?? 0 }),
    );
  const remove = vi.fn().mockImplementation(() => {
    teardownOrder.push('populator');
    return Promise.resolve(undefined);
  });
  const logs = vi.fn().mockResolvedValue(Buffer.from(opts.logs ?? ''));

  // The marker probe and the populator are both containers; the copy tells them apart.
  const probeWait = vi.fn().mockResolvedValue({
    StatusCode: (opts.volumePopulated ?? true) ? 0 : 1,
  });
  const populatorArgs: FakeContainerArg[] = [];
  const probeArgs: FakeContainerArg[] = [];
  const createContainer = vi.fn().mockImplementation((arg: FakeContainerArg) => {
    if (arg.Cmd.join(' ').includes('cp -a')) {
      populatorArgs.push(arg);
      return Promise.resolve({ start, wait, remove, logs });
    }
    probeArgs.push(arg);
    return Promise.resolve({
      start: vi.fn().mockResolvedValue(undefined),
      wait: probeWait,
      remove: vi.fn().mockResolvedValue(undefined),
      logs,
    });
  });
  const getImage = vi.fn().mockReturnValue({
    inspect: vi.fn().mockResolvedValue({ Id: opts.imageId ?? 'sha256:' + 'a'.repeat(64) }),
  });
  return {
    docker: {
      getVolume,
      createVolume,
      createContainer,
      getImage,
      pull: vi.fn(),
      modem: { followProgress: vi.fn() },
    } as never,
    createVolume,
    createContainer,
    volumeRemove,
    remove,
    /** 1 means the copy ran once. */
    populatorCount: () => populatorArgs.length,
    populatorArg: () => populatorArgs[0],
    probeArg: () => probeArgs[0],
    /** Teardown calls in the order they happened: 'populator' / 'volume'. */
    teardownOrder: () => teardownOrder,
  };
}

describe('runtimeVolumeName', () => {
  it('keys the volume by image CONTENT, so a rebuild gets a fresh runtime', () => {
    // A moving tag such as :latest is rebuilt in place; keying by name would
    // reuse a volume populated from the OLD image.
    const a = runtimeVolumeName('sha256:' + 'a'.repeat(64));
    const b = runtimeVolumeName('sha256:' + 'b'.repeat(64));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^kici-runtime-/);
  });

  it('produces a name a container runtime accepts', () => {
    expect(runtimeVolumeName('sha256:' + 'c'.repeat(64))).toMatch(/^[a-zA-Z0-9_.-]+$/);
  });

  it('separates the node subtree from the whole tree for the same image', () => {
    // A `node` volume's root is the node tree. Sharing a name would mount
    // bin/node one level off, failing at container start with no named cause.
    const id = 'sha256:' + 'd'.repeat(64);
    expect(runtimeVolumeName(id, RuntimeSubtree.enum.node)).not.toBe(
      runtimeVolumeName(id, RuntimeSubtree.enum.all),
    );
  });
});

describe('ensureRuntimeVolume', () => {
  it('reuses an existing volume without repopulating it', async () => {
    const { docker, createVolume, populatorCount } = runtimeDocker({ volumeExists: true });
    const name = await ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1' });
    // Named for the image's CONTENT id, not the tag it happens to carry.
    expect(name).toBe(runtimeVolumeName('sha256:' + 'a'.repeat(64)));
    expect(createVolume).not.toHaveBeenCalled();
    expect(populatorCount()).toBe(0);
  });

  it('copies the runtime out of the agent image on first use', async () => {
    const { docker, createVolume, createContainer, remove } = runtimeDocker();
    await ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1' });

    expect(createVolume).toHaveBeenCalled();
    const createArg = createContainer.mock.calls[0][0] as { Cmd: string[]; Image: string };
    expect(createArg.Image).toBe('kici-agent:1');
    // `cp -a` preserves the executable bits the node binary needs.
    expect(createArg.Cmd.join(' ')).toMatch(/cp -a \/opt\/kici\/\. /);
    // Leaving the populator behind leaks a container per agent-image upgrade.
    expect(remove).toHaveBeenCalled();
  });

  it('runs the populator as root so it can write a fresh volume', async () => {
    const { docker, createContainer } = runtimeDocker();
    await ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1' });

    // The agent image runs as `node` and a fresh volume is root-owned, so a
    // non-root copy fails with a bare "exited 1" under rootful docker (rootless
    // podman maps the user and happens to work).
    expect((createContainer.mock.calls[0][0] as { User?: string }).User).toBe('0:0');
  });

  it('verifies the copy landed, so an empty volume cannot pass as success', async () => {
    const { docker, createContainer } = runtimeDocker();
    await ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1' });

    // An empty or partial copy otherwise exits 0, and every container spawned
    // on the volume fails to start (seen with a volume from a pre-/opt/kici image).
    const cmd = (createContainer.mock.calls[0][0] as { Cmd: string[] }).Cmd.join(' ');
    expect(cmd).toContain('set -e');
    expect(cmd).toContain('test -x /kici-runtime-out/node/bin/node');
    expect(cmd).toContain('test -f /kici-runtime-out/app/packages/agent/dist/server.js');
  });

  it('materializes the node subtree at the volume ROOT, and verifies it', async () => {
    const { docker, createContainer } = runtimeDocker();
    const name = await ensureRuntimeVolume({
      docker,
      agentImage: 'kici-agent:1',
      subtree: RuntimeSubtree.enum.node,
    });

    // Mounted at /opt/kici/node, so its root holds `bin/node`, not `node/bin/node`.
    const cmd = (createContainer.mock.calls[0][0] as { Cmd: string[] }).Cmd.join(' ');
    expect(cmd).toContain('cp -a /opt/kici/node/. /kici-runtime-out/');
    expect(cmd).toContain('test -x /kici-runtime-out/bin/node');
    expect(name).toBe(runtimeVolumeName('sha256:' + 'a'.repeat(64), RuntimeSubtree.enum.node));
  });

  it('names what the image must carry when materialization fails', async () => {
    const { docker } = runtimeDocker({ copyExit: 1 });
    await expect(ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1' })).rejects.toThrow(
      /must carry \/opt\/kici\/node and \/opt\/kici\/app/,
    );
  });

  it("carries the populator's own output into the failure", async () => {
    const { docker } = runtimeDocker({ copyExit: 1, logs: 'cp: cannot create: No space left' });
    // Otherwise the failure reads only as "exited 1": no sign of a missing tree,
    // an unwritable volume or a full disk.
    await expect(ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1' })).rejects.toThrow(
      /No space left/,
    );
  });

  it('removes the half-populated volume when the copy fails', async () => {
    const { docker, volumeRemove } = runtimeDocker({ volumePopulated: false, copyExit: 1 });
    await expect(ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1' })).rejects.toThrow(
      /Failed to materialize/,
    );
    // Disk hygiene: the missing marker already stops a mount, but the dead
    // volume would sit there, overwritten by every retry.
    expect(volumeRemove).toHaveBeenCalled();
  });

  it('drops the populator before reaping the volume it references', async () => {
    const { docker, teardownOrder } = runtimeDocker({ volumePopulated: false, copyExit: 1 });
    await expect(ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1' })).rejects.toThrow(
      /Failed to materialize/,
    );
    // The daemon refuses to remove a volume any container, even a STOPPED
    // populator, references: reaping first silently leaves it on disk.
    expect(teardownOrder()).toEqual(['populator', 'volume']);
  });

  it('does not reap a volume another populate has completed in the meantime', async () => {
    const { docker, volumeRemove } = runtimeDocker({
      // Another process created AND filled the volume between look and failure.
      volumeExists: false,
      volumePopulated: true,
      copyExit: 1,
    });
    await expect(ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1' })).rejects.toThrow(
      /Failed to materialize/,
    );
    // "This call created it" is a pre-copy snapshot and cannot authorise a
    // removal after it: removing a now-complete volume leaves the winner
    // mounting a daemon-recreated EMPTY one. The daemon's 409 covers only while
    // the winner's populator is registered; the marker covers the rest.
    expect(volumeRemove).not.toHaveBeenCalled();
  });

  it('leaves a pre-existing volume alone when the copy fails', async () => {
    const { docker, volumeRemove } = runtimeDocker({
      volumeExists: true,
      volumePopulated: false,
      copyExit: 1,
    });
    await expect(ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1' })).rejects.toThrow(
      /Failed to materialize/,
    );
    // The in-flight map serialises populates within ONE process; agents are a
    // process each on a shared daemon. A cross-process loser reaches this while
    // the winner still copies, and force-removing would leave the winner
    // mounting an EMPTY recreated volume. Only a volume this call created is
    // safe to reap.
    expect(volumeRemove).not.toHaveBeenCalled();
  });

  it('writes the completion marker LAST, after the copy verifies', async () => {
    for (const subtree of [RuntimeSubtree.enum.all, RuntimeSubtree.enum.node]) {
      const { docker, populatorArg } = runtimeDocker();
      await ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1', subtree });

      const cmd = populatorArg().Cmd.join(' ').trim();
      // Any earlier, a half-copied, unverified runtime would read as complete.
      expect(cmd.endsWith('touch /kici-runtime-out/.kici-runtime-complete')).toBe(true);
      expect(cmd.indexOf('test -')).toBeLessThan(cmd.indexOf('touch '));
    }
  });

  it('probes the marker with the same mount shape the populator uses', async () => {
    const { docker, probeArg } = runtimeDocker({ volumeExists: true });
    const name = await ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1' });

    // Only a container can read the daemon-owned volume, and it must be root
    // with the same bind to read the tree the populator wrote.
    const arg = probeArg();
    expect(arg.Cmd.join(' ')).toContain('test -f /kici-runtime-out/.kici-runtime-complete');
    expect(arg.User).toBe('0:0');
    expect(arg.HostConfig.Binds).toEqual([`${name}:/kici-runtime-out`]);
  });

  it('labels the probe and the populator so the orphan reaper can find them', async () => {
    const fresh = runtimeDocker();
    await ensureRuntimeVolume({ docker: fresh.docker, agentImage: 'kici-agent:1' });
    // The reaper selects on `kici-managed=true`: an unlabelled container
    // stranded by a kill between create and remove is invisible to it.
    expect(fresh.populatorArg().Labels).toEqual({ 'kici-managed': 'true' });

    const reused = runtimeDocker({ volumeExists: true });
    await ensureRuntimeVolume({ docker: reused.docker, agentImage: 'kici-agent:1' });
    // The probe matters more than the populator: it runs on EVERY spawn.
    expect(reused.probeArg().Labels).toEqual({ 'kici-managed': 'true' });
  });

  it('repopulates an existing volume that carries no completion marker', async () => {
    const { docker, populatorCount } = runtimeDocker({
      volumeExists: true,
      volumePopulated: false,
    });
    await ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1' });

    // Existence is NOT population: a volume from a crashed or running populate
    // inspects fine and mounts a half-copied runtime that fails far from here.
    expect(populatorCount()).toBe(1);
  });

  it('shares one populate between callers that arrive concurrently', async () => {
    let release!: (v: { StatusCode: number }) => void;
    const gate = new Promise<{ StatusCode: number }>((resolve) => {
      release = resolve;
    });
    const { docker, createVolume, populatorCount } = runtimeDocker({ populateGate: gate });

    const first = ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1' });
    // Wait until the first call is INSIDE the populate (wait() parked on the
    // gate); otherwise every assertion below holds with no mutex present.
    await vi.waitFor(() => expect(populatorCount()).toBe(1));

    const second = ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1' });
    // A full macrotask lets the second caller reach the volume mid-copy. Assert
    // HERE, with the gate closed: without the mutex this reads 2.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(populatorCount()).toBe(1);
    expect(createVolume).toHaveBeenCalledTimes(1);

    release({ StatusCode: 0 });

    // Two agents spawning together share the one populate's result, so neither
    // mounts a tree the other is still writing.
    const name = runtimeVolumeName('sha256:' + 'a'.repeat(64));
    expect(await Promise.all([first, second])).toEqual([name, name]);
    expect(populatorCount()).toBe(1);
  });

  it('clears the in-flight entry when a populate fails, so a later spawn retries', async () => {
    const { docker, populatorCount } = runtimeDocker({ copyExit: 1 });
    for (const _attempt of [1, 2]) {
      await expect(ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1' })).rejects.toThrow(
        /Failed to materialize/,
      );
    }
    // A retained rejection would fail every later spawn of this image.
    expect(populatorCount()).toBe(2);
  });
});

describe('RUNTIME_NODE_MOUNT', () => {
  it('sits under the runtime mount', () => {
    expect(RUNTIME_NODE_MOUNT).toBe(`${RUNTIME_MOUNT}/node`);
  });
});
