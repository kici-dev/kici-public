import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger } from '@kici-dev/core';
import { diagnosticsCommand } from './diagnostics.js';
import * as clientMod from '../remote/dashboard-client.js';

afterEach(() => vi.restoreAllMocks());

function fakeClient(overrides: Partial<clientMod.DashboardClient>): clientMod.DashboardClient {
  return overrides as unknown as clientMod.DashboardClient;
}

const summary = {
  connections: [],
  executionMetrics: {
    totalRuns: 3,
    successRate: 100,
    avgDurationSeconds: 5,
    queuedJobs: 0,
    runningJobs: 1,
  },
  orphanedConnections: 0,
};

describe('diagnosticsCommand', () => {
  it('renders the orchestrator tree with agent labels', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue(
      fakeClient({
        getDiagnosticsSummary: async () => summary as never,
        getInfrastructure: async () =>
          ({
            orchestrators: [
              {
                connectionId: 'c1',
                clusterName: 'cluster-a',
                routingKeys: ['github:1'],
                connected: true,
                agentCount: 1,
                runningJobs: 1,
                queuedJobs: 0,
                pendingLabelGaps: [],
                scalerBackends: [],
                statefulAgentCount: 0,
                scalers: [
                  {
                    name: 's1',
                    type: 'container',
                    maxAgents: 5,
                    activeAgents: 1,
                    labelSets: [['linux']],
                    hosts: [],
                  },
                ],
                agents: [
                  {
                    agentId: 'a1',
                    labels: ['linux', 'x64'],
                    platform: 'linux',
                    arch: 'x64',
                    activeJobs: 1,
                    maxConcurrency: 2,
                    lastHeartbeatAt: 1,
                    registeredAt: 1,
                    scalerName: 's1',
                  },
                ],
              },
            ],
            alerts: [],
          }) as never,
      }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await diagnosticsCommand({});
    expect(ok).toBe(true);
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('cluster-a');
    expect(printed).toContain('s1');
    expect(printed).toContain('linux');
  });

  it('emits raw JSON with --json', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue(
      fakeClient({
        getDiagnosticsSummary: async () => summary as never,
        getInfrastructure: async () => ({ orchestrators: [], alerts: [] }) as never,
      }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await diagnosticsCommand({ json: true });
    expect(log.mock.calls.some((c) => String(c[0]).includes('"orchestrators"'))).toBe(true);
  });

  it('scopes the tree to a single orchestrator with --orchestrator', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue(
      fakeClient({
        getDiagnosticsSummary: async () => summary as never,
        getInfrastructure: async () =>
          ({
            orchestrators: [
              {
                connectionId: 'c1',
                clusterName: 'cluster-a',
                routingKeys: [],
                connected: true,
                agentCount: 0,
                runningJobs: 0,
                queuedJobs: 0,
                pendingLabelGaps: [],
                scalerBackends: [],
                statefulAgentCount: 0,
                scalers: [],
                agents: [],
              },
              {
                connectionId: 'c2',
                clusterName: 'cluster-b',
                routingKeys: [],
                connected: true,
                agentCount: 0,
                runningJobs: 0,
                queuedJobs: 0,
                pendingLabelGaps: [],
                scalerBackends: [],
                statefulAgentCount: 0,
                scalers: [],
                agents: [],
              },
            ],
            alerts: [],
          }) as never,
      }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await diagnosticsCommand({ orchestrator: 'c2' });
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('cluster-b');
    expect(printed).not.toContain('cluster-a');
  });

  it('returns false and reports a clear message when not logged in', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockRejectedValue(
      new clientMod.DashboardClientError('not_logged_in', 'Not logged in. Run `kici login` first.'),
    );
    const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const ok = await diagnosticsCommand({});
    expect(ok).toBe(false);
    expect(errSpy).toHaveBeenCalled();
  });
});
