import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { JobDispatch, AgentToOrchestratorMessage } from '@kici-dev/engine';
import type { AppConfig } from '../config.js';
import { JobRunner, type JobRunnerDeps, buildEvalNeedsContext } from './job-runner.js';
import type { JobExecutionResult } from './sandbox/types.js';

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

// Mock @kici-dev/shared (createLogger + getRequestContext + createMeter)
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
  };
});

// Mock fs for mkdtemp and rm
vi.mock('node:fs/promises', () => ({
  default: {
    mkdtemp: vi.fn().mockResolvedValue('/tmp/kici-test123'),
    rm: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockResolvedValue(undefined),
  },
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
}));

// Mock git clone (used by build jobs)
vi.mock('../checkout/git-clone.js', () => ({
  gitClone: vi.fn().mockResolvedValue(undefined),
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

// Mock init-runner (used by handleInitJob to evaluate dynamic fields).
vi.mock('./init-runner.js', () => ({
  evaluateDynamicFields: vi.fn().mockResolvedValue({}),
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

// Mock log streamer -- track instances for verifying destroy() calls
const logStreamerInstances: Array<{
  addLine: Mock;
  flush: Mock;
  destroy: Mock;
  getTotalBytes: Mock;
}> = [];
vi.mock('./log-streamer.js', () => ({
  LogStreamer: vi.fn(function () {
    const instance = {
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

// Mock dep-restore (used by init jobs)
vi.mock('./dep-restore.js', () => ({
  restoreDeps: vi.fn().mockResolvedValue(undefined),
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
  directMessages: AgentToOrchestratorMessage[];
} {
  const messages: AgentToOrchestratorMessage[] = [];
  const directMessages: AgentToOrchestratorMessage[] = [];
  return {
    send: (msg) => messages.push(msg),
    sendDirect: (msg) => directMessages.push(msg),
    config: makeConfig(),
    requestUploadUrl: vi.fn().mockResolvedValue('https://s3.example.com/upload?presigned=1'),
    sendUploadComplete: vi.fn(),
    sendEventEmit: vi.fn().mockResolvedValue({ requestId: 'r1' }),
    sendJobContext: vi.fn(),
    sendRunEvent: vi.fn(),
    sendConcurrencyReport: vi.fn().mockResolvedValue({ action: 'proceed' }),
    messages,
    directMessages,
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
    const jobStatuses = deps.directMessages.filter((m) => m.type === 'job.status');
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
    const jobStatuses = deps.directMessages.filter((m) => m.type === 'job.status');
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
    const jobStatuses = deps.directMessages.filter((m) => m.type === 'job.status');
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

    const jobStatuses = deps.directMessages.filter((m) => m.type === 'job.status');
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

    const jobStatuses = deps.directMessages.filter((m) => m.type === 'job.status');
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

    const stepStatuses = deps.directMessages.filter((m) => m.type === 'step.status');
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

    const stepStatuses = deps.directMessages.filter((m) => m.type === 'step.status') as Array<{
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

    const jobStatuses = deps.directMessages.filter((m) => m.type === 'job.status');
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
      // runner is captured via closure below -- use deps.directMessages as proxy
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
    const jobStatuses = deps.directMessages.filter((m) => m.type === 'job.status');
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

  function makeInitDispatch(overrides: Record<string, unknown> = {}): JobDispatch {
    return makeDispatch({
      jobConfig: {
        initOnly: true,
        targetJobName: 'deploy',
        workflowName: 'test-workflow',
        source: '.kici/workflows/ci.ts',
        dynamicEnvironment: false,
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
    const jobStatuses = deps.directMessages.filter((m) => m.type === 'job.status');
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

    const jobStatuses = deps.directMessages.filter((m) => m.type === 'job.status');
    const states = jobStatuses.map((m) => (m as { state: string }).state);
    expect(states[states.length - 1]).toBe('success');
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

    const jobStatuses = deps.directMessages.filter((m) => m.type === 'job.status') as Array<{
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

    const jobStatuses = deps.directMessages.filter((m) => m.type === 'job.status') as Array<{
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

    const jobStatuses = deps.directMessages.filter((m) => m.type === 'job.status') as Array<{
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

    const jobStatuses = deps.directMessages.filter((m) => m.type === 'job.status') as Array<{
      state: string;
      data?: Record<string, unknown>;
    }>;
    const finalStatus = jobStatuses[jobStatuses.length - 1]!;
    expect(finalStatus.state).toBe('failed');
    expect(finalStatus.data?.dynamicFailed).toBe(true);
    expect(finalStatus.data?.initFailure).toBeUndefined();
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
