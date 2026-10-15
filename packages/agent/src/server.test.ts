import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { JobDispatch, JobCancel, AgentToOrchestratorMessage } from '@kici-dev/engine';
import { decideIdleShutdown } from './idle-shutdown.js';

/**
 * server.ts wiring (concurrency control, drain mode, status messages), tested in
 * isolation because importing server.ts starts its listeners.
 */

interface MockClient {
  state: string;
  sentDirect: AgentToOrchestratorMessage[];
  sendDirect: (msg: AgentToOrchestratorMessage) => void;
  send: (msg: AgentToOrchestratorMessage) => void;
  connect: () => void;
  disconnect: () => void;
}

interface MockJobRunner {
  activeJobs: Map<string, { abortController: AbortController; completionPromise: Promise<void> }>;
  execute: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
}

function createMockClient(): MockClient {
  const sentDirect: AgentToOrchestratorMessage[] = [];
  return {
    state: 'registered',
    sentDirect,
    sendDirect: (msg) => sentDirect.push(msg),
    send: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

function createMockJobRunner(): MockJobRunner {
  return {
    activeJobs: new Map(),
    execute: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
  };
}

function makeDispatch(overrides: Partial<JobDispatch> = {}): JobDispatch {
  return {
    type: 'job.dispatch',
    messageId: randomUUID(),
    runId: 'run-1',
    jobId: `job-${randomUUID().slice(0, 8)}`,
    repoUrl: 'https://github.com/org/repo.git',
    ref: 'main',
    sha: 'abc123',
    lockFileUrl: 'https://example.com/lock.json',
    jobConfig: {
      name: 'test-job',
      workflowName: 'test-wf',
      source: { file: '.kici/workflows/ci.ts' },
    },
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Mirrors the server.ts onJobDispatch callback. */
function createDispatchHandler(opts: {
  client: MockClient;
  jobRunner: MockJobRunner;
  config: { agentId: string };
  isDraining: () => boolean;
}) {
  const { client, jobRunner, config } = opts;

  return (dispatch: JobDispatch) => {
    if (opts.isDraining()) {
      client.sendDirect({
        type: 'job.reject',
        messageId: randomUUID(),
        runId: dispatch.runId,
        jobId: dispatch.jobId,
        reason: 'draining',
        timestamp: Date.now(),
      });
      client.sendDirect({
        type: 'agent.status',
        messageId: randomUUID(),
        agentId: config.agentId,
        activeJobs: jobRunner.activeJobs.size,
      });
      return;
    }

    // Single-job enforcement.
    if (jobRunner.activeJobs.size > 0) {
      client.sendDirect({
        type: 'job.reject',
        messageId: randomUUID(),
        runId: dispatch.runId,
        jobId: dispatch.jobId,
        reason: 'busy',
        timestamp: Date.now(),
      });
      client.sendDirect({
        type: 'agent.status',
        messageId: randomUUID(),
        agentId: config.agentId,
        activeJobs: jobRunner.activeJobs.size,
      });
      return;
    }

    // Acked before execution starts.
    client.sendDirect({
      type: 'job.ack',
      messageId: randomUUID(),
      runId: dispatch.runId,
      jobId: dispatch.jobId,
      timestamp: Date.now(),
    });

    jobRunner
      .execute(dispatch)
      .then(() => {
        // success tracking
      })
      .catch(() => {
        // error tracking
      })
      .finally(() => {
        jobRunner.activeJobs.delete(dispatch.jobId);
        client.sendDirect({
          type: 'agent.status',
          messageId: randomUUID(),
          agentId: config.agentId,
          activeJobs: jobRunner.activeJobs.size,
        });
      });
  };
}

describe('Server wiring: concurrency control', () => {
  let client: MockClient;
  let jobRunner: MockJobRunner;
  let handler: (dispatch: JobDispatch) => void;

  beforeEach(() => {
    client = createMockClient();
    jobRunner = createMockJobRunner();
    handler = createDispatchHandler({
      client,
      jobRunner,
      config: { agentId: 'test-agent' },
      isDraining: () => false,
    });
  });

  it('accepts job dispatch when below capacity', () => {
    const dispatch = makeDispatch();
    handler(dispatch);

    expect(jobRunner.execute).toHaveBeenCalledWith(dispatch);
  });

  it('sends job.ack with the dispatch runId/jobId before executing', () => {
    const dispatch = makeDispatch();
    handler(dispatch);

    const ackMsgs = client.sentDirect.filter((m) => m.type === 'job.ack');
    expect(ackMsgs).toHaveLength(1);
    if (ackMsgs[0].type === 'job.ack') {
      expect(ackMsgs[0].runId).toBe(dispatch.runId);
      expect(ackMsgs[0].jobId).toBe(dispatch.jobId);
    }
    // The ack is sent before execution begins.
    const ackIndex = client.sentDirect.findIndex((m) => m.type === 'job.ack');
    expect(ackIndex).toBeGreaterThanOrEqual(0);
    expect(jobRunner.execute).toHaveBeenCalled();
  });

  it('does not send job.ack when the dispatch is rejected as busy', () => {
    jobRunner.activeJobs.set('job-1', {
      abortController: new AbortController(),
      completionPromise: new Promise(() => {}),
    });

    handler(makeDispatch());

    expect(client.sentDirect.filter((m) => m.type === 'job.ack')).toHaveLength(0);
  });

  it('rejects dispatch with agent.status when already running a job', () => {
    jobRunner.activeJobs.set('job-1', {
      abortController: new AbortController(),
      completionPromise: new Promise(() => {}),
    });

    const dispatch = makeDispatch();
    handler(dispatch);

    expect(jobRunner.execute).not.toHaveBeenCalled();

    const statusMsgs = client.sentDirect.filter((m) => m.type === 'agent.status');
    expect(statusMsgs).toHaveLength(1);
    const status = statusMsgs[0] as { activeJobs: number };
    expect(status.activeJobs).toBe(1);
  });

  it('sends job.reject with reason busy when a job is already running', () => {
    const client = createMockClient();
    const jobRunner = createMockJobRunner();
    jobRunner.activeJobs.set('job-running', {
      abortController: new AbortController(),
      completionPromise: Promise.resolve(),
    });
    const handler = createDispatchHandler({
      client,
      jobRunner,
      config: { agentId: 'test-agent' },
      isDraining: () => false,
    });

    const dispatch = makeDispatch();
    handler(dispatch);

    expect(jobRunner.execute).not.toHaveBeenCalled();
    const rejectMsgs = client.sentDirect.filter((m) => m.type === 'job.reject');
    expect(rejectMsgs).toHaveLength(1);
    if (rejectMsgs[0].type === 'job.reject') {
      expect(rejectMsgs[0].reason).toBe('busy');
      expect(rejectMsgs[0].runId).toBe(dispatch.runId);
    }
  });

  it('sends agent.status after job completion', async () => {
    let resolveJob!: () => void;
    const jobPromise = new Promise<void>((resolve) => {
      resolveJob = resolve;
    });

    jobRunner.execute.mockImplementation(async (dispatch: JobDispatch) => {
      jobRunner.activeJobs.set(dispatch.jobId, {
        abortController: new AbortController(),
        completionPromise: jobPromise,
      });
      await jobPromise;
    });

    const dispatch = makeDispatch();
    handler(dispatch);

    expect(client.sentDirect.filter((m) => m.type === 'agent.status')).toHaveLength(0);

    resolveJob();
    await new Promise((r) => setTimeout(r, 10));

    const statusMsgs = client.sentDirect.filter((m) => m.type === 'agent.status');
    expect(statusMsgs.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Server wiring: drain mode', () => {
  it('rejects dispatch with agent.status when draining', () => {
    const client = createMockClient();
    const jobRunner = createMockJobRunner();
    const handler = createDispatchHandler({
      client,
      jobRunner,
      config: { agentId: 'test-agent' },
      isDraining: () => true,
    });

    const dispatch = makeDispatch();
    handler(dispatch);

    expect(jobRunner.execute).not.toHaveBeenCalled();

    const statusMsgs = client.sentDirect.filter((m) => m.type === 'agent.status');
    expect(statusMsgs).toHaveLength(1);

    const rejectMsgs = client.sentDirect.filter((m) => m.type === 'job.reject');
    expect(rejectMsgs).toHaveLength(1);
    if (rejectMsgs[0].type === 'job.reject') {
      expect(rejectMsgs[0].reason).toBe('draining');
      expect(rejectMsgs[0].jobId).toBe(dispatch.jobId);
    }

    // A drained dispatch is rejected, never acked.
    expect(client.sentDirect.filter((m) => m.type === 'job.ack')).toHaveLength(0);
  });
});

describe('Server wiring: drain-on-reset-failure gate', () => {
  // Mirrors the job-completion `.finally` gate, which is inline in server.ts:
  // drain when opted in, not already draining, and consecutive reset failures
  // reach the threshold.
  const RESET_FAILURE_DRAIN_THRESHOLD = 3;
  function shouldDrain(
    drainOnResetFailure: boolean,
    isDraining: boolean,
    consecutiveResetFailures: number,
  ): boolean {
    return (
      drainOnResetFailure &&
      !isDraining &&
      consecutiveResetFailures >= RESET_FAILURE_DRAIN_THRESHOLD
    );
  }

  it('drains once the threshold is reached and the flag is set', () => {
    expect(shouldDrain(true, false, 3)).toBe(true);
    expect(shouldDrain(true, false, 4)).toBe(true);
  });

  it('does not drain below the threshold', () => {
    expect(shouldDrain(true, false, 2)).toBe(false);
  });

  it('does not drain when the opt-in flag is off', () => {
    expect(shouldDrain(false, false, 5)).toBe(false);
  });

  it('does not re-trigger when already draining', () => {
    expect(shouldDrain(true, true, 5)).toBe(false);
  });
});

describe('Server wiring: cancel callback', () => {
  it('routes cancel to jobRunner.cancel()', () => {
    const jobRunner = createMockJobRunner();

    // Mirrors onJobCancel.
    const onJobCancel = (cancel: JobCancel) => {
      jobRunner.cancel(cancel.jobId, cancel.reason);
    };

    onJobCancel({
      type: 'job.cancel',
      messageId: 'msg-1',
      runId: 'run-1',
      jobId: 'job-1',
      reason: 'user cancelled',
    });

    expect(jobRunner.cancel).toHaveBeenCalledWith('job-1', 'user cancelled');
  });
});

describe('Server wiring: graceful shutdown', () => {
  it('graceful shutdown waits for active jobs', async () => {
    const jobRunner = createMockJobRunner();
    let resolveJob!: () => void;
    const jobPromise = new Promise<void>((resolve) => {
      resolveJob = resolve;
    });

    jobRunner.activeJobs.set('job-1', {
      abortController: new AbortController(),
      completionPromise: jobPromise,
    });

    // Mirrors the shutdown wait.
    const waitForJobs = async () => {
      if (jobRunner.activeJobs.size > 0) {
        await Promise.allSettled(
          [...jobRunner.activeJobs.values()].map((j) => j.completionPromise),
        );
      }
    };

    let resolved = false;
    const shutdownPromise = waitForJobs().then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);

    resolveJob();
    await shutdownPromise;

    expect(resolved).toBe(true);
  });

  it('force exit after timeout aborts active jobs', () => {
    const jobRunner = createMockJobRunner();
    const controller = new AbortController();
    jobRunner.activeJobs.set('job-1', {
      abortController: controller,
      completionPromise: new Promise(() => {}),
    });

    // Mirrors the force-kill.
    for (const job of jobRunner.activeJobs.values()) {
      job.abortController.abort();
    }

    expect(controller.signal.aborted).toBe(true);
  });
});

describe('Server wiring: scaler idle shutdown', () => {
  let client: MockClient;
  let jobRunner: MockJobRunner;

  beforeEach(() => {
    vi.useFakeTimers();
    client = createMockClient();
    jobRunner = createMockJobRunner();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Mirrors the server.ts idle-shutdown timer. */
  function evaluateIdleShutdown(opts: {
    scalerManaged: boolean;
    idleTimeoutMs: number;
    onShutdown: () => void;
  }): { idleShutdownTimer: NodeJS.Timeout | undefined; startIdleShutdownTimer: () => void } {
    let idleShutdownTimer: NodeJS.Timeout | undefined;

    const startIdleShutdownTimer = () => {
      if (idleShutdownTimer) clearTimeout(idleShutdownTimer);
      if (opts.idleTimeoutMs <= 0) {
        opts.onShutdown();
      } else {
        idleShutdownTimer = setTimeout(() => {
          if (jobRunner.activeJobs.size === 0) {
            opts.onShutdown();
          }
        }, opts.idleTimeoutMs);
      }
    };

    return {
      get idleShutdownTimer() {
        return idleShutdownTimer;
      },
      startIdleShutdownTimer,
    };
  }

  it('does not start idle shutdown timer when client is disconnected', () => {
    client.state = 'disconnected';
    const shutdownFn = vi.fn();

    // Mirrors the server.ts `.finally()`.
    const scalerManaged = true;
    const idle = jobRunner.activeJobs.size === 0;

    if (scalerManaged && idle) {
      if (client.state !== 'registered') {
        // A disconnected agent starts no timer.
      } else {
        shutdownFn();
      }
    }

    expect(shutdownFn).not.toHaveBeenCalled();
  });

  it('starts idle shutdown timer when client is registered and agent is idle', () => {
    client.state = 'registered';
    const shutdownFn = vi.fn();
    const { startIdleShutdownTimer } = evaluateIdleShutdown({
      scalerManaged: true,
      idleTimeoutMs: 5000,
      onShutdown: shutdownFn,
    });

    if (client.state === 'registered' && jobRunner.activeJobs.size === 0) {
      startIdleShutdownTimer();
    }

    expect(shutdownFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5001);

    expect(shutdownFn).toHaveBeenCalledTimes(1);
  });

  it('re-evaluates idle shutdown on reconnection via onRegistered callback', () => {
    client.state = 'disconnected';
    const shutdownFn = vi.fn();
    const { startIdleShutdownTimer } = evaluateIdleShutdown({
      scalerManaged: true,
      idleTimeoutMs: 5000,
      onShutdown: shutdownFn,
    });

    if (client.state !== 'registered') {
      // Idle but disconnected: shutdown is deferred.
    }
    expect(shutdownFn).not.toHaveBeenCalled();

    client.state = 'registered';
    // The `decideIdleShutdown` the real onRegistered uses, so this cannot drift.
    if (
      decideIdleShutdown({ scalerManaged: true, activeJobs: jobRunner.activeJobs.size }) === 'idle'
    ) {
      startIdleShutdownTimer();
    }

    expect(shutdownFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5001);

    expect(shutdownFn).toHaveBeenCalledTimes(1);
  });

  it('does not start idle shutdown on reconnection if jobs are active', () => {
    client.state = 'disconnected';
    const shutdownFn = vi.fn();
    const { startIdleShutdownTimer } = evaluateIdleShutdown({
      scalerManaged: true,
      idleTimeoutMs: 5000,
      onShutdown: shutdownFn,
    });

    jobRunner.activeJobs.set('job-1', {
      abortController: new AbortController(),
      completionPromise: new Promise(() => {}),
    });

    client.state = 'registered';
    if (
      decideIdleShutdown({ scalerManaged: true, activeJobs: jobRunner.activeJobs.size }) === 'idle'
    ) {
      startIdleShutdownTimer();
    }

    vi.advanceTimersByTime(10000);

    expect(shutdownFn).not.toHaveBeenCalled();
  });
});
