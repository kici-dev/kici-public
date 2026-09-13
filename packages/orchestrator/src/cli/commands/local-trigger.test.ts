import { describe, it, expect } from 'vitest';
import { buildLocalTriggerRequest } from './local-trigger.js';

describe('buildLocalTriggerRequest', () => {
  it('builds a push webhook request from ref + sha + repo identifier', () => {
    const req = buildLocalTriggerRequest({
      orgId: 'org-1',
      sourceId: 'src-1',
      repoFullName: 'policy/repo',
      event: 'push',
      ref: 'refs/heads/main',
      sha: 'abc123',
      defaultBranch: 'main',
    });
    expect(req.path).toBe('/webhook/org-1/generic/src-1');
    expect(req.headers['x-event-type']).toBe('push');
    expect(req.headers['x-delivery-id']).toBeTruthy();
    const body = JSON.parse(req.body);
    expect(body.ref).toBe('refs/heads/main');
    expect(body.after).toBe('abc123');
    expect(body.repository.full_name).toBe('policy/repo');
    expect(body.repository.default_branch).toBe('main');
  });

  it('produces a distinct delivery id on each call (dedup-safe)', () => {
    const base = {
      orgId: 'o',
      sourceId: 's',
      repoFullName: 'a/b',
      event: 'push' as const,
      ref: 'refs/heads/main',
      sha: 'x',
      defaultBranch: 'main',
    };
    const a = buildLocalTriggerRequest(base);
    const b = buildLocalTriggerRequest(base);
    expect(a.headers['x-delivery-id']).not.toBe(b.headers['x-delivery-id']);
  });
});
