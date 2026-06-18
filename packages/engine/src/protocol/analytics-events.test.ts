import { describe, expect, it } from 'vitest';
import { AnalyticsEvent, ANALYTICS_EVENTS } from './analytics-events.ts';

describe('AnalyticsEvent', () => {
  it('accepts every catalogued event name', () => {
    for (const name of ANALYTICS_EVENTS) {
      expect(AnalyticsEvent.parse(name)).toBe(name);
    }
  });

  it('rejects an unknown event name', () => {
    expect(() => AnalyticsEvent.parse('not_an_event')).toThrow();
  });

  it('exposes the feasible dashboard + docs events', () => {
    expect(ANALYTICS_EVENTS).toEqual(
      expect.arrayContaining([
        'login',
        'org_created',
        'secret_created',
        'workflow_run_triggered',
        'run_viewed',
        'billing_plan_selected',
        'code_copy',
        'docs_search',
        'cta_dashboard',
      ]),
    );
  });
});
