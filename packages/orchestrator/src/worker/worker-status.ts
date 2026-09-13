/**
 * Worker /status and /drain HTTP endpoint handlers.
 *
 * - GET /status -- returns worker instance info, connection state, agents, active/recent jobs
 * - POST /drain -- sets draining flag, returns active job count
 *
 * These are mounted on the worker's HTTP server in worker-core.ts.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { InMemoryExecutionTracker } from './in-memory-execution-tracker.js';
import type { AgentRegistry } from '../agent/registry.js';
import type { PeerClient } from '../cluster/peer-client.js';

export interface WorkerStatusDeps {
  instanceId: string;
  executionTracker: InMemoryExecutionTracker;
  agentRegistry: AgentRegistry;
  peerClient: PeerClient;
  startedAt: number;
  getDraining: () => boolean;
  setDraining: (v: boolean) => void;
}

/**
 * Create a handler for GET /status.
 *
 * Returns worker instance info including role, coordinator connection state,
 * draining flag, uptime, agent counts, active jobs, and recent job history.
 */
export function createWorkerStatusHandler(deps: WorkerStatusDeps) {
  return (_req: IncomingMessage, res: ServerResponse) => {
    const agents = [...deps.agentRegistry.getAllEntries()];
    const activeJobs = agents.reduce((sum, a) => sum + a.activeJobs, 0);
    const recentJobs = deps.executionTracker.getRecentJobs().slice(0, 20);

    const status = {
      instanceId: deps.instanceId,
      role: 'worker' as const,
      coordinatorConnection: deps.peerClient.state,
      draining: deps.getDraining(),
      uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
      agents: {
        total: agents.length,
        active: agents.filter((a) => a.activeJobs > 0).length,
        idle: agents.filter((a) => a.activeJobs === 0).length,
      },
      activeJobs,
      recentJobs,
    };

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status));
  };
}

/**
 * Create a handler for POST /drain.
 *
 * Sets the draining flag to true and returns the current active job count.
 * Idempotent -- calling multiple times has no additional effect.
 */
export function createWorkerDrainHandler(deps: WorkerStatusDeps) {
  return (_req: IncomingMessage, res: ServerResponse) => {
    deps.setDraining(true);
    const agents = [...deps.agentRegistry.getAllEntries()];
    const activeJobs = agents.reduce((sum, a) => sum + a.activeJobs, 0);

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ draining: true, activeJobs }));
  };
}
