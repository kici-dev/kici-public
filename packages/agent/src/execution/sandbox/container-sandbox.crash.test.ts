import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Duplex } from 'node:stream';
import Docker from 'dockerode';
import { ExecutionJobStatus } from '@kici-dev/engine';

vi.mock('@kici-dev/shared', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  toErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

vi.mock('@kici-dev/shared/container-runtime', () => ({
  ensureRuntimeVolume: vi.fn(async () => 'kici-runtime-node-abc123'),
  RuntimeSubtree: { enum: { all: 'all', node: 'node' } },
}));

import { ContainerSandbox } from './container-sandbox.js';
import {
  DEFAULT_MEMORY_BYTES,
  DEFAULT_NANO_CPUS,
  DEFAULT_PIDS_LIMIT,
} from './container-hardening.js';
import { EXIT_COMMAND_NOT_FOUND } from './runner-crash.js';

/** What Docker writes to the exec's stdout when the image has no `node`. */
const OCI_NODE_NOT_FOUND =
  'OCI runtime exec failed: exec failed: unable to start container process: ' +
  'exec: "node": executable file not found in $PATH\r\n';

/** Docker's multiplexed-stream frame for one stdout payload. */
function stdoutFrame(payload: string): Buffer {
  const body = Buffer.from(payload);
  const header = Buffer.alloc(8);
  header.writeUInt8(1, 0);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

/**
 * A hijacked exec stream double: what the test pushes is what the sandbox
 * reads, and what the sandbox writes (IPC responses) is discarded.
 */
function hijackedStream(): Duplex {
  return new Duplex({
    read() {},
    write(_chunk, _enc, cb) {
      cb();
    },
  });
}

/**
 * Docker double whose modem is the real dockerode one, so the demuxer under
 * test is the one that ships. Constructing it opens no connection.
 */
function mockDocker(stream: Duplex, exitCode: number, inspect?: () => Promise<unknown>) {
  const realModem = new Docker({ socketPath: '/nonexistent/docker.sock' }).modem;
  const infoArchive = vi.fn(async ({ path }: { path: string }) =>
    ['/lib64/ld-linux-x86-64.so.2', '/bin/sh'].includes(path)
      ? { name: path }
      : Promise.reject(new Error('not found')),
  );
  const execInspect = inspect
    ? vi.fn(inspect)
    : vi.fn().mockResolvedValue({ Running: false, ExitCode: exitCode });
  const exec = vi.fn().mockResolvedValue({
    start: vi.fn().mockResolvedValue(stream),
    inspect: execInspect,
  });
  const container = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    infoArchive,
    exec,
    id: 'deadbeefcafe0000',
  };
  const docker = {
    createContainer: vi.fn().mockResolvedValue(container),
    getImage: vi.fn().mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) }),
    modem: { demuxStream: realModem.demuxStream.bind(realModem) },
  } as unknown as Docker;
  return { docker, execInspect };
}

async function sandboxFor(docker: Docker, runtimeNodePath?: string): Promise<ContainerSandbox> {
  const sandbox = new ContainerSandbox({
    docker,
    image: 'python:3.12-bookworm',
    runnerPath: '/x/dist/workflow-runner.js',
    env: {},
    jobId: 'job-crash',
    hardening: {
      hardened: true,
      readonlyRootfs: false,
      pidsLimit: DEFAULT_PIDS_LIMIT,
      memoryBytes: DEFAULT_MEMORY_BYTES,
      nanoCpus: DEFAULT_NANO_CPUS,
      networkMode: 'default',
    },
    networkIsolation: false,
    ...(runtimeNodePath ? { runtimeNodePath } : {}),
  });
  await sandbox.setup({ workDir: '/work', env: {} });
  return sandbox;
}

function runJob(sandbox: ContainerSandbox, ac = new AbortController()) {
  return sandbox.executeJob({ signal: ac.signal, dispatch: {} } as never);
}

/** Let the exec start and the stream wiring run. */
const settle = () => new Promise((r) => setImmediate(r));

describe('ContainerSandbox runner that exits without job.complete', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it('reports an unknown exit code when the exec inspect never answers', async () => {
    const stream = hijackedStream();
    const { docker } = mockDocker(stream, 0, () => new Promise(() => {}));
    const sandbox = await sandboxFor(docker, '/host/opt/kici/node');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const result = runJob(sandbox);
    await settle();
    stream.push(OCI_NODE_NOT_FOUND);
    stream.push(null);
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);

    // fails-when: the inspect is awaited unbounded — the job never resolves.
    const res = await result;
    expect(res.status).toBe(ExecutionJobStatus.enum.failed);
    expect(res.error).toContain('unknown exit code');
  });

  it('resolves a job aborted mid-run as cancelled with no crash error', async () => {
    const stream = hijackedStream();
    const { docker } = mockDocker(stream, 137);
    const sandbox = await sandboxFor(docker, '/host/opt/kici/node');
    // The abort handler's grace timer is not under test; keep it from firing.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ac = new AbortController();

    const result = runJob(sandbox, ac);
    await settle();
    ac.abort();
    // The stopped container ends the exec stream with no job.complete.
    stream.push(null);

    // fails-when: the crash text is attached regardless of status, so a
    // cancelled job reports "runner exited without job.complete".
    const res = await result;
    expect(res.status).toBe(ExecutionJobStatus.enum.cancelled);
    expect(res.error).toBeUndefined();
  });

  it('fails promptly with the exit code and the error the runtime wrote to stdout', async () => {
    const stream = hijackedStream();
    const { docker, execInspect } = mockDocker(stream, EXIT_COMMAND_NOT_FOUND);
    const sandbox = await sandboxFor(docker, '/host/opt/kici/node');

    const result = runJob(sandbox);
    await new Promise((r) => setTimeout(r, 0));
    stream.push(OCI_NODE_NOT_FOUND);
    stream.push(null);

    // fails-when: the demuxed stdout is never ended on stream end — the
    // readline never closes and this await hits the test timeout.
    const res = await result;
    expect(res.status).toBe(ExecutionJobStatus.enum.failed);
    expect(execInspect).toHaveBeenCalled();
    // fails-when: the exit code or the stdout error line is dropped from the message.
    expect(res.error).toContain(`exit code ${EXIT_COMMAND_NOT_FOUND}`);
    expect(res.error).toContain('executable file not found in $PATH');
    // An injected runtime rules out the image's own node as the cause.
    expect(res.error).toContain('Workflow runner exited without sending job.complete');
  });

  it('names the image and the runtime settings when the image has no node', async () => {
    const stream = hijackedStream();
    const { docker } = mockDocker(stream, EXIT_COMMAND_NOT_FOUND);
    const sandbox = await sandboxFor(docker);

    const result = runJob(sandbox);
    await new Promise((r) => setTimeout(r, 0));
    stream.push(OCI_NODE_NOT_FOUND);
    stream.push(null);

    const res = await result;
    expect(res.status).toBe(ExecutionJobStatus.enum.failed);
    // fails-when: the no-runtime fallback crash is reported as a generic runner crash.
    expect(res.error).toContain("'python:3.12-bookworm' has no 'node' executable");
    expect(res.error).toContain('KICI_RUNTIME_NODE_SOURCE');
    expect(res.error).toContain('KICI_RUNTIME_IMAGE');
  });

  it('still resolves success when the runner reports job.complete before the stream ends', async () => {
    const stream = hijackedStream();
    const { docker, execInspect } = mockDocker(stream, 0);
    const sandbox = await sandboxFor(docker);

    const result = runJob(sandbox);
    await new Promise((r) => setTimeout(r, 0));
    const complete = {
      type: 'job.complete',
      status: ExecutionJobStatus.enum.success,
      stepResults: [],
    };
    stream.push(stdoutFrame(JSON.stringify(complete) + '\n'));
    stream.push(null);

    // breaks-if-wrong: ending the outputs on stream end must not turn a
    // reported success into a crash.
    const res = await result;
    expect(res.status).toBe(ExecutionJobStatus.enum.success);
    expect(res.error).toBeUndefined();
    expect(execInspect).not.toHaveBeenCalled();
  });
});

describe('ContainerSandbox runner that reports a failure on job.complete', () => {
  beforeEach(() => vi.clearAllMocks());

  it('carries the runner-reported error and dropped jobs into the result', async () => {
    const stream = hijackedStream();
    const { docker, execInspect } = mockDocker(stream, 1);
    const sandbox = await sandboxFor(docker);

    const result = runJob(sandbox);
    await new Promise((r) => setTimeout(r, 0));
    // A runner that fails before its first step (clone, deps, compile, rules)
    // sends job.complete with no step results and the reason in `error`.
    const complete = {
      type: 'job.complete',
      status: ExecutionJobStatus.enum.failed,
      stepResults: [],
      error: 'Dependency install failed: registry unreachable',
      droppedJobs: ['sibling-job'],
    };
    stream.push(stdoutFrame(JSON.stringify(complete) + '\n'));
    stream.push(null);

    const res = await result;
    expect(res.status).toBe(ExecutionJobStatus.enum.failed);
    // fails-when: applyJobComplete drops msg.error — the job reaches the
    // orchestrator with no reason.
    expect(res.error).toBe('Dependency install failed: registry unreachable');
    // fails-when: applyJobComplete drops msg.droppedJobs.
    expect(res.droppedJobs).toEqual(['sibling-job']);
    // A reported completion is not a crash, so the exec is never inspected.
    expect(execInspect).not.toHaveBeenCalled();
  });

  it('omits error and droppedJobs when the runner reports neither', async () => {
    const stream = hijackedStream();
    const { docker } = mockDocker(stream, 0);
    const sandbox = await sandboxFor(docker);

    const result = runJob(sandbox);
    await new Promise((r) => setTimeout(r, 0));
    const complete = {
      type: 'job.complete',
      status: ExecutionJobStatus.enum.failed,
      stepResults: [],
      droppedJobs: [],
    };
    stream.push(stdoutFrame(JSON.stringify(complete) + '\n'));
    stream.push(null);

    // breaks-if-wrong: an empty droppedJobs list or an absent error must not
    // surface as a field, matching the fork backend.
    const res = await result;
    expect(res.status).toBe(ExecutionJobStatus.enum.failed);
    expect(res.error).toBeUndefined();
    expect(res.droppedJobs).toBeUndefined();
  });
});
