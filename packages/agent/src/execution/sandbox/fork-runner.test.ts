import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { JobDispatch } from '@kici-dev/engine';
import type { JobExecutionOptions } from './types.js';
import type { RunnerToAgentMessage, AgentToRunnerMessage } from './ipc-protocol.js';

// We test createForkRunner via a controlled mock of child_process.fork
// The fork-runner uses fork/spawn internally, so we mock at the module level.

/**
 * Create a mock ChildProcess that supports IPC message passing.
 */
function createMockChild(): ChildProcess &
  EventEmitter & {
    sentMessages: AgentToRunnerMessage[];
    simulateIpc: (msg: RunnerToAgentMessage) => void;
    simulateExit: (code: number | null, signal: string | null) => void;
  } {
  const emitter = new EventEmitter();
  const sentMessages: AgentToRunnerMessage[] = [];

  const child = Object.assign(emitter, {
    pid: 12345,
    killed: false,
    connected: true,
    exitCode: null as number | null,
    signalCode: null as string | null,
    spawnargs: [],
    spawnfile: '',
    stdin: null as unknown as Writable,
    stdout: new EventEmitter() as unknown as Readable,
    stderr: new EventEmitter() as unknown as Readable,
    stdio: [null, null, null, null] as any,
    channel: {} as any,
    sentMessages,
    send: vi.fn((msg: AgentToRunnerMessage, _?: any, cb?: (err: Error | null) => void) => {
      sentMessages.push(msg);
      if (typeof cb === 'function') cb(null);
      return true;
    }),
    kill: vi.fn((_signal?: string) => {
      (child as any).killed = true;
      return true;
    }),
    disconnect: vi.fn(),
    unref: vi.fn(),
    ref: vi.fn(),
    [Symbol.dispose]: vi.fn(),
    simulateIpc: (msg: RunnerToAgentMessage) => {
      emitter.emit('message', msg);
    },
    simulateExit: (code: number | null, signal: string | null) => {
      (child as any).exitCode = code;
      (child as any).signalCode = signal;
      emitter.emit('exit', code, signal);
    },
  }) as any;

  return child;
}

/**
 * Create minimal mock JobExecutionOptions.
 */
function createMockExecOptions(overrides: Partial<JobExecutionOptions> = {}): JobExecutionOptions {
  const abortController = new AbortController();
  return {
    dispatch: {
      runId: 'run-1',
      jobId: 'job-1',
      repoUrl: 'https://github.com/test/repo',
      ref: 'refs/heads/main',
      sha: 'abc123',
      jobConfig: {
        name: 'test-job',
        workflowName: 'ci',
        runsOn: 'linux',
      },
    } as unknown as JobDispatch,
    onStepStatus: vi.fn(),
    onLogLine: vi.fn(),
    signal: abortController.signal,
    ...overrides,
  };
}

// --- State machine tests ---

describe('fork-runner cancel state machine', () => {
  let mockChild: ReturnType<typeof createMockChild>;
  let mockFork: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockChild = createMockChild();
    // Mock child_process.fork to return our mock
    mockFork = vi.fn().mockReturnValue(mockChild);
    vi.doMock('node:child_process', () => ({
      fork: mockFork,
      spawn: mockFork,
    }));
    vi.doMock('node:fs', () => ({
      existsSync: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('./env-sanitizer.js', () => ({
      buildSanitizedEnv: vi.fn().mockReturnValue({}),
    }));
    vi.doMock('./secret-encryption.js', () => ({
      encryptSecretOutputs: vi.fn().mockReturnValue(undefined),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function importForkRunner() {
    return await import('./fork-runner.js');
  }

  it('pins TMPDIR=/tmp for the bwrap-sandboxed child (tmpfs /tmp would orphan a host TMPDIR)', async () => {
    const mod = await importForkRunner();
    const execOpts = createMockExecOptions();
    mod.createForkRunner({ runnerPath: '/test/runner.js', env: {}, useBwrap: true }, execOpts);

    // bwrap path spawns via the mocked spawn (same vi.fn as fork).
    expect(mockFork).toHaveBeenCalled();
    const spawnOpts = mockFork.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOpts.env.TMPDIR).toBe('/tmp');
  });

  it('does NOT force TMPDIR when not using bwrap (host /tmp is inherited as-is)', async () => {
    const mod = await importForkRunner();
    const execOpts = createMockExecOptions();
    mod.createForkRunner({ runnerPath: '/test/runner.js', env: {} }, execOpts);

    expect(mockFork).toHaveBeenCalled();
    const forkOpts = mockFork.mock.calls[0][2] as { env: Record<string, string> };
    expect(forkOpts.env.TMPDIR).toBeUndefined();
  });

  it('starts in running state and transitions to cancelling on graceful cancel', async () => {
    const mod = await importForkRunner();
    const execOpts = createMockExecOptions();
    const handle = mod.createForkRunner({ runnerPath: '/test/runner.js', env: {} }, execOpts);

    // Simulate ready + execute flow
    mockChild.simulateIpc({ type: 'ready' });

    // Cancel gracefully
    handle.cancel(false);

    // Should have sent IPC abort with force: false
    const abortMsg = mockChild.sentMessages.find((m) => m.type === 'abort') as any;
    expect(abortMsg).toBeDefined();
    expect(abortMsg.force).toBe(false);

    // Should have sent SIGTERM
    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');

    // Clean up - simulate job.complete from workflow-runner
    mockChild.simulateIpc({
      type: 'job.complete',
      status: 'failed',
      stepResults: [],
    });
    await handle.result;
  });

  it('transitions to force_killing on second cancel (force=true while cancelling)', async () => {
    const mod = await importForkRunner();
    const execOpts = createMockExecOptions();
    const handle = mod.createForkRunner({ runnerPath: '/test/runner.js', env: {} }, execOpts);

    mockChild.simulateIpc({ type: 'ready' });

    // First cancel (graceful)
    handle.cancel(false);
    mockChild.kill.mockClear();
    mockChild.sentMessages.length = 0;

    // Second cancel (force) while in cancelling state
    handle.cancel(true);

    // Should have sent IPC abort with force: true
    const forceAbortMsg = mockChild.sentMessages.find((m) => m.type === 'abort') as any;
    expect(forceAbortMsg).toBeDefined();
    expect(forceAbortMsg.force).toBe(true);

    // Should have sent SIGKILL
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');

    // Force cancel resolves immediately (doesn't wait for IPC)
    mockChild.simulateExit(null, 'SIGKILL');
    const result = await handle.result;
    expect(result.status).toBe('cancelled');
  });

  it('transitions directly to force_killing when cancel(force=true) called from running', async () => {
    const mod = await importForkRunner();
    const execOpts = createMockExecOptions();
    const handle = mod.createForkRunner({ runnerPath: '/test/runner.js', env: {} }, execOpts);

    mockChild.simulateIpc({ type: 'ready' });

    // Force cancel directly from running state
    handle.cancel(true);

    // Should send force abort IPC
    const abortMsg = mockChild.sentMessages.find((m) => m.type === 'abort') as any;
    expect(abortMsg).toBeDefined();
    expect(abortMsg.force).toBe(true);

    // Should SIGKILL immediately
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');

    // Force cancel resolves immediately
    mockChild.simulateExit(null, 'SIGKILL');
    const result = await handle.result;
    expect(result.status).toBe('cancelled');
  });

  it('graceful cancel sends IPC abort with force:false and SIGTERM to process', async () => {
    const mod = await importForkRunner();
    const execOpts = createMockExecOptions();
    const handle = mod.createForkRunner({ runnerPath: '/test/runner.js', env: {} }, execOpts);

    mockChild.simulateIpc({ type: 'ready' });

    handle.cancel(false);

    // Verify IPC message
    const abortMsg = mockChild.sentMessages.find((m) => m.type === 'abort') as any;
    expect(abortMsg).toEqual({ type: 'abort', force: false });

    // Verify signal
    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');

    // Clean up
    mockChild.simulateIpc({ type: 'job.complete', status: 'failed', stepResults: [] });
    await handle.result;
  });

  it('force cancel sends IPC abort with force:true and SIGKILL', async () => {
    const mod = await importForkRunner();
    const execOpts = createMockExecOptions();
    const handle = mod.createForkRunner({ runnerPath: '/test/runner.js', env: {} }, execOpts);

    mockChild.simulateIpc({ type: 'ready' });
    handle.cancel(true);

    const abortMsg = mockChild.sentMessages.find((m) => m.type === 'abort') as any;
    expect(abortMsg).toEqual({ type: 'abort', force: true });
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');

    mockChild.simulateExit(null, 'SIGKILL');
    const result = await handle.result;
    expect(result.status).toBe('cancelled');
  });

  it('grace period timer escalates to SIGKILL if still cancelling after timeout', async () => {
    vi.useFakeTimers();

    const mod = await importForkRunner();
    const execOpts = createMockExecOptions();
    const handle = mod.createForkRunner({ runnerPath: '/test/runner.js', env: {} }, execOpts);

    mockChild.simulateIpc({ type: 'ready' });

    // Graceful cancel with 5s grace period
    handle.cancel(false, 5000);

    // Should have sent SIGTERM
    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
    mockChild.kill.mockClear();

    // Advance past grace period
    vi.advanceTimersByTime(5100);

    // Should have escalated to SIGKILL
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');

    // Clean up
    mockChild.simulateExit(null, 'SIGKILL');
    const result = await handle.result;
    expect(result.status).toBe('cancelled');

    vi.useRealTimers();
  });

  it('grace period uses min of job grace period and agent max', async () => {
    vi.useFakeTimers();

    const mod = await importForkRunner();
    const execOpts = createMockExecOptions();
    const handle = mod.createForkRunner(
      {
        runnerPath: '/test/runner.js',
        env: {},
        maxGracePeriodMs: 10_000, // agent max = 10s
      },
      execOpts,
    );

    mockChild.simulateIpc({ type: 'ready' });

    // Job requests 30s grace period, but agent max is 10s
    handle.cancel(false, 30_000);

    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
    mockChild.kill.mockClear();

    // Should not escalate at 10s (right at boundary)
    vi.advanceTimersByTime(9900);
    expect(mockChild.kill).not.toHaveBeenCalled();

    // Should escalate at 10s
    vi.advanceTimersByTime(200);
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');

    mockChild.simulateExit(null, 'SIGKILL');
    await handle.result;

    vi.useRealTimers();
  });

  it('does NOT resolve result on graceful cancel -- waits for workflow-runner IPC', async () => {
    const mod = await importForkRunner();
    const execOpts = createMockExecOptions();
    const handle = mod.createForkRunner({ runnerPath: '/test/runner.js', env: {} }, execOpts);

    mockChild.simulateIpc({ type: 'ready' });

    // Graceful cancel
    handle.cancel(false);

    // Result should NOT be resolved yet
    let resolved = false;
    handle.result.then(() => {
      resolved = true;
    });

    // Give microtask queue time to process
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);

    // Workflow-runner sends job.complete after running hooks
    mockChild.simulateIpc({
      type: 'job.complete',
      status: 'failed',
      stepResults: [],
    });

    const result = await handle.result;
    // Status should be 'cancelled' because cancel was initiated
    expect(result.status).toBe('cancelled');
  });

  it('force cancel resolves immediately without waiting for IPC', async () => {
    const mod = await importForkRunner();
    const execOpts = createMockExecOptions();
    const handle = mod.createForkRunner({ runnerPath: '/test/runner.js', env: {} }, execOpts);

    mockChild.simulateIpc({ type: 'ready' });

    // Force cancel
    handle.cancel(true);

    // Simulate process exit (SIGKILL triggers exit)
    mockChild.simulateExit(null, 'SIGKILL');

    // Should resolve immediately with cancelled status
    const result = await handle.result;
    expect(result.status).toBe('cancelled');
  });

  it('forwards step.start messages with hook step_type during cancelling', async () => {
    const mod = await importForkRunner();
    const onStepStatus = vi.fn();
    const execOpts = createMockExecOptions({ onStepStatus });
    const handle = mod.createForkRunner({ runnerPath: '/test/runner.js', env: {} }, execOpts);

    mockChild.simulateIpc({ type: 'ready' });

    // Cancel gracefully
    handle.cancel(false);

    // Workflow-runner sends hook step.start during cancel path
    mockChild.simulateIpc({
      type: 'step.start',
      stepIndex: 2,
      stepName: 'onCancel',
      step_type: 'hook:onCancel',
    });

    // Should forward to onStepStatus
    expect(onStepStatus).toHaveBeenCalledWith(2, 'onCancel', 'running');

    // Complete
    mockChild.simulateIpc({ type: 'job.complete', status: 'failed', stepResults: [] });
    await handle.result;
  });
});

// --- buildRequest tests for global workflow fields ---

/**
 * Create a minimal valid JobDispatch for buildRequest testing.
 */
function makeDispatch(overrides: Partial<JobDispatch> = {}): JobDispatch {
  return {
    type: 'job.dispatch',
    messageId: 'msg-1',
    runId: 'run-1',
    jobId: 'job-1',
    repoUrl: 'https://github.com/org/source-repo.git',
    ref: 'main',
    sha: 'abc123',
    lockFileUrl: 'https://example.com/lock.json',
    jobConfig: {
      workflowName: 'ci',
      name: 'build',
      runsOn: 'kici:os:linux',
    },
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('buildRequest - global workflow fields', () => {
  it('non-global workflow (isGlobalWorkflow absent) has no global fields', async () => {
    const { buildRequest } = await import('./fork-runner.js');
    const dispatch = makeDispatch();
    const request = buildRequest(dispatch, '/workspace');

    expect(request.isGlobalWorkflow).toBeUndefined();
    expect(request.workflowRepoUrl).toBeUndefined();
    expect(request.workflowRef).toBeUndefined();
    expect(request.workflowSha).toBeUndefined();
    expect(request.workflowRepoIdentifier).toBeUndefined();
  });

  it('threads runId/jobId from the dispatch (for the OIDC token relay)', async () => {
    const { buildRequest } = await import('./fork-runner.js');
    const request = buildRequest(makeDispatch({ runId: 'run-42', jobId: 'job-99' }), '/workspace');

    expect(request.runId).toBe('run-42');
    expect(request.jobId).toBe('job-99');
  });

  it('maps matrixValues and uses the base job name for ctx/source resolution', async () => {
    const { buildRequest } = await import('./fork-runner.js');
    const dispatch = makeDispatch({
      jobConfig: {
        workflowName: 'ci',
        name: 'test (a)',
        baseJobName: 'test',
        matrixValues: { variant: 'a' },
        runsOn: 'kici:os:linux',
      },
    });
    const request = buildRequest(dispatch, '/workspace');

    // jobName drives findJob/extractSteps + ctx.job.name -> base name.
    expect(request.jobName).toBe('test');
    expect(request.matrixValues).toEqual({ variant: 'a' });
  });

  it('falls back to the config name when no baseJobName is present', async () => {
    const { buildRequest } = await import('./fork-runner.js');
    const request = buildRequest(makeDispatch(), '/workspace');
    expect(request.jobName).toBe('build');
    expect(request.matrixValues).toBeUndefined();
  });

  it('maps dispatchInputs from jobConfig onto the request', async () => {
    const { buildRequest } = await import('./fork-runner.js');
    const dispatch = makeDispatch({
      jobConfig: {
        workflowName: 'deploy',
        name: 'gates',
        runsOn: 'kici:os:linux',
        dispatchInputs: { skipCveScan: true, mode: 'full' },
      },
    });
    const request = buildRequest(dispatch, '/workspace');
    expect(request.dispatchInputs).toEqual({ skipCveScan: true, mode: 'full' });
  });

  it('leaves dispatchInputs undefined when absent (webhook parity)', async () => {
    const { buildRequest } = await import('./fork-runner.js');
    const request = buildRequest(makeDispatch(), '/workspace');
    expect(request.dispatchInputs).toBeUndefined();
  });

  it('non-global workflow (isGlobalWorkflow=false) maps the flag', async () => {
    const { buildRequest } = await import('./fork-runner.js');
    const dispatch = makeDispatch({
      jobConfig: {
        workflowName: 'ci',
        name: 'build',
        runsOn: 'kici:os:linux',
        isGlobalWorkflow: false,
      },
    });
    const request = buildRequest(dispatch, '/workspace');

    expect(request.isGlobalWorkflow).toBe(false);
  });

  it('global workflow maps all workflow repo fields', async () => {
    const { buildRequest } = await import('./fork-runner.js');
    const dispatch = makeDispatch({
      jobConfig: {
        workflowName: 'global-ci',
        name: 'lint',
        runsOn: 'kici:os:linux',
        isGlobalWorkflow: true,
        workflowRepoUrl: 'https://github.com/org/workflow-repo.git',
        workflowRef: 'v1.0',
        workflowSha: 'def456',
        workflowRepoIdentifier: 'org/workflow-repo',
      },
    });
    const request = buildRequest(dispatch, '/workspace');

    expect(request.isGlobalWorkflow).toBe(true);
    expect(request.workflowRepoUrl).toBe('https://github.com/org/workflow-repo.git');
    expect(request.workflowRef).toBe('v1.0');
    expect(request.workflowSha).toBe('def456');
    expect(request.workflowRepoIdentifier).toBe('org/workflow-repo');
  });

  it('global workflow preserves source repo fields in repoUrl/ref/sha', async () => {
    const { buildRequest } = await import('./fork-runner.js');
    const dispatch = makeDispatch({
      repoUrl: 'https://github.com/org/source-repo.git',
      ref: 'feature-branch',
      sha: 'src-sha-123',
      jobConfig: {
        workflowName: 'global-ci',
        name: 'lint',
        runsOn: 'kici:os:linux',
        isGlobalWorkflow: true,
        workflowRepoUrl: 'https://github.com/org/workflow-repo.git',
        workflowRef: 'main',
        workflowSha: 'wf-sha-456',
        workflowRepoIdentifier: 'org/workflow-repo',
      },
    });
    const request = buildRequest(dispatch, '/workspace');

    // Source repo info still in standard fields
    expect(request.repoUrl).toBe('https://github.com/org/source-repo.git');
    expect(request.ref).toBe('feature-branch');
    expect(request.sha).toBe('src-sha-123');

    // Workflow repo info in new fields
    expect(request.workflowRepoUrl).toBe('https://github.com/org/workflow-repo.git');
    expect(request.workflowRef).toBe('main');
    expect(request.workflowSha).toBe('wf-sha-456');
  });
});

// --- buildRequest tests for job-level timeout ---

describe('buildRequest - job timeout', () => {
  it('threads jobConfig.timeout into request.jobTimeoutMs', async () => {
    const { buildRequest } = await import('./fork-runner.js');
    const dispatch = makeDispatch({
      jobConfig: { workflowName: 'ci', name: 'build', runsOn: 'linux', timeout: 600_000 },
    });
    const req = buildRequest(dispatch, '/workspace');
    expect(req.jobTimeoutMs).toBe(600_000);
  });

  it('leaves jobTimeoutMs undefined when jobConfig has no timeout', async () => {
    const { buildRequest } = await import('./fork-runner.js');
    const dispatch = makeDispatch({
      jobConfig: { workflowName: 'ci', name: 'build', runsOn: 'linux' },
    });
    const req = buildRequest(dispatch, '/workspace');
    expect(req.jobTimeoutMs).toBeUndefined();
  });
});

// --- buildBwrapArgs tests ---
//
// The splice logic that adds `/lib64` when it exists on the host is the
// source of a regression seen in E2E: an off-by-one caused bwrap to receive
// `--ro-bind /lib --ro-bind /lib64 /lib64 /lib` which bwrap parsed as
// "mount /lib at --ro-bind, then exec the command /lib64", crashing with
// `bwrap: execvp /lib64: No such file or directory`. These tests lock in
// the correct argument layout on both x86_64 (/lib64 present) and arm64
// (/lib64 absent) so the regression can't return silently.

describe('buildBwrapArgs', () => {
  let mockExistsSync: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Reset modules so the next dynamic import of fork-runner.js picks up
    // the fresh `node:fs` mock instead of reusing a cached copy from an
    // earlier describe block.
    vi.resetModules();
    mockExistsSync = vi.fn();
    vi.doMock('node:fs', () => ({
      existsSync: mockExistsSync,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('node:fs');
  });

  /**
   * Walk the arg list and assert that every `--ro-bind` / `--bind` flag is
   * immediately followed by two non-flag tokens (source + destination).
   * This is the invariant bwrap requires — if it's violated the process
   * crashes with `execvp`-style errors.
   */
  function assertBindInvariant(args: string[]): void {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--ro-bind' || arg === '--bind') {
        const src = args[i + 1];
        const dest = args[i + 2];
        expect(src).toBeDefined();
        expect(dest).toBeDefined();
        expect(src?.startsWith('--')).toBe(false);
        expect(dest?.startsWith('--')).toBe(false);
        i += 2;
      }
    }
  }

  it('produces a well-formed arg list on x86_64 hosts (/lib64 present)', async () => {
    mockExistsSync.mockReturnValue(true);
    const { buildBwrapArgs } = await import('./fork-runner.js');

    const args = buildBwrapArgs('/tmp/workdir', '/usr/bin/node', true);

    // Invariant: every bind flag is followed by valid src+dest tokens.
    assertBindInvariant(args);

    // /lib and /lib64 are both bound, in the right order, with correct
    // source/destination pairing. This is the exact layout that broke in
    // E2E before the splice fix.
    const joined = args.join(' ');
    expect(joined).toContain('--ro-bind /lib /lib --ro-bind /lib64 /lib64');

    // The regression signature must NOT be present — before the fix the
    // args contained `--ro-bind /lib --ro-bind /lib64 /lib64 /lib` which
    // caused bwrap to interpret `/lib64` as the exec command.
    expect(joined).not.toContain('--ro-bind /lib --ro-bind /lib64 /lib64 /lib');

    // Namespace isolation flags must be present.
    expect(args).toContain('--unshare-pid');
    expect(args).toContain('--unshare-ipc');
    expect(args).toContain('--unshare-net');
    expect(args).toContain('--die-with-parent');

    // Workspace bind is writable and chdir'd.
    expect(joined).toContain('--bind /tmp/workdir /workspace');
    expect(joined).toContain('--chdir /workspace');
  });

  it('omits /lib64 on arm64 hosts (/lib64 absent) and still produces valid args', async () => {
    mockExistsSync.mockReturnValue(false);
    const { buildBwrapArgs } = await import('./fork-runner.js');

    const args = buildBwrapArgs('/tmp/workdir', '/usr/bin/node', true);

    assertBindInvariant(args);
    expect(args).not.toContain('/lib64');

    // /lib is still present and correctly formed.
    const joined = args.join(' ');
    expect(joined).toContain('--ro-bind /lib /lib');
    expect(joined).toContain('--ro-bind /bin /bin');
  });

  it('omits --unshare-net when networkIsolation=false', async () => {
    mockExistsSync.mockReturnValue(true);
    const { buildBwrapArgs } = await import('./fork-runner.js');

    const args = buildBwrapArgs('/tmp/workdir', '/usr/bin/node', false);

    assertBindInvariant(args);
    expect(args).not.toContain('--unshare-net');
    expect(args).toContain('--unshare-pid');
  });

  it('adds a ro-bind for the node install ROOT when node lives outside /usr and /bin', async () => {
    // Distributions like nvm/mise/asdf colocate `npm` under
    // $NODE_ROOT/lib/node_modules. Without binding the entire root, the
    // workflow runner's `npm install` step crashes with `Cannot find module
    // .../lib/node_modules/npm/bin/npm-cli.js`. Regression seen in E2E.
    mockExistsSync.mockReturnValue(false);
    const { buildBwrapArgs } = await import('./fork-runner.js');

    const args = buildBwrapArgs(
      '/tmp/workdir',
      '/home/user/.local/share/mise/installs/node/24.0.0/bin/node',
      true,
    );

    assertBindInvariant(args);
    const joined = args.join(' ');
    expect(joined).toContain(
      '--ro-bind /home/user/.local/share/mise/installs/node/24.0.0 /home/user/.local/share/mise/installs/node/24.0.0',
    );
    // We should NOT also bind the bin/ subdir separately — that would be
    // a redundant nested mount.
    expect(
      args.filter(
        (a, i) =>
          a === '/home/user/.local/share/mise/installs/node/24.0.0/bin' &&
          args[i - 1] === '--ro-bind',
      ).length,
    ).toBe(0);
  });

  it('does not add a ro-bind for node when it lives under /usr', async () => {
    mockExistsSync.mockReturnValue(false);
    const { buildBwrapArgs } = await import('./fork-runner.js');

    const args = buildBwrapArgs('/tmp/workdir', '/usr/bin/node', true);

    assertBindInvariant(args);
    // /usr is already mounted ro-bind; we must not double-mount its bin dir
    // or its parent (which IS /usr — caught by the startsWith('/usr') guard).
    const usrBinBindCount = args.filter(
      (a, i) => a === '/usr/bin' && args[i - 1] === '--ro-bind',
    ).length;
    expect(usrBinBindCount).toBe(0);
    const usrBindCount = args.filter((a, i) => a === '/usr' && args[i - 1] === '--ro-bind').length;
    // /usr is bound exactly once (at the top of the args list).
    expect(usrBindCount).toBe(1);
  });

  it('binds the runner directory in single-tree (production) installs', async () => {
    // No pnpm-workspace.yaml found walking up — production tarball case.
    // Without this bind, bwrap'd Node crashes with `Cannot find module
    // '/home/.../workflow-runner.js'` because the host install path is not
    // mapped into the sandbox. Regression seen in E2E (kici-e2e-orch-restart.log).
    mockExistsSync.mockReturnValue(false);
    const { buildBwrapArgs } = await import('./fork-runner.js');

    const args = buildBwrapArgs(
      '/tmp/workdir',
      '/usr/bin/node',
      true,
      '/opt/kici/dist/workflow-runner.js',
    );

    assertBindInvariant(args);
    expect(args.join(' ')).toContain('--ro-bind /opt/kici/dist /opt/kici/dist');
  });

  it('does not bind-mount the runner directory when it lives under /usr', async () => {
    mockExistsSync.mockReturnValue(false);
    const { buildBwrapArgs } = await import('./fork-runner.js');

    const args = buildBwrapArgs(
      '/tmp/workdir',
      '/usr/bin/node',
      true,
      '/usr/lib/kici/workflow-runner.js',
    );

    assertBindInvariant(args);
    // /usr is already mounted ro-bind; we must not double-mount.
    const dupBind = args.filter(
      (a, i) => a === '/usr/lib/kici' && args[i - 1] === '--ro-bind',
    ).length;
    expect(dupBind).toBe(0);
  });

  it('does not double-bind when runner is colocated with the node install', async () => {
    // Single-binary distribution where the node install root contains both
    // bin/node and dist/workflow-runner.js. nodeInstallRoot = /opt/kici, and
    // runnerDir = /opt/kici/dist is covered by it — no second bind.
    mockExistsSync.mockReturnValue(false);
    const { buildBwrapArgs } = await import('./fork-runner.js');

    const args = buildBwrapArgs(
      '/tmp/workdir',
      '/opt/kici/bin/node',
      true,
      '/opt/kici/dist/workflow-runner.js',
    );

    assertBindInvariant(args);
    const bindCount = args.filter(
      (a, i) => a === '/opt/kici' && args[i - 1] === '--ro-bind',
    ).length;
    expect(bindCount).toBe(1);
    // No nested bind for /opt/kici/dist.
    const distBindCount = args.filter(
      (a, i) => a === '/opt/kici/dist' && args[i - 1] === '--ro-bind',
    ).length;
    expect(distBindCount).toBe(0);
  });

  it('omits runner bind when runnerPath is not provided (back-compat)', async () => {
    mockExistsSync.mockReturnValue(false);
    const { buildBwrapArgs } = await import('./fork-runner.js');

    const args = buildBwrapArgs('/tmp/workdir', '/usr/bin/node', true);
    assertBindInvariant(args);
    // No extra binds beyond /usr family + workspace + node dir.
  });

  it('binds the pnpm workspace root when one is found walking up from runnerPath', async () => {
    // pnpm symlinks point to sibling packages outside of node_modules. The
    // only way to make those resolve inside the sandbox is to bind the
    // entire workspace root. Without this the runner crashes with
    // `Cannot find package '@kici-dev/shared'`. Regression seen in E2E.
    mockExistsSync.mockImplementation(
      (p: string) => p === '/home/u/devel/myci26/pnpm-workspace.yaml',
    );

    const { buildBwrapArgs } = await import('./fork-runner.js');
    const args = buildBwrapArgs(
      '/tmp/workdir',
      '/usr/bin/node',
      true,
      '/home/u/devel/myci26/packages/agent/dist/workflow-runner.js',
    );

    assertBindInvariant(args);
    const joined = args.join(' ');
    expect(joined).toContain('--ro-bind /home/u/devel/myci26 /home/u/devel/myci26');
    // No redundant per-node_modules binds when the workspace root is bound.
    expect(joined).not.toContain('--ro-bind /home/u/devel/myci26/packages/agent/node_modules');
  });

  it('falls back to per-node_modules walking when no pnpm-workspace.yaml is found', async () => {
    const validNodeModules = new Set(['/opt/kici/node_modules']);
    mockExistsSync.mockImplementation((p: string) => validNodeModules.has(p));

    const { buildBwrapArgs } = await import('./fork-runner.js');
    const args = buildBwrapArgs(
      '/tmp/workdir',
      '/usr/bin/node',
      true,
      '/opt/kici/dist/workflow-runner.js',
    );

    assertBindInvariant(args);
    const joined = args.join(' ');
    expect(joined).toContain('--ro-bind /opt/kici/dist /opt/kici/dist');
    expect(joined).toContain('--ro-bind /opt/kici/node_modules /opt/kici/node_modules');
  });

  it('does not bind a node_modules under /usr or /bin (already mounted)', async () => {
    // Pretend a node_modules exists under /usr/lib (already mounted via /usr).
    mockExistsSync.mockImplementation((p: string) => p === '/usr/lib/kici/node_modules');

    const { buildBwrapArgs } = await import('./fork-runner.js');
    const args = buildBwrapArgs(
      '/tmp/workdir',
      '/usr/bin/node',
      true,
      '/usr/lib/kici/dist/workflow-runner.js',
    );

    assertBindInvariant(args);
    // No duplicate /usr/lib/kici/node_modules bind.
    const dupBind = args.filter(
      (a, i) => a === '/usr/lib/kici/node_modules' && args[i - 1] === '--ro-bind',
    ).length;
    expect(dupBind).toBe(0);
  });

  it('terminates the parent walk at "/" without infinite looping', async () => {
    mockExistsSync.mockReturnValue(false);
    const { buildBwrapArgs } = await import('./fork-runner.js');

    // Runner directly at root — walk should not blow up.
    const args = buildBwrapArgs('/tmp/workdir', '/usr/bin/node', true, '/runner.js');
    assertBindInvariant(args);
    expect(args.length).toBeGreaterThan(0);
  });

  it('appends extraReadOnlyBinds (e.g. file:// clone source dirs)', async () => {
    // Internal-provider E2E uses `file:///path/to/test-repo` as the clone
    // URL. The test repo lives outside the workspace root, so without
    // mounting it into the sandbox the workflow runner's git clone fails
    // with `does not appear to be a git repository`. Regression seen in E2E.
    mockExistsSync.mockImplementation((p: string) => p === '/srv/test-repos/myrepo');
    const { buildBwrapArgs } = await import('./fork-runner.js');

    const args = buildBwrapArgs(
      '/tmp/workdir',
      '/usr/bin/node',
      true,
      '/opt/kici/dist/workflow-runner.js',
      ['/srv/test-repos/myrepo'],
    );

    assertBindInvariant(args);
    expect(args.join(' ')).toContain('--ro-bind /srv/test-repos/myrepo /srv/test-repos/myrepo');
  });

  it('skips extraReadOnlyBinds that do not exist on the host', async () => {
    mockExistsSync.mockReturnValue(false);
    const { buildBwrapArgs } = await import('./fork-runner.js');

    const args = buildBwrapArgs(
      '/tmp/workdir',
      '/usr/bin/node',
      true,
      '/opt/kici/dist/workflow-runner.js',
      ['/no/such/path'],
    );

    assertBindInvariant(args);
    expect(args.join(' ')).not.toContain('/no/such/path');
  });

  it('skips extraReadOnlyBinds already covered by /usr or /workspace', async () => {
    mockExistsSync.mockImplementation((p: string) =>
      ['/usr/share/foo', '/workspace/sub'].includes(p),
    );
    const { buildBwrapArgs } = await import('./fork-runner.js');

    const args = buildBwrapArgs(
      '/tmp/workdir',
      '/usr/bin/node',
      true,
      '/opt/kici/dist/workflow-runner.js',
      ['/usr/share/foo', '/workspace/sub'],
    );

    assertBindInvariant(args);
    const joined = args.join(' ');
    // /usr is already mounted ro-bind; we must not double-mount its subdirs.
    expect(joined.split('/usr/share/foo').length - 1).toBeLessThanOrEqual(0);
    expect(joined.split('/workspace/sub').length - 1).toBeLessThanOrEqual(0);
  });
});
