import '../../__test-helpers__/shared-mocks.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Docker from 'dockerode';
import { link, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { x as tarExtract } from 'tar';

// The cases assert which runtime the sandbox MOUNTS, not how the volume is
// populated (covered in @kici-dev/shared).
const ensureRuntimeVolumeMock = vi.hoisted(() => vi.fn(async () => 'kici-runtime-node-abc123'));
vi.mock('@kici-dev/shared/container-runtime', () => ({
  ensureRuntimeVolume: ensureRuntimeVolumeMock,
  RuntimeSubtree: { enum: { all: 'all', node: 'node' } },
}));

// Both name-resolution files "exist", whatever the test host's /etc layout;
// the rest stays real because the workspace copy-in walks a real tree.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: vi.fn(() => true),
}));

import { ContainerSandbox } from './container-sandbox.js';
import {
  DEFAULT_PIDS_LIMIT,
  DEFAULT_MEMORY_BYTES,
  DEFAULT_NANO_CPUS,
  type SandboxHardeningOptions,
} from './container-hardening.js';

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

/** Dockerode mock capturing the createContainer arg; `imagePresent: false`
 *  rejects image-inspect to exercise the pull path. */
function mockDocker(opts: { imagePresent?: boolean } = {}) {
  const start = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue(undefined);
  const remove = vi.fn().mockResolvedValue(undefined);
  // The image preflight stats these through an unstarted container. Default:
  // a glibc image with a shell; a case wanting a rejection overrides it.
  const infoArchive = vi.fn(async ({ path }: { path: string }) =>
    ['/lib64/ld-linux-x86-64.so.2', '/bin/sh'].includes(path)
      ? { name: path }
      : Promise.reject(new Error('not found')),
  );
  const container = { start, stop, remove, infoArchive, id: 'deadbeefcafe0000' };
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
  return {
    docker,
    createContainer,
    container,
    stop,
    remove,
    getImage,
    pull,
    inspect,
    infoArchive,
  };
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
    // The container owns /workspace (an anonymous volume); the host workDir is
    // NOT bind-mounted, only the runner :ro binds.
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

    expect(pull).toHaveBeenCalledWith('node:20-alpine', {});
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
    // The /workspace volume and runner binds are outside the hardening posture.
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
      // 'default' = bridge, the production default.
      hardening: hardening({ networkMode: 'default' }),
    });

    await sandbox.setup({ workDir: '/work', env: {} });

    const arg = createContainer.mock.calls[0][0] as Docker.ContainerCreateOptions;
    const hc = arg.HostConfig!;
    // No /etc/hosts bind, and NetworkMode unset (runtime bridge).
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
    // The /etc/hosts + nsswitch RO binds (existsSync mocked true) give bwrap
    // `--ro-bind /etc/hosts` parity, so an /etc/hosts-only registry name resolves.
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
    // job-runner passes the bundle (resolveRunnerBundlePath); the sandbox mounts
    // whatever path it gets at runnerMountPath.
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
    // KICI_LOG_STDERR keeps runner Winston logs off the fd1 IPC channel
    // (routing itself: @kici-dev/core logger.test.ts 'KICI_LOG_STDERR routing').
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
    // executeJob never completes (the mock never emits job.complete), but the
    // exec is created with the asserted env before the abort.
    const ac = new AbortController();
    const jobPromise = sandbox.executeJob({ signal: ac.signal } as never).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    await jobPromise;

    expect(exec).toHaveBeenCalled();
    const execArg = exec.mock.calls[0][0] as { Env: string[] };
    expect(execArg.Env).toContain('KICI_TS_LOADER_HOOK_PATH=/opt/kici/ts-loader-hook.js');
    expect(execArg.Env).toContain('KICI_LOG_STDERR=1');
  });

  it('launches the runner on the injected node, not the image’s own', async () => {
    const { docker, container } = mockDocker();
    const exec = vi.fn().mockResolvedValue({
      start: vi.fn().mockResolvedValue({ on: vi.fn(), destroy: vi.fn() }),
      inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
    });
    (container as unknown as { exec: typeof exec }).exec = exec;
    const sandbox = new ContainerSandbox({
      docker,
      image: 'python:3.12-slim',
      runnerPath: '/x/dist/workflow-runner.js',
      env: {},
      jobId: 'job-injected-node',
      hardening: hardening(),
      runtimeNodePath: '/host/opt/kici/node',
    });

    await sandbox.setup({ workDir: '/work', env: {} });
    const ac = new AbortController();
    const jobPromise = sandbox.executeJob({ signal: ac.signal } as never).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    await jobPromise;

    // A bare `node` would resolve from the image's PATH, and the image need not
    // ship Node (python:3.12-slim does not).
    const execArg = exec.mock.calls[0][0] as { Cmd: string[] };
    expect(execArg.Cmd).toEqual(['/opt/kici/node/bin/node', '/opt/kici/workflow-runner.js']);

    // Read-only, or a job could rewrite the interpreter of every later step.
    // The preflight's probe container comes first, so find the job's create call.
    const createCalls = (docker.createContainer as unknown as { mock: { calls: unknown[][] } }).mock
      .calls as Array<[{ HostConfig?: { Binds?: string[] } }]>;
    const jobCreate = createCalls.find((c) => c[0]?.HostConfig?.Binds)?.[0];
    expect(jobCreate?.HostConfig?.Binds).toContain('/host/opt/kici/node:/opt/kici/node:ro');
  });

  it('falls back to the image’s node when no runtime is injected', async () => {
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
      jobId: 'job-legacy-node',
      hardening: hardening(),
    });

    await sandbox.setup({ workDir: '/work', env: {} });
    const ac = new AbortController();
    const jobPromise = sandbox.executeJob({ signal: ac.signal } as never).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    await jobPromise;

    // Legacy contract, kept until every spawn path provisions the runtime.
    const execArg = exec.mock.calls[0][0] as { Cmd: string[] };
    expect(execArg.Cmd).toEqual(['node', '/opt/kici/workflow-runner.js']);
    const createCalls2 = (docker.createContainer as unknown as { mock: { calls: unknown[][] } })
      .mock.calls as Array<[{ HostConfig?: { Binds?: string[] } }]>;
    const jobCreate2 = createCalls2.find((c) => c[0]?.HostConfig?.Binds)?.[0];
    expect(jobCreate2?.HostConfig?.Binds?.some((b) => b.includes('/opt/kici/node'))).toBe(false);
  });
});

describe('ContainerSandbox authenticated image pull', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pulls with the per-job registry auth when the image is absent', async () => {
    const { docker, pull } = mockDocker({ imagePresent: false });
    const sandbox = new ContainerSandbox({
      docker,
      image: 'reg.internal:5000/acme/ci:1.2',
      runnerPath: '/x/runner.js',
      env: {},
      jobId: 'job-auth-pull',
      hardening: hardening(),
      registryAuth: { username: 'bot', password: 's3cr3t', serveraddress: 'reg.internal:5000' },
    });

    await sandbox.setup({ workDir: '/work', env: {} });

    expect(pull).toHaveBeenCalledWith('reg.internal:5000/acme/ci:1.2', {
      authconfig: { username: 'bot', password: 's3cr3t', serveraddress: 'reg.internal:5000' },
    });
  });

  it('pulls anonymously when no auth was supplied', async () => {
    const { docker, pull } = mockDocker({ imagePresent: false });
    const sandbox = new ContainerSandbox({
      docker,
      image: 'python:3.12-slim',
      runnerPath: '/x/runner.js',
      env: {},
      jobId: 'job-anon-pull',
      hardening: hardening(),
    });

    await sandbox.setup({ workDir: '/work', env: {} });
    expect(pull).toHaveBeenCalledWith('python:3.12-slim', {});
  });

  it('preflights AFTER the pull, so a not-yet-pulled image can be probed', async () => {
    const { docker, pull, createContainer } = mockDocker({ imagePresent: false });
    const sandbox = new ContainerSandbox({
      docker,
      image: 'python:3.12-slim',
      runnerPath: '/x/runner.js',
      env: {},
      jobId: 'job-order',
      hardening: hardening(),
      runtimeNodePath: '/host/opt/kici/node',
    });

    await sandbox.setup({ workDir: '/work', env: {} });

    // Probing before the pull fails with "no such image" on an uncached host.
    expect(pull).toHaveBeenCalled();
    expect(pull.mock.invocationCallOrder[0]).toBeLessThan(
      createContainer.mock.invocationCallOrder[0],
    );
  });
});

describe('ContainerSandbox workspace copy-in', () => {
  beforeEach(() => vi.clearAllMocks());

  it('copies the host workdir into /workspace when the agent cloned on the host', async () => {
    const { docker, container } = mockDocker();
    const putArchive = vi.fn().mockResolvedValue(undefined);
    (container as unknown as { putArchive: typeof putArchive }).putArchive = putArchive;

    const dir = await mkdtemp(join(tmpdir(), 'kici-copyin-'));
    await writeFile(join(dir, 'README.md'), '# hi\n');

    const sandbox = new ContainerSandbox({
      docker,
      image: 'python:3.12-slim',
      runnerPath: '/x/dist/workflow-runner.js',
      env: {},
      jobId: 'job-copyin',
      hardening: hardening(),
      runtimeNodePath: '/host/opt/kici/node',
    });

    await sandbox.setup({ workDir: dir, env: {}, workspaceFromHost: true });

    expect(putArchive).toHaveBeenCalledTimes(1);
    const [, opts] = putArchive.mock.calls[0] as [unknown, { path: string }];
    expect(opts.path).toBe('/workspace');
    await rm(dir, { recursive: true, force: true });
  });

  it('copies a workdir whose node_modules files are hard-linked', async () => {
    const { docker, container } = mockDocker();
    // Consume the archive as the runtime would, so the pack has to finish.
    let archive = Buffer.alloc(0);
    const putArchive = vi.fn(async (stream: AsyncIterable<Uint8Array>) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      archive = Buffer.concat(chunks);
    });
    (container as unknown as { putArchive: typeof putArchive }).putArchive = putArchive;

    // pnpm hard-links identical files to one store inode outside the workdir;
    // this order (plain, link, plain, plain, link, plain) stalls node-tar's own
    // hard-link handling for good.
    const dir = await mkdtemp(join(tmpdir(), 'kici-copyin-'));
    const store = await mkdtemp(join(tmpdir(), 'kici-copyin-store-'));
    const pkg = join(dir, 'node_modules', '.pnpm', 'p@1.0.0', 'node_modules', 'p');
    await mkdir(pkg, { recursive: true });
    await writeFile(join(store, 'shared.d.ts'), 'export {};\n');
    for (const name of ['a.js', 'c.js', 'd.js', 'f.js']) await writeFile(join(pkg, name), name);
    for (const name of ['b.d.ts', 'e.d.ts'])
      await link(join(store, 'shared.d.ts'), join(pkg, name));

    const sandbox = new ContainerSandbox({
      docker,
      image: 'python:3.12-slim',
      runnerPath: '/x/dist/workflow-runner.js',
      env: {},
      jobId: 'job-copyin-hardlinks',
      hardening: hardening(),
      runtimeNodePath: '/host/opt/kici/node',
    });

    // fails-when: copyWorkspaceIn hands node-tar no single-link caches, so the
    // archive never ends and setup never resolves
    await sandbox.setup({ workDir: dir, env: {}, workspaceFromHost: true });

    // breaks-if-wrong: each linked path must land with its own content
    const out = await mkdtemp(join(tmpdir(), 'kici-copyin-out-'));
    await writeFile(join(out, 'workspace.tar'), archive);
    await tarExtract({ file: join(out, 'workspace.tar'), cwd: out });
    const landed = join(out, 'node_modules', '.pnpm', 'p@1.0.0', 'node_modules', 'p');
    for (const name of ['a.js', 'c.js', 'd.js', 'f.js']) {
      expect(await readFile(join(landed, name), 'utf-8')).toBe(name);
    }
    for (const name of ['b.d.ts', 'e.d.ts']) {
      expect(await readFile(join(landed, name), 'utf-8')).toBe('export {};\n');
    }
    await rm(dir, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }, 15_000);

  it('does not copy anything in when the runner will clone itself', async () => {
    const { docker, container } = mockDocker();
    const putArchive = vi.fn().mockResolvedValue(undefined);
    (container as unknown as { putArchive: typeof putArchive }).putArchive = putArchive;

    const sandbox = new ContainerSandbox({
      docker,
      image: 'node:20-alpine',
      runnerPath: '/x/dist/workflow-runner.js',
      env: {},
      jobId: 'job-no-copyin',
      hardening: hardening(),
    });

    await sandbox.setup({ workDir: '/work', env: {} });
    expect(putArchive).not.toHaveBeenCalled();
  });

  it('fails setup loudly when the copy-in does not land', async () => {
    const { docker, container } = mockDocker();
    // Silently continuing would run the job on an EMPTY workspace.
    (container as unknown as { putArchive: unknown }).putArchive = vi
      .fn()
      .mockRejectedValue(new Error('no space left on device'));

    const dir = await mkdtemp(join(tmpdir(), 'kici-copyin-'));
    const sandbox = new ContainerSandbox({
      docker,
      image: 'python:3.12-slim',
      runnerPath: '/x/dist/workflow-runner.js',
      env: {},
      jobId: 'job-copyin-fail',
      hardening: hardening(),
      runtimeNodePath: '/host/opt/kici/node',
    });

    await expect(sandbox.setup({ workDir: dir, env: {}, workspaceFromHost: true })).rejects.toThrow(
      /workspace|no space/i,
    );
    await rm(dir, { recursive: true, force: true });
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
    (sandbox as unknown as { jobFailed: boolean }).jobFailed = true;
    await sandbox.teardown();

    expect(remove).not.toHaveBeenCalled();
  });
});

describe('ContainerSandbox runtime injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureRuntimeVolumeMock.mockResolvedValue('kici-runtime-node-abc123');
  });

  it('materializes the runtime from the agent image and mounts it read-only', async () => {
    const { docker, createContainer } = mockDocker();
    const sandbox = new ContainerSandbox({
      docker,
      image: 'python:3.12-slim',
      runnerPath: '/host/runner/workflow-runner-bundle.js',
      runtimeImage: 'quay.io/kici-dev/kici-agent:1.2.3',
      env: {},
      jobId: 'job-runtime-1',
      hardening: hardening(),
    });

    await sandbox.setup({ workDir: '/tmp/wd', env: {} });

    // Only the node tree: the runner bundle and loader hook bind at fixed paths
    // under /opt/kici, which a whole-tree mount would make read-only.
    expect(ensureRuntimeVolumeMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentImage: 'quay.io/kici-dev/kici-agent:1.2.3', subtree: 'node' }),
    );
    // The preflight's probe container comes first; the job's create is LAST.
    const binds = (createContainer.mock.calls.at(-1)![0] as { HostConfig: { Binds: string[] } })
      .HostConfig.Binds;
    // Writable would let the job rewrite its later steps' interpreter.
    expect(binds).toContain('kici-runtime-node-abc123:/opt/kici/node:ro');
  });

  it('prefers a pre-provisioned tree over materializing the same one', async () => {
    const { docker, createContainer } = mockDocker();
    const sandbox = new ContainerSandbox({
      docker,
      image: 'python:3.12-slim',
      runnerPath: '/host/runner/workflow-runner-bundle.js',
      runtimeNodePath: '/host/opt/kici/node',
      runtimeImage: 'quay.io/kici-dev/kici-agent:1.2.3',
      env: {},
      jobId: 'job-runtime-2',
      hardening: hardening(),
    });

    await sandbox.setup({ workDir: '/tmp/wd', env: {} });

    expect(ensureRuntimeVolumeMock).not.toHaveBeenCalled();
    // The preflight's probe container comes first; the job's create is LAST.
    const binds = (createContainer.mock.calls.at(-1)![0] as { HostConfig: { Binds: string[] } })
      .HostConfig.Binds;
    expect(binds).toContain('/host/opt/kici/node:/opt/kici/node:ro');
  });

  it('injects nothing when no runtime source is configured', async () => {
    const { docker, createContainer } = mockDocker();
    const sandbox = new ContainerSandbox({
      docker,
      image: 'node:20',
      runnerPath: '/host/runner/workflow-runner-bundle.js',
      env: {},
      jobId: 'job-runtime-3',
      hardening: hardening(),
    });

    await sandbox.setup({ workDir: '/tmp/wd', env: {} });

    // Legacy contract, still correct for an image that ships Node.
    expect(ensureRuntimeVolumeMock).not.toHaveBeenCalled();
    // The preflight's probe container comes first; the job's create is LAST.
    const binds = (createContainer.mock.calls.at(-1)![0] as { HostConfig: { Binds: string[] } })
      .HostConfig.Binds;
    expect(binds.some((b) => b.includes('/opt/kici/node'))).toBe(false);
  });

  it('fails the setup when materialization fails, rather than running without it', async () => {
    const { docker, createContainer } = mockDocker();
    ensureRuntimeVolumeMock.mockRejectedValue(new Error('runtime copy exited 1: no space left'));
    const sandbox = new ContainerSandbox({
      docker,
      image: 'python:3.12-slim',
      runnerPath: '/host/runner/workflow-runner-bundle.js',
      runtimeImage: 'quay.io/kici-dev/kici-agent:1.2.3',
      env: {},
      jobId: 'job-runtime-4',
      hardening: hardening(),
    });

    // Continuing would fail later with a "node: not found" that names nothing.
    await expect(sandbox.setup({ workDir: '/tmp/wd', env: {} })).rejects.toThrow(/no space left/);
    expect(createContainer).not.toHaveBeenCalled();
  });
});

describe('ContainerSandbox built-image teardown', () => {
  beforeEach(() => vi.clearAllMocks());

  it('removes the built tag, so a per-run tag does not accumulate on the host', async () => {
    const { docker, container, getImage } = mockDocker();
    const removeImage = vi.fn().mockResolvedValue(undefined);
    getImage.mockReturnValue({ inspect: vi.fn().mockResolvedValue({}), remove: removeImage });

    const sandbox = new ContainerSandbox({
      docker,
      image: 'kici-build:run-1-build',
      buildTag: 'kici-build:run-1-build',
      runnerPath: '/host/runner/workflow-runner-bundle.js',
      env: {},
      jobId: 'job-teardown-1',
      hardening: hardening(),
    });

    await sandbox.setup({ workDir: '/tmp/wd', env: {} });
    await sandbox.teardown();

    // The LAYER cache is not a tag and survives, keeping the next build fast.
    expect(removeImage).toHaveBeenCalledWith({ force: true });
    expect(container.remove).toHaveBeenCalled();
  });

  it('leaves a named image alone — we did not create it', async () => {
    const { docker, getImage } = mockDocker();
    const removeImage = vi.fn().mockResolvedValue(undefined);
    getImage.mockReturnValue({ inspect: vi.fn().mockResolvedValue({}), remove: removeImage });

    const sandbox = new ContainerSandbox({
      docker,
      image: 'python:3.12',
      runnerPath: '/host/runner/workflow-runner-bundle.js',
      env: {},
      jobId: 'job-teardown-2',
      hardening: hardening(),
    });

    await sandbox.setup({ workDir: '/tmp/wd', env: {} });
    await sandbox.teardown();

    expect(removeImage).not.toHaveBeenCalled();
  });

  it('survives a removal that fails, since teardown must not fail the job', async () => {
    const { docker, getImage } = mockDocker();
    getImage.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockRejectedValue(new Error('image is in use')),
    });

    const sandbox = new ContainerSandbox({
      docker,
      image: 'kici-build:run-1-build',
      buildTag: 'kici-build:run-1-build',
      runnerPath: '/host/runner/workflow-runner-bundle.js',
      env: {},
      jobId: 'job-teardown-3',
      hardening: hardening(),
    });

    await sandbox.setup({ workDir: '/tmp/wd', env: {} });
    await expect(sandbox.teardown()).resolves.toBeUndefined();
  });
});

describe('ContainerSandbox built-image reclaim without a container', () => {
  beforeEach(() => vi.clearAllMocks());

  it('drops the built tag even when setup never created a container', async () => {
    // A setup failing AFTER the build (e.g. the preflight rejecting a musl base)
    // leaves a tag and no container; unreclaimed, it stays on the host forever.
    const { docker, getImage } = mockDocker();
    const removeImage = vi.fn().mockResolvedValue(undefined);
    getImage.mockReturnValue({ inspect: vi.fn().mockResolvedValue({}), remove: removeImage });

    const sandbox = new ContainerSandbox({
      docker,
      image: 'kici-build:run-1-build',
      buildTag: 'kici-build:run-1-build',
      runnerPath: '/host/runner/workflow-runner-bundle.js',
      env: {},
      jobId: 'job-no-container',
      hardening: hardening(),
    });

    // No setup() at all: this.container is still null.
    await sandbox.teardown();

    expect(removeImage).toHaveBeenCalledWith({ force: true });
  });

  it('keeps the built image when a failed container is kept for debugging', async () => {
    // A container kept for debugging needs the image it runs to be kept too.
    const { docker, getImage } = mockDocker();
    const removeImage = vi.fn().mockResolvedValue(undefined);
    getImage.mockReturnValue({ inspect: vi.fn().mockResolvedValue({}), remove: removeImage });

    const sandbox = new ContainerSandbox({
      docker,
      image: 'kici-build:run-1-build',
      buildTag: 'kici-build:run-1-build',
      runnerPath: '/host/runner/workflow-runner-bundle.js',
      env: {},
      jobId: 'job-keep-failed',
      keepFailed: true,
      hardening: hardening(),
    });

    await sandbox.setup({ workDir: '/tmp/wd', env: {} });
    (sandbox as unknown as { jobFailed: boolean }).jobFailed = true;
    await sandbox.teardown();

    expect(removeImage).not.toHaveBeenCalled();
  });
});
