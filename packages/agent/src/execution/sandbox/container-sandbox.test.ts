import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Docker from 'dockerode';

// Mock the logger so setup() doesn't touch the filesystem.
vi.mock('@kici-dev/shared', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  toErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

// Mock node:fs so the host name-resolution bind (host-network parity) is
// deterministic regardless of the test host's /etc layout: both files "exist".
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
}));

import { ContainerSandbox } from './container-sandbox.js';
import {
  DEFAULT_PIDS_LIMIT,
  DEFAULT_MEMORY_BYTES,
  DEFAULT_NANO_CPUS,
  type SandboxHardeningOptions,
} from './container-hardening.js';

/** Hardened-by-default option baseline. */
function hardening(overrides: Partial<SandboxHardeningOptions> = {}): SandboxHardeningOptions {
  return {
    hardened: true,
    readonlyRootfs: false,
    pidsLimit: DEFAULT_PIDS_LIMIT,
    memoryBytes: DEFAULT_MEMORY_BYTES,
    nanoCpus: DEFAULT_NANO_CPUS,
    networkMode: 'default',
    ...overrides,
  };
}

/** Build a minimal dockerode mock capturing the createContainer arg.
 *  `imagePresent: false` makes the image-inspect reject, exercising the pull path. */
function mockDocker(opts: { imagePresent?: boolean } = {}) {
  const start = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue(undefined);
  const remove = vi.fn().mockResolvedValue(undefined);
  const container = { start, stop, remove, id: 'deadbeefcafe0000' };
  const createContainer = vi.fn().mockResolvedValue(container);
  const inspect = vi.fn();
  if (opts.imagePresent === false) inspect.mockRejectedValue(new Error('no such image'));
  else inspect.mockResolvedValue({});
  const getImage = vi.fn().mockReturnValue({ inspect });
  const pullStream = {};
  const pull = vi.fn().mockResolvedValue(pullStream);
  const followProgress = vi.fn((_stream: unknown, cb: (err: Error | null) => void) => cb(null));
  const docker = {
    createContainer,
    getImage,
    pull,
    modem: { followProgress },
  } as unknown as Docker;
  return { docker, createContainer, container, stop, remove, getImage, pull, inspect };
}

describe('ContainerSandbox.setup hardening', () => {
  beforeEach(() => vi.clearAllMocks());

  it('merges the hardened posture into the createContainer HostConfig', async () => {
    const { docker, createContainer } = mockDocker();
    const sandbox = new ContainerSandbox({
      docker,
      image: 'node:20-alpine',
      runnerPath: '/host/runner.js',
      env: {},
      jobId: 'job-1',
      hardening: hardening(),
    });

    await sandbox.setup({ workDir: '/work', env: {} });

    expect(createContainer).toHaveBeenCalledOnce();
    const arg = createContainer.mock.calls[0][0] as Docker.ContainerCreateOptions;
    const hc = arg.HostConfig!;
    expect(hc.CapDrop).toEqual(['ALL']);
    expect(hc.SecurityOpt).toEqual(['no-new-privileges']);
    expect(hc.PidsLimit).toBe(DEFAULT_PIDS_LIMIT);
    expect(hc.Memory).toBe(DEFAULT_MEMORY_BYTES);
    expect(hc.NanoCpus).toBe(DEFAULT_NANO_CPUS);
    expect(hc.Tmpfs).toEqual({ '/tmp': 'rw,exec,nosuid,nodev' });
    // The container owns its /workspace (an anonymous volume) — the host workDir
    // is NOT bind-mounted read-write. Only the runner :ro bind remains alongside
    // the hardening fields.
    expect(arg.Volumes).toEqual({ '/workspace': {} });
    expect(hc.Binds).toEqual([
      '/host/runner.js:/opt/kici/workflow-runner.js:ro',
      '/host/container-ts-loader-hook.js:/opt/kici/ts-loader-hook.js:ro',
    ]);
    // No user / readonly rootfs by default.
    expect(arg.User).toBeUndefined();
    expect(hc.ReadonlyRootfs).toBeUndefined();
  });

  it('skips the image pull when the image is already present', async () => {
    const { docker, pull, getImage } = mockDocker({ imagePresent: true });
    const sandbox = new ContainerSandbox({
      docker,
      image: 'node:20-alpine',
      runnerPath: '/host/runner.js',
      env: {},
      jobId: 'job-present',
      hardening: hardening(),
    });

    await sandbox.setup({ workDir: '/work', env: {} });

    expect(getImage).toHaveBeenCalledWith('node:20-alpine');
    expect(pull).not.toHaveBeenCalled();
  });

  it('pulls the image when it is not present locally (no auto-pull from createContainer)', async () => {
    const { docker, pull, createContainer } = mockDocker({ imagePresent: false });
    const sandbox = new ContainerSandbox({
      docker,
      image: 'node:20-alpine',
      runnerPath: '/host/runner.js',
      env: {},
      jobId: 'job-missing',
      hardening: hardening(),
    });

    await sandbox.setup({ workDir: '/work', env: {} });

    expect(pull).toHaveBeenCalledWith('node:20-alpine');
    // The pull completes before the container is created.
    expect(createContainer).toHaveBeenCalledOnce();
  });

  it('applies the resolved user top-level when configured', async () => {
    const { docker, createContainer } = mockDocker();
    const sandbox = new ContainerSandbox({
      docker,
      image: 'node:20-alpine',
      runnerPath: '/host/runner.js',
      env: {},
      jobId: 'job-2',
      hardening: hardening({ user: '1000:1000', readonlyRootfs: true }),
    });

    await sandbox.setup({ workDir: '/work', env: {} });

    const arg = createContainer.mock.calls[0][0] as Docker.ContainerCreateOptions;
    expect(arg.User).toBe('1000:1000');
    expect(arg.HostConfig!.ReadonlyRootfs).toBe(true);
  });

  it('applies no hardening fields when the rollback flag is off', async () => {
    const { docker, createContainer } = mockDocker();
    const sandbox = new ContainerSandbox({
      docker,
      image: 'node:20-alpine',
      runnerPath: '/host/runner.js',
      env: {},
      jobId: 'job-3',
      hardening: hardening({ hardened: false }),
    });

    await sandbox.setup({ workDir: '/work', env: {} });

    const arg = createContainer.mock.calls[0][0] as Docker.ContainerCreateOptions;
    const hc = arg.HostConfig!;
    expect(hc.CapDrop).toBeUndefined();
    expect(hc.SecurityOpt).toBeUndefined();
    expect(hc.PidsLimit).toBeUndefined();
    expect(hc.Memory).toBeUndefined();
    // The container-owned /workspace volume + runner bind are not part of the
    // hardening posture, so they are present regardless of the rollback flag.
    expect(arg.Volumes).toEqual({ '/workspace': {} });
    expect(hc.Binds).toEqual([
      '/host/runner.js:/opt/kici/workflow-runner.js:ro',
      '/host/container-ts-loader-hook.js:/opt/kici/ts-loader-hook.js:ro',
    ]);
  });

  it('applies no hardening when no posture is supplied (explicit opt-out seam)', async () => {
    const { docker, createContainer } = mockDocker();
    const sandbox = new ContainerSandbox({
      docker,
      image: 'node:20-alpine',
      runnerPath: '/host/runner.js',
      env: {},
      jobId: 'job-4',
    });

    await sandbox.setup({ workDir: '/work', env: {} });

    const arg = createContainer.mock.calls[0][0] as Docker.ContainerCreateOptions;
    expect(arg.HostConfig!.CapDrop).toBeUndefined();
    expect(arg.User).toBeUndefined();
  });
});

describe('ContainerSandbox.setup binds (bwrap parity)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the default posture: only workspace + runner binds, no host-net binds', async () => {
    const { docker, createContainer } = mockDocker();
    const sandbox = new ContainerSandbox({
      docker,
      image: 'node:20-alpine',
      runnerPath: '/host/runner.js',
      env: {},
      jobId: 'job-default',
      // Default network posture ('default' = bridge) — the production default.
      hardening: hardening({ networkMode: 'default' }),
    });

    await sandbox.setup({ workDir: '/work', env: {} });

    const arg = createContainer.mock.calls[0][0] as Docker.ContainerCreateOptions;
    const hc = arg.HostConfig!;
    // Unchanged default: the container-owned /workspace volume + the runner
    // bind and the loader-hook bind, no /etc/hosts, and NetworkMode left unset
    // (runtime bridge).
    expect(arg.Volumes).toEqual({ '/workspace': {} });
    expect(hc.Binds).toEqual([
      '/host/runner.js:/opt/kici/workflow-runner.js:ro',
      '/host/container-ts-loader-hook.js:/opt/kici/ts-loader-hook.js:ro',
    ]);
    expect(hc.NetworkMode).toBeUndefined();
  });

  it('binds file:// clone-source dirs read-only (extraReadOnlyBinds)', async () => {
    const { docker, createContainer } = mockDocker();
    const sandbox = new ContainerSandbox({
      docker,
      image: 'node:20-alpine',
      runnerPath: '/host/runner.js',
      env: {},
      jobId: 'job-src',
      hardening: hardening(),
    });

    await sandbox.setup({
      workDir: '/work',
      env: {},
      extraReadOnlyBinds: ['/home/me/repo'],
    });

    const arg = createContainer.mock.calls[0][0] as Docker.ContainerCreateOptions;
    expect(arg.Volumes).toEqual({ '/workspace': {} });
    expect(arg.HostConfig!.Binds).toEqual([
      '/host/runner.js:/opt/kici/workflow-runner.js:ro',
      '/host/container-ts-loader-hook.js:/opt/kici/ts-loader-hook.js:ro',
      '/home/me/repo:/home/me/repo:ro',
    ]);
    // A bridge (default) network adds no /etc/hosts bind.
    expect(arg.HostConfig!.NetworkMode).toBeUndefined();
  });

  it('binds host name-resolution files read-only under host networking', async () => {
    const { docker, createContainer } = mockDocker();
    const sandbox = new ContainerSandbox({
      docker,
      image: 'node:20-alpine',
      runnerPath: '/host/runner.js',
      env: {},
      jobId: 'job-hostnet',
      hardening: hardening({ networkMode: 'host' }),
    });

    await sandbox.setup({
      workDir: '/work',
      env: {},
      extraReadOnlyBinds: ['/home/me/repo'],
    });

    const arg = createContainer.mock.calls[0][0] as Docker.ContainerCreateOptions;
    const hc = arg.HostConfig!;
    expect(hc.NetworkMode).toBe('host');
    // Source bind AND the host /etc/hosts + nsswitch RO binds (node:fs.existsSync
    // is mocked true) — bwrap `--ro-bind /etc/hosts` parity so an /etc/hosts-only
    // registry name resolves inside the container. The container-owned /workspace
    // volume replaces the host workDir bind.
    expect(arg.Volumes).toEqual({ '/workspace': {} });
    expect(hc.Binds).toEqual([
      '/host/runner.js:/opt/kici/workflow-runner.js:ro',
      '/host/container-ts-loader-hook.js:/opt/kici/ts-loader-hook.js:ro',
      '/home/me/repo:/home/me/repo:ro',
      '/etc/hosts:/etc/hosts:ro',
      '/etc/nsswitch.conf:/etc/nsswitch.conf:ro',
    ]);
  });

  it('mounts exactly the supplied runner path — the container backend passes the self-contained bundle', async () => {
    const { docker, createContainer } = mockDocker();
    // job-runner passes the bundle sibling here (resolveRunnerBundlePath); the
    // sandbox mounts whatever runner path it is given at runnerMountPath, so a
    // bundle path lands as the single-file runner mount the job container runs.
    const sandbox = new ContainerSandbox({
      docker,
      image: 'node:20-alpine',
      runnerPath: '/app/dist/workflow-runner-bundle.js',
      env: {},
      jobId: 'job-bundle',
      hardening: hardening(),
    });

    await sandbox.setup({ workDir: '/work', env: {} });

    const arg = createContainer.mock.calls[0][0] as Docker.ContainerCreateOptions;
    expect(arg.Volumes).toEqual({ '/workspace': {} });
    expect(arg.HostConfig!.Binds).toEqual([
      '/app/dist/workflow-runner-bundle.js:/opt/kici/workflow-runner.js:ro',
      '/app/dist/container-ts-loader-hook.js:/opt/kici/ts-loader-hook.js:ro',
    ]);
  });
});

describe('ContainerSandbox loader-hook mount + stdio IPC hygiene', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts the container loader hook and sets the loader-path + stderr env', async () => {
    const { docker, createContainer } = mockDocker();
    const sandbox = new ContainerSandbox({
      docker,
      image: 'node:20-alpine',
      runnerPath: '/x/dist/workflow-runner.js',
      env: {},
      jobId: 'job-hook',
      hardening: hardening(),
    });

    await sandbox.setup({ workDir: '/work', env: {} });

    const arg = createContainer.mock.calls[0][0] as Docker.ContainerCreateOptions;
    // Hook bundle bound read-only next to the runner, at the fixed internal target.
    expect(arg.HostConfig!.Binds).toContain(
      '/x/dist/container-ts-loader-hook.js:/opt/kici/ts-loader-hook.js:ro',
    );
    // Agent-internal env: points the in-container runner at the mounted hook, and
    // routes runner-internal Winston logs to stderr so they cannot corrupt the
    // fd1 IPC channel. (The logger lever's stderr routing itself is covered by
    // @kici-dev/core's logger.test.ts 'KICI_LOG_STDERR routing'.)
    expect(arg.Env).toContain('KICI_TS_LOADER_HOOK_PATH=/opt/kici/ts-loader-hook.js');
    expect(arg.Env).toContain('KICI_LOG_STDERR=1');
  });

  it('sets the loader-path + stderr env on the per-step exec too', async () => {
    const { docker, container } = mockDocker();
    const exec = vi.fn().mockResolvedValue({
      start: vi.fn().mockResolvedValue({ on: vi.fn(), destroy: vi.fn() }),
      inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
    });
    (container as unknown as { exec: typeof exec }).exec = exec;
    const sandbox = new ContainerSandbox({
      docker,
      image: 'node:20-alpine',
      runnerPath: '/x/dist/workflow-runner.js',
      env: {},
      jobId: 'job-hook-exec',
      hardening: hardening(),
    });

    await sandbox.setup({ workDir: '/work', env: {} });
    // Kick off executeJob far enough to build the exec (it will not complete —
    // the mocked stream never emits job.complete — but the exec is created
    // synchronously with the env we assert, then we abort).
    const ac = new AbortController();
    const jobPromise = sandbox.executeJob({ signal: ac.signal } as never).catch(() => undefined);
    // Give the microtask queue a tick so attachExecStream runs.
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    await jobPromise;

    expect(exec).toHaveBeenCalled();
    const execArg = exec.mock.calls[0][0] as { Env: string[] };
    expect(execArg.Env).toContain('KICI_TS_LOADER_HOOK_PATH=/opt/kici/ts-loader-hook.js');
    expect(execArg.Env).toContain('KICI_LOG_STDERR=1');
  });
});

describe('ContainerSandbox.teardown workspace volume', () => {
  beforeEach(() => vi.clearAllMocks());

  it('removes the container and its anonymous volume on normal teardown', async () => {
    const { docker, remove } = mockDocker();
    const sandbox = new ContainerSandbox({
      docker,
      image: 'node:20-alpine',
      runnerPath: '/host/runner.js',
      env: {},
      jobId: 'job-teardown',
      hardening: hardening(),
    });

    await sandbox.setup({ workDir: '/work', env: {} });
    await sandbox.teardown();

    // `v: true` removes the anonymous /workspace volume with the container.
    expect(remove).toHaveBeenCalledWith({ force: true, v: true });
  });

  it('keeps the failed container (and its volume) when keepFailed is set', async () => {
    const { docker, remove } = mockDocker();
    const sandbox = new ContainerSandbox({
      docker,
      image: 'node:20-alpine',
      runnerPath: '/host/runner.js',
      env: {},
      jobId: 'job-keep',
      keepFailed: true,
      hardening: hardening(),
    });

    await sandbox.setup({ workDir: '/work', env: {} });
    // Simulate a failed job so the keepFailed early-return path is taken.
    (sandbox as unknown as { jobFailed: boolean }).jobFailed = true;
    await sandbox.teardown();

    // The failed container (and its volume) are retained for debugging.
    expect(remove).not.toHaveBeenCalled();
  });
});
