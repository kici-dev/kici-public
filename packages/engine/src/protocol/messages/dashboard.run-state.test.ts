import { describe, it, expect } from 'vitest';
import {
  dashboardRunStateRequestSchema,
  dashboardRunStateResponseSchema,
  dashboardPlatformToOrchSchema,
  dashboardOrchToPlatformSchema,
} from './dashboard.js';

const systemActor = { type: 'system' as const, component: 'run-reconciler' };

const sampleRun = {
  runId: 'run-1',
  workflowName: 'ci',
  status: 'success' as const,
  jobCount: 1,
  startedAt: 1_700_000_000_000,
  jobs: [{ jobId: 'j1', jobName: 'build', status: 'success' }],
};

describe('dashboard.run.state protocol', () => {
  it('request parses and is in the platform→orch union', () => {
    expect(() =>
      dashboardRunStateRequestSchema.parse({
        type: 'dashboard.run.state',
        requestId: 'r1',
        actor: systemActor,
        runId: 'run-1',
      }),
    ).not.toThrow();
    const reqTypes = dashboardPlatformToOrchSchema.options.map((o) => o.shape.type.value);
    expect(reqTypes).toContain('dashboard.run.state');
  });

  it('response (run present) parses and is in the orch→platform union', () => {
    expect(() =>
      dashboardRunStateResponseSchema.parse({
        type: 'dashboard.run.state.response',
        requestId: 'r1',
        run: sampleRun,
      }),
    ).not.toThrow();
    const respTypes = dashboardOrchToPlatformSchema.options.map((o) => o.shape.type.value);
    expect(respTypes).toContain('dashboard.run.state.response');
  });

  it('response accepts a null run (unknown run id)', () => {
    expect(() =>
      dashboardRunStateResponseSchema.parse({
        type: 'dashboard.run.state.response',
        requestId: 'r2',
        run: null,
      }),
    ).not.toThrow();
  });
});
