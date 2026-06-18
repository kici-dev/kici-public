import { describe, it, expect } from 'vitest';
import { LocalWebhookNormalizer } from './normalizer.js';

describe('LocalWebhookNormalizer', () => {
  const normalizer = new LocalWebhookNormalizer();

  it('has provider set to local', () => {
    expect(normalizer.provider).toBe('local');
  });

  describe('extractRoutingKey', () => {
    it('returns x-kici-routing-key header value when present', () => {
      const headers = { 'x-kici-routing-key': 'generic:e2e:source-1' };
      expect(normalizer.extractRoutingKey(headers, {})).toBe('generic:e2e:source-1');
    });

    it('falls back to x-kici-source-id header', () => {
      const headers = { 'x-kici-source-id': 'generic:test:abc' };
      expect(normalizer.extractRoutingKey(headers, {})).toBe('generic:test:abc');
    });

    it('prefers x-kici-routing-key over x-kici-source-id', () => {
      const headers = {
        'x-kici-routing-key': 'generic:primary:key',
        'x-kici-source-id': 'generic:fallback:key',
      };
      expect(normalizer.extractRoutingKey(headers, {})).toBe('generic:primary:key');
    });

    it('returns null when no routing header present', () => {
      const headers = { 'x-event-type': 'push' };
      expect(normalizer.extractRoutingKey(headers, {})).toBeNull();
    });
  });

  describe('extractDeliveryId', () => {
    it('extracts from x-delivery-id header', () => {
      const headers = { 'x-delivery-id': 'delivery-abc-123' };
      expect(normalizer.extractDeliveryId(headers)).toBe('delivery-abc-123');
    });

    it('falls back to x-request-id header', () => {
      const headers = { 'x-request-id': 'req-456' };
      expect(normalizer.extractDeliveryId(headers)).toBe('req-456');
    });

    it('prefers x-delivery-id over x-request-id', () => {
      const headers = {
        'x-delivery-id': 'delivery-first',
        'x-request-id': 'request-second',
      };
      expect(normalizer.extractDeliveryId(headers)).toBe('delivery-first');
    });

    it('returns null when no ID header present', () => {
      expect(normalizer.extractDeliveryId({})).toBeNull();
    });
  });

  describe('extractEventType', () => {
    it('extracts from x-event-type header', () => {
      const headers = { 'x-event-type': 'push' };
      expect(normalizer.extractEventType(headers)).toBe('push');
    });

    it('returns null when header is missing', () => {
      expect(normalizer.extractEventType({})).toBeNull();
    });
  });

  describe('verifySignature', () => {
    it('always returns true (no verification for local sources)', () => {
      expect(normalizer.verifySignature('body', {}, 'secret')).toBe(true);
      expect(normalizer.verifySignature('', {}, '')).toBe(true);
    });
  });

  describe('normalizeEvent', () => {
    it('normalizes a push event with refs/heads/ prefix', () => {
      const result = normalizer.normalizeEvent('push', null, {
        ref: 'refs/heads/master',
        repository: { full_name: 'test/repo' },
      });

      expect(result).toEqual({
        type: 'push',
        action: undefined,
        targetBranch: 'master',
        payload: {
          ref: 'refs/heads/master',
          repository: { full_name: 'test/repo' },
        },
        provider: 'local',
      });
    });

    it('normalizes a push event with refs/tags/ prefix', () => {
      const result = normalizer.normalizeEvent('tag', null, {
        ref: 'refs/tags/v1.0.0',
      });

      expect(result).toEqual({
        type: 'tag',
        action: undefined,
        targetBranch: 'v1.0.0',
        payload: { ref: 'refs/tags/v1.0.0' },
        provider: 'local',
      });
    });

    it('normalizes a push event with bare ref (no prefix)', () => {
      const result = normalizer.normalizeEvent('push', null, {
        ref: 'feature/test',
      });

      expect(result).toEqual({
        type: 'push',
        action: undefined,
        targetBranch: 'feature/test',
        payload: { ref: 'feature/test' },
        provider: 'local',
      });
    });

    it('uses __local__ when no ref in payload', () => {
      const result = normalizer.normalizeEvent('generic_webhook', null, {
        data: 'test-data',
      });

      expect(result).toEqual({
        type: 'generic_webhook',
        action: undefined,
        targetBranch: '__local__',
        payload: { data: 'test-data' },
        provider: 'local',
      });
    });

    it('extracts action from payload when present', () => {
      const result = normalizer.normalizeEvent('pull_request', null, {
        action: 'opened',
        ref: 'refs/heads/main',
        pull_request: { base: { ref: 'main' } },
      });

      expect(result).toEqual({
        type: 'pull_request',
        action: 'opened',
        targetBranch: 'main',
        payload: {
          action: 'opened',
          ref: 'refs/heads/main',
          pull_request: { base: { ref: 'main' } },
        },
        provider: 'local',
      });
    });

    it('handles null payload gracefully', () => {
      const result = normalizer.normalizeEvent('test', null, null);

      expect(result).toEqual({
        type: 'test',
        action: undefined,
        targetBranch: '__local__',
        payload: {},
        provider: 'local',
      });
    });

    it('ignores action parameter (uses payload.action instead)', () => {
      const result = normalizer.normalizeEvent('push', 'from-param', {
        action: 'from-payload',
      });

      expect(result?.action).toBe('from-payload');
    });
  });

  describe('extractRepoIdentifier', () => {
    it('extracts from repository.full_name', () => {
      const payload = { repository: { full_name: 'test/repo' } };
      expect(normalizer.extractRepoIdentifier(payload)).toBe('test/repo');
    });

    it('falls back to owner.login/name', () => {
      const payload = { repository: { owner: { login: 'org' }, name: 'repo' } };
      expect(normalizer.extractRepoIdentifier(payload)).toBe('org/repo');
    });

    it('returns null when no repository info', () => {
      expect(normalizer.extractRepoIdentifier({})).toBeNull();
    });
  });

  describe('extractRef', () => {
    it('extracts payload.after for push events', () => {
      expect(normalizer.extractRef('push', { after: 'sha123' })).toBe('sha123');
    });

    it('extracts pull_request.head.sha for PR events', () => {
      const payload = { pull_request: { head: { sha: 'pr-sha' } } };
      expect(normalizer.extractRef('pull_request', payload)).toBe('pr-sha');
    });

    it('returns HEAD for unknown event types', () => {
      expect(normalizer.extractRef('custom_event', {})).toBe('HEAD');
    });
  });

  describe('extractCredentials', () => {
    it('returns empty object', () => {
      expect(normalizer.extractCredentials({ installation: { id: 123 } })).toEqual({});
    });
  });

  describe('getAccessCacheInvalidations', () => {
    it('returns repo-user for member events', () => {
      const payload = {
        action: 'added',
        repository: { full_name: 'acme/frontend' },
        member: { login: 'alice' },
      };
      expect(normalizer.getAccessCacheInvalidations('member', 'added', payload)).toEqual([
        { kind: 'repo-user', repoFullName: 'acme/frontend', username: 'alice' },
      ]);
    });

    it('returns user-in-org for organization events', () => {
      const payload = {
        action: 'member_added',
        organization: { login: 'acme' },
        membership: { user: { login: 'bob' } },
      };
      expect(
        normalizer.getAccessCacheInvalidations('organization', 'member_added', payload),
      ).toEqual([{ kind: 'user-in-org', orgLogin: 'acme', username: 'bob' }]);
    });

    it('returns user-in-org for membership events', () => {
      const payload = {
        action: 'added',
        organization: { login: 'acme' },
        member: { login: 'charlie' },
      };
      expect(normalizer.getAccessCacheInvalidations('membership', 'added', payload)).toEqual([
        { kind: 'user-in-org', orgLogin: 'acme', username: 'charlie' },
      ]);
    });

    it('returns repo for team repo-scoped events', () => {
      const payload = {
        action: 'added_to_repository',
        repository: { full_name: 'acme/backend' },
      };
      expect(
        normalizer.getAccessCacheInvalidations('team', 'added_to_repository', payload),
      ).toEqual([{ kind: 'repo', repoFullName: 'acme/backend' }]);
    });

    it('returns empty for non-membership events (push / pull_request / etc.)', () => {
      expect(normalizer.getAccessCacheInvalidations('push', null, {})).toEqual([]);
      expect(normalizer.getAccessCacheInvalidations('pull_request', 'opened', {})).toEqual([]);
    });

    it('returns empty for malformed payloads without throwing', () => {
      expect(normalizer.getAccessCacheInvalidations('member', 'added', null)).toEqual([]);
      expect(normalizer.getAccessCacheInvalidations('member', 'added', {})).toEqual([]);
    });
  });
});
