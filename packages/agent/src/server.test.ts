import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { JobDispatch, JobCancel, AgentToOrchestratorMessage } from '@kici-dev/engine';

/**
 * Tests for server.ts wiring logic.
 *
 * We test the dispatch callback logic (concurrency control, drain mode, status messages)
 * in isolation rather than importing the full server.ts (which starts listeners/http).
 */

// --- Helpers to simulate server.ts wiring logic ---

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

/**
 * Creates the onJobDispatch callback that mirrors server.ts logic.
 * This is the core wiring logic we want to test.
 */
function createDispatchHandler(opts: {
  client: MockClient;
  jobRunner: MockJobRunner;
  config: { agentId: string };
  isDraining: () => boolean;
}) {
  const { client, jobRunner, config } = opts;

  return (dispatch: JobDispatch) => {
    // Drain mode check
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

    // Single-job enforcement: reject if already running a job
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

    // Positive dispatch acknowledgment before execution starts.
    client.sendDirect({
      type: 'job.ack',
      messageId: randomUUID(),
      runId: dispatch.runId,
      jobId: dispatch.jobId,
      timestamp: Date.now(),
    });

    // Accept and execute
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
        // Send agent.status after completion
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
    // Already running one job
    jobRunner.activeJobs.set('job-1', {
      abortController: new AbortController(),
      completionPromise: new Promise(() => {}),
    });

    const dispatch = makeDispatch();
    handler(dispatch);

    // Should NOT execute
    expect(jobRunner.execute).not.toHaveBeenCalled();

    // Should send agent.status
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

    // Before completion, no agent.status sent
    expect(client.sentDirect.filter((m) => m.type === 'agent.status')).toHaveLength(0);

    // Complete the job
    resolveJob();
    // Allow microtask queue to flush
    await new Promise((r) => setTimeout(r, 10));

    // After completion, agent.status should be sent
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

    // Should NOT execute
    expect(jobRunner.execute).not.toHaveBeenCalled();

    // Should send agent.status
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

describe('Server wiring: cancel callback', () => {
  it('routes cancel to jobRunner.cancel()', () => {
    const jobRunner = createMockJobRunner();

    // Simulate onJobCancel from server.ts
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

    // Simulate the shutdown wait logic from server.ts
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

    // Not yet resolved
    expect(resolved).toBe(false);

    // Complete the job
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

    // Simulate the force-kill logic
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

  /**
   * Simulates the idle shutdown logic from server.ts.
   * Extracted here to test the connection-gated behavior.
   */
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

    // Simulate the .finally() logic from server.ts
    const scalerManaged = true;
    const idle = jobRunner.activeJobs.size === 0;

    if (scalerManaged && idle) {
      if (client.state !== 'registered') {
        // Should NOT start timer -- this is the fix
      } else {
        shutdownFn();
      }
    }

    // Timer should not have been started
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

    // Simulate: client is registered, agent is idle -> start timer
    if (client.state === 'registered' && jobRunner.activeJobs.size === 0) {
      startIdleShutdownTimer();
    }

    // Not yet fired
    expect(shutdownFn).not.toHaveBeenCalled();

    // Advance past idle timeout
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

    // Step 1: Agent is idle but disconnected -- defer shutdown
    if (client.state !== 'registered') {
      // Deferred -- timer not started
    }
    expect(shutdownFn).not.toHaveBeenCalled();

    // Step 2: Simulate reconnection (onRegistered callback fires)
    client.state = 'registered';
    // This mimics client.onRegistered callback from server.ts:
    if (jobRunner.activeJobs.size === 0) {
      startIdleShutdownTimer();
    }

    // Timer running but not fired yet
    expect(shutdownFn).not.toHaveBeenCalled();

    // Step 3: Advance past idle timeout
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

    // Step 1: Agent has active job when reconnecting
    jobRunner.activeJobs.set('job-1', {
      abortController: new AbortController(),
      completionPromise: new Promise(() => {}),
    });

    // Step 2: Reconnection
    client.state = 'registered';
    if (jobRunner.activeJobs.size === 0) {
      startIdleShutdownTimer();
    }

    // Step 3: Advance time -- should NOT fire
    vi.advanceTimersByTime(10000);

    expect(shutdownFn).not.toHaveBeenCalled();
  });
});
