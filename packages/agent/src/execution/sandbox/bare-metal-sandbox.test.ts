import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { JobDispatch } from '@kici-dev/engine';

// Mock child_process before imports. `execSync` is looked up via dynamic
// `import('node:child_process')` inside BareMetalSandbox.setup() to verify
// that `bwrap` is on PATH when sandbox=true. `vi.hoisted` is required because
// `vi.mock` factories are hoisted above top-level variable declarations.
const { mockExecSync } = vi.hoisted(() => ({ mockExecSync: vi.fn() }));
vi.mock('node:child_process', () => ({
  fork: vi.fn(),
  spawn: vi.fn(),
  execSync: mockExecSync,
}));

// Mock node:fs/promises for access() checks
vi.mock('node:fs/promises', () => ({
  access: vi.fn().mockResolvedValue(undefined),
}));

// Mock node:fs for existsSync (used in buildBwrapArgs)
vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

// Mock @kici-dev/shared createLogger
vi.mock('@kici-dev/shared', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),

  toErrorMessage: (err) => (err instanceof Error ? err.message : String(err)),
}));

import { BareMetalSandbox } from './bare-metal-sandbox.js';
import { fork } from 'node:child_process';
import { access } from 'node:fs/promises';
import type { RunnerToAgentMessage } from './ipc-protocol.js';

/** Create a minimal fake ChildProcess that supports IPC events. */
function createFakeChild(): ChildProcess & EventEmitter {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  child.send = vi.fn().mockReturnValue(true);
  child.kill = vi.fn().mockReturnValue(true);
  child.killed = false;
  child.pid = 12345;
  child.stderr = new EventEmitter() as ChildProcess['stderr'];
  return child;
}

/** Create a minimal JobDispatch for testing. */
function createTestDispatch(): JobDispatch {
  return {
    runId: 'run-1',
    jobId: 'job-1',
    repoUrl: 'https://github.com/test/repo.git',
    ref: 'refs/heads/main',
    sha: 'abc123',
    provider: 'github',
    providerContext: { installationId: 1 },
    runsOn: 'linux',
    jobConfig: {
      workflowName: 'ci',
      name: 'build',
      runsOn: 'linux',
      source: { file: '.kici/workflows/ci.ts' },
    },
  } as unknown as JobDispatch;
}

describe('BareMetalSandbox', () => {
  const mockFork = vi.mocked(fork);
  const mockAccess = vi.mocked(access);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('setup', () => {
    it('validates runner path exists', async () => {
      mockAccess.mockResolvedValue(undefined);

      const sandbox = new BareMetalSandbox({
        runnerPath: '/opt/kici/workflow-runner.js',
        sandbox: false,
        env: {},
      });

      await sandbox.setup({ workDir: '/workspace', env: {} });

      expect(mockAccess).toHaveBeenCalledWith('/opt/kici/workflow-runner.js');
    });

    it('throws when runner path does not exist', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const sandbox = new BareMetalSandbox({
        runnerPath: '/nonexistent/runner.js',
        sandbox: false,
        env: {},
      });

      await expect(sandbox.setup({ workDir: '/workspace', env: {} })).rejects.toThrow(
        'Workflow runner not found at: /nonexistent/runner.js',
      );
    });

    it('does not probe for bwrap when sandbox=false', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockExecSync.mockClear();

      const sandbox = new BareMetalSandbox({
        runnerPath: '/opt/kici/runner.js',
        sandbox: false,
        env: {},
      });

      await sandbox.setup({ workDir: '/workspace', env: {} });

      // bwrap discovery must be skipped entirely in the default path.
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('probes for bwrap via `which bwrap` when sandbox=true', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockExecSync.mockClear();
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/bwrap\n'));

      const sandbox = new BareMetalSandbox({
        runnerPath: '/opt/kici/runner.js',
        sandbox: true,
        env: {},
      });

      await sandbox.setup({ workDir: '/workspace', env: {} });

      expect(mockExecSync).toHaveBeenCalledTimes(1);
      expect(mockExecSync).toHaveBeenCalledWith('which bwrap', expect.any(Object));
    });

    it('throws a clear error when sandbox=true but bwrap is not installed', async () => {
      // This path is how macOS and Windows users (where bwrap does not exist)
      // will see the feature gate fail. The error must name `bwrap` and the
      // fix so operators know to install it or disable KICI_SANDBOX.
      mockAccess.mockResolvedValue(undefined);
      mockExecSync.mockClear();
      mockExecSync.mockImplementation(() => {
        throw new Error('Command failed: which bwrap');
      });

      const sandbox = new BareMetalSandbox({
        runnerPath: '/opt/kici/runner.js',
        sandbox: true,
        env: {},
      });

      await expect(sandbox.setup({ workDir: '/workspace', env: {} })).rejects.toThrow(
        /Bubblewrap \(bwrap\) not found\. Install bubblewrap or set sandbox=false/,
      );
    });
  });

  describe('executeJob', () => {
    it('passes sanitized env to child process (KICI_* excluded)', async () => {
      // Set agent-internal vars in process.env
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        PATH: '/usr/bin',
        HOME: '/home/agent',
        KICI_ORCHESTRATOR_URL: 'ws://orch:8080',
        KICI_AGENT_ID: 'agent-1',
        DATABASE_URL: 'postgres://localhost/kici',
      };

      const fakeChild = createFakeChild();
      mockFork.mockReturnValue(fakeChild);

      const sandbox = new BareMetalSandbox({
        runnerPath: '/opt/kici/runner.js',
        sandbox: false,
        env: {}, // base env (pre-sanitized user vars go here)
      });

      const controller = new AbortController();
      const execPromise = sandbox.executeJob({
        dispatch: createTestDispatch(),
        onStepStatus: vi.fn(),
        onLogLine: vi.fn(),
        onEventEmit: vi.fn(),
        onConcurrencyReport: vi.fn(),
        signal: controller.signal,
      });

      // Verify fork was called
      expect(mockFork).toHaveBeenCalledTimes(1);
      const forkCall = mockFork.mock.calls[0]!;
      const envPassed = forkCall[2]?.env as Record<string, string>;

      // Sanitized env should include PATH and HOME (allowlisted)
      expect(envPassed).toHaveProperty('PATH');
      expect(envPassed).toHaveProperty('HOME');

      // Agent-internal vars must NOT be passed
      expect(envPassed).not.toHaveProperty('KICI_ORCHESTRATOR_URL');
      expect(envPassed).not.toHaveProperty('KICI_AGENT_ID');
      expect(envPassed).not.toHaveProperty('DATABASE_URL');

      // Clean up: complete the job
      fakeChild.emit('message', {
        type: 'job.complete',
        status: 'success',
        stepResults: [],
      } satisfies RunnerToAgentMessage);

      await execPromise;

      // Restore original env
      process.env = originalEnv;
    });

    it('dispatches IPC messages to callbacks', async () => {
      const fakeChild = createFakeChild();
      mockFork.mockReturnValue(fakeChild);

      const sandbox = new BareMetalSandbox({
        runnerPath: '/opt/kici/runner.js',
        sandbox: false,
        env: {},
      });

      const onStepStatus = vi.fn();
      const onLogLine = vi.fn();
      const controller = new AbortController();

      const execPromise = sandbox.executeJob({
        dispatch: createTestDispatch(),
        onStepStatus,
        onLogLine,
        onEventEmit: vi.fn(),
        onConcurrencyReport: vi.fn(),
        signal: controller.signal,
      });

      // Simulate IPC messages from the runner
      fakeChild.emit('message', { type: 'ready' } satisfies RunnerToAgentMessage);

      // step.start
      fakeChild.emit('message', {
        type: 'step.start',
        stepIndex: 0,
        stepName: 'Install deps',
      } satisfies RunnerToAgentMessage);

      expect(onStepStatus).toHaveBeenCalledWith(0, 'Install deps', 'running');

      // log.line
      fakeChild.emit('message', {
        type: 'log.line',
        stepIndex: 0,
        line: 'npm install done',
      } satisfies RunnerToAgentMessage);

      expect(onLogLine).toHaveBeenCalledWith(0, 'npm install done');

      // step.complete
      fakeChild.emit('message', {
        type: 'step.complete',
        stepIndex: 0,
        status: 'success',
        durationMs: 5000,
      } satisfies RunnerToAgentMessage);

      expect(onStepStatus).toHaveBeenCalledWith(0, 'Install deps', 'success', {
        durationMs: 5000,
      });

      // job.complete
      fakeChild.emit('message', {
        type: 'job.complete',
        status: 'success',
        stepResults: [{ name: 'Install deps', stepIndex: 0, status: 'success', durationMs: 5000 }],
      } satisfies RunnerToAgentMessage);

      const result = await execPromise;
      expect(result.status).toBe('success');
      expect(result.stepResults).toHaveLength(1);
      expect(result.stepResults[0]!.name).toBe('Install deps');
    });

    it('sends execute message after ready', async () => {
      const fakeChild = createFakeChild();
      mockFork.mockReturnValue(fakeChild);

      const sandbox = new BareMetalSandbox({
        runnerPath: '/opt/kici/runner.js',
        sandbox: false,
        env: {},
      });

      const controller = new AbortController();
      const execPromise = sandbox.executeJob({
        dispatch: createTestDispatch(),
        onStepStatus: vi.fn(),
        onLogLine: vi.fn(),
        onEventEmit: vi.fn(),
        onConcurrencyReport: vi.fn(),
        signal: controller.signal,
      });

      // Simulate runner sending ready
      fakeChild.emit('message', { type: 'ready' } satisfies RunnerToAgentMessage);

      // Verify execute message was sent back
      expect(fakeChild.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'execute' }));

      // Complete the job
      fakeChild.emit('message', {
        type: 'job.complete',
        status: 'success',
        stepResults: [],
      } satisfies RunnerToAgentMessage);

      await execPromise;
    });

    it('handles child process crash (exit without job.complete)', async () => {
      const fakeChild = createFakeChild();
      mockFork.mockReturnValue(fakeChild);

      const sandbox = new BareMetalSandbox({
        runnerPath: '/opt/kici/runner.js',
        sandbox: false,
        env: {},
      });

      const onLogLine = vi.fn();
      const controller = new AbortController();
      const execPromise = sandbox.executeJob({
        dispatch: createTestDispatch(),
        onStepStatus: vi.fn(),
        onLogLine,
        onEventEmit: vi.fn(),
        onConcurrencyReport: vi.fn(),
        signal: controller.signal,
      });

      // Simulate crash (exit without job.complete)
      fakeChild.emit('exit', 1, null);

      const result = await execPromise;
      expect(result.status).toBe('failed');
      expect(result.stepResults).toEqual([]);

      // Should log a crash message
      expect(onLogLine).toHaveBeenCalledWith(-1, expect.stringContaining('[sandbox]'));
    });
  });

  describe('abort', () => {
    it('sends abort IPC message and SIGTERM immediately on graceful cancel', async () => {
      const fakeChild = createFakeChild();
      mockFork.mockReturnValue(fakeChild);

      const sandbox = new BareMetalSandbox({
        runnerPath: '/opt/kici/runner.js',
        sandbox: false,
        env: {},
      });

      const controller = new AbortController();
      const execPromise = sandbox.executeJob({
        dispatch: createTestDispatch(),
        onStepStatus: vi.fn(),
        onLogLine: vi.fn(),
        onEventEmit: vi.fn(),
        onConcurrencyReport: vi.fn(),
        signal: controller.signal,
      });

      // Trigger abort via AbortController (delegates to graceful cancel)
      controller.abort();

      // Abort IPC message should be sent with force: false
      expect(fakeChild.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'abort', force: false }),
      );

      // SIGTERM sent immediately (graceful cancel behavior)
      expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');

      // Advance past grace period (30s default) to trigger SIGKILL
      vi.advanceTimersByTime(30_100);
      expect(fakeChild.kill).toHaveBeenCalledWith('SIGKILL');

      // Complete via exit
      fakeChild.emit('exit', null, 'SIGKILL');

      const result = await execPromise;
      expect(result.status).toBe('cancelled');
    });
  });

  describe('teardown', () => {
    it('kills child process if still running', async () => {
      const fakeChild = createFakeChild();
      mockFork.mockReturnValue(fakeChild);

      const sandbox = new BareMetalSandbox({
        runnerPath: '/opt/kici/runner.js',
        sandbox: false,
        env: {},
      });

      const controller = new AbortController();
      sandbox.executeJob({
        dispatch: createTestDispatch(),
        onStepStatus: vi.fn(),
        onLogLine: vi.fn(),
        onEventEmit: vi.fn(),
        onConcurrencyReport: vi.fn(),
        signal: controller.signal,
      });

      await sandbox.teardown();

      expect(fakeChild.kill).toHaveBeenCalledWith('SIGKILL');
    });
  });
});
