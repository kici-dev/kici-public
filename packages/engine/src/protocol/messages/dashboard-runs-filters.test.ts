import { describe, it, expect } from 'vitest';
import {
  dashboardRunsFiltersRequestSchema,
  dashboardRunsFiltersResponseSchema,
} from './dashboard.js';

describe('dashboard.runs.filters schema', () => {
  it('validates request', () => {
    expect(
      dashboardRunsFiltersRequestSchema.safeParse({
        type: 'dashboard.runs.filters',
        requestId: 'r',
        actor: { type: 'platform_operator', sub: 'op', reason: 'INC-1 looking now' },
      }).success,
    ).toBe(true);
  });
  it('validates response', () => {
    expect(
      dashboardRunsFiltersResponseSchema.safeParse({
        type: 'dashboard.runs.filters.response',
        requestId: 'r',
        statuses: ['success'],
        workflows: ['ci'],
        branches: ['main'],
        repositories: ['o/r'],
        triggerTypes: ['push'],
        sources: [{ routingKey: 'github:1', name: 'o/r' }],
      }).success,
    ).toBe(true);
  });
});
