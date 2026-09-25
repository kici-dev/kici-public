import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { JobDispatch, AgentToOrchestratorMessage } from '@kici-dev/engine';
import { ExecutionJobStatus, RuntimeFact } from '@kici-dev/engine';
import { PackageManager } from '@kici-dev/shared/package-manager';
import type { AppConfig } from '../config.js';
import {
  JobRunner,
  type JobRunnerDeps,
  buildEvalNeedsContext,
  resolveJobWorkDir,
  buildEvalShell,
} from './job-runner.js';
import type { JobExecutionResult } from './sandbox/types.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// --- vi.hoisted shared mock state ---

const defaultSuccessResult: JobExecutionResult = {
  status: 'success',
  stepResults: [
    { name: 'build', stepIndex: 0, status: 'success', durationMs: 100 },
    { name: 'test', stepIndex: 1, status: 'success', durationMs: 100 },
  ],
  durationMs: 200,
};

const mockSandboxInstance = vi.hoisted(() => ({
  setup: vi.fn() as Mock,
  executeJob: vi.fn() as Mock,
  abort: vi.fn() as Mock,
  teardown: vi.fn() as Mock,
}));

// Hoisted so individual tests can assert on the module-level logger.
const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// --- Mocks ---

// Mock @kici-dev/shared (createLogger + getRequestContext + createMeter +
// kiciTmpBase — the bring-up handler resolves the agent-payload cache dir via
// defaultPayloadCacheDir() → kiciTmpBase()).
vi.mock('@kici-dev/shared', () => {
  const noopInstrument = { add: vi.fn(), record: vi.fn() };
  return {
    createLogger: vi.fn().mockReturnValue(loggerMock),
    getRequestContext: vi.fn().mockReturnValue({ runId: 'run-1', requestId: 'req-1' }),
    createMeter: vi.fn().mockReturnValue({
      createCounter: vi.fn().mockReturnValue(noopInstrument),
      createUpDownCounter: vi.fn().mockReturnValue(noopInstrument),
      createHistogram: vi.fn().mockReturnValue(noopInstrument),
    }),
    toErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
    kiciTmpBase: vi.fn().mockReturnValue('/tmp'),
  };
});

// Mock fs for mkdtemp and rm. The workdir now flows through the
// @kici-dev/core/tmp allocator, which imports the *named* mkdtemp/rm/writeFile
// from node:fs/promises, while job-runner still uses the default import — so
// named and default exports share the same vi.fn instances (assertions read
// the default export).
const { mkdtempFn, rmFn, accessFn, writeFileFn, mkdirFn } = vi.hoisted(() => ({
  mkdtempFn: vi.fn().mockResolvedValue('/tmp/kici-test123'),
  rmFn: vi.fn().mockResolvedValue(undefined),
  accessFn: vi.fn().mockResolvedValue(undefined),
  writeFileFn: vi.fn().mockResolvedValue(undefined),
  // The host checkout of a global workflow creates its workflow/source dirs.
  mkdirFn: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('node:fs/promises', () => ({
  default: {
    mkdtemp: mkdtempFn,
    rm: rmFn,
    access: accessFn,
    writeFile: writeFileFn,
    mkdir: mkdirFn,
  },
  mkdtemp: mkdtempFn,
  rm: rmFn,
  access: accessFn,
  writeFile: writeFileFn,
  mkdir: mkdirFn,
}));

// Mock dockerode to prevent real Docker connections
vi.mock('dockerode', () => ({
  default: vi.fn(),
}));

// Mock sandbox barrel -- all sandbox classes return the shared mockSandboxInstance
// Use function() instead of arrow functions so they can be called with `new`
vi.mock('./sandbox/index.js', () => ({
  BareMetalSandbox: vi.fn(function () {
    return mockSandboxInstance;
  }),
  ContainerSandbox: vi.fn(function () {
    return mockSandboxInstance;
  }),
  FirecrackerSandbox: vi.fn(function () {
    return mockSandboxInstance;
  }),
  buildSanitizedEnv: vi.fn().mockReturnValue({ PATH: '/usr/bin', HOME: '/home/user' }),
  fileCloneSourceBinds: vi.fn(() => [] as string[]),
}));

// Mock the eval child's process boundary, NOT the evaluation itself.
//
// `runEvalChild` forks `eval-runner.js`; a unit test cannot drive a real fork,
// but the evaluation it performs is `runEvalRequest` in `eval-dispatch.ts`. The
// fake calls that real function, so every assertion below still exercises the
// production evaluation path (and the module mocks it depends on) — it just
// skips the process boundary. A hand-written imitation would drift from the
// child the moment either side changed.
const runEvalChildMock = vi.hoisted(() => vi.fn());
vi.mock('./sandbox/eval-fork-runner.js', () => ({
  runEvalChild: (opts: {
    request: unknown;
    onLogLine: (line: string) => void;
    onApiRequest?: (m: string, p: Record<string, unknown>) => Promise<unknown>;
  }) => runEvalChildMock(opts),
}));

// Mock git clone (used by build jobs)
vi.mock('../checkout/git-clone.js', () => ({
  gitClone: vi.fn().mockResolvedValue(undefined),
}));

// Overlay application and the Dockerfile image build record one shared call
// order, so a test can assert the workspace is complete before the build reads
// it as its context.
const workspaceEvents = vi.hoisted(() => [] as string[]);
vi.mock('./overlay-applier.js', () => ({
  applyOverlay: vi.fn(async (cfg: { repoDir: string }) => {
    workspaceEvents.push(`overlay:${cfg.repoDir}`);
    return { filesApplied: 1, filesDeleted: 0 };
  }),
}));
vi.mock('./image-build/build-step.js', () => ({
  CONTAINER_BUILD_STEP_INDEX: 1_000_000,
  runJobImageBuild: vi.fn(async (args: { workDir: string }) => {
    workspaceEvents.push(`build:${args.workDir}`);
    return 'localhost/kici-job-image:test';
  }),
}));

// Mock workflow loader (used by build / init / dynamic jobs to load author
// TS and verify contentHash). The init and dynamic handlers also call
// extractWorkflow / extractDynamicJobFn; stub them so the unit tests can
// drive the handler past the load step without a real workflow module.
vi.mock('./workflow-loader.js', () => ({
  loadWorkflowSource: vi.fn().mockResolvedValue({ module: {} }),
  extractWorkflow: vi.fn().mockReturnValue({ name: 'test-workflow', jobs: [] }),
  extractDynamicJobFn: vi.fn().mockReturnValue(async () => [{ name: 'generated-job', steps: [] }]),
}));

// Mock init-runner (used by handleInitJob to evaluate dynamic fields, and by
// handleDynamicJobFn to evaluate a workflow-level filter before the generator).
vi.mock('./init-runner.js', () => ({
  evaluateDynamicFields: vi.fn().mockResolvedValue({}),
  evaluateWorkflowFilter: vi.fn().mockResolvedValue(true),
}));

// Mock dynamic-job-serializer (used by handleDynamicJobFn to serialize
// generated jobs to LockJob[]). Keep the real MatrixExpansionError so the
// handler's `instanceof` check in handleDynamicJobFn resolves against the
// same class the test throws.
vi.mock('./dynamic-job-serializer.js', async (importActual) => {
  const actual = await importActual<typeof import('./dynamic-job-serializer.js')>();
  return {
    serializeJobsToLock: vi.fn().mockResolvedValue([]),
    MatrixExpansionError: actual.MatrixExpansionError,
  };
});

// Mock source packer (used by build jobs to produce the cached tarball)
vi.mock('./source-packer.js', () => ({
  packKiciSource: vi
    .fn()
    .mockResolvedValue({ tarball: Buffer.from('packed-source'), hash: 'source-tar-hash' }),
}));

// Mock source restore (used by init/execution jobs when sourceTarUrl is set)
vi.mock('./source-restore.js', () => ({
  restoreSource: vi.fn().mockResolvedValue(undefined),
}));

// Mock log streamer -- track instances for verifying destroy() calls. Each
// instance records the step index it was built for, so a test can find the
// workflow-level (step -1) streamer among the per-step ones.
const logStreamerInstances: Array<{
  stepIndex: number;
  addLine: Mock;
  flush: Mock;
  destroy: Mock;
  getTotalBytes: Mock;
}> = [];
vi.mock('./log-streamer.js', () => ({
  LogStreamer: vi.fn(function (opts: { stepIndex: number }) {
    const instance = {
      stepIndex: opts.stepIndex,
      addLine: vi.fn(),
      flush: vi.fn(),
      destroy: vi.fn(),
      getTotalBytes: vi.fn().mockReturnValue(0),
    };
    logStreamerInstances.push(instance);
    return instance;
  }),
}));

// Mock dep-installer (used by build jobs)
vi.mock('./dep-installer.js', () => ({
  installDeps: vi.fn().mockResolvedValue(undefined),
}));

// The container host install: the allowlist check and the isolated installer.
// Their default results are set after the imports below.
vi.mock('./host-install-eligibility.js', async (importActual) => ({
  ...(await importActual<typeof import('./host-install-eligibility.js')>()),
  checkHostInstallEligibility: vi.fn(),
}));
vi.mock('./host-isolated-install.js', () => ({
  resolveHostNpm: vi.fn(),
  resolvePinnedPnpm: vi.fn(async () => null),
  runHostIsolatedInstall: vi.fn(async () => undefined),
}));
vi.mock('./host-install-lockfile.js', () => ({
  checkLockedInstall: vi.fn(async () => null),
}));

// Mock dep-restore (used by init jobs)
vi.mock('./dep-restore.js', () => ({
  restoreDeps: vi.fn().mockResolvedValue(undefined),
  // The host checkout hides dep-restore scratch dirs from `git status` in the
  // freshly cloned tree; omitting it here makes the real module's export
  // undefined and the call site throw.
  excludeScratchFromGit: vi.fn().mockResolvedValue(undefined),
}));

// Mock dep-packer (used by build jobs)
vi.mock('./dep-packer.js', () => ({
  packNodeModules: vi
    .fn()
    .mockResolvedValue({ tarball: Buffer.from('packed'), hash: 'abc123hash' }),
}));

// Mock download (used by build jobs)
vi.mock('./download.js', () => ({
  uploadToPresignedUrl: vi.fn().mockResolvedValue(undefined),
}));

// Import mocks after setup
const { BareMetalSandbox, ContainerSandbox } = await import('./sandbox/index.js');
const { gitClone } = await import('../checkout/git-clone.js');
const { checkHostInstallEligibility, HostInstallRefusal } =
  await import('./host-install-eligibility.js');
const { runHostIsolatedInstall, resolveHostNpm } = await import('./host-isolated-install.js');
const { checkLockedInstall } = await import('./host-install-lockfile.js');

const ELIGIBLE_NPM = {
  eligible: true as const,
  plan: {
    packageManager: PackageManager.Npm as const,
    lockfile: null,
    registries: [],
    npmrc: { ini: { decode: () => ({}), encode: () => '' }, operator: {}, repo: {} },
  },
};
const HOST_NPM = {
  packageManager: PackageManager.Npm as const,
  nodeExe: '/opt/node/bin/node',
  script: '/opt/node/lib/node_modules/npm/bin/npm-cli.js',
  version: '11.19.1',
};
vi.mocked(checkHostInstallEligibility).mockResolvedValue(ELIGIBLE_NPM);
vi.mocked(resolveHostNpm).mockResolvedValue(HOST_NPM);
const fsPromises = (await import('node:fs/promises')).default;

// --- Helpers ---

function makeConfig(): AppConfig {
  return {
    orchestratorUrl: 'ws://localhost:9999',
    agentId: 'test-agent',
    labels: ['linux'],
    port: 8080,
    logLevel: 'info',
    maxLogSizeBytes: 10 * 1024 * 1024,
    defaultStepTimeoutMs: 30 * 60 * 1000,
    dockerKeepFailed: false,
    jobHeartbeatIntervalMs: 60_000,
    backpressureMode: 'pause' as const,
  };
}

function makeDispatch(overrides: Partial<JobDispatch> = {}): JobDispatch {
  return {
    type: 'job.dispatch',
    messageId: 'msg-1',
    runId: 'run-1',
    jobId: 'job-1',
    repoUrl: 'https://github.com/org/repo.git',
    ref: 'main',
    sha: 'abc123',
    lockFileUrl: 'https://example.com/lock.json',
    jobConfig: {
      name: 'test-job',
      workflowName: 'test-workflow',
      runsOn: 'linux',
      source: { file: '.kici/workflows/ci.ts' },
      checkout: true,
    },
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeDeps(): JobRunnerDeps & {
  messages: AgentToOrchestratorMessage[];
} {
  const messages: AgentToOrchestratorMessage[] = [];
  return {
    send: (msg) => messages.push(msg),
    config: makeConfig(),
    requestUploadUrl: vi.fn().mockResolvedValue('https://s3.example.com/upload?presigned=1'),
    sendUploadComplete: vi.fn(),
    sendEventEmit: vi.fn().mockResolvedValue({ requestId: 'r1' }),
    sendJobContext: vi.fn(),
    sendRunEvent: vi.fn(),
    sendConcurrencyReport: vi.fn().mockResolvedValue({ action: 'proceed' }),
    // A container runtime is present unless a case says otherwise, so no test
    // depends on which sockets the machine running it happens to have.
    resolveContainerRuntime: () => ({
      fact: RuntimeFact.enum.docker,
      socketPath: '/var/run/docker.sock',
    }),
    messages,
  };
}

function resetSandboxMocks(resultOverride?: Partial<JobExecutionResult>) {
  const result = { ...defaultSuccessResult, ...resultOverride };
  mockSandboxInstance.setup.mockReset().mockResolvedValue(undefined);
  mockSandboxInstance.executeJob.mockReset().mockResolvedValue(result);
  mockSandboxInstance.abort.mockReset().mockResolvedValue(undefined);
  mockSandboxInstance.teardown.mockReset().mockResolvedValue(undefined);
}

describe('JobRunner', () => {
  beforeEach(() => {
    // Default: run the real evaluation in-process, minus the fork.
    runEvalChildMock.mockImplementation(async (opts: any) => {
      const { runEvalRequest } = await import('./sandbox/eval-dispatch.js');
      return runEvalRequest(opts.request, {
        emit: (line: string) => opts.onLogLine(line),
        kici: {} as never,
      });
    });
    vi.clearAllMocks();
    logStreamerInstances.length = 0;
    resetSandboxMocks();
  });

  // --- A. Execution job tests (sandbox-delegating) ---

  it('successful job: sandbox created, setup/executeJob/teardown called, running -> success', async () => {
    const deps = makeDeps();
    const runner = new JobRunner(deps);

    await runner.execute(makeDispatch());

    // BareMetalSandbox should have been constructed (default mode)
    expect(BareMetalSandbox).toHaveBeenCalledOnce();

    // Full sandbox lifecycle
    expect(mockSandboxInstance.setup).toHaveBeenCalledOnce();
    expect(mockSandboxInstance.executeJob).toHaveBeenCalledOnce();
    expect(mockSandboxInstance.teardown).toHaveBeenCalledOnce();

    // gitClone should NOT be called for execution jobs (sandbox handles clone)
    expect(gitClone).not.toHaveBeenCalled();

    // Verify status messages: running -> success
    const jobStatuses = deps.messages.filter((m) => m.type === 'job.status');
    expect(jobStatuses).toHaveLength(2);
    expect((jobStatuses[0] as { state: string }).state).toBe('running');
    expect((jobStatuses[1] as { state: string }).state).toBe('success');
  });

  it('failed execution: sandbox returns failed result, running -> failed', async () => {
    resetSandboxMocks({
      status: 'failed',
      stepResults: [
        {
          name: 'build',
          stepIndex: 0,
          status: 'failed',
          durationMs: 50,
          error: { message: 'build failed' },
        },
      ],
      durationMs: 50,
    });

    const deps = makeDeps();
    const runner = new JobRunner(deps);

    await runner.execute(makeDispatch());

    // Job reports failed
    const jobStatuses = deps.messages.filter((m) => m.type === 'job.status');
    expect((jobStatuses[jobStatuses.length - 1] as { state: string }).state).toBe('failed');
  });

  it('failed step with continueOnError: sandbox returns failed with multiple stepResults', async () => {
    resetSandboxMocks({
      status: 'failed',
      stepResults: [
        {
          name: 'lint',
          stepIndex: 0,
          status: 'failed',
          durationMs: 50,
          error: { message: 'lint warnings' },
        },
        { name: 'test', stepIndex: 1, status: 'success', durationMs: 100 },
      ],
      durationMs: 150,
    });

    const deps = makeDeps();
    const runner = new JobRunner(deps);

    await runner.execute(makeDispatch());

    // Job reports failed with 2 stepResults
    const jobStatuses = deps.messages.filter((m) => m.type === 'job.status');
    const failedStatus = jobStatuses.find((m) => (m as { state: string }).state === 'failed') as {
      data?: { stepResults?: unknown[] };
    };
    expect(failedStatus).toBeDefined();
    expect(failedStatus.data?.stepResults).toHaveLength(2);
  });

  it('failed init phase (stepCount 0): logs the job-level cause in the failure line', async () => {
    resetSandboxMocks({
      status: 'failed',
      stepResults: [],
      durationMs: 25572,
      error: 'init[1] mise provision failed: mise: command failed (exit 1)',
    });

    const deps = makeDeps();
    const runner = new JobRunner(deps);

    await runner.execute(makeDispatch());

    const failLog = loggerMock.error.mock.calls.find(
      ([msg]) => msg === 'Sandbox returned failed result',
    );
    expect(failLog).toBeDefined();
    expect(failLog![1]).toMatchObject({
      stepCount: 0,
      error: 'init[1] mise provision failed: mise: command failed (exit 1)',
    });
  });

  it('failed steps: lists each failed step error as stepErrors in the failure line', async () => {
    resetSandboxMocks({
      status: 'failed',
      stepResults: [
        {
          name: 'build',
          stepIndex: 0,
          status: 'failed',
          durationMs: 50,
          error: { message: 'build failed' },
        },
        { name: 'test', stepIndex: 1, status: 'success', durationMs: 100 },
      ],
      durationMs: 150,
    });

    const deps = makeDeps();
    const runner = new JobRunner(deps);

    await runner.execute(makeDispatch());

    const failLog = loggerMock.error.mock.calls.find(
      ([msg]) => msg === 'Sandbox returned failed result',
    );
    expect(failLog).toBeDefined();
    expect(failLog![1]).toMatchObject({ stepErrors: 'build: build failed' });
  });

  it('sandbox error: executeJob throws, running -> failed with error message', async () => {
    mockSandboxInstance.executeJob
      .mockReset()
      .mockRejectedValue(new Error('sandbox process crashed'));

    const deps = makeDeps();
    const runner = new JobRunner(deps);

    await runner.execute(makeDispatch());

    const jobStatuses = deps.messages.filter((m) => m.type === 'job.status');
    const failedStatus = jobStatuses.find((m) => (m as { state: string }).state === 'failed') as {
      data?: Record<string, unknown>;
    };
    expect(failedStatus).toBeDefined();
    expect(failedStatus.data).toHaveProperty('error', 'sandbox process crashed');
  });

  it('container mode: ContainerSandbox created when container config present', async () => {
    const dispatch = makeDispatch({
      jobConfig: {
        name: 'test-job',
        workflowName: 'test-workflow',
        runsOn: 'linux',
        source: { file: '.kici/workflows/ci.ts' },
        container: 'node:20-alpine',
      },
    });

    const deps = makeDeps();
    const runner = new JobRunner(deps);

    await runner.execute(dispatch);

    // ContainerSandbox should have been created (not BareMetalSandbox)
    expect(ContainerSandbox).toHaveBeenCalledOnce();
    expect(BareMetalSandbox).not.toHaveBeenCalled();

    // Full sandbox lifecycle
    expect(mockSandboxInstance.setup).toHaveBeenCalledOnce();
    expect(mockSandboxInstance.executeJob).toHaveBeenCalledOnce();
    expect(mockSandboxInstance.teardown).toHaveBeenCalledOnce();
  });

  it('job-image agent runs bare-metal instead of nesting another container', async () => {
    // The scaler spawned this agent FROM the job's image with the runtime
    // injected, so it is already inside the image the job asked for. Nesting a
    // second container from the same image would need a runtime inside a
    // runtime.
    const deps = makeDeps();
    deps.config = { ...deps.config, jobImageAgent: true } as typeof deps.config;
    const dispatch = makeDispatch({
      jobConfig: {
        name: 'test-job',
        workflowName: 'test-workflow',
        runsOn: 'linux',
        source: { file: '.kici/workflows/ci.ts' },
        container: 'python:3.12-slim',
      },
    });

    await new JobRunner(deps).execute(dispatch);

    expect(BareMetalSandbox).toHaveBeenCalled();
    expect(ContainerSandbox).not.toHaveBeenCalled();
  });

  it('container mode: clones on the HOST and tells the runner not to re-clone', async () => {
    const { gitClone } = await import('../checkout/git-clone.js');
    const dispatch = makeDispatch({
      jobConfig: {
        name: 'test-job',
        workflowName: 'test-workflow',
        runsOn: 'linux',
        source: { file: '.kici/workflows/ci.ts' },
        container: 'python:3.12-slim',
      },
    });

    await new JobRunner(makeDeps()).execute(dispatch);

    // Cloning on the host is what lets the image ship without git, and keeps
    // clone-time credentials out of a CapDrop:ALL container.
    expect(gitClone).toHaveBeenCalled();

    // The workspace is copied in, and the runner must not clone over it.
    const setupArg = (mockSandboxInstance.setup as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { workspaceFromHost?: boolean };
    expect(setupArg.workspaceFromHost).toBe(true);
    expect((dispatch.jobConfig as Record<string, unknown>).checkout).toBe(false);
  });

  it('container mode: a global job clones the workflow repo named in jobConfig on the host', async () => {
    const { gitClone } = await import('../checkout/git-clone.js');
    vi.mocked(gitClone).mockClear();
    const dispatch = makeDispatch({
      repoUrl: 'https://github.com/org/source.git',
      ref: 'feature',
      sha: 'source-sha',
      jobConfig: {
        name: 'test-job',
        workflowName: 'test-workflow',
        runsOn: 'linux',
        source: { file: '.kici/workflows/ci.ts' },
        container: 'python:3.12-slim',
        isGlobalWorkflow: true,
        workflowRepoUrl: 'https://github.com/org/ci.git',
        workflowRef: 'main',
        workflowSha: 'workflow-sha',
      },
    });

    await new JobRunner(makeDeps()).execute(dispatch);

    // fails-when: the host checkout reads the workflow repo from the dispatch
    // envelope, where it is absent, so the workflow clone gets no URL.
    expect(gitClone).toHaveBeenCalledWith(
      expect.objectContaining({
        repoUrl: 'https://github.com/org/ci.git',
        ref: 'main',
        sha: 'workflow-sha',
        workDir: '/tmp/kici-test123/workflow',
      }),
    );
    expect(gitClone).toHaveBeenCalledWith(
      expect.objectContaining({
        repoUrl: 'https://github.com/org/source.git',
        ref: 'feature',
        sha: 'source-sha',
        workDir: '/tmp/kici-test123/source',
      }),
    );
    expect(gitClone).toHaveBeenCalledTimes(2);
  });

  it('container mode: a same-repo job clones only its own repo on the host', async () => {
    // breaks-if-wrong: a per-repository container job must still clone the
    // dispatch repo into the work dir, once.
    const { gitClone } = await import('../checkout/git-clone.js');
    vi.mocked(gitClone).mockClear();
    const dispatch = makeDispatch({
      jobConfig: {
        name: 'test-job',
        workflowName: 'test-workflow',
        runsOn: 'linux',
        source: { file: '.kici/workflows/ci.ts' },
        container: 'python:3.12-slim',
      },
    });

    await new JobRunner(makeDeps()).execute(dispatch);

    expect(gitClone).toHaveBeenCalledTimes(1);
    expect(gitClone).toHaveBeenCalledWith(
      expect.objectContaining({
        repoUrl: 'https://github.com/org/repo.git',
        ref: 'main',
        sha: 'abc123',
        workDir: '/tmp/kici-test123',
      }),
    );
  });

  describe('container mode: host overlay before the image build', () => {
    const overlayFields = {
      tarballUrl: 'https://s3.example.com/overlay.tar.enc',
      cliPublicKey: 'cli-pub',
      orchestratorPrivateKey: 'orch-priv',
    };

    it('a full-repo job clones nothing and applies the overlay before the Dockerfile build', async () => {
      const { gitClone } = await import('../checkout/git-clone.js');
      const { applyOverlay } = await import('./overlay-applier.js');
      vi.mocked(gitClone).mockClear();
      vi.mocked(applyOverlay).mockClear();
      workspaceEvents.length = 0;
      const dispatch = makeDispatch({
        jobConfig: {
          name: 'test-job',
          workflowName: 'test-workflow',
          runsOn: 'linux',
          source: { file: '.kici/workflows/ci.ts' },
          container: { dockerfile: 'Dockerfile' },
          fullRepo: true,
          ...overlayFields,
        },
      });

      await new JobRunner(makeDeps()).execute(dispatch);

      expect(gitClone).not.toHaveBeenCalled();
      // fails-when: the overlay is left to the runner inside the container, so
      // the build reads an empty work dir as its context.
      expect(workspaceEvents).toEqual(['overlay:/tmp/kici-test123', 'build:/tmp/kici-test123']);
      // The runner must not apply it again, and the key stays on the host.
      const cfg = dispatch.jobConfig as Record<string, unknown>;
      expect(cfg.tarballUrl).toBeUndefined();
      expect(cfg.orchestratorPrivateKey).toBeUndefined();
      expect(cfg.checkout).toBe(false);
      expect(cfg.fullRepo).toBe(true);
    });

    it('a cloned job with an overlay applies it over the clone, before the build', async () => {
      // breaks-if-wrong: a non-full-repo container job still clones its repo once.
      const { gitClone } = await import('../checkout/git-clone.js');
      vi.mocked(gitClone).mockClear();
      vi.mocked(gitClone).mockImplementation(async (opts: { workDir: string }) => {
        workspaceEvents.push(`clone:${opts.workDir}`);
      });
      workspaceEvents.length = 0;
      const dispatch = makeDispatch({
        jobConfig: {
          name: 'test-job',
          workflowName: 'test-workflow',
          runsOn: 'linux',
          source: { file: '.kici/workflows/ci.ts' },
          container: { dockerfile: 'Dockerfile' },
          ...overlayFields,
        },
      });

      try {
        await new JobRunner(makeDeps()).execute(dispatch);
      } finally {
        vi.mocked(gitClone).mockReset().mockResolvedValue(undefined);
      }

      expect(workspaceEvents).toEqual([
        'clone:/tmp/kici-test123',
        'overlay:/tmp/kici-test123',
        'build:/tmp/kici-test123',
      ]);
    });

    it('a container job with no overlay applies none', async () => {
      const { applyOverlay } = await import('./overlay-applier.js');
      vi.mocked(applyOverlay).mockClear();
      const dispatch = makeDispatch({
        jobConfig: {
          name: 'test-job',
          workflowName: 'test-workflow',
          runsOn: 'linux',
          source: { file: '.kici/workflows/ci.ts' },
          container: 'python:3.12-slim',
        },
      });

      await new JobRunner(makeDeps()).execute(dispatch);

      expect(applyOverlay).not.toHaveBeenCalled();
    });
  });

  describe('container mode: .kici install on the host', () => {
    const containerJob = (extra: Record<string, unknown> = {}) =>
      makeDispatch({
        npmRegistries: [
          {
            scope: '@acme',
            url: 'https://npm.acme.internal/',
            alwaysAuth: false,
            token: 'tok-SECRET-1',
          },
        ],
        installEnvSecrets: { ACME_TOKEN: 'install-SECRET-2' },
        jobConfig: {
          name: 'test-job',
          workflowName: 'test-workflow',
          runsOn: 'linux',
          source: { file: '.kici/workflows/ci.ts' },
          container: 'python:3.12-slim',
          ...extra,
        },
      });

    /** An agent that injects its runtime; scripts stay at the disabled default. */
    const injectingDeps = () => {
      const deps = makeDeps();
      deps.config = {
        ...deps.config,
        runtimeImage: 'localhost/kici-agent:test',
        hostInstallRegistries: ['https://npm.acme.internal'],
      };
      return deps;
    };

    const failedStatus = (deps: ReturnType<typeof makeDeps>) =>
      deps.messages.find(
        (m) =>
          m.type === 'job.status' &&
          (m as { state?: string }).state === ExecutionJobStatus.enum.failed,
      ) as { data?: Record<string, unknown> } | undefined;

    beforeEach(() => {
      // `.kici/package.json` exists, `.kici/node_modules` does not.
      accessFn.mockImplementation(async (p: string) => {
        if (String(p).endsWith('node_modules')) throw new Error('ENOENT');
      });
    });

    afterEach(() => {
      accessFn.mockReset().mockResolvedValue(undefined);
      vi.mocked(runHostIsolatedInstall).mockReset().mockResolvedValue(undefined);
      vi.mocked(checkHostInstallEligibility).mockReset().mockResolvedValue(ELIGIBLE_NPM);
      mockSandboxInstance.setup.mockReset().mockResolvedValue(undefined);
    });

    it('installs the checkout .kici through the isolated installer, after the build and before the copy-in', async () => {
      workspaceEvents.length = 0;
      vi.mocked(runHostIsolatedInstall).mockImplementation(async (a: { kiciDir: string }) => {
        workspaceEvents.push(`install:${a.kiciDir}`);
      });
      mockSandboxInstance.setup.mockImplementation(async () => {
        workspaceEvents.push('setup');
      });

      await new JobRunner(injectingDeps()).execute(
        containerJob({ container: { dockerfile: 'Dockerfile' } }),
      );

      const registries = [
        {
          scope: '@acme',
          url: 'https://npm.acme.internal/',
          alwaysAuth: false,
          token: 'tok-SECRET-1',
        },
      ];
      // fails-when: the agent's KICI_HOST_INSTALL_REGISTRIES origins are not
      // handed to the check, so a workflow registry the operator listed falls
      // back to the container.
      expect(checkHostInstallEligibility).toHaveBeenCalledWith('/tmp/kici-test123', {
        workflowRegistries: registries,
        hostInstallRegistries: ['https://npm.acme.internal'],
      });
      // fails-when: the lockfile check is not wired, so an npm that runs npm ci
      // installs a lockfile that leaves a URL dependency for npm to fetch.
      expect(checkLockedInstall).toHaveBeenCalledWith(
        '/tmp/kici-test123/.kici',
        ELIGIBLE_NPM.plan,
        HOST_NPM,
      );
      expect(runHostIsolatedInstall).toHaveBeenCalledWith({
        kiciDir: '/tmp/kici-test123/.kici',
        plan: ELIGIBLE_NPM.plan,
        tool: HOST_NPM,
        registries,
        installEnvSecrets: { ACME_TOKEN: 'install-SECRET-2' },
        jobIdShort: 'job-1',
        // The sanitized agent environment, never process.env.
        baseEnv: { PATH: '/usr/bin', HOME: '/home/user' },
        signal: expect.any(AbortSignal),
      });
      // fails-when: the install runs before the build (node_modules lands in the
      // Dockerfile build context) or after the copy-in (the container never sees
      // it).
      expect(workspaceEvents).toEqual([
        'build:/tmp/kici-test123',
        'install:/tmp/kici-test123/.kici',
        'setup',
      ]);
    });

    it('a global job installs the workflow repo checkout', async () => {
      await new JobRunner(injectingDeps()).execute(
        containerJob({
          isGlobalWorkflow: true,
          workflowRepoUrl: 'https://github.com/org/ci.git',
          workflowRef: 'main',
          workflowSha: 'workflow-sha',
        }),
      );

      // fails-when: the host install targets the source repo, which carries no
      // `.kici/` for a global job.
      expect(checkHostInstallEligibility).toHaveBeenCalledWith(
        '/tmp/kici-test123/workflow',
        expect.anything(),
      );
      expect(vi.mocked(runHostIsolatedInstall).mock.calls[0]![0].kiciDir).toBe(
        '/tmp/kici-test123/workflow/.kici',
      );
    });

    it('a checkout outside the allowlist installs nothing on the host', async () => {
      vi.mocked(checkHostInstallEligibility).mockResolvedValue({
        eligible: false,
        refusal: HostInstallRefusal.PnpmHooks,
        detail: '.pnpmfile.cjs is present',
      });

      await new JobRunner(injectingDeps()).execute(containerJob());

      // breaks-if-wrong: the job still runs, with the install left to the container.
      expect(runHostIsolatedInstall).not.toHaveBeenCalled();
      expect(mockSandboxInstance.executeJob).toHaveBeenCalledOnce();
    });

    it('a dispatch with a dependency cache installs nothing on the host', async () => {
      const dispatch = containerJob();
      dispatch.depsUrl = 'https://s3.example.com/deps.tar.gz';

      await new JobRunner(injectingDeps()).execute(dispatch);

      expect(runHostIsolatedInstall).not.toHaveBeenCalled();
    });

    it('an agent that allows install scripts leaves the install to the container', async () => {
      const deps = injectingDeps();
      deps.config = { ...deps.config, allowInstallScripts: true };

      await new JobRunner(deps).execute(containerJob());

      // breaks-if-wrong: lifecycle scripts must never run on the host; with
      // them allowed the runner installs inside the container, as before.
      expect(runHostIsolatedInstall).not.toHaveBeenCalled();
      expect(checkHostInstallEligibility).not.toHaveBeenCalled();
      const workflowLog = logStreamerInstances.find((s) => s.stepIndex === -1);
      expect(workflowLog?.addLine).toHaveBeenCalledWith(
        '[host-install] Install scripts are allowed on this agent, so the job container installs the .kici dependencies',
      );
    });

    it('an agent with no injected runtime leaves the install to the container', async () => {
      await new JobRunner(makeDeps()).execute(containerJob());

      expect(runHostIsolatedInstall).not.toHaveBeenCalled();
    });

    it('a bare-metal job installs nothing on the host — its runner does', async () => {
      await new JobRunner(injectingDeps()).execute(makeDispatch());

      expect(runHostIsolatedInstall).not.toHaveBeenCalled();
    });

    it('a failed host install fails the job with the redacted installer error and tears the sandbox down', async () => {
      vi.mocked(runHostIsolatedInstall).mockRejectedValue(
        new Error('npm error 401 for tok-SECRET-1 / install-SECRET-2'),
      );
      const deps = injectingDeps();

      await new JobRunner(deps).execute(containerJob({ container: { dockerfile: 'Dockerfile' } }));

      // fails-when: the installer's raw error, which echoes the registry token
      // and the install secret, reaches job.status.error.
      expect(failedStatus(deps)?.data?.error).toBe(
        'npm error 401 for ***REDACTED*** / ***REDACTED***',
      );
      // The container never gets a workspace to fall back to an in-container
      // install with.
      expect(mockSandboxInstance.setup).not.toHaveBeenCalled();
      expect(mockSandboxInstance.executeJob).not.toHaveBeenCalled();
      // fails-when: a sandbox created before the failure is not torn down, so
      // the image the Dockerfile build tagged is never reclaimed.
      expect(mockSandboxInstance.teardown).toHaveBeenCalledOnce();

      const workflowLog = logStreamerInstances.find((s) => s.stepIndex === -1);
      const lines = workflowLog!.addLine.mock.calls.map(([line]) => line as string);
      expect(lines).toContain(
        '[host-install] [error] npm error 401 for ***REDACTED*** / ***REDACTED***',
      );
      expect(lines.join('\n')).not.toMatch(/SECRET/);
      expect(workflowLog?.destroy).toHaveBeenCalled();
    });

    it('a job cancelled during the host install is cancelled without creating its container', async () => {
      const deps = injectingDeps();
      const runner = new JobRunner(deps);
      vi.mocked(runHostIsolatedInstall).mockImplementation(async (a: { signal?: AbortSignal }) => {
        runner.cancel('job-1', 'user cancelled');
        // The real installer's child is killed by the signal and rejects.
        expect(a.signal?.aborted).toBe(true);
        throw new Error('The operation was aborted');
      });

      await runner.execute(containerJob());

      const states = deps.messages
        .filter((m) => m.type === 'job.status')
        .map((m) => (m as { state: string }).state);
      // fails-when: the abort is reported as a failure, or the post-install
      // abort check is missing and setup creates, starts and fills the container.
      expect(states).toEqual([ExecutionJobStatus.enum.running, ExecutionJobStatus.enum.cancelled]);
      expect(mockSandboxInstance.setup).not.toHaveBeenCalled();
      expect(mockSandboxInstance.teardown).toHaveBeenCalledOnce();
    });

    it('a sandbox whose setup throws is still torn down, with the error redacted', async () => {
      // A container created by setup() must not outlive a job whose setup
      // failed partway (the copy-in, say).
      mockSandboxInstance.setup
        .mockReset()
        .mockRejectedValue(new Error('copy-in failed tok-SECRET-1'));
      const deps = makeDeps();

      await new JobRunner(deps).execute(containerJob());

      // fails-when: teardown reads only a sandbox whose setup returned, so the
      // started container outlives the job.
      expect(mockSandboxInstance.teardown).toHaveBeenCalledOnce();
      expect(failedStatus(deps)?.data?.error).toBe('copy-in failed ***REDACTED***');
    });
  });

  describe('workflow-level (step -1) setup log', () => {
    const containerJob = () =>
      makeDispatch({
        jobConfig: {
          name: 'test-job',
          workflowName: 'test-workflow',
          runsOn: 'linux',
          source: { file: '.kici/workflows/ci.ts' },
          container: 'python:3.12-slim',
        },
      });

    it('streams the host checkout of a container job to step -1, on the streamer the runner reuses', async () => {
      mockSandboxInstance.executeJob.mockReset().mockImplementation(async (opts: unknown) => {
        const options = opts as { onLogLine: (stepIndex: number, line: string) => void };
        options.onLogLine(-1, '[workflow-runner] Deps already present');
        return defaultSuccessResult;
      });

      await new JobRunner(makeDeps()).execute(containerJob());

      const workflowLogs = logStreamerInstances.filter((s) => s.stepIndex === -1);
      // One streamer for the whole workflow-level log: a second one would
      // interleave two independently-flushed buffers into one stored file.
      expect(workflowLogs).toHaveLength(1);
      const lines = workflowLogs[0]!.addLine.mock.calls.map(([line]) => line as string);
      // fails-when: the host checkout logs only to the agent's own logger, so
      // the run's step -1 log starts at the runner and the clone is invisible.
      expect(lines).toEqual([
        '[host-checkout] Cloning https://github.com/org/repo.git ref=main into /tmp/kici-test123',
        '[host-checkout] Clone complete',
        '[workflow-runner] Deps already present',
      ]);
      expect(workflowLogs[0]!.destroy).toHaveBeenCalled();
    });

    it('a setup that fails after the host checkout leaves the checkout lines and the error on step -1', async () => {
      mockSandboxInstance.setup.mockReset().mockRejectedValue(new Error('copy-in failed'));
      const deps = makeDeps();
      const send = vi.fn(deps.send);
      deps.send = send;

      await new JobRunner(deps).execute(containerJob());

      const workflowLogs = logStreamerInstances.filter((s) => s.stepIndex === -1);
      expect(workflowLogs).toHaveLength(1);
      // fails-when: the setup error reaches only job.status, so a job that never
      // started a step has a setup log ending mid-clone with no cause in it
      expect(workflowLogs[0]!.addLine.mock.calls.map(([line]) => line)).toEqual([
        '[host-checkout] Cloning https://github.com/org/repo.git ref=main into /tmp/kici-test123',
        '[host-checkout] Clone complete',
        '[job-setup] Setup failed: copy-in failed',
      ]);
      // The streamer is flushed before the terminal status goes out, so its
      // lines are on the wire ahead of the status that ends the job.
      const failedAt = send.mock.calls.findIndex(
        ([m]) =>
          m.type === 'job.status' &&
          (m as { state?: string }).state === ExecutionJobStatus.enum.failed,
      );
      expect(failedAt).toBeGreaterThanOrEqual(0);
      expect(workflowLogs[0]!.destroy.mock.invocationCallOrder[0]).toBeLessThan(
        send.mock.invocationCallOrder[failedAt]!,
      );
    });

    it('a job whose setup succeeds gets no setup-failure line', async () => {
      await new JobRunner(makeDeps()).execute(containerJob());

      // breaks-if-wrong: a healthy container job's step -1 log is its setup
      // narration only
      const lines = logStreamerInstances
        .filter((s) => s.stepIndex === -1)
        .flatMap((s) => s.addLine.mock.calls.map(([line]) => line as string));
      expect(lines.some((l) => l.startsWith('[job-setup]'))).toBe(false);
    });

    it('a container job on a host with no runtime fails before the clone, naming the runtime and labels', async () => {
      const { gitClone } = await import('../checkout/git-clone.js');
      vi.mocked(gitClone).mockClear();
      const deps = makeDeps();
      deps.config = { ...deps.config, labels: ['linux', 'kici:agent:container'] };
      deps.resolveContainerRuntime = () => null;

      await new JobRunner(deps).execute(containerJob());

      const failed = deps.messages.find(
        (m) =>
          m.type === 'job.status' &&
          (m as { state?: string }).state === ExecutionJobStatus.enum.failed,
      ) as { data?: { error?: string } } | undefined;
      // fails-when: the job reaches the container client and dies on a bare
      // `connect ENOENT /var/run/docker.sock`
      expect(failed?.data?.error).toContain(
        'This job runs in a container (image python:3.12-slim), but this agent has no container runtime',
      );
      expect(failed?.data?.error).toContain('Agent labels: linux, kici:agent:container');
      expect(failed?.data?.error).toContain('kici:runtime:docker or kici:runtime:podman');
      // Nothing was cloned, and no container client was built.
      expect(gitClone).not.toHaveBeenCalled();
      expect(ContainerSandbox).not.toHaveBeenCalled();
      const workflowLog = logStreamerInstances.find((s) => s.stepIndex === -1);
      expect(workflowLog?.addLine).toHaveBeenCalledWith(
        `[job-setup] Setup failed: ${failed?.data?.error}`,
      );
    });

    it('a container job starts its container on the resolved runtime socket', async () => {
      const Docker = (await import('dockerode')).default;
      vi.mocked(Docker).mockClear();
      const deps = makeDeps();
      deps.resolveContainerRuntime = () => ({
        fact: RuntimeFact.enum.podman,
        socketPath: '/run/user/1000/podman/podman.sock',
      });

      await new JobRunner(deps).execute(containerJob());

      // fails-when: the client is built with no socket and falls back to
      // /var/run/docker.sock on a host that only runs Podman
      expect(Docker).toHaveBeenCalledWith({ socketPath: '/run/user/1000/podman/podman.sock' });
    });

    it('a bare-metal job opens no host-side step -1 streamer — its runner narrates the clone', async () => {
      // breaks-if-wrong: the runner's own step -1 lines must still reach a
      // streamer created on demand.
      mockSandboxInstance.executeJob.mockReset().mockImplementation(async (opts: unknown) => {
        const options = opts as { onLogLine: (stepIndex: number, line: string) => void };
        options.onLogLine(-1, '[workflow-runner] Cloning');
        return defaultSuccessResult;
      });

      await new JobRunner(makeDeps()).execute(makeDispatch());

      const workflowLogs = logStreamerInstances.filter((s) => s.stepIndex === -1);
      expect(workflowLogs).toHaveLength(1);
      expect(workflowLogs[0]!.addLine.mock.calls.map(([line]) => line)).toEqual([
        '[workflow-runner] Cloning',
      ]);
    });
  });

  it('bare-metal mode: does NOT clone on the host — the runner still does it', async () => {
    const { gitClone } = await import('../checkout/git-clone.js');
    vi.mocked(gitClone).mockClear();
    const dispatch = makeDispatch({
      jobConfig: {
        name: 'test-job',
        workflowName: 'test-workflow',
        runsOn: 'linux',
        source: { file: '.kici/workflows/ci.ts' },
      },
    });

    await new JobRunner(makeDeps()).execute(dispatch);

    // Bare-metal already runs against workDir directly, so a host clone here
    // would be a second clone of the same tree.
    expect(gitClone).not.toHaveBeenCalled();
    const setupArg = (mockSandboxInstance.setup as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { workspaceFromHost?: boolean };
    expect(setupArg.workspaceFromHost).toBeUndefined();
  });

  it('container mode with object config: ContainerSandbox created with correct image', async () => {
    const dispatch = makeDispatch({
      jobConfig: {
        name: 'test-job',
        workflowName: 'test-workflow',
        runsOn: 'linux',
        source: { file: '.kici/workflows/ci.ts' },
        container: { image: 'node:20-alpine', env: { NODE_ENV: 'production' } },
      },
    });

    const deps = makeDeps();
    const runner = new JobRunner(deps);

    await runner.execute(dispatch);

    // ContainerSandbox constructor called with correct image
    expect(ContainerSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        image: 'node:20-alpine',
      }),
    );
  });

  it('container mode: threads the dispatched sandbox grant into hardening.grant', async () => {
    const dispatch = makeDispatch({
      jobConfig: {
        name: 'test-job',
        workflowName: 'test-workflow',
        runsOn: 'linux',
        source: { file: '.kici/workflows/ci.ts' },
        container: 'node:20',
        // The dispatch-resolved (allow-listed) escape-hatch grant.
        sandboxGrant: { capabilities: ['NET_ADMIN'], network: 'host' },
      },
    });

    const runner = new JobRunner(makeDeps());
    await runner.execute(dispatch);

    expect(ContainerSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        hardening: expect.objectContaining({
          grant: { capabilities: ['NET_ADMIN'], network: 'host' },
        }),
      }),
    );
  });

  it('container mode: no grant threaded when jobConfig carries none (default posture)', async () => {
    const dispatch = makeDispatch({
      jobConfig: {
        name: 'test-job',
        workflowName: 'test-workflow',
        runsOn: 'linux',
        source: { file: '.kici/workflows/ci.ts' },
        container: 'node:20',
      },
    });

    const runner = new JobRunner(makeDeps());
    await runner.execute(dispatch);

    const call = (ContainerSandbox as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(call?.[0].hardening.grant).toBeUndefined();
  });

  it('cancel: abort() called on active sandbox', async () => {
    // Make sandbox.executeJob block until manually resolved
    let resolveExecution!: (value: JobExecutionResult) => void;
    const executionPromise = new Promise<JobExecutionResult>((resolve) => {
      resolveExecution = resolve;
    });
    mockSandboxInstance.executeJob.mockReset().mockReturnValue(executionPromise);

    const deps = makeDeps();
    const runner = new JobRunner(deps);
    const dispatch = makeDispatch();

    const executePromise = runner.execute(dispatch);

    // Wait for the job to start and sandbox to be set
    await new Promise((r) => setTimeout(r, 20));

    // Cancel the job
    runner.cancel(dispatch.jobId, 'user cancelled');

    // Verify sandbox.abort() was called
    expect(mockSandboxInstance.abort).toHaveBeenCalled();

    // Resolve the execution so the test can finish cleanly
    resolveExecution({
      status: 'cancelled',
      stepResults: [],
      durationMs: 0,
    });

    await executePromise;
  });

  it('status order: running then success', async () => {
    const deps = makeDeps();
    const runner = new JobRunner(deps);

    await runner.execute(makeDispatch());

    const jobStatuses = deps.messages.filter((m) => m.type === 'job.status');
    const states = jobStatuses.map((m) => (m as { state: string }).state);

    expect(states[0]).toBe('running');
    expect(states[states.length - 1]).toBe('success');
  });

  it('step status callbacks: onStepStatus invoked, step.status messages sent', async () => {
    // Make sandbox.executeJob invoke the onStepStatus callback
    mockSandboxInstance.executeJob.mockReset().mockImplementation(async (opts: unknown) => {
      const options = opts as {
        onStepStatus: (
          stepIndex: number,
          name: string,
          state: string,
          data?: Record<string, unknown>,
        ) => void;
      };
      options.onStepStatus(0, 'build', 'running');
      options.onStepStatus(0, 'build', 'success', { durationMs: 50 });
      options.onStepStatus(1, 'test', 'running');
      options.onStepStatus(1, 'test', 'success', { durationMs: 100 });

      return defaultSuccessResult;
    });

    const deps = makeDeps();
    const runner = new JobRunner(deps);

    await runner.execute(makeDispatch());

    const stepStatuses = deps.messages.filter((m) => m.type === 'step.status');
    expect(stepStatuses).toHaveLength(4);

    // Verify step status message content
    const firstStep = stepStatuses[0] as { stepIndex: number; stepName: string; state: string };
    expect(firstStep.stepIndex).toBe(0);
    expect(firstStep.stepName).toBe('build');
    expect(firstStep.state).toBe('running');
  });

  it('cache pseudo-steps emit a cache.restore / cache.save run event', async () => {
    mockSandboxInstance.executeJob.mockReset().mockImplementation(async (opts: unknown) => {
      const options = opts as {
        onStepStatus: (
          stepIndex: number,
          name: string,
          state: string,
          data?: Record<string, unknown>,
        ) => void;
      };
      // A cache:restore pseudo-step that hit, and a cache:save that saved.
      options.onStepStatus(100, 'cache restore: k1', 'success', {
        durationMs: 5,
        step_type: 'cache:restore',
        cacheOutcome: 'hit',
        key: 'k1',
        matchedKey: 'k1',
      });
      options.onStepStatus(101, 'cache save: k2', 'success', {
        durationMs: 7,
        step_type: 'cache:save',
        cacheOutcome: 'saved',
        key: 'k2',
      });
      // A regular step must NOT emit a cache run event.
      options.onStepStatus(0, 'build', 'success', { durationMs: 3 });
      return defaultSuccessResult;
    });

    const deps = makeDeps();
    const sendRunEvent = deps.sendRunEvent as ReturnType<typeof vi.fn>;
    const runner = new JobRunner(deps);
    await runner.execute(makeDispatch());

    const calls = sendRunEvent.mock.calls.map((c) => c[1]);
    expect(calls).toContain('cache.restore');
    expect(calls).toContain('cache.save');

    const restoreCall = sendRunEvent.mock.calls.find((c) => c[1] === 'cache.restore');
    expect(restoreCall?.[2]?.metadata?.outcome).toBe('hit');
    expect(restoreCall?.[2]?.metadata?.key).toBe('k1');
    const saveCall = sendRunEvent.mock.calls.find((c) => c[1] === 'cache.save');
    expect(saveCall?.[2]?.metadata?.outcome).toBe('saved');
  });

  it('step status: terminal step.status messages carry logBytesStreamed from LogStreamer', async () => {
    // The agent calls onStepStatus from inside sandbox.executeJob; the
    // job-runner looks up the per-step LogStreamer (created lazily by
    // onLogLine) and forwards getTotalBytes() on terminal states. Drive
    // distinct return values on the mocked streamers so we can prove the
    // wiring picks the right streamer per step index.
    mockSandboxInstance.executeJob.mockReset().mockImplementation(async (opts: unknown) => {
      const options = opts as {
        onStepStatus: (
          stepIndex: number,
          name: string,
          state: string,
          data?: Record<string, unknown>,
        ) => void;
        onLogLine: (stepIndex: number, line: string) => void;
      };
      // Trigger LogStreamer creation for step 0 and step 1.
      options.onLogLine(0, 'build line 1');
      options.onLogLine(1, 'test line 1');

      // Mocked LogStreamer instances are pushed in creation order.
      // Mock distinct byte totals so we can verify per-step wiring.
      logStreamerInstances[0]!.getTotalBytes.mockReturnValue(2048);
      logStreamerInstances[1]!.getTotalBytes.mockReturnValue(512);

      options.onStepStatus(0, 'build', 'running');
      options.onStepStatus(0, 'build', 'success', { durationMs: 50 });
      options.onStepStatus(1, 'test', 'running');
      options.onStepStatus(1, 'test', 'success', { durationMs: 100 });
      return defaultSuccessResult;
    });

    const deps = makeDeps();
    const runner = new JobRunner(deps);
    await runner.execute(makeDispatch());

    const stepStatuses = deps.messages.filter((m) => m.type === 'step.status') as Array<{
      stepIndex: number;
      state: string;
      logBytesStreamed?: number;
    }>;

    // running messages must NOT carry logBytesStreamed (would double-count).
    for (const r of stepStatuses.filter((s) => s.state === 'running')) {
      expect(r.logBytesStreamed).toBeUndefined();
    }

    const terminalMsgs = stepStatuses.filter((s) => s.state === 'success');
    expect(terminalMsgs).toHaveLength(2);
    const step0 = terminalMsgs.find((t) => t.stepIndex === 0)!;
    const step1 = terminalMsgs.find((t) => t.stepIndex === 1)!;
    expect(step0.logBytesStreamed).toBe(2048);
    expect(step1.logBytesStreamed).toBe(512);
  });

  it('success includes durationMs and stepResults', async () => {
    const deps = makeDeps();
    const runner = new JobRunner(deps);

    await runner.execute(makeDispatch());

    const jobStatuses = deps.messages.filter((m) => m.type === 'job.status');
    const successStatus = jobStatuses.find((m) => (m as { state: string }).state === 'success') as {
      data?: Record<string, unknown>;
    };

    expect(successStatus).toBeDefined();
    expect(successStatus.data).toHaveProperty('durationMs');
    expect(successStatus.data).toHaveProperty('stepResults');
    expect(Array.isArray(successStatus.data!.stepResults)).toBe(true);
  });

  it('activeJobs map tracks running jobs', async () => {
    let sawActive = false;

    // Make sandbox.executeJob check activeJobs mid-execution
    mockSandboxInstance.executeJob.mockReset().mockImplementation(async () => {
      // runner is captured via closure below -- use deps.messages as proxy
      // Instead, we check from outside after a tick
      return defaultSuccessResult;
    });

    const deps = makeDeps();
    const runner = new JobRunner(deps);
    const dispatch = makeDispatch();

    // Use a blocking sandbox to check activeJobs mid-execution
    let resolveExecution!: (value: JobExecutionResult) => void;
    const executionPromise = new Promise<JobExecutionResult>((resolve) => {
      resolveExecution = resolve;
    });
    mockSandboxInstance.executeJob.mockReset().mockReturnValue(executionPromise);

    const executePromise = runner.execute(dispatch);

    // Wait for the job to start
    await new Promise((r) => setTimeout(r, 20));

    // Check activeJobs mid-execution
    sawActive = runner.activeJobs.has(dispatch.jobId);

    // Unblock
    resolveExecution(defaultSuccessResult);
    await executePromise;

    expect(sawActive).toBe(true);
    // After completion, job removed from activeJobs
    expect(runner.activeJobs.has(dispatch.jobId)).toBe(false);
  });

  // --- B. Execution job: gitClone not called (sandbox handles clone) ---

  it('execution job with checkout=false: gitClone not called (sandbox handles clone)', async () => {
    const dispatch = makeDispatch({
      jobConfig: {
        name: 'test-job',
        workflowName: 'test-workflow',
        runsOn: 'linux',
        source: { file: '.kici/workflows/ci.ts' },
        checkout: false,
      },
    });

    const deps = makeDeps();
    const runner = new JobRunner(deps);

    await runner.execute(dispatch);

    // gitClone not called at job-runner level -- sandbox handles clone
    expect(gitClone).not.toHaveBeenCalled();
    // sandbox.executeJob was called (execution delegated to sandbox)
    expect(mockSandboxInstance.executeJob).toHaveBeenCalledOnce();
  });

  // --- C. Lifecycle tests ---

  it('work directory cleaned up after execution (even on failure)', async () => {
    mockSandboxInstance.executeJob
      .mockReset()
      .mockRejectedValue(new Error('unexpected sandbox error'));

    const deps = makeDeps();
    const runner = new JobRunner(deps);

    await runner.execute(makeDispatch());

    // rm should have been called to clean up
    expect(fsPromises.rm).toHaveBeenCalled();
  });

  it('sandbox teardown called even on failure', async () => {
    mockSandboxInstance.executeJob
      .mockReset()
      .mockRejectedValue(new Error('unexpected sandbox error'));

    const deps = makeDeps();
    const runner = new JobRunner(deps);

    await runner.execute(makeDispatch());

    // teardown should still be called
    expect(mockSandboxInstance.teardown).toHaveBeenCalledOnce();
  });

  // --- D. job.context and run.event emission ---

  it('emits job.context after sandbox setup with runtime info', async () => {
    const sendJobContext = vi.fn();
    const deps = { ...makeDeps(), sendJobContext };
    const runner = new JobRunner(deps);

    await runner.execute(makeDispatch());

    expect(sendJobContext).toHaveBeenCalledOnce();
    const [runId, jobId, context] = sendJobContext.mock.calls[0];
    expect(runId).toBe('run-1');
    expect(jobId).toBe('job-1');
    expect(context.runtime).toBeDefined();
    expect(context.runtime.nodeVersion).toBe(process.version);
    expect(context.sandboxType).toBe('bare-metal');
    expect(context.gitRef).toBe('main');
    expect(context.workingDirectory).toMatch(/kici/);
    expect(context.envVars).toBeDefined();
    expect(Array.isArray(context.envVars)).toBe(true);
  });

  it('emits run.event at execution start, end, and teardown', async () => {
    const sendRunEvent = vi.fn();
    const deps = { ...makeDeps(), sendRunEvent };
    const runner = new JobRunner(deps);

    await runner.execute(makeDispatch());

    const eventTypes = sendRunEvent.mock.calls.map((call: unknown[]) => call[1]);
    expect(eventTypes).toContain('agent.execution.start');
    expect(eventTypes).toContain('agent.execution.end');
    expect(eventTypes).toContain('agent.teardown');
  });

  it('agent.execution.end includes durationMs', async () => {
    const sendRunEvent = vi.fn();
    const deps = { ...makeDeps(), sendRunEvent };
    const runner = new JobRunner(deps);

    await runner.execute(makeDispatch());

    const endCall = sendRunEvent.mock.calls.find(
      (call: unknown[]) => call[1] === 'agent.execution.end',
    );
    expect(endCall).toBeDefined();
    const opts = endCall![2] as { durationMs?: number; metadata?: Record<string, unknown> };
    expect(opts.durationMs).toBeGreaterThanOrEqual(0);
    expect(opts.metadata?.status).toBe('success');
  });

  it('build job emits clone start/end events', async () => {
    const sendRunEvent = vi.fn();
    const deps = { ...makeDeps(), sendRunEvent };
    const runner = new JobRunner(deps);

    const dispatch = makeDispatch({
      jobConfig: {
        name: 'build-job',
        workflowName: 'test-workflow',
        runsOn: 'linux',
        buildOnly: true,
        buildSourceNeeded: true,
        contentHash: 'abc123hash',
        source: { file: '.kici/workflows/ci.ts' },
      },
    });

    await runner.execute(dispatch);

    const eventTypes = sendRunEvent.mock.calls.map((call: unknown[]) => call[1]);
    expect(eventTypes).toContain('agent.clone.start');
    expect(eventTypes).toContain('agent.clone.end');
  });

  it('collectEnvVars returns KICI_ system vars from process.env', async () => {
    // Set a KICI_ env var for the test
    process.env.KICI_TEST_VAR = 'test-value';

    const sendJobContext = vi.fn();
    const deps = { ...makeDeps(), sendJobContext };
    const runner = new JobRunner(deps);

    await runner.execute(makeDispatch());

    const context = sendJobContext.mock.calls[0][2];
    const kiciVars = context.envVars.filter((v: { category: string }) => v.category === 'system');
    expect(kiciVars.some((v: { name: string }) => v.name === 'KICI_TEST_VAR')).toBe(true);

    delete process.env.KICI_TEST_VAR;
  });

  // --- D2. LogStreamer lifecycle ---

  it('log streamers are destroyed (not just flushed) after execution', async () => {
    // Make sandbox call onLogLine so LogStreamers are created
    mockSandboxInstance.executeJob.mockReset().mockImplementation(async (opts: unknown) => {
      const options = opts as {
        onLogLine: (stepIndex: number, line: string) => void;
      };
      options.onLogLine(0, 'step 0 output');
      options.onLogLine(1, 'step 1 output');
      return defaultSuccessResult;
    });

    const deps = makeDeps();
    const runner = new JobRunner(deps);

    await runner.execute(makeDispatch());

    // Two log streamers should have been created (one per step index)
    expect(logStreamerInstances).toHaveLength(2);

    // Each must have destroy() called (not just flush())
    for (const instance of logStreamerInstances) {
      expect(instance.destroy).toHaveBeenCalledOnce();
    }
  });

  it('log streamers are destroyed when execution throws, before the failed status', async () => {
    // The step's buffered output — where the failure diagnostics sit — must
    // reach the orchestrator even when the sandbox blows up mid-execution.
    mockSandboxInstance.executeJob.mockReset().mockImplementation(async (opts: unknown) => {
      const options = opts as {
        onLogLine: (stepIndex: number, line: string) => void;
      };
      options.onLogLine(0, 'nft: Could not process rule');
      throw new Error('sandbox exploded');
    });

    const deps = makeDeps();
    const runner = new JobRunner(deps);

    await runner.execute(makeDispatch());

    expect(logStreamerInstances).toHaveLength(1);
    expect(logStreamerInstances[0]!.destroy).toHaveBeenCalledOnce();

    const failed = deps.messages.filter(
      (m) => m.type === 'job.status' && (m as { state?: string }).state === 'failed',
    );
    expect(failed).toHaveLength(1);
  });

  // --- E. Build job tests (in-process, no sandbox) ---

  it('build job: gitClone and loadWorkflowSource called in-process', async () => {
    const dispatch = makeDispatch({
      jobConfig: {
        name: 'build-job',
        workflowName: 'test-workflow',
        runsOn: 'linux',
        buildOnly: true,
        buildSourceNeeded: true,
        contentHash: 'abc123hash',
        source: { file: '.kici/workflows/ci.ts' },
      },
    });

    const deps = makeDeps();
    const runner = new JobRunner(deps);

    await runner.execute(dispatch);

    // Build jobs use in-process gitClone
    expect(gitClone).toHaveBeenCalledOnce();

    // No sandbox created for build jobs
    expect(BareMetalSandbox).not.toHaveBeenCalled();
    expect(ContainerSandbox).not.toHaveBeenCalled();

    // Status: running -> success
    const jobStatuses = deps.messages.filter((m) => m.type === 'job.status');
    const states = jobStatuses.map((m) => (m as { state: string }).state);
    expect(states[0]).toBe('running');
    expect(states[states.length - 1]).toBe('success');
  });

  // --- F. Init / dynamic loadWorkflowSource contentHash propagation ---
  //
  // The orchestrator dispatch payloads carry `contentHash` and
  // `resolvedHashFiles` for init and dynamic eval jobs so the agent's
  // loadWorkflowSource drift gate fires at every author-TS load site. These
  // tests pin the wiring: the handler must forward both fields into
  // loadWorkflowSource, and a thrown drift error must surface as a failed
  // job status.

  // --- E2. Bring-up job tests (init-runner SSH bring-up, no sandbox) ---

  it('bring-up job: relays ensureInitRunner for the target and reports success', async () => {
    // broughtUp:false (target already live) exercises the no-SSH path; the SSH
    // transport itself is covered in ensure-init-runner.test.ts.
    const sendApiRequest = vi.fn().mockResolvedValue({ broughtUp: false });
    const deps = { ...makeDeps(), sendApiRequest };
    const runner = new JobRunner(deps);

    const dispatch = makeDispatch({
      jobConfig: {
        name: '__bringup__test-workflow__fresh-01',
        workflowName: 'test-workflow',
        runsOn: 'kici:capability:ssh-transport',
        bringupOnly: true,
        bringupTarget: 'fresh-01',
      },
    });

    await runner.execute(dispatch);

    expect(sendApiRequest).toHaveBeenCalledWith('kici.ensureInitRunner', {
      targetAgentId: 'fresh-01',
    });
    const statuses = deps.messages
      .filter((m) => m.type === 'job.status')
      .map((m) => (m as { state: string }).state);
    expect(statuses).toContain('success');
  });

  it('bring-up job: a failed bring-up reports a failed job status', async () => {
    const sendApiRequest = vi.fn().mockRejectedValue(new Error('ssh refused'));
    const deps = { ...makeDeps(), sendApiRequest };
    const runner = new JobRunner(deps);

    const dispatch = makeDispatch({
      jobConfig: {
        name: '__bringup__test-workflow__fresh-01',
        workflowName: 'test-workflow',
        runsOn: 'kici:capability:ssh-transport',
        bringupOnly: true,
        bringupTarget: 'fresh-01',
      },
    });

    await runner.execute(dispatch);

    const statuses = deps.messages
      .filter((m) => m.type === 'job.status')
      .map((m) => (m as { state: string }).state);
    expect(statuses).toContain('failed');
  });

  function makeInitDispatch(overrides: Record<string, unknown> = {}): JobDispatch {
    return makeDispatch({
      jobConfig: {
        initOnly: true,
        targetJobName: 'deploy',
        workflowName: 'test-workflow',
        source: '.kici/workflows/ci.ts',
        dynamicContext: false,
        dynamicEnv: false,
        dynamicConcurrencyGroup: false,
        event: {},
        contentHash: 'abc123hash',
        resolvedHashFiles: ['asset.txt'],
        ...overrides,
      },
    });
  }

  function makeDynamicDispatch(overrides: Record<string, unknown> = {}): JobDispatch {
    return makeDispatch({
      jobConfig: {
        dynamicJobFn: true,
        workflowName: 'test-workflow',
        source: { file: '.kici/workflows/ci.ts', index: 0 },
        event: {},
        contentHash: 'abc123hash',
        resolvedHashFiles: ['asset.txt'],
        ...overrides,
      },
    });
  }

  it('init job: passes contentHash and resolvedHashFiles to loadWorkflowSource', async () => {
    const { loadWorkflowSource } = await import('./workflow-loader.js');

    const deps = makeDeps();
    const runner = new JobRunner(deps);

    await runner.execute(makeInitDispatch());

    expect(loadWorkflowSource).toHaveBeenCalledWith(
      expect.any(String),
      '.kici/workflows/ci.ts',
      'abc123hash',
      ['asset.txt'],
    );

    // Init job ends in success when the drift gate is happy
    const jobStatuses = deps.messages.filter((m) => m.type === 'job.status');
    const states = jobStatuses.map((m) => (m as { state: string }).state);
    expect(states[states.length - 1]).toBe('success');
  });

  it('dynamic eval job: passes contentHash and resolvedHashFiles to loadWorkflowSource', async () => {
    const { loadWorkflowSource } = await import('./workflow-loader.js');

    const deps = makeDeps();
    const runner = new JobRunner(deps);

    await runner.execute(makeDynamicDispatch());

    expect(loadWorkflowSource).toHaveBeenCalledWith(
      expect.any(String),
      '.kici/workflows/ci.ts',
      'abc123hash',
      ['asset.txt'],
    );

    const jobStatuses = deps.messages.filter((m) => m.type === 'job.status');
    const states = jobStatuses.map((m) => (m as { state: string }).state);
    expect(states[states.length - 1]).toBe('success');
  });

  it('dynamic eval job: a false filter verdict generates no jobs and never runs the generator', async () => {
    // Without this the filter would be entirely inert for a workflow whose jobs
    // are all generated, and a mixed workflow would deterministically
    // half-dispatch: static jobs suppressed, generated jobs running.
    const { evaluateWorkflowFilter } = await import('./init-runner.js');
    const { extractDynamicJobFn } = await import('./workflow-loader.js');
    (evaluateWorkflowFilter as Mock).mockResolvedValueOnce(false);

    const deps = makeDeps();
    await new JobRunner(deps).execute(makeDynamicDispatch({ hasFilter: true }));

    expect(evaluateWorkflowFilter).toHaveBeenCalledTimes(1);
    // The generator is never reached — a suppressed workflow must not run
    // customer code whose output nothing can consume.
    expect(extractDynamicJobFn).not.toHaveBeenCalled();
    const success = deps.messages.find(
      (m) => m.type === 'job.status' && (m as { state: string }).state === 'success',
    ) as { data?: { dynamicJobs?: unknown[]; dynamicComplete?: boolean } } | undefined;
    expect(success?.data?.dynamicComplete).toBe(true);
    expect(success?.data?.dynamicJobs).toEqual([]);
  });

  it('dynamic eval job: a passing filter runs the generator as usual', async () => {
    // Positive control for the test above: identical setup, opposite verdict.
    const { evaluateWorkflowFilter } = await import('./init-runner.js');
    const { extractDynamicJobFn } = await import('./workflow-loader.js');
    (evaluateWorkflowFilter as Mock).mockResolvedValueOnce(true);

    const deps = makeDeps();
    await new JobRunner(deps).execute(makeDynamicDispatch({ hasFilter: true }));

    expect(evaluateWorkflowFilter).toHaveBeenCalledTimes(1);
    expect(extractDynamicJobFn).toHaveBeenCalledTimes(1);
  });

  it('dynamic eval job: no filter declared means no filter call at all', async () => {
    const { evaluateWorkflowFilter } = await import('./init-runner.js');
    const { extractDynamicJobFn } = await import('./workflow-loader.js');

    const deps = makeDeps();
    await new JobRunner(deps).execute(makeDynamicDispatch());

    expect(evaluateWorkflowFilter).not.toHaveBeenCalled();
    expect(extractDynamicJobFn).toHaveBeenCalledTimes(1);
  });

  it('init job: asks evaluateDynamicFields for the filter verdict and gives it a context', async () => {
    const { evaluateDynamicFields } = await import('./init-runner.js');

    const deps = makeDeps();
    await new JobRunner(deps).execute(makeInitDispatch({ hasFilter: true }));

    const call = (evaluateDynamicFields as Mock).mock.calls.at(-1)!;
    expect(call[3]).toMatchObject({ hasFilter: true });
    // The 6th argument is the filter context; without it the evaluator throws
    // rather than filtering against an empty tree.
    expect(call[5]).toBeDefined();
    expect(call[5].sourceRepo).toEqual(call[5].workflowRepo);
  });

  it('init job: no filter declared means no filter context is built', async () => {
    const { evaluateDynamicFields } = await import('./init-runner.js');

    const deps = makeDeps();
    await new JobRunner(deps).execute(makeInitDispatch());

    const call = (evaluateDynamicFields as Mock).mock.calls.at(-1)!;
    expect(call[3]).toMatchObject({ hasFilter: false });
    expect(call[5]).toBeUndefined();
  });

  it('dynamic eval job: builds ctx.needs from the result-aware upstream snapshot', async () => {
    const { extractDynamicJobFn } = await import('./workflow-loader.js');
    let capturedCtx: any;
    (extractDynamicJobFn as Mock).mockReturnValueOnce(async (context: any) => {
      capturedCtx = context.ctx;
      return [{ name: 'generated-job', steps: [] }];
    });

    const deps = makeDeps();
    const runner = new JobRunner(deps);

    await runner.execute(
      makeDynamicDispatch({
        resultAware: true,
        declaredNeeds: ['discover', { group: 'scan' }],
        upstreamSnapshot: {
          jobs: { discover: { targets: ['a'] }, 'scan-a': { findings: 1 } },
          groups: { scan: ['scan-a'] },
        },
      }),
    );

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx.needs).toBeDefined();
    expect(
      (capturedCtx.needs.discover as { result: { targets: string[] } }).result.targets,
    ).toEqual(['a']);
    const scan = capturedCtx.needs.scan as Array<{ name: string; result: { findings: number } }>;
    expect(scan.map((e) => e.name)).toEqual(['scan-a']);
    expect(scan[0].result.findings).toBe(1);
  });

  it('dynamic eval job: event-only generator has no ctx.needs', async () => {
    const { extractDynamicJobFn } = await import('./workflow-loader.js');
    let capturedCtx: any;
    (extractDynamicJobFn as Mock).mockReturnValueOnce(async (context: any) => {
      capturedCtx = context.ctx;
      return [{ name: 'generated-job', steps: [] }];
    });

    const deps = makeDeps();
    const runner = new JobRunner(deps);

    await runner.execute(makeDynamicDispatch());

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx.needs).toBeUndefined();
  });

  it('init job: contentHash mismatch surfaces as failed status with initFailed', async () => {
    const { loadWorkflowSource } = await import('./workflow-loader.js');
    (loadWorkflowSource as Mock).mockRejectedValueOnce(
      new Error('Lock file is out of date: workflow source changed'),
    );

    const deps = makeDeps();
    const runner = new JobRunner(deps);

    await runner.execute(makeInitDispatch());

    const jobStatuses = deps.messages.filter((m) => m.type === 'job.status') as Array<{
      state: string;
      data?: Record<string, unknown>;
    }>;
    const finalStatus = jobStatuses[jobStatuses.length - 1]!;
    expect(finalStatus.state).toBe('failed');
    expect(finalStatus.data).toMatchObject({
      initFailed: true,
      error: 'Lock file is out of date: workflow source changed',
    });
  });

  it('dynamic eval job: contentHash mismatch surfaces as failed status with dynamicFailed', async () => {
    const { loadWorkflowSource } = await import('./workflow-loader.js');
    (loadWorkflowSource as Mock).mockRejectedValueOnce(
      new Error('Lock file is out of date: workflow source changed'),
    );

    const deps = makeDeps();
    const runner = new JobRunner(deps);

    await runner.execute(makeDynamicDispatch());

    const jobStatuses = deps.messages.filter((m) => m.type === 'job.status') as Array<{
      state: string;
      data?: Record<string, unknown>;
    }>;
    const finalStatus = jobStatuses[jobStatuses.length - 1]!;
    expect(finalStatus.state).toBe('failed');
    expect(finalStatus.data).toMatchObject({
      dynamicFailed: true,
      error: 'Lock file is out of date: workflow source changed',
    });
  });

  it('dynamic eval job: attaches matrix_expansion initFailure when the matrix throws', async () => {
    const { serializeJobsToLock, MatrixExpansionError } =
      await import('./dynamic-job-serializer.js');
    (serializeJobsToLock as Mock).mockRejectedValueOnce(
      new MatrixExpansionError('build', "Matrix expansion failed for job 'build': boom"),
    );

    const deps = makeDeps();
    const runner = new JobRunner(deps);

    await runner.execute(makeDynamicDispatch());

    const jobStatuses = deps.messages.filter((m) => m.type === 'job.status') as Array<{
      state: string;
      data?: Record<string, unknown>;
    }>;
    const finalStatus = jobStatuses[jobStatuses.length - 1]!;
    expect(finalStatus.state).toBe('failed');
    expect(finalStatus.data).toMatchObject({
      dynamicFailed: true,
      initFailure: {
        scope: 'job',
        category: 'matrix_expansion',
        jobName: 'build',
      },
    });
  });

  it('dynamic eval job: non-matrix failure carries no initFailure', async () => {
    const { serializeJobsToLock } = await import('./dynamic-job-serializer.js');
    (serializeJobsToLock as Mock).mockRejectedValueOnce(new Error('plain boom'));

    const deps = makeDeps();
    const runner = new JobRunner(deps);

    await runner.execute(makeDynamicDispatch());

    const jobStatuses = deps.messages.filter((m) => m.type === 'job.status') as Array<{
      state: string;
      data?: Record<string, unknown>;
    }>;
    const finalStatus = jobStatuses[jobStatuses.length - 1]!;
    expect(finalStatus.state).toBe('failed');
    expect(finalStatus.data?.dynamicFailed).toBe(true);
    expect(finalStatus.data?.initFailure).toBeUndefined();
  });

  /**
   * An evaluation job of a global workflow loads the workflow module from the
   * workflow repository (A) and sees the source repository (B) as its source
   * tree, in the layout every other job of that workflow uses.
   */
  describe('global evaluation jobs check out the workflow repository', () => {
    const WORK_DIR = '/tmp/kici-test123';
    const WORKFLOW_DIR = `${WORK_DIR}/workflow`;
    const SOURCE_DIR = `${WORK_DIR}/source`;
    const SOURCE_AUTH = { kind: 'basic' as const, user: 'x-access-token', secret: 'b-token' };
    const WORKFLOW_AUTH = { kind: 'basic' as const, user: 'x-access-token', secret: 'a-token' };
    const GLOBAL_FIELDS = {
      isGlobalWorkflow: true,
      workflowRepoUrl: 'https://github.com/org/ci.git',
      workflowRef: 'main',
      workflowSha: 'workflow-sha',
      workflowRepoIdentifier: 'org/ci',
    };
    const DEPS = { depsUrl: 'https://cache.example/deps.tgz', depsHash: 'deps-hash' };
    const PACK = { sourceTarUrl: 'https://cache.example/src.tgz', sourceTarDigest: 'src-digest' };

    /** A global evaluation dispatch for source repo B, with both repos' credentials. */
    function globalDispatch(base: JobDispatch, extra: Partial<JobDispatch> = {}): JobDispatch {
      return {
        ...base,
        repoUrl: 'https://github.com/org/app.git',
        ref: 'feature',
        sha: 'source-sha',
        sourceAuth: SOURCE_AUTH,
        workflowAuth: WORKFLOW_AUTH,
        jobConfig: { ...base.jobConfig, ...GLOBAL_FIELDS },
        ...extra,
      };
    }

    /** The two clones of the global layout: A with A's auth, B with B's. */
    function expectDualClone(): void {
      // fails-when: the evaluation job clones only the source repository into the work dir
      expect(gitClone).toHaveBeenCalledWith(
        expect.objectContaining({
          repoUrl: 'https://github.com/org/ci.git',
          ref: 'main',
          sha: 'workflow-sha',
          workDir: WORKFLOW_DIR,
          gitAuth: WORKFLOW_AUTH,
        }),
      );
      expect(gitClone).toHaveBeenCalledWith(
        expect.objectContaining({
          repoUrl: 'https://github.com/org/app.git',
          ref: 'feature',
          sha: 'source-sha',
          workDir: SOURCE_DIR,
          gitAuth: SOURCE_AUTH,
        }),
      );
      expect(gitClone).toHaveBeenCalledTimes(2);
    }

    function finalState(deps: ReturnType<typeof makeDeps>): string {
      const statuses = deps.messages.filter((m) => m.type === 'job.status');
      return (statuses[statuses.length - 1] as { state: string }).state;
    }

    it("init job with no source pack: loads A's workflow module, B checked out as the source", async () => {
      const { loadWorkflowSource } = await import('./workflow-loader.js');
      const { restoreDeps } = await import('./dep-restore.js');
      const { restoreSource } = await import('./source-restore.js');
      const { installDeps } = await import('./dep-installer.js');
      const deps = makeDeps();

      await new JobRunner(deps).execute(globalDispatch(makeInitDispatch(), DEPS));

      expectDualClone();
      // fails-when: the workflow module is loaded from a clone of the source repository
      expect(loadWorkflowSource).toHaveBeenCalledWith(
        WORKFLOW_DIR,
        '.kici/workflows/ci.ts',
        'abc123hash',
        ['asset.txt'],
      );
      // fails-when: the workflow repository's dependency tarball lands in the source tree
      expect(restoreDeps).toHaveBeenCalledWith(WORKFLOW_DIR, DEPS.depsUrl, DEPS.depsHash);
      expect(restoreDeps).toHaveBeenCalledTimes(1);
      expect(restoreSource).not.toHaveBeenCalled();
      expect(installDeps).not.toHaveBeenCalled();
      // fails-when: the global path drops the deps-check line Loki keys off
      expect(loggerMock.info).toHaveBeenCalledWith(
        'Init job: checking deps',
        expect.objectContaining({ kiciDir: `${WORKFLOW_DIR}/.kici`, hasPackageJson: true }),
      );
      expect(finalState(deps)).toBe('success');
    });

    it("init job with no dependency tarball installs into A's .kici", async () => {
      const { installDeps } = await import('./dep-installer.js');

      await new JobRunner(makeDeps()).execute(globalDispatch(makeInitDispatch()));

      expectDualClone();
      expect(installDeps).toHaveBeenCalledWith(`${WORKFLOW_DIR}/.kici`, expect.anything());
      expect(installDeps).toHaveBeenCalledTimes(1);
    });

    it("init job with A's source pack restores it and the deps over A's checkout", async () => {
      // breaks-if-wrong: a global init job carrying the workflow repository's pack keeps
      //   evaluating that pack
      const { loadWorkflowSource } = await import('./workflow-loader.js');
      const { restoreDeps } = await import('./dep-restore.js');
      const { restoreSource } = await import('./source-restore.js');
      const deps = makeDeps();

      await new JobRunner(deps).execute(globalDispatch(makeInitDispatch(), { ...DEPS, ...PACK }));

      expectDualClone();
      expect(restoreDeps).toHaveBeenCalledWith(WORKFLOW_DIR, DEPS.depsUrl, DEPS.depsHash);
      expect(restoreSource).toHaveBeenCalledWith(
        WORKFLOW_DIR,
        PACK.sourceTarUrl,
        PACK.sourceTarDigest,
      );
      expect(loadWorkflowSource).toHaveBeenCalledWith(
        WORKFLOW_DIR,
        '.kici/workflows/ci.ts',
        'abc123hash',
        ['asset.txt'],
      );
      expect(finalState(deps)).toBe('success');
    });

    it('init job of a same-repo workflow keeps its single checkout', async () => {
      // breaks-if-wrong: a per-repository init job still clones its own repository into
      //   the work dir and loads the workflow module from there
      const { loadWorkflowSource } = await import('./workflow-loader.js');
      const { restoreDeps } = await import('./dep-restore.js');

      await new JobRunner(makeDeps()).execute({ ...makeInitDispatch(), ...DEPS });

      expect(gitClone).toHaveBeenCalledTimes(1);
      expect(gitClone).toHaveBeenCalledWith(
        expect.objectContaining({ repoUrl: 'https://github.com/org/repo.git', workDir: WORK_DIR }),
      );
      expect(restoreDeps).toHaveBeenCalledWith(WORK_DIR, DEPS.depsUrl, DEPS.depsHash);
      expect(loadWorkflowSource).toHaveBeenCalledWith(
        WORK_DIR,
        '.kici/workflows/ci.ts',
        'abc123hash',
        ['asset.txt'],
      );
    });

    it("init job evaluates its dynamic fields with the global workflow's KICI_* environment", async () => {
      // fails-when: a dynamic env function of a global workflow reads KICI_SOURCE_REPO_PATH and
      //   gets nothing, while every step of the same job sees it
      const { evaluateDynamicFields } = await import('./init-runner.js');
      let seen: string | undefined;
      (evaluateDynamicFields as Mock).mockImplementationOnce(async () => {
        seen = process.env.KICI_SOURCE_REPO_PATH;
        return {};
      });
      delete process.env.KICI_SOURCE_REPO_PATH;

      await new JobRunner(makeDeps()).execute(globalDispatch(makeInitDispatch()));

      expect(seen).toBe(SOURCE_DIR);
      // The evaluation restores the environment it changed.
      expect(process.env.KICI_SOURCE_REPO_PATH).toBeUndefined();
    });

    it('init job with a filter hands it B as the source repo and A as the workflow repo', async () => {
      const { evaluateDynamicFields } = await import('./init-runner.js');

      await new JobRunner(makeDeps()).execute(
        globalDispatch(
          makeInitDispatch({ hasFilter: true, event: { changedFilesStatus: 'fetched' } }),
        ),
      );

      const filterInput = (evaluateDynamicFields as Mock).mock.calls.at(-1)![5];
      // fails-when: the filter of a global workflow sees the source repository under both names
      expect(filterInput.sourceRepo).toMatchObject({ identifier: 'org/app', path: SOURCE_DIR });
      expect(filterInput.workflowRepo).toMatchObject({ identifier: 'org/ci', path: WORKFLOW_DIR });
    });

    it("generator evaluation with no source pack: loads A's module and hands the generator the repo pair", async () => {
      const { loadWorkflowSource, extractDynamicJobFn } = await import('./workflow-loader.js');
      let context: { sourceRepo?: { path: string }; workflowRepo?: { path: string } } = {};
      (extractDynamicJobFn as Mock).mockReturnValueOnce(async (c: typeof context) => {
        context = c;
        return [];
      });
      const deps = makeDeps();

      await new JobRunner(deps).execute(globalDispatch(makeDynamicDispatch(), DEPS));

      expectDualClone();
      expect(loadWorkflowSource).toHaveBeenCalledWith(
        WORKFLOW_DIR,
        '.kici/workflows/ci.ts',
        'abc123hash',
        ['asset.txt'],
      );
      // fails-when: the generator's two evaluations disagree about the source repository —
      //   the sandbox re-evaluation hands it the pair, this one would not
      expect(context.sourceRepo?.path).toBe(SOURCE_DIR);
      expect(context.workflowRepo?.path).toBe(WORKFLOW_DIR);
      expect(finalState(deps)).toBe('success');
    });

    it('generator evaluation of a same-repo workflow gets no repo pair and one checkout', async () => {
      // breaks-if-wrong: a per-repository generator keeps its context shape
      const { extractDynamicJobFn } = await import('./workflow-loader.js');
      let context: Record<string, unknown> = {};
      (extractDynamicJobFn as Mock).mockReturnValueOnce(async (c: Record<string, unknown>) => {
        context = c;
        return [];
      });

      await new JobRunner(makeDeps()).execute(makeDynamicDispatch());

      expect(gitClone).toHaveBeenCalledTimes(1);
      expect(gitClone).toHaveBeenCalledWith(expect.objectContaining({ workDir: WORK_DIR }));
      expect('sourceRepo' in context).toBe(false);
    });

    it('global eval round clones both repositories with their own credentials', async () => {
      const { restoreDeps } = await import('./dep-restore.js');
      const deps = makeDeps();
      const round = makeDispatch({
        jobConfig: {
          globalEvalRound: true,
          candidates: [],
          event: { changedFilesStatus: 'fetched', changedFiles: [] },
          ...GLOBAL_FIELDS,
        } as unknown as JobDispatch['jobConfig'],
      });

      await new JobRunner(deps).execute(globalDispatch(round, DEPS));

      expectDualClone();
      expect(restoreDeps).toHaveBeenCalledWith(WORKFLOW_DIR, DEPS.depsUrl, DEPS.depsHash);
      expect(finalState(deps)).toBe('success');
    });
  });
});

describe('buildEvalNeedsContext', () => {
  it('returns undefined for an event-only generator (no snapshot)', () => {
    expect(buildEvalNeedsContext({ resultAware: false })).toBeUndefined();
    expect(buildEvalNeedsContext({ resultAware: true })).toBeUndefined();
  });

  it('populates ctx.needs.<job>.status from the frozen snapshot', () => {
    const needs = buildEvalNeedsContext({
      resultAware: true,
      declaredNeeds: ['probe'],
      upstreamSnapshot: {
        jobs: { probe: { findings: 3 } },
        groups: {},
        statuses: { probe: 'failed' },
      },
    });
    const entry = needs!.probe as { result: any; status: string };
    expect(entry.status).toBe('failed');
    expect(entry.result.findings).toBe(3);
  });

  it('defaults status to success when the snapshot omits it', () => {
    const needs = buildEvalNeedsContext({
      resultAware: true,
      declaredNeeds: ['build'],
      upstreamSnapshot: { jobs: { build: {} }, groups: {} },
    });
    expect((needs!.build as { status: string }).status).toBe('success');
  });
});

describe('resolveJobWorkDir', () => {
  it('in-place + file:// source → uses the decoded repo path, no-op cleanup', async () => {
    const { workDir, inPlace, cleanup } = await resolveJobWorkDir(
      true,
      'file:///home/op/devel/repo',
    );
    expect(inPlace).toBe(true);
    expect(workDir).toBe('/home/op/devel/repo');
    // Cleanup must be a no-op — never remove the operator's real tree.
    await expect(cleanup()).resolves.toBeUndefined();
  });

  it('in-place + non-file:// source → still mkdtemps (gate: only file://)', async () => {
    const { workDir, inPlace } = await resolveJobWorkDir(true, 'https://github.com/acme/repo.git');
    expect(inPlace).toBe(false);
    // The mocked mkdtemp value, NOT the operator tree.
    expect(workDir).toBe('/tmp/kici-test123');
  });

  it('in-place disabled → mkdtemps + removes even for a file:// source', async () => {
    const fsPromises = (await import('node:fs/promises')).default;
    (fsPromises.rm as unknown as Mock).mockClear();
    const { workDir, inPlace, cleanup } = await resolveJobWorkDir(
      false,
      'file:///home/op/devel/repo',
    );
    expect(inPlace).toBe(false);
    expect(workDir).toBe('/tmp/kici-test123');
    await cleanup();
    // Cleanup removes the throwaway workDir.
    expect(fsPromises.rm).toHaveBeenCalledWith(
      '/tmp/kici-test123',
      expect.objectContaining({ recursive: true, force: true }),
    );
  });
});

describe('global eval round: shell cwd matches the sandbox re-evaluation', () => {
  // The property is a cross-module invariant no unit test can observe without
  // driving a whole fork-runner, so assert it at the source level.
  //
  // The sandbox re-evaluation hands a generator the AMBIENT `$`
  // (`workflow-loader.ts` does a bare `const { $ } = await import('zx')`), whose
  // cwd is the forked runner's — `fork-runner.ts` spawns with
  // `cwd: effectiveWorkDir`, i.e. `options.workDir`, the PARENT of `workflow/`
  // and `source/`. If the round rooted its own shell at `workflowDir`, a
  // generator running a relative `$` command would see the workflow repo here
  // and an almost-empty parent directory on re-eval — two different worlds.
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  // The shells are built inside the eval child, which is where customer
  // evaluation code runs; `eval-dispatch.ts` is that code with the IPC shell
  // factored out.
  const evalDispatchSrc = read('./sandbox/eval-dispatch.ts');
  const loaderSrc = read('./workflow-loader.ts');
  const forkRunnerSrc = read('./sandbox/fork-runner.ts');

  it('finds all three call sites (positive control — guards against a vacuous pass)', () => {
    expect(evalDispatchSrc).toContain('await buildEvalShell(');
    expect(loaderSrc).toContain("const { $ } = await import('zx');");
    expect(forkRunnerSrc).toContain('cwd: effectiveWorkDir || undefined');
  });

  it('roots the round shell at workDir, not workflowDir', () => {
    expect(evalDispatchSrc).toContain('await buildEvalShell(request.workDir, deps.emit)');
    expect(evalDispatchSrc).not.toContain('buildEvalShell(workflowDir');
  });

  it('the sandbox side derives its cwd from options.workDir', () => {
    expect(forkRunnerSrc).toContain("const effectiveWorkDir = options.workDir ?? '/workspace'");
  });
});

describe('handleDynamicJobFn eval shell: live env, matching the round', () => {
  // The non-global DynamicJobFn path builds its eval shell through
  // buildEvalShell, which resolves the LIVE process.env — never an
  // `env: { ...process.env }` spread, which would snapshot env before the
  // workflow module loads and hide any var a module sets at import time from a
  // subprocess the DynamicJobFn shells out to. This matches the global eval
  // round. The env-live behavior itself is covered by the buildEvalShell
  // behavioral test above; this asserts the call site is wired through it.
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const evalDispatchSrc = read('./sandbox/eval-dispatch.ts');

  it('builds the DynamicJobFn shell through buildEvalShell(request.workDir, ...)', () => {
    expect(evalDispatchSrc).toContain(
      'const scopedDollar = await buildEvalShell(request.workDir, deps.emit)',
    );
  });

  it('does not snapshot env with a { ...process.env } spread', () => {
    expect(evalDispatchSrc).not.toContain('{ ...process.env }');
  });
});

describe('buildEvalShell', () => {
  const PROBE = 'KICI_BUILD_EVAL_SHELL_PROBE';
  afterEach(() => {
    delete process.env[PROBE];
  });

  it('resolves env LIVE, so a key set after the shell is built reaches a subprocess', async () => {
    // The round applies the seven KICI_* keys INSIDE runGlobalEvalRound, after
    // the shell is built. A `{ ...process.env }` spread snapshots at build time,
    // so a filter that shells out would see nothing here while the sandbox
    // re-evaluation's ambient `$` — which resolves process.env at spawn — does.
    // Same two-worlds determinism failure as the cwd, one layer down.
    delete process.env[PROBE];
    const shell = await buildEvalShell(process.cwd(), () => {});

    // Positive control: the key is genuinely absent at build time, so a passing
    // assertion below cannot be explained by it having been set all along.
    const beforeSet = (await shell`printenv ${PROBE} || true`).stdout.trim();
    expect(beforeSet).toBe('');

    process.env[PROBE] = 'set-after-build';
    const afterSet = (await shell`printenv ${PROBE} || true`).stdout.trim();
    expect(afterSet).toBe('set-after-build');
  });

  it('roots the shell at the cwd it is given', async () => {
    const shell = await buildEvalShell('/tmp', () => {});
    expect((await shell`pwd`).stdout.trim()).toBe('/tmp');
  });

  it('routes subprocess output through the caller-supplied sink, not the streamer', async () => {
    const seen: string[] = [];
    const shell = await buildEvalShell(process.cwd(), (line) => seen.push(line));

    await shell`echo hello-from-subprocess`;

    // Positive control on the sink itself: it fired at all, so the closed-guard
    // test below is asserting suppression rather than a sink that never emits.
    expect(seen.join('\n')).toContain('hello-from-subprocess');
  });

  it('emits nothing once the caller-supplied sink is closed', async () => {
    // The guard the handler installs: LogStreamer.destroy() sets no closed flag
    // and addLine buffers unconditionally, so without this a late subprocess
    // line emits a log.chunk for a step already reported terminal.
    const seen: string[] = [];
    let closed = false;
    const shell = await buildEvalShell(process.cwd(), (line) => {
      if (!closed) seen.push(line);
    });

    await shell`echo before-close`;
    expect(seen.join('\n')).toContain('before-close');

    closed = true;
    await shell`echo after-close`;
    expect(seen.join('\n')).not.toContain('after-close');
  });
});

describe('JobRunner global eval round — malformed dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logStreamerInstances.length = 0;
    resetSandboxMocks();
  });

  it('missing candidates: resolves and reports a failed verdict naming candidates', async () => {
    const deps = makeDeps();
    const runner = new JobRunner(deps);

    // A global-eval-round dispatch with `candidates` omitted. The opening log
    // line reads `config.candidates.length` before the handler's `try`, so the
    // defect it guards against is a throw that rejects execute() with no verdict.
    const dispatch = makeDispatch({
      jobConfig: {
        globalEvalRound: true,
        workflowRepoIdentifier: 'org/repo',
      } as unknown as JobDispatch['jobConfig'],
    });

    // Must RESOLVE (not reject) — the malformed dispatch is turned into a
    // reported job failure, not an unhandled rejection.
    await expect(runner.execute(dispatch)).resolves.toBeUndefined();

    const jobStatuses = deps.messages.filter((m) => m.type === 'job.status');
    const failed = jobStatuses.find((m) => (m as { state: string }).state === 'failed') as
      { state: string; data?: { error?: string } } | undefined;
    expect(failed).toBeDefined();
    expect(failed?.data?.error).toMatch(/candidates/);
  });
});
