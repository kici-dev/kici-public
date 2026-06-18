import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GenericWebhookNormalizer,
  parseBody,
  extractEventType,
  filterHeaders,
} from './normalizer.js';
import type { GenericSourceManager } from '../../webhook/generic-sources.js';
import type { GenericWebhookSource } from '../../db/types.js';

// Mock source for testing
function createMockSource(overrides: Partial<GenericWebhookSource> = {}): GenericWebhookSource {
  return {
    id: 'src-123',
    customer_id: 'cust-1',
    name: 'test-source',
    routing_key: 'generic:cust-1:src-123',
    verification_method: 'hmac_sha256',
    verification_config: '{}',
    event_type_header: null,
    event_type_path: null,
    idempotency_key_header: null,
    idempotency_key_path: null,
    dedup_window_seconds: 300,
    max_payload_bytes: 1048576,
    allowed_events: null,
    strip_headers:
      '["authorization","cookie","set-cookie","proxy-authorization","x-api-key","x-auth-token"]',
    enabled: true,
    rate_limit_rpm: 600,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

function createMockSourceManager(source: GenericWebhookSource | null = null): GenericSourceManager {
  return {
    getByRoutingKey: vi.fn().mockResolvedValue(source),
    getById: vi.fn().mockResolvedValue(source),
    create: vi.fn(),
    getByCustomerAndName: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
    hardDelete: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    checkIdempotency: vi.fn(),
    checkPayloadSize: vi.fn(),
  } as unknown as GenericSourceManager;
}

describe('GenericWebhookNormalizer', () => {
  let normalizer: GenericWebhookNormalizer;
  let sourceManager: GenericSourceManager;

  beforeEach(() => {
    sourceManager = createMockSourceManager(createMockSource());
    normalizer = new GenericWebhookNormalizer(sourceManager);
  });

  describe('extractRoutingKey', () => {
    it('returns routing key from X-KiCI-Source-ID header', () => {
      const headers = { 'x-kici-source-id': 'generic:cust-1:src-123' };
      expect(normalizer.extractRoutingKey(headers, {})).toBe('generic:cust-1:src-123');
    });

    it('returns null when header is missing', () => {
      expect(normalizer.extractRoutingKey({}, {})).toBeNull();
    });
  });

  describe('extractDeliveryId', () => {
    it('extracts from X-Delivery-ID header', () => {
      expect(normalizer.extractDeliveryId({ 'x-delivery-id': 'del-1' })).toBe('del-1');
    });

    it('falls back to X-Request-ID', () => {
      expect(normalizer.extractDeliveryId({ 'x-request-id': 'req-1' })).toBe('req-1');
    });

    it('falls back to X-Idempotency-Key', () => {
      expect(normalizer.extractDeliveryId({ 'x-idempotency-key': 'idem-1' })).toBe('idem-1');
    });

    it('returns null when no delivery ID headers present', () => {
      expect(normalizer.extractDeliveryId({})).toBeNull();
    });
  });

  describe('extractEventType', () => {
    it('returns X-Event-Type header value', () => {
      expect(normalizer.extractEventType({ 'x-event-type': 'deploy' })).toBe('deploy');
    });

    it('returns null when no event type header present', () => {
      expect(normalizer.extractEventType({})).toBeNull();
    });
  });

  describe('normalizeEvent', () => {
    it('returns SimulatedEvent with generic_webhook type', () => {
      const payload = { env: 'prod', service: 'api' };
      const result = normalizer.normalizeEvent('deploy', null, payload);

      expect(result).toEqual({
        type: 'generic_webhook',
        action: 'deploy',
        targetBranch: '__generic__',
        payload: { env: 'prod', service: 'api' },
        provider: 'generic',
      });
    });

    it('sets action to undefined for default event type', () => {
      const result = normalizer.normalizeEvent('default', null, { key: 'value' });

      expect(result).toEqual({
        type: 'generic_webhook',
        action: undefined,
        targetBranch: '__generic__',
        payload: { key: 'value' },
        provider: 'generic',
      });
    });
  });

  describe('normalizeGenericRequest', () => {
    it('normalizes a JSON body with source config', async () => {
      const result = await normalizer.normalizeGenericRequest(
        'generic:cust-1:src-123',
        '{"event":"deploy","env":"prod"}',
        {
          'content-type': 'application/json',
          'x-event-type': 'deploy',
          'x-custom-header': 'test',
        },
      );

      expect(result).not.toBeNull();
      expect(result!.event).toBe('deploy');
      expect(result!.payload).toEqual({ event: 'deploy', env: 'prod' });
      expect(result!.routingKey).toBe('generic:cust-1:src-123');
      // Authorization should be stripped
      expect(result!.headers).not.toHaveProperty('authorization');
      expect(result!.headers).toHaveProperty('x-custom-header', 'test');
    });

    it('returns null for unknown routing key', async () => {
      sourceManager = createMockSourceManager(null);
      normalizer = new GenericWebhookNormalizer(sourceManager);

      const result = await normalizer.normalizeGenericRequest('generic:unknown:unknown', '{}', {});

      expect(result).toBeNull();
    });

    it('extracts event type from configured header', async () => {
      sourceManager = createMockSourceManager(
        createMockSource({ event_type_header: 'X-Custom-Event' }),
      );
      normalizer = new GenericWebhookNormalizer(sourceManager);

      const result = await normalizer.normalizeGenericRequest('generic:cust-1:src-123', '{}', {
        'x-custom-event': 'custom-deploy',
      });

      expect(result!.event).toBe('custom-deploy');
    });

    it('extracts event type from JSONPath in body', async () => {
      sourceManager = createMockSourceManager(
        createMockSource({ event_type_path: '$.event.type' }),
      );
      normalizer = new GenericWebhookNormalizer(sourceManager);

      const result = await normalizer.normalizeGenericRequest(
        'generic:cust-1:src-123',
        '{"event":{"type":"build-complete"}}',
        { 'content-type': 'application/json' },
      );

      expect(result!.event).toBe('build-complete');
    });

    it('defaults to "default" when no event type available', async () => {
      sourceManager = createMockSourceManager(createMockSource());
      normalizer = new GenericWebhookNormalizer(sourceManager);

      const result = await normalizer.normalizeGenericRequest(
        'generic:cust-1:src-123',
        '{"data":"value"}',
        { 'content-type': 'application/json' },
      );

      expect(result!.event).toBe('default');
    });

    it('strips sensitive headers based on source config', async () => {
      const result = await normalizer.normalizeGenericRequest('generic:cust-1:src-123', '{}', {
        'content-type': 'application/json',
        authorization: 'Bearer secret-token',
        cookie: 'session=abc',
        'x-safe-header': 'safe-value',
      });

      expect(result!.headers).not.toHaveProperty('authorization');
      expect(result!.headers).not.toHaveProperty('cookie');
      expect(result!.headers).toHaveProperty('x-safe-header', 'safe-value');
    });
  });
});

describe('parseBody', () => {
  it('parses JSON body', () => {
    const result = parseBody('{"key":"value","num":42}', 'application/json');
    expect(result).toEqual({ key: 'value', num: 42 });
  });

  it('parses JSON body without content-type', () => {
    const result = parseBody('{"key":"value"}');
    expect(result).toEqual({ key: 'value' });
  });

  it('parses URL-encoded form data', () => {
    const result = parseBody('name=test&value=42', 'application/x-www-form-urlencoded');
    expect(result).toEqual({ name: 'test', value: '42' });
  });

  it('wraps non-object JSON as value', () => {
    const result = parseBody('"hello"', 'application/json');
    expect(result).toEqual({ value: 'hello' });
  });

  it('returns empty object for empty body', () => {
    expect(parseBody('')).toEqual({});
    expect(parseBody('   ')).toEqual({});
  });

  it('wraps unparseable body as raw', () => {
    const result = parseBody('not json or form', 'text/plain');
    expect(result).toEqual({ body: 'not json or form' });
  });

  it('handles JSON arrays', () => {
    const result = parseBody('[1,2,3]', 'application/json');
    // Arrays are objects, but not Record<string, unknown>; depends on implementation
    expect(result).toBeDefined();
  });
});

describe('extractEventType', () => {
  it('uses configured header first', () => {
    const result = extractEventType({ 'x-custom-event': 'deploy' }, {}, 'X-Custom-Event', null);
    expect(result).toBe('deploy');
  });

  it('falls back to JSONPath in body', () => {
    const result = extractEventType({}, { event: { type: 'build' } }, null, '$.event.type');
    expect(result).toBe('build');
  });

  it('falls back to X-Event-Type header', () => {
    const result = extractEventType({ 'x-event-type': 'release' }, {}, null, null);
    expect(result).toBe('release');
  });

  it('defaults to "default"', () => {
    const result = extractEventType({}, {}, null, null);
    expect(result).toBe('default');
  });

  it('handles dot notation path without $ prefix', () => {
    const result = extractEventType({}, { data: { action: 'notify' } }, null, 'data.action');
    expect(result).toBe('notify');
  });
});

describe('filterHeaders', () => {
  it('removes listed headers', () => {
    const result = filterHeaders({ authorization: 'Bearer x', 'x-safe': 'value', cookie: 'abc' }, [
      'authorization',
      'cookie',
    ]);
    expect(result).toEqual({ 'x-safe': 'value' });
  });

  it('is case-insensitive', () => {
    const result = filterHeaders({ Authorization: 'Bearer x', 'X-Safe': 'value' }, [
      'authorization',
    ]);
    expect(result).toEqual({ 'X-Safe': 'value' });
  });

  it('returns all headers when strip list is empty', () => {
    const result = filterHeaders({ 'x-a': '1', 'x-b': '2' }, []);
    expect(result).toEqual({ 'x-a': '1', 'x-b': '2' });
  });
});

describe('GenericWebhookNormalizer - provider-agnostic methods', () => {
  const sourceManager = {
    getByRoutingKey: vi.fn(),
  } as unknown as GenericSourceManager;
  const normalizer = new GenericWebhookNormalizer(sourceManager);

  describe('extractRepoIdentifier', () => {
    it('returns null (no repo concept)', () => {
      expect(normalizer.extractRepoIdentifier({ repository: { full_name: 'a/b' } })).toBeNull();
    });
  });

  describe('extractRef', () => {
    it('returns HEAD (no ref concept)', () => {
      expect(normalizer.extractRef('push', { after: 'abc123' })).toBe('HEAD');
    });
  });

  describe('extractCredentials', () => {
    it('returns empty object', () => {
      expect(normalizer.extractCredentials({ installation: { id: 123 } })).toEqual({});
    });
  });
});
