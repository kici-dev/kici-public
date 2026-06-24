import { describe, it, expect } from 'vitest';
import {
  dashboardFleetHostsRequestSchema,
  dashboardFleetHostRequestSchema,
  dashboardFleetPreviewRequestSchema,
  dashboardFleetHostsResponseSchema,
  dashboardFleetHostResponseSchema,
  dashboardFleetPreviewResponseSchema,
  dashboardPlatformToOrchSchema,
  dashboardOrchToPlatformSchema,
} from './dashboard.js';

const sampleHost = {
  agentId: 'agent-1',
  labels: ['region:eu', 'gpu'],
  properties: { cores: 8 },
  hostname: 'host-1',
  platform: 'linux',
  arch: 'x64',
  lifecycleClass: 'static' as const,
  status: 'ready' as const,
  lastSeen: '2026-06-23T00:00:00.000Z',
};

describe('fleet read protocol', () => {
  it('hosts request/response parse and are in the unions', () => {
    expect(() =>
      dashboardFleetHostsRequestSchema.parse({
        type: 'dashboard.fleet.hosts',
        requestId: 'r1',
        actor: { type: 'user', sub: 'u1' },
      }),
    ).not.toThrow();
    expect(() =>
      dashboardFleetHostsResponseSchema.parse({
        type: 'dashboard.fleet.hosts.response',
        requestId: 'r1',
        hosts: [sampleHost],
      }),
    ).not.toThrow();
    const reqTypes = dashboardPlatformToOrchSchema.options.map((o) => o.shape.type.value);
    expect(reqTypes).toContain('dashboard.fleet.hosts');
    const respTypes = dashboardOrchToPlatformSchema.options.map((o) => o.shape.type.value);
    expect(respTypes).toContain('dashboard.fleet.hosts.response');
  });

  it('host detail request/response parse and are in the unions', () => {
    expect(() =>
      dashboardFleetHostRequestSchema.parse({
        type: 'dashboard.fleet.host',
        requestId: 'r2',
        actor: { type: 'user', sub: 'u1' },
        agentId: 'agent-1',
      }),
    ).not.toThrow();
    expect(() =>
      dashboardFleetHostResponseSchema.parse({
        type: 'dashboard.fleet.host.response',
        requestId: 'r2',
        host: sampleHost,
        runs: [
          {
            runId: 'run-1',
            workflowName: 'deploy',
            status: 'success',
            createdAt: '2026-06-23T00:00:00.000Z',
          },
        ],
      }),
    ).not.toThrow();
    // null host is valid (host not in roster)
    expect(() =>
      dashboardFleetHostResponseSchema.parse({
        type: 'dashboard.fleet.host.response',
        requestId: 'r2',
        host: null,
        runs: [],
      }),
    ).not.toThrow();
    const reqTypes = dashboardPlatformToOrchSchema.options.map((o) => o.shape.type.value);
    expect(reqTypes).toContain('dashboard.fleet.host');
    const respTypes = dashboardOrchToPlatformSchema.options.map((o) => o.shape.type.value);
    expect(respTypes).toContain('dashboard.fleet.host.response');
  });

  it('preview request/response parse and are in the unions', () => {
    expect(() =>
      dashboardFleetPreviewRequestSchema.parse({
        type: 'dashboard.fleet.preview',
        requestId: 'r3',
        actor: { type: 'user', sub: 'u1' },
        workflowName: 'fanout',
      }),
    ).not.toThrow();
    expect(() =>
      dashboardFleetPreviewResponseSchema.parse({
        type: 'dashboard.fleet.preview.response',
        requestId: 'r3',
        matched: [{ entry: sampleHost, disposition: 'target' }],
        onUnreachable: 'hold',
        estimatedChildCount: 1,
      }),
    ).not.toThrow();
    const reqTypes = dashboardPlatformToOrchSchema.options.map((o) => o.shape.type.value);
    expect(reqTypes).toContain('dashboard.fleet.preview');
    const respTypes = dashboardOrchToPlatformSchema.options.map((o) => o.shape.type.value);
    expect(respTypes).toContain('dashboard.fleet.preview.response');
  });
});
