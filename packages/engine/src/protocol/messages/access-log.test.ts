import { describe, it, expect } from 'vitest';
import { accessLogItemSchema, dashboardAccessLogListRequestSchema } from './access-log.js';

describe('dashboardAccessLogListRequestSchema', () => {
  it('accepts agentLabel and agentOnly filters', () => {
    const r = dashboardAccessLogListRequestSchema.parse({
      type: 'dashboard.access-log.list',
      requestId: 'r1',
      actor: { type: 'user', sub: 'u1' },
      orgId: 'o1',
      agentLabel: 'cc',
      agentOnly: true,
    });
    expect(r.agentLabel).toBe('cc');
    expect(r.agentOnly).toBe(true);
  });

  it('parses without the agent filters (both optional)', () => {
    const r = dashboardAccessLogListRequestSchema.parse({
      type: 'dashboard.access-log.list',
      requestId: 'r1',
      actor: { type: 'user', sub: 'u1' },
      orgId: 'o1',
    });
    expect(r.agentLabel).toBeUndefined();
    expect(r.agentOnly).toBeUndefined();
  });
});

describe('accessLogItemSchema', () => {
  it('carries a first-class agentLabel field', () => {
    const item = accessLogItemSchema.parse({
      id: 'a1',
      orgId: 'o1',
      routingKey: null,
      actorType: 'api_key',
      actorId: 'k1',
      actorMeta: { ownerSub: 'u1', agentLabel: 'ci-bot' },
      action: 'run.trigger',
      targetType: null,
      targetId: null,
      requestId: null,
      source: 'platform_proxy',
      outcome: 'allowed',
      errorMessage: null,
      agentLabel: 'ci-bot',
      createdAt: '2026-06-30T00:00:00.000Z',
    });
    expect(item.agentLabel).toBe('ci-bot');
  });
});
