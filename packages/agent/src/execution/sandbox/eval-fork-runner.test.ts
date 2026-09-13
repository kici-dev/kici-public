import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { EvalRequest, EvalToAgentMessage, AgentToEvalMessage } from './ipc-protocol.js';

const forkMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ fork: forkMock }));

const buildSanitizedEnvMock = vi.hoisted(() =>
  vi.fn().mockReturnValue({ PATH: '/usr/bin', HOME: '/home/kici' }),
);
vi.mock('./env-sanitizer.js', () => ({ buildSanitizedEnv: buildSanitizedEnvMock }));

function makeChild() {
  const emitter = new EventEmitter();
  const sent: AgentToEvalMessage[] = [];
  // A real emitter, because the runner subscribes to stderr `data` to keep the
  // tail it reports when the child dies without sending anything.
  const stderr = Object.assign(new EventEmitter(), {
    resume: vi.fn(),
    setEncoding: vi.fn(),
  });
  return Object.assign(emitter, {
    pid: 4242,
    sent,
    stdout: { resume: vi.fn() },
    stderr,
    send: vi.fn((m: AgentToEvalMessage) => {
      sent.push(m);
      return true;
    }),
    kill: vi.fn(),
    fromChild: (m: EvalToAgentMessage) => emitter.emit('message', m),
    fromChildStderr: (chunk: string) => stderr.emit('data', chunk),
  }) as unknown as ChildProcess & {
    sent: AgentToEvalMessage[];
    fromChild: (m: EvalToAgentMessage) => void;
    fromChildStderr: (chunk: string) => void;
  };
}

const request: EvalRequest = {
  kind: 'init',
  workDir: '/tmp/wd',
  config: { workflowName: 'ci' },
  dispatch: { jobId: 'job-1' },
};

describe('runEvalChild', () => {
  let child: ReturnType<typeof makeChild>;

  beforeEach(() => {
    child = makeChild();
    forkMock.mockReset().mockReturnValue(child);
    buildSanitizedEnvMock.mockClear();
  });

  afterEach(() => vi.restoreAllMocks());

  it('forks with a sanitized env built from {}, never from process.env', async () => {
    const { runEvalChild } = await import('./eval-fork-runner.js');
    const p = runEvalChild({
      evalRunnerPath: '/opt/kici/eval-runner.js',
      request,
      onLogLine: () => {},
      trustedEnv: true,
    });

    expect(buildSanitizedEnvMock).toHaveBeenCalledWith({}, { trustedEnv: true });
    const [path, argv, opts] = forkMock.mock.calls[0];
    expect(path).toBe('/opt/kici/eval-runner.js');
    expect(argv).toEqual([]);
    expect(opts.env.KICI_AGENT_TOKEN).toBeUndefined();
    expect(opts.cwd).toBe('/tmp/wd');

    child.fromChild({ type: 'eval.result', result: { ok: true } });
    expect(await p).toEqual({ ok: true });
  });

  it('sends the request only after the child reports ready', async () => {
    const { runEvalChild } = await import('./eval-fork-runner.js');
    const p = runEvalChild({ evalRunnerPath: '/r.js', request, onLogLine: () => {} });

    expect(child.sent).toHaveLength(0);
    child.fromChild({ type: 'ready' });
    expect(child.sent[0]).toEqual({ type: 'eval', request });

    child.fromChild({ type: 'eval.result', result: null });
    await p;
  });

  it('streams log lines to the caller', async () => {
    const lines: string[] = [];
    const { runEvalChild } = await import('./eval-fork-runner.js');
    const p = runEvalChild({
      evalRunnerPath: '/r.js',
      request,
      onLogLine: (line) => lines.push(line),
    });

    child.fromChild({ type: 'log.line', line: 'workflow loaded' });
    child.fromChild({ type: 'eval.result', result: null });
    await p;

    expect(lines).toEqual(['workflow loaded']);
  });

  it('rejects with the evaluation error text', async () => {
    const { runEvalChild } = await import('./eval-fork-runner.js');
    const p = runEvalChild({ evalRunnerPath: '/r.js', request, onLogLine: () => {} });

    child.fromChild({ type: 'eval.error', error: "Job 'x' not found in workflow" });
    await expect(p).rejects.toThrow("Job 'x' not found in workflow");
  });

  it('rejects when the child dies without reporting', async () => {
    const { runEvalChild } = await import('./eval-fork-runner.js');
    const p = runEvalChild({ evalRunnerPath: '/r.js', request, onLogLine: () => {} });

    (child as unknown as EventEmitter).emit('exit', 1, null);
    await expect(p).rejects.toThrow('exited without a result');
  });

  it("carries the child's stderr into the died-without-reporting message", async () => {
    // The shape a Firecracker rootfs missing eval-runner.js produces: node
    // starts, cannot load the module, and exits 1 having sent no IPC message.
    // Without the tail the operator sees only `code=1`.
    const { runEvalChild } = await import('./eval-fork-runner.js');
    const p = runEvalChild({
      evalRunnerPath: '/opt/kici/eval-runner.js',
      request,
      onLogLine: () => {},
    });

    child.fromChildStderr(
      "node:internal/modules/esm/resolve:275\n  Cannot find module '/opt/kici/eval-runner.js'\n",
    );
    (child as unknown as EventEmitter).emit('exit', 1, null);

    await expect(p).rejects.toThrow(/Cannot find module '\/opt\/kici\/eval-runner\.js'/);
  });

  it('bounds the stderr tail it reports', async () => {
    const { runEvalChild } = await import('./eval-fork-runner.js');
    const p = runEvalChild({ evalRunnerPath: '/r.js', request, onLogLine: () => {} });

    // 4097 chars of filler, then the marker: only the tail survives, so the
    // filler's first char must be gone and the marker must be present.
    child.fromChildStderr('x'.repeat(4097));
    child.fromChildStderr('THE-REAL-ERROR');
    (child as unknown as EventEmitter).emit('exit', 1, null);

    const err = await p.catch((e: Error) => e);
    expect((err as Error).message).toContain('THE-REAL-ERROR');
    expect((err as Error).message.length).toBeLessThan(4200);
  });

  it('does not echo stderr when the evaluation reports its own error', async () => {
    const { runEvalChild } = await import('./eval-fork-runner.js');
    const p = runEvalChild({ evalRunnerPath: '/r.js', request, onLogLine: () => {} });

    child.fromChildStderr('a warning nobody asked for');
    child.fromChild({ type: 'eval.error', error: "Job 'x' not found in workflow" });

    const err = await p.catch((e: Error) => e);
    expect((err as Error).message).toBe("Job 'x' not found in workflow");
  });

  it('relays an api request and answers it', async () => {
    const onApiRequest = vi.fn().mockResolvedValue({ value: 42 });
    const { runEvalChild } = await import('./eval-fork-runner.js');
    const p = runEvalChild({
      evalRunnerPath: '/r.js',
      request,
      onLogLine: () => {},
      onApiRequest,
    });

    child.fromChild({ type: 'eval.api.request', id: 'a1', method: 'kici.get', params: { k: 1 } });
    await vi.waitFor(() => expect(child.sent).toHaveLength(1));
    expect(child.sent[0]).toEqual({ type: 'eval.api.response', id: 'a1', result: { value: 42 } });
    expect(onApiRequest).toHaveBeenCalledWith('kici.get', { k: 1 });

    child.fromChild({ type: 'eval.result', result: null });
    await p;
  });

  it('answers an api request with an error when no transport is wired', async () => {
    const { runEvalChild } = await import('./eval-fork-runner.js');
    const p = runEvalChild({ evalRunnerPath: '/r.js', request, onLogLine: () => {} });

    child.fromChild({ type: 'eval.api.request', id: 'a1', method: 'kici.get', params: {} });
    await vi.waitFor(() => expect(child.sent).toHaveLength(1));
    expect(child.sent[0]).toMatchObject({ id: 'a1', error: 'Agent API not available' });

    child.fromChild({ type: 'eval.result', result: null });
    await p;
  });

  it('ignores a message outside the eval union rather than acting on it', async () => {
    const { runEvalChild } = await import('./eval-fork-runner.js');
    const p = runEvalChild({ evalRunnerPath: '/r.js', request, onLogLine: () => {} });

    // A customer module with code execution in the child naming one of the step
    // runner's privileged relays must reach nothing.
    child.fromChild({ type: 'cache.request' } as unknown as EvalToAgentMessage);
    expect(child.sent).toHaveLength(0);

    child.fromChild({ type: 'eval.result', result: 'still fine' });
    expect(await p).toBe('still fine');
  });

  it('kills the child and rejects when the caller aborts', async () => {
    const abort = new AbortController();
    const { runEvalChild } = await import('./eval-fork-runner.js');
    const p = runEvalChild({
      evalRunnerPath: '/r.js',
      request,
      onLogLine: () => {},
      signal: abort.signal,
    });

    abort.abort();
    await expect(p).rejects.toThrow('Evaluation cancelled');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
