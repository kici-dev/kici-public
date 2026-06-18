import { describe, it, expect, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createWorkerStatusHandler,
  createWorkerDrainHandler,
  type WorkerStatusDeps,
} from './worker-status.js';

/** Minimal mock for InMemoryExecutionTracker.getRecentJobs */
function createMockTracker(recentJobs: any[] = []) {
  return {
    getRecentJobs: () => recentJobs,
  };
}

/** Minimal mock for AgentRegistry.getAllEntries */
function createMockAgentRegistry(entries: any[] = []) {
  return {
    getAllEntries: function* () {
      yield* entries;
    },
  };
}

/** Minimal mock for PeerClient.state */
function createMockPeerClient(state: string = 'connected') {
  return {
    get state() {
      return state;
    },
  };
}

/** Create a mock ServerResponse that captures the JSON output */
function createMockRes(): ServerResponse & { _body: string; _status: number } {
  const res = {
    _body: '',
    _status: 200,
    writeHead(status: number, _headers: Record<string, string>) {
      res._status = status;
      return res;
    },
    end(body: string) {
      res._body = body;
    },
  } as any;
  return res;
}

function createDeps(overrides: Partial<WorkerStatusDeps> = {}): WorkerStatusDeps {
  let draining = false;
  return {
    instanceId: 'worker-1',
    executionTracker: createMockTracker() as any,
    agentRegistry: createMockAgentRegistry() as any,
    peerClient: createMockPeerClient() as any,
    startedAt: Date.now() - 60_000, // 60 seconds ago
    getDraining: () => draining,
    setDraining: (v: boolean) => {
      draining = v;
    },
    ...overrides,
  };
}

describe('createWorkerStatusHandler', () => {
  it('returns role=worker', () => {
    const deps = createDeps();
    const handler = createWorkerStatusHandler(deps);
    const res = createMockRes();
    handler({} as IncomingMessage, res);

    const body = JSON.parse(res._body);
    expect(body.role).toBe('worker');
  });

  it('includes coordinatorConnection state', () => {
    const deps = createDeps({
      peerClient: createMockPeerClient('connecting') as any,
    });
    const handler = createWorkerStatusHandler(deps);
    const res = createMockRes();
    handler({} as IncomingMessage, res);

    const body = JSON.parse(res._body);
    expect(body.coordinatorConnection).toBe('connecting');
  });

  it('includes recentJobs from tracker', () => {
    const recentJobs = [
      {
        runId: 'r1',
        jobId: 'j1',
        jobName: 'build',
        status: 'success',
        startedAt: 1000,
        completedAt: 2000,
        durationMs: 1000,
      },
    ];
    const deps = createDeps({
      executionTracker: createMockTracker(recentJobs) as any,
    });
    const handler = createWorkerStatusHandler(deps);
    const res = createMockRes();
    handler({} as IncomingMessage, res);

    const body = JSON.parse(res._body);
    expect(body.recentJobs).toHaveLength(1);
    expect(body.recentJobs[0].jobName).toBe('build');
  });

  it('shows correct agent counts', () => {
    const agents = [
      { agentId: 'a1', activeJobs: 2 },
      { agentId: 'a2', activeJobs: 0 },
      { agentId: 'a3', activeJobs: 1 },
    ];
    const deps = createDeps({
      agentRegistry: createMockAgentRegistry(agents) as any,
    });
    const handler = createWorkerStatusHandler(deps);
    const res = createMockRes();
    handler({} as IncomingMessage, res);

    const body = JSON.parse(res._body);
    expect(body.agents.total).toBe(3);
    expect(body.agents.active).toBe(2);
    expect(body.agents.idle).toBe(1);
    expect(body.activeJobs).toBe(3);
  });

  it('shows draining=true after drain', () => {
    const deps = createDeps();
    const drainHandler = createWorkerDrainHandler(deps);
    const statusHandler = createWorkerStatusHandler(deps);

    // Drain first
    const drainRes = createMockRes();
    drainHandler({} as IncomingMessage, drainRes);

    // Then check status
    const statusRes = createMockRes();
    statusHandler({} as IncomingMessage, statusRes);

    const body = JSON.parse(statusRes._body);
    expect(body.draining).toBe(true);
  });

  it('limits recentJobs to 20', () => {
    const recentJobs = Array.from({ length: 30 }, (_, i) => ({
      runId: `r${i}`,
      jobId: `j${i}`,
      jobName: `job-${i}`,
      status: 'success',
      startedAt: i * 1000,
      completedAt: (i + 1) * 1000,
      durationMs: 1000,
    }));
    const deps = createDeps({
      executionTracker: createMockTracker(recentJobs) as any,
    });
    const handler = createWorkerStatusHandler(deps);
    const res = createMockRes();
    handler({} as IncomingMessage, res);

    const body = JSON.parse(res._body);
    expect(body.recentJobs).toHaveLength(20);
  });
});

describe('createWorkerDrainHandler', () => {
  it('sets draining flag', () => {
    const deps = createDeps();
    const handler = createWorkerDrainHandler(deps);
    const res = createMockRes();
    handler({} as IncomingMessage, res);

    const body = JSON.parse(res._body);
    expect(body.draining).toBe(true);
    expect(deps.getDraining()).toBe(true);
  });

  it('is idempotent', () => {
    const deps = createDeps();
    const handler = createWorkerDrainHandler(deps);

    const res1 = createMockRes();
    handler({} as IncomingMessage, res1);
    const body1 = JSON.parse(res1._body);

    const res2 = createMockRes();
    handler({} as IncomingMessage, res2);
    const body2 = JSON.parse(res2._body);

    expect(body1.draining).toBe(true);
    expect(body2.draining).toBe(true);
  });
});
