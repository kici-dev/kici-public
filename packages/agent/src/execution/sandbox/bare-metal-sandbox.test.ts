import '../../__test-helpers__/shared-mocks.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { JobDispatch } from '@kici-dev/engine';

// BareMetalSandbox.setup() reaches `execSync` through a dynamic
// `import('node:child_process')` to check `bwrap` is on PATH when sandbox=true.
// `vi.hoisted` because `vi.mock` factories hoist above top-level declarations.
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

import { BareMetalSandbox } from './bare-metal-sandbox.js';
import { fork, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import type { RunnerToAgentMessage } from './ipc-protocol.js';

function createFakeChild(): ChildProcess & EventEmitter {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  child.send = vi.fn().mockReturnValue(true);
  child.kill = vi.fn().mockReturnValue(true);
  child.killed = false;
  child.pid = 12345;
  child.stderr = new EventEmitter() as ChildProcess['stderr'];
  return child;
}

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
      // macOS and Windows, where bwrap does not exist, fail here. The error names
      // `bwrap` and the fix: install it or disable KICI_SANDBOX.
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

  describe('executeJob: the git credential directory under bwrap', () => {
    const HELPER = '/tmp/kici-gitcred-job-1/git-credential-kici.cjs';
    const bindOf = (args: string[]): number =>
      args.findIndex((a, i) => a === '--ro-bind' && args[i + 1] === '/tmp/kici-gitcred-job-1');

    async function spawnArgs(useBwrap: boolean): Promise<string[] | undefined> {
      vi.mocked(existsSync).mockImplementation((p) => p === '/tmp/kici-gitcred-job-1');
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/bwrap\n'));
      const fakeChild = createFakeChild();
      vi.mocked(spawn).mockReturnValue(fakeChild);
      mockFork.mockReturnValue(fakeChild);
      const sandbox = new BareMetalSandbox({
        runnerPath: '/opt/kici/runner.js',
        sandbox: useBwrap,
        env: {},
      });
      await sandbox.setup({ workDir: '/workspace', env: {} });
      const execPromise = sandbox.executeJob({
        dispatch: createTestDispatch(),
        credentialHelperPath: HELPER,
        onStepStatus: vi.fn(),
        onLogLine: vi.fn(),
        onEventEmit: vi.fn(),
        onConcurrencyReport: vi.fn(),
        signal: new AbortController().signal,
      });
      const args = useBwrap ? (vi.mocked(spawn).mock.calls[0]![1] as string[]) : undefined;
      fakeChild.emit('message', {
        type: 'job.complete',
        status: 'success',
        stepResults: [],
      } satisfies RunnerToAgentMessage);
      await execPromise;
      vi.mocked(existsSync).mockReset().mockReturnValue(false);
      return args;
    }

    // fails-when: the directory is not bound — bwrap's private /tmp then hides
    // the helper, its socket and any SSH key from the runner's git.
    it('binds the directory read-only, after the private /tmp', async () => {
      const args = (await spawnArgs(true))!;
      const bind = bindOf(args);
      expect(bind).toBeGreaterThan(-1);
      // A bind placed before the tmpfs would be hidden by it.
      expect(bind).toBeGreaterThan(args.indexOf('/tmp'));
      expect(args[args.indexOf('/tmp') - 1]).toBe('--tmpfs');
    });

    it('spawns no bwrap without the sandbox', async () => {
      expect(await spawnArgs(false)).toBeUndefined();
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    });
  });

  describe('executeJob', () => {
    it('passes sanitized env to child process (KICI_* excluded)', async () => {
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

      expect(mockFork).toHaveBeenCalledTimes(1);
      const forkCall = mockFork.mock.calls[0]!;
      const envPassed = forkCall[2]?.env as Record<string, string>;

      expect(envPassed).toHaveProperty('PATH');
      expect(envPassed).toHaveProperty('HOME');

      expect(envPassed).not.toHaveProperty('KICI_ORCHESTRATOR_URL');
      expect(envPassed).not.toHaveProperty('KICI_AGENT_ID');
      expect(envPassed).not.toHaveProperty('DATABASE_URL');

      fakeChild.emit('message', {
        type: 'job.complete',
        status: 'success',
        stepResults: [],
      } satisfies RunnerToAgentMessage);

      await execPromise;

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

      fakeChild.emit('message', { type: 'ready' } satisfies RunnerToAgentMessage);

      fakeChild.emit('message', {
        type: 'step.start',
        stepIndex: 0,
        stepName: 'Install deps',
      } satisfies RunnerToAgentMessage);

      expect(onStepStatus).toHaveBeenCalledWith(0, 'Install deps', 'running');

      fakeChild.emit('message', {
        type: 'log.line',
        stepIndex: 0,
        line: 'npm install done',
      } satisfies RunnerToAgentMessage);

      expect(onLogLine).toHaveBeenCalledWith(0, 'npm install done', undefined);

      fakeChild.emit('message', {
        type: 'step.complete',
        stepIndex: 0,
        status: 'success',
        durationMs: 5000,
      } satisfies RunnerToAgentMessage);

      expect(onStepStatus).toHaveBeenCalledWith(0, 'Install deps', 'success', {
        durationMs: 5000,
      });

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

      fakeChild.emit('message', { type: 'ready' } satisfies RunnerToAgentMessage);

      expect(fakeChild.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'execute' }));

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

      expect(fakeChild.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'abort', force: false }),
      );

      // SIGTERM sent immediately (graceful cancel behavior)
      expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');

      // Advance past grace period (30s default) to trigger SIGKILL
      vi.advanceTimersByTime(30_100);
      expect(fakeChild.kill).toHaveBeenCalledWith('SIGKILL');

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
