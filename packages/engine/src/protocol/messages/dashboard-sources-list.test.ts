import { describe, it, expect } from 'vitest';
import {
  dashboardSourcesListRequestSchema,
  dashboardSourcesListResponseSchema,
} from './dashboard.js';

describe('dashboard.sources.list schema', () => {
  it('validates a request', () => {
    const r = dashboardSourcesListRequestSchema.safeParse({
      type: 'dashboard.sources.list',
      requestId: 'req-1',
      actor: { type: 'platform_operator', sub: 'op', reason: 'INC-1 looking now' },
      limit: 50,
    });
    expect(r.success).toBe(true);
  });

  it('validates a response with source summaries', () => {
    const r = dashboardSourcesListResponseSchema.safeParse({
      type: 'dashboard.sources.list.response',
      requestId: 'req-1',
      sources: [
        {
          routingKey: 'github:42',
          name: 'acme/repo',
          provider: 'github',
          subtype: 'github_app',
          enabled: true,
          createdAt: '2026-05-30T10:00:00.000Z',
        },
        {
          routingKey: 'generic:org_x:abc',
          name: 'webhook',
          provider: 'generic',
          subtype: 'generic_webhook',
          enabled: false,
          createdAt: '2026-05-30T10:00:00.000Z',
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('rejects a request with limit out of range', () => {
    expect(
      dashboardSourcesListRequestSchema.safeParse({
        type: 'dashboard.sources.list',
        requestId: 'r',
        actor: { type: 'platform_operator', sub: 'op', reason: 'INC-1 looking now' },
        limit: 9999,
      }).success,
    ).toBe(false);
  });
});
