import { describe, it, expect, vi } from 'vitest';
import {
  pullImageIfMissing,
  runtimeInjectBind,
  injectedAgentCommand,
  ensureRuntimeVolume,
  runtimeVolumeName,
  RUNTIME_MOUNT,
  RUNTIME_NODE_MOUNT,
  RuntimeSubtree,
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
    // A private registry otherwise fails with a 401 that reads like a missing
    // image.
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
    // A label set on a MOVING tag sets Always; skipping the pull would run
    // yesterday's bytes under today's tag.
    expect(pull).toHaveBeenCalled();
  });

  it('never pulls under the Never policy, even when the image is absent', async () => {
    const { docker, pull } = mockDocker();
    expect(
      await pullImageIfMissing({ docker, image: 'locally-built:1', pullPolicy: 'Never' }),
    ).toBe(false);
    // Never means the operator guarantees the image is present — an air-gapped
    // host, or a locally-built image with no registry to pull from.
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
    // Writable would let a job rewrite the interpreter its own later steps run
    // under.
    expect(runtimeInjectBind('/var/lib/kici/runtime')).toBe(
      `/var/lib/kici/runtime:${RUNTIME_MOUNT}:ro`,
    );
  });
});

describe('injectedAgentCommand', () => {
  it('names both halves absolutely, since the image ships neither', () => {
    expect(injectedAgentCommand()).toEqual([
      `${RUNTIME_MOUNT}/node/bin/node`,
      `${RUNTIME_MOUNT}/app/packages/agent/dist/server.js`,
    ]);
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
     * Held instead of the populator's exit status, so a second caller can be
     * made to arrive while the first is genuinely mid-populate. Without a gate
     * the populator resolves immediately, the two never overlap, and a
     * concurrency assertion passes with no mutex present.
     */
    populateGate?: Promise<{ StatusCode: number }>;
  } = {},
) {
  const volumeInspect = opts.volumeExists
    ? vi.fn().mockResolvedValue({})
    : vi.fn().mockRejectedValue(new Error('no such volume'));
  // Every teardown appends here, so a test can assert the ORDER two of them
  // happen in — which is the whole content of "the populator is gone before
  // the volume is reaped".
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

  // Both the marker probe and the populator are containers; the copy is what
  // tells them apart.
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
    /** How many populator containers were created — 1 means the copy ran once. */
    populatorCount: () => populatorArgs.length,
    populatorArg: () => populatorArgs[0],
    probeArg: () => probeArgs[0],
    /** Teardown calls in the order they happened: 'populator' / 'volume'. */
    teardownOrder: () => teardownOrder,
  };
}

describe('runtimeVolumeName', () => {
  it('keys the volume by image CONTENT, so a rebuild gets a fresh runtime', () => {
    // A tag moves — :stg, :latest and every E2E tag are rebuilt in place — so
    // keying by name would reuse a volume populated from the OLD image.
    const a = runtimeVolumeName('sha256:' + 'a'.repeat(64));
    const b = runtimeVolumeName('sha256:' + 'b'.repeat(64));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^kici-runtime-/);
  });

  it('produces a name a container runtime accepts', () => {
    expect(runtimeVolumeName('sha256:' + 'c'.repeat(64))).toMatch(/^[a-zA-Z0-9_.-]+$/);
  });

  it('separates the node subtree from the whole tree for the same image', () => {
    // The two volumes have different ROOTS: a `node` volume's own root is the
    // node tree. Sharing one name would mount a tree whose bin/node is one
    // level off, which fails at container start with nothing naming the cause.
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
    // The populator is a throwaway; leaving it behind would leak a container
    // per agent-image upgrade.
    expect(remove).toHaveBeenCalled();
  });

  it('runs the populator as root so it can write a fresh volume', async () => {
    const { docker, createContainer } = runtimeDocker();
    await ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1' });

    // The agent image runs as `node`, and a fresh named volume is root-owned:
    // under rootful docker a non-root copy fails with a bare "exited 1".
    // Rootless podman maps the user and happens to work, which is why this only
    // appeared on the docker executor.
    expect((createContainer.mock.calls[0][0] as { User?: string }).User).toBe('0:0');
  });

  it('verifies the copy landed, so an empty volume cannot pass as success', async () => {
    const { docker, createContainer } = runtimeDocker();
    await ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1' });

    // An empty or partial copy otherwise exits 0 and yields a volume that looks
    // fine until every spawned container fails to start on a runtime that is
    // not there. That happened: a volume populated from a pre-/opt/kici image
    // was reused, and the job image was created but never started.
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

    // The volume is mounted at /opt/kici/node, so its root has to BE the node
    // tree — `bin/node`, not `node/bin/node`.
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
    // Without it the failure reads only as "exited 1", which says nothing about
    // whether the tree was missing, the volume unwritable, or the disk full —
    // a full debugging session was spent recovering exactly that.
    await expect(ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1' })).rejects.toThrow(
      /No space left/,
    );
  });

  it('removes the half-populated volume when the copy fails', async () => {
    const { docker, volumeRemove } = runtimeDocker({ volumePopulated: false, copyExit: 1 });
    await expect(ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1' })).rejects.toThrow(
      /Failed to materialize/,
    );
    // Disk hygiene: the absent completion marker already stops a later call
    // mounting it, but a dead volume would otherwise sit there being overwritten
    // by every retry.
    expect(volumeRemove).toHaveBeenCalled();
  });

  it('drops the populator before reaping the volume it references', async () => {
    const { docker, teardownOrder } = runtimeDocker({ volumePopulated: false, copyExit: 1 });
    await expect(ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1' })).rejects.toThrow(
      /Failed to materialize/,
    );
    // The daemon refuses to remove a volume any container still references, and
    // a STOPPED populator still counts. Reaping first is a silent no-op that
    // leaves the dead volume on disk — which is how a test host accumulates
    // dozens of them.
    expect(teardownOrder()).toEqual(['populator', 'volume']);
  });

  it('does not reap a volume another populate has completed in the meantime', async () => {
    const { docker, volumeRemove } = runtimeDocker({
      // No volume when this call looked; the marker is there by the time it
      // fails — i.e. another process created AND filled it in between.
      volumeExists: false,
      volumePopulated: true,
      copyExit: 1,
    });
    await expect(ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1' })).rejects.toThrow(
      /Failed to materialize/,
    );
    // Whether this call created the volume is a snapshot taken BEFORE the copy,
    // so it cannot authorise a removal after it. Removing a volume that now
    // reads complete destroys the winner's work and leaves it mounting a
    // daemon-recreated EMPTY volume. The daemon refuses the reap with 409 only
    // while the winner's populator is still registered, so the marker is what
    // covers the window after that container exits.
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
    // The in-flight map serialises populates within ONE process. Agents are a
    // process each on a shared daemon, so the loser of a cross-process race
    // gets here while the winner is still copying — and force-removing then
    // destroys the volume the winner is about to mark complete, leaving it to
    // mount a daemon-recreated EMPTY volume. Only a volume this call created
    // is safe to reap.
    expect(volumeRemove).not.toHaveBeenCalled();
  });

  it('writes the completion marker LAST, after the copy verifies', async () => {
    for (const subtree of [RuntimeSubtree.enum.all, RuntimeSubtree.enum.node]) {
      const { docker, populatorArg } = runtimeDocker();
      await ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1', subtree });

      const cmd = populatorArg().Cmd.join(' ').trim();
      // Written any earlier the marker lands on a tree that has not been
      // verified — a half-copied runtime that then reads as complete, which is
      // the exact bug it exists to prevent.
      expect(cmd.endsWith('touch /kici-runtime-out/.kici-runtime-complete')).toBe(true);
      expect(cmd.indexOf('test -')).toBeLessThan(cmd.indexOf('touch '));
    }
  });

  it('probes the marker with the same mount shape the populator uses', async () => {
    const { docker, probeArg } = runtimeDocker({ volumeExists: true });
    const name = await ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1' });

    // The daemon owns the volume, so the only way to read it is a container —
    // and it has to be root with the same bind, or it reads a different tree
    // than the populator wrote.
    const arg = probeArg();
    expect(arg.Cmd.join(' ')).toContain('test -f /kici-runtime-out/.kici-runtime-complete');
    expect(arg.User).toBe('0:0');
    expect(arg.HostConfig.Binds).toEqual([`${name}:/kici-runtime-out`]);
  });

  it('labels the probe and the populator so the orphan reaper can find them', async () => {
    const fresh = runtimeDocker();
    await ensureRuntimeVolume({ docker: fresh.docker, agentImage: 'kici-agent:1' });
    // The reaper selects on `kici-managed=true`; an unlabelled container is
    // invisible to it, so a process killed between create and remove strands
    // one nothing can identify.
    expect(fresh.populatorArg().Labels).toEqual({ 'kici-managed': 'true' });

    const reused = runtimeDocker({ volumeExists: true });
    await ensureRuntimeVolume({ docker: reused.docker, agentImage: 'kici-agent:1' });
    // The probe matters more than the populator: it runs on EVERY spawn, where
    // the reuse path previously created no container at all.
    expect(reused.probeArg().Labels).toEqual({ 'kici-managed': 'true' });
  });

  it('repopulates an existing volume that carries no completion marker', async () => {
    const { docker, populatorCount } = runtimeDocker({
      volumeExists: true,
      volumePopulated: false,
    });
    await ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1' });

    // Existence is NOT population — the silent half of the bug. A volume left
    // by a crashed or still-running populate inspects fine, and mounting it
    // yields a half-copied runtime whose failure surfaces nowhere near here.
    expect(populatorCount()).toBe(1);
  });

  it('shares one populate between callers that arrive concurrently', async () => {
    let release!: (v: { StatusCode: number }) => void;
    const gate = new Promise<{ StatusCode: number }>((resolve) => {
      release = resolve;
    });
    const { docker, createVolume, populatorCount } = runtimeDocker({ populateGate: gate });

    const first = ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1' });
    // Block until the first call is genuinely INSIDE the populate — its
    // populator is created and its wait() is parked on the still-closed gate.
    // Without this the second call arrives after the first has finished and
    // every assertion below holds with no mutex present.
    await vi.waitFor(() => expect(populatorCount()).toBe(1));

    const second = ensureRuntimeVolume({ docker, agentImage: 'kici-agent:1' });
    // Give the second caller a full macrotask to run: it now reaches the same
    // volume while the first is demonstrably mid-copy. This is the instant the
    // race used to happen, so assert the property HERE, while the gate is still
    // closed — un-mutexed, this reads 2.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(populatorCount()).toBe(1);
    expect(createVolume).toHaveBeenCalledTimes(1);

    release({ StatusCode: 0 });

    // Two agents spawning together used to both copy into the same mount, so
    // the loser mounted a tree the winner was still writing. Both now get the
    // one populate's result.
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
    // A retained rejected promise would replay the same failure forever, making
    // every later spawn of this image fail — worse than the race it closes.
    expect(populatorCount()).toBe(2);
  });
});

describe('RUNTIME_NODE_MOUNT', () => {
  it('sits under the runtime mount', () => {
    expect(RUNTIME_NODE_MOUNT).toBe(`${RUNTIME_MOUNT}/node`);
  });
});
