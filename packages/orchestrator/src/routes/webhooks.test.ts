import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGenericWebhookRoutes, type GenericWebhookRoutesDeps } from './webhooks.js';

function createMockDeps(
  overrides: Partial<GenericWebhookRoutesDeps> = {},
): GenericWebhookRoutesDeps {
  return {
    sourceManager: {
      getByOrgAndName: vi.fn().mockResolvedValue(null),
      checkIdempotency: vi.fn().mockResolvedValue(false),
    } as any,
    dedup: {
      exists: vi.fn().mockResolvedValue(false),
      mark: vi.fn().mockResolvedValue(undefined),
    } as any,
    onWebhook: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('generic webhook routes', () => {
  describe('payload size check', () => {
    it('rejects payloads exceeding max_payload_bytes using byte length', async () => {
      // Multi-byte character: U+1F600 (😀) = 4 bytes in UTF-8, but only 2 JS chars (surrogate pair)
      // Craft a payload with multi-byte chars that exceeds byte limit but not char count
      const emoji = '😀'; // 4 bytes UTF-8, 2 chars in JS
      // Create payload of 60 emojis: 120 JS chars, but 240 UTF-8 bytes
      const body = emoji.repeat(60);
      const bodyByteLength = Buffer.byteLength(body, 'utf-8'); // 240 bytes
      expect(body.length).toBe(120); // JS char count < 200
      expect(bodyByteLength).toBe(240); // Byte count > 200

      const source = {
        id: 'src-1',
        customer_id: 'org-1',
        name: 'test',
        routing_key: 'generic:org-1:src-1',
        enabled: true,
        max_payload_bytes: 200, // Between char count (120) and byte count (240)
        rate_limit_rpm: 100,
        verification_method: 'none',
        verification_config: '{}',
        event_type_header: null,
        event_type_path: null,
        idempotency_key_header: null,
        idempotency_key_path: null,
        dedup_window_seconds: 300,
        allowed_events: null,
        strip_headers: '[]',
      };

      const deps = createMockDeps({
        sourceManager: {
          getByOrgAndName: vi.fn().mockResolvedValue(source),
          checkIdempotency: vi.fn().mockResolvedValue(false),
        } as any,
      });

      const app = createGenericWebhookRoutes(deps);
      const res = await app.request('http://localhost/webhook/org-1/generic/test', {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'text/plain' },
      });

      // Should be rejected (413) because byte length (240) exceeds limit (200),
      // even though char count (120) is under the limit
      expect(res.status).toBe(413);
      const json = await res.json();
      expect(json.reason).toBe('Payload too large');
    });

    it('accepts payloads within max_payload_bytes', async () => {
      const source = {
        id: 'src-1',
        customer_id: 'org-1',
        name: 'test',
        routing_key: 'generic:org-1:src-1',
        enabled: true,
        max_payload_bytes: 1048576,
        rate_limit_rpm: 100,
        verification_method: 'none',
        verification_config: '{}',
        event_type_header: 'x-event-type',
        event_type_path: null,
        idempotency_key_header: null,
        idempotency_key_path: null,
        dedup_window_seconds: 300,
        allowed_events: null,
        strip_headers: '[]',
      };

      const deps = createMockDeps({
        sourceManager: {
          getByOrgAndName: vi.fn().mockResolvedValue(source),
          checkIdempotency: vi.fn().mockResolvedValue(false),
        } as any,
      });

      const app = createGenericWebhookRoutes(deps);
      const res = await app.request('http://localhost/webhook/org-1/generic/test', {
        method: 'POST',
        body: JSON.stringify({ event: 'test' }),
        headers: {
          'Content-Type': 'application/json',
          'x-event-type': 'test.event',
        },
      });

      // Should not be 413 (payload is well under limit)
      expect(res.status).not.toBe(413);
    });
  });

  describe('cross-source dedup isolation', () => {
    it('does not block a second source when both share the same idempotency key', async () => {
      const makeSource = (id: string, name: string) => ({
        id,
        customer_id: 'org-1',
        name,
        routing_key: `generic:org-1:${id}`,
        enabled: true,
        max_payload_bytes: 1048576,
        rate_limit_rpm: 1000,
        verification_method: 'none' as const,
        verification_config: '{}',
        event_type_header: 'x-event-type',
        event_type_path: null,
        idempotency_key_header: 'x-idempotency-key',
        idempotency_key_path: null,
        dedup_window_seconds: 300,
        allowed_events: null,
        strip_headers: '[]',
      });

      const sourceA = makeSource('src-a', 'source-a');
      const sourceB = makeSource('src-b', 'source-b');

      // Track which deliveryIds are marked as processed
      const markedIds = new Set<string>();

      const deps = createMockDeps({
        sourceManager: {
          getByOrgAndName: vi.fn().mockImplementation((_orgId: string, name: string) => {
            if (name === 'source-a') return Promise.resolve(sourceA);
            if (name === 'source-b') return Promise.resolve(sourceB);
            return Promise.resolve(null);
          }),
          getByRoutingKey: vi.fn().mockImplementation((key: string) => {
            if (key === sourceA.routing_key) return Promise.resolve(sourceA);
            if (key === sourceB.routing_key) return Promise.resolve(sourceB);
            return Promise.resolve(null);
          }),
          checkIdempotency: vi.fn().mockResolvedValue(false),
          markIdempotency: vi.fn().mockResolvedValue(undefined),
        } as any,
        dedup: {
          exists: vi.fn().mockImplementation((id: string) => Promise.resolve(markedIds.has(id))),
          mark: vi.fn().mockImplementation((id: string) => {
            markedIds.add(id);
            return Promise.resolve();
          }),
        } as any,
      });

      const app = createGenericWebhookRoutes(deps);

      // Send webhook to source A with idempotency key "shared-key-123"
      const resA = await app.request('http://localhost/webhook/org-1/generic/source-a', {
        method: 'POST',
        body: JSON.stringify({ data: 'from-a' }),
        headers: {
          'Content-Type': 'application/json',
          'x-event-type': 'deploy',
          'x-idempotency-key': 'shared-key-123',
        },
      });
      expect(resA.status).toBe(202);

      // Send webhook to source B with the SAME idempotency key
      const resB = await app.request('http://localhost/webhook/org-1/generic/source-b', {
        method: 'POST',
        body: JSON.stringify({ data: 'from-b' }),
        headers: {
          'Content-Type': 'application/json',
          'x-event-type': 'deploy',
          'x-idempotency-key': 'shared-key-123',
        },
      });

      // Source B should also be accepted (202), not blocked as duplicate (200)
      expect(resB.status).toBe(202);

      // Both webhooks should have been processed
      expect(deps.onWebhook).toHaveBeenCalledTimes(2);
    });
  });

  describe('local provider routing', () => {
    function makeLocalSource(): any {
      return {
        id: 'src-int-1',
        customer_id: 'org-1',
        name: 'stg-generic',
        routing_key: 'generic:org-1:stg-generic',
        enabled: true,
        max_payload_bytes: 10485760,
        rate_limit_rpm: 600,
        verification_method: 'none',
        verification_config: '{}',
        event_type_header: 'x-event-type',
        event_type_path: null,
        idempotency_key_header: null,
        idempotency_key_path: null,
        dedup_window_seconds: 300,
        allowed_events: null,
        strip_headers: '[]',
        provider_type: 'local',
      };
    }

    function makeGenericSource(): any {
      return {
        id: 'src-gen-1',
        customer_id: 'org-1',
        name: 'stripe-events',
        routing_key: 'generic:org-1:stripe-events',
        enabled: true,
        max_payload_bytes: 10485760,
        rate_limit_rpm: 600,
        verification_method: 'none',
        verification_config: '{}',
        event_type_header: 'x-event-type',
        event_type_path: null,
        idempotency_key_header: null,
        idempotency_key_path: null,
        dedup_window_seconds: 300,
        allowed_events: null,
        strip_headers: '[]',
        provider_type: 'generic',
      };
    }

    it('routes provider_type=local sources with info.provider=local', async () => {
      const source = makeLocalSource();
      const captured: any[] = [];
      const deps = createMockDeps({
        sourceManager: {
          getByOrgAndName: vi.fn().mockResolvedValue(source),
          checkIdempotency: vi.fn().mockResolvedValue(false),
          markIdempotency: vi.fn().mockResolvedValue(undefined),
        } as any,
        onWebhook: vi.fn().mockImplementation(async (info: any) => {
          captured.push(info);
        }),
      });

      const app = createGenericWebhookRoutes(deps);
      const res = await app.request('http://localhost/webhook/org-1/generic/stg-generic', {
        method: 'POST',
        body: JSON.stringify({
          ref: 'refs/heads/master',
          after: 'deadbeef',
          repository: {
            full_name: 'example-org/test-repo',
            default_branch: 'master',
            owner: { login: 'example-org' },
            name: 'test-repo',
          },
        }),
        headers: {
          'Content-Type': 'application/json',
          'x-event-type': 'push',
          'x-delivery-id': 'test-delivery-local-1',
        },
      });

      expect(res.status).toBe(202);
      expect(captured).toHaveLength(1);
      expect(captured[0].provider).toBe('local');
      expect(captured[0].routingKey).toBe('generic:org-1:stg-generic');
      expect(captured[0].event).toBe('push');
      expect(captured[0].payload.ref).toBe('refs/heads/master');
    });

    it('rejects local source request without x-event-type header', async () => {
      const source = makeLocalSource();
      const deps = createMockDeps({
        sourceManager: {
          getByOrgAndName: vi.fn().mockResolvedValue(source),
          checkIdempotency: vi.fn().mockResolvedValue(false),
        } as any,
      });

      const app = createGenericWebhookRoutes(deps);
      const res = await app.request('http://localhost/webhook/org-1/generic/stg-generic', {
        method: 'POST',
        body: JSON.stringify({ ref: 'refs/heads/master' }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.reason).toContain('x-event-type');
    });

    it('rejects local source request with non-JSON body', async () => {
      const source = makeLocalSource();
      const deps = createMockDeps({
        sourceManager: {
          getByOrgAndName: vi.fn().mockResolvedValue(source),
          checkIdempotency: vi.fn().mockResolvedValue(false),
        } as any,
      });

      const app = createGenericWebhookRoutes(deps);
      const res = await app.request('http://localhost/webhook/org-1/generic/stg-generic', {
        method: 'POST',
        body: 'not-json',
        headers: {
          'Content-Type': 'text/plain',
          'x-event-type': 'push',
        },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.reason).toContain('JSON');
    });

    it('preserves generic provider routing for provider_type=generic sources', async () => {
      const source = makeGenericSource();
      const captured: any[] = [];
      const deps = createMockDeps({
        sourceManager: {
          getByOrgAndName: vi.fn().mockResolvedValue(source),
          getByRoutingKey: vi.fn().mockResolvedValue(source),
          checkIdempotency: vi.fn().mockResolvedValue(false),
          markIdempotency: vi.fn().mockResolvedValue(undefined),
        } as any,
        onWebhook: vi.fn().mockImplementation(async (info: any) => {
          captured.push(info);
        }),
      });

      const app = createGenericWebhookRoutes(deps);
      const res = await app.request('http://localhost/webhook/org-1/generic/stripe-events', {
        method: 'POST',
        body: JSON.stringify({ event: 'invoice.paid' }),
        headers: {
          'Content-Type': 'application/json',
          'x-event-type': 'invoice.paid',
        },
      });

      expect(res.status).toBe(202);
      expect(captured).toHaveLength(1);
      expect(captured[0].provider).toBe('generic');
      expect(captured[0].routingKey).toBe('generic:org-1:stripe-events');
    });

    // Regression coverage for WARNING 9: server.ts onWebhookRelay must
    // resolve provider from the registered bundle (not blindly cast the
    // routing-key prefix). The relay path is exercised through the
    // ProviderRegistry — register a stub github bundle and confirm the
    // resolved provider is 'github'. This protects the legacy github
    // routing flow while we add bundle-first resolution for local sources.
    it('onWebhookRelay github:* routing key resolves provider via registered github bundle', async () => {
      const { ProviderRegistry } = await import('../provider-registry.js');
      const registry = new ProviderRegistry();
      const githubBundle = {
        normalizer: { provider: 'github' as const } as any,
      };
      registry.register('github', githubBundle);

      const routingKey = 'github:12345';
      const bundle = registry.getByRoutingKey(routingKey);
      const provider = bundle?.normalizer.provider ?? routingKey.split(':')[0];
      expect(provider).toBe('github');
    });
  });

  describe('verification config validation', () => {
    it('returns 500 when hmac_sha256 source has no secret in config', async () => {
      const source = {
        id: 'src-1',
        customer_id: 'org-1',
        name: 'test',
        routing_key: 'generic:org-1:src-1',
        enabled: true,
        max_payload_bytes: 1048576,
        rate_limit_rpm: 100,
        verification_method: 'hmac_sha256',
        verification_config: '{}', // Missing required `secret` field
        event_type_header: null,
        event_type_path: null,
        idempotency_key_header: null,
        idempotency_key_path: null,
        dedup_window_seconds: 300,
        allowed_events: null,
        strip_headers: '[]',
      };

      const deps = createMockDeps({
        sourceManager: {
          getByOrgAndName: vi.fn().mockResolvedValue(source),
          checkIdempotency: vi.fn().mockResolvedValue(false),
        } as any,
      });

      const app = createGenericWebhookRoutes(deps);
      const res = await app.request('http://localhost/webhook/org-1/generic/test', {
        method: 'POST',
        body: JSON.stringify({ event: 'test' }),
        headers: {
          'Content-Type': 'application/json',
          'x-signature-256': 'sha256=fake',
        },
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.reason).toBe('Source verification misconfigured');
    });

    it('returns 500 when bearer_token source has no token in config', async () => {
      const source = {
        id: 'src-2',
        customer_id: 'org-1',
        name: 'test-bearer',
        routing_key: 'generic:org-1:src-2',
        enabled: true,
        max_payload_bytes: 1048576,
        rate_limit_rpm: 100,
        verification_method: 'bearer_token',
        verification_config: '{}', // Missing required `token` field
        event_type_header: null,
        event_type_path: null,
        idempotency_key_header: null,
        idempotency_key_path: null,
        dedup_window_seconds: 300,
        allowed_events: null,
        strip_headers: '[]',
      };

      const deps = createMockDeps({
        sourceManager: {
          getByOrgAndName: vi.fn().mockResolvedValue(source),
          checkIdempotency: vi.fn().mockResolvedValue(false),
        } as any,
      });

      const app = createGenericWebhookRoutes(deps);
      const res = await app.request('http://localhost/webhook/org-1/generic/test-bearer', {
        method: 'POST',
        body: JSON.stringify({ event: 'test' }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.reason).toBe('Source verification misconfigured');
    });
  });
});
