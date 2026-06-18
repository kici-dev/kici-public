import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyInboundWebhook, type VerifyInboundDeps } from './verify-inbound.js';

// --- Test doubles --------------------------------------------------

/** Build a fake Kysely chain that resolves the github source row lookup. */
function fakeDb(sourceRow: { id: string } | null) {
  return {
    selectFrom: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    executeTakeFirst: vi.fn().mockResolvedValue(sourceRow ?? undefined),
  } as unknown as VerifyInboundDeps['db'];
}

/** Build a PgSecretStore stub returning the provided secrets map by scope. */
function fakeSecretStore(scopes: Record<string, Record<string, string>>) {
  return {
    getSecrets: vi
      .fn()
      .mockImplementation(async (_org: string, scope: string) => scopes[scope] ?? {}),
  } as unknown as VerifyInboundDeps['secretStore'];
}

/** Build a GenericSourceManager stub returning a single row by routing key. */
function fakeGenericSourceManager(
  row: {
    routing_key: string;
    verification_method: string;
    verification_config: string;
  } | null,
) {
  return {
    getByRoutingKey: vi.fn().mockResolvedValue(row),
  } as unknown as VerifyInboundDeps['genericSourceManager'];
}

/** Compute a `sha256=<hex>` signature over body using secret. */
function githubSig(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

// --- routing-key prefix dispatch ----------------------------------

describe('verifyInboundWebhook (dispatch)', () => {
  it('returns rejected_unknown_source for an unknown routing-key prefix', async () => {
    const deps: VerifyInboundDeps = {
      db: fakeDb(null),
      secretStore: fakeSecretStore({}),
      genericSourceManager: fakeGenericSourceManager(null),
    };
    const out = await verifyInboundWebhook(deps, {
      routingKey: 'gitlab:42',
      body: Buffer.from('{}'),
      headers: {},
      signatureHeaderName: null,
      signatureHeader: null,
      clientIp: null,
    });
    expect(out.result).toBe('rejected_unknown_source');
    expect(out.reason).toMatch(/provider not implemented/);
  });
});

// --- github branch -------------------------------------------------

describe('verifyInboundWebhook (github)', () => {
  const SOURCE_ID = 'src-1';
  const SCOPE = `__source__/${SOURCE_ID}`;
  const SECRET = 'whsec_abcdefghijklmnopqrstuvwxyz';
  const BODY = '{"hello":"world"}';

  it('accepts a valid signature', async () => {
    const sig = githubSig(BODY, SECRET);
    const deps: VerifyInboundDeps = {
      db: fakeDb({ id: SOURCE_ID }),
      secretStore: fakeSecretStore({ [SCOPE]: { webhookSecret: SECRET } }),
      genericSourceManager: fakeGenericSourceManager(null),
    };
    const out = await verifyInboundWebhook(deps, {
      routingKey: 'github:12345',
      body: Buffer.from(BODY, 'utf8'),
      headers: { 'x-hub-signature-256': sig },
      signatureHeaderName: 'x-hub-signature-256',
      signatureHeader: sig,
      clientIp: null,
    });
    expect(out).toEqual({ result: 'accepted' });
  });

  it('falls back to the headers map when signatureHeader is null', async () => {
    const sig = githubSig(BODY, SECRET);
    const deps: VerifyInboundDeps = {
      db: fakeDb({ id: SOURCE_ID }),
      secretStore: fakeSecretStore({ [SCOPE]: { webhookSecret: SECRET } }),
      genericSourceManager: fakeGenericSourceManager(null),
    };
    const out = await verifyInboundWebhook(deps, {
      routingKey: 'github:12345',
      body: Buffer.from(BODY, 'utf8'),
      headers: { 'x-hub-signature-256': sig },
      signatureHeaderName: null,
      signatureHeader: null,
      clientIp: null,
    });
    expect(out).toEqual({ result: 'accepted' });
  });

  it('rejects when the signature does not match', async () => {
    const wrong = githubSig(BODY, 'different-secret');
    const deps: VerifyInboundDeps = {
      db: fakeDb({ id: SOURCE_ID }),
      secretStore: fakeSecretStore({ [SCOPE]: { webhookSecret: SECRET } }),
      genericSourceManager: fakeGenericSourceManager(null),
    };
    const out = await verifyInboundWebhook(deps, {
      routingKey: 'github:12345',
      body: Buffer.from(BODY, 'utf8'),
      headers: { 'x-hub-signature-256': wrong },
      signatureHeaderName: 'x-hub-signature-256',
      signatureHeader: wrong,
      clientIp: null,
    });
    expect(out.result).toBe('rejected_signature');
    expect(out.reason).toMatch(/no rotation secret matched/);
  });

  it('rejects when the signature header is missing entirely', async () => {
    const deps: VerifyInboundDeps = {
      db: fakeDb({ id: SOURCE_ID }),
      secretStore: fakeSecretStore({ [SCOPE]: { webhookSecret: SECRET } }),
      genericSourceManager: fakeGenericSourceManager(null),
    };
    const out = await verifyInboundWebhook(deps, {
      routingKey: 'github:12345',
      body: Buffer.from(BODY, 'utf8'),
      headers: {},
      signatureHeaderName: null,
      signatureHeader: null,
      clientIp: null,
    });
    expect(out.result).toBe('rejected_signature');
    expect(out.reason).toMatch(/missing signature header/);
  });

  it('returns rejected_unknown_source when no source row exists', async () => {
    const deps: VerifyInboundDeps = {
      db: fakeDb(null),
      secretStore: fakeSecretStore({}),
      genericSourceManager: fakeGenericSourceManager(null),
    };
    const out = await verifyInboundWebhook(deps, {
      routingKey: 'github:99999',
      body: Buffer.from(BODY, 'utf8'),
      headers: {},
      signatureHeaderName: 'x-hub-signature-256',
      signatureHeader: githubSig(BODY, SECRET),
      clientIp: null,
    });
    expect(out.result).toBe('rejected_unknown_source');
  });

  it('returns rejected_misconfigured when source has no stored secret', async () => {
    const deps: VerifyInboundDeps = {
      db: fakeDb({ id: SOURCE_ID }),
      secretStore: fakeSecretStore({ [SCOPE]: {} }),
      genericSourceManager: fakeGenericSourceManager(null),
    };
    const out = await verifyInboundWebhook(deps, {
      routingKey: 'github:12345',
      body: Buffer.from(BODY, 'utf8'),
      headers: { 'x-hub-signature-256': 'sha256=00' },
      signatureHeaderName: 'x-hub-signature-256',
      signatureHeader: 'sha256=00',
      clientIp: null,
    });
    expect(out.result).toBe('rejected_misconfigured');
    expect(out.reason).toMatch(/no webhook secret stored/);
  });

  it('returns rejected_misconfigured when PgSecretStore throws', async () => {
    const failingStore = {
      getSecrets: vi.fn().mockRejectedValue(new Error('decryption key unavailable')),
    } as unknown as VerifyInboundDeps['secretStore'];
    const deps: VerifyInboundDeps = {
      db: fakeDb({ id: SOURCE_ID }),
      secretStore: failingStore,
      genericSourceManager: fakeGenericSourceManager(null),
    };
    const out = await verifyInboundWebhook(deps, {
      routingKey: 'github:12345',
      body: Buffer.from(BODY, 'utf8'),
      headers: { 'x-hub-signature-256': 'sha256=00' },
      signatureHeaderName: 'x-hub-signature-256',
      signatureHeader: 'sha256=00',
      clientIp: null,
    });
    expect(out.result).toBe('rejected_misconfigured');
    expect(out.reason).toMatch(/failed to read webhook secret/);
  });
});

// --- generic branch ------------------------------------------------

describe('verifyInboundWebhook (generic, hmac_sha256)', () => {
  const ROUTING = 'generic:org-1:src-1';
  const SECRET = 'whsec_xyz';
  const BODY = '{"event":"ping"}';

  function gmRow(method: string, config: object) {
    return fakeGenericSourceManager({
      routing_key: ROUTING,
      verification_method: method,
      verification_config: JSON.stringify(config),
    });
  }

  it('accepts a valid HMAC signature with default header', async () => {
    const sig = createHmac('sha256', SECRET).update(BODY, 'utf8').digest('hex');
    const deps: VerifyInboundDeps = {
      db: fakeDb(null),
      secretStore: fakeSecretStore({}),
      genericSourceManager: gmRow('hmac_sha256', { secret: SECRET }),
    };
    const out = await verifyInboundWebhook(deps, {
      routingKey: ROUTING,
      body: Buffer.from(BODY),
      headers: { 'x-signature-256': sig },
      signatureHeaderName: 'x-signature-256',
      signatureHeader: sig,
      clientIp: null,
    });
    expect(out).toEqual({ result: 'accepted' });
  });

  it('rejects an HMAC signature mismatch', async () => {
    const wrong = createHmac('sha256', 'different').update(BODY).digest('hex');
    const deps: VerifyInboundDeps = {
      db: fakeDb(null),
      secretStore: fakeSecretStore({}),
      genericSourceManager: gmRow('hmac_sha256', { secret: SECRET }),
    };
    const out = await verifyInboundWebhook(deps, {
      routingKey: ROUTING,
      body: Buffer.from(BODY),
      headers: { 'x-signature-256': wrong },
      signatureHeaderName: 'x-signature-256',
      signatureHeader: wrong,
      clientIp: null,
    });
    expect(out.result).toBe('rejected_signature');
    expect(out.reason).toMatch(/verification_method=hmac_sha256/);
  });

  it('returns rejected_misconfigured when verification_config is missing the secret', async () => {
    const deps: VerifyInboundDeps = {
      db: fakeDb(null),
      secretStore: fakeSecretStore({}),
      genericSourceManager: gmRow('hmac_sha256', {}),
    };
    const out = await verifyInboundWebhook(deps, {
      routingKey: ROUTING,
      body: Buffer.from(BODY),
      headers: {},
      signatureHeaderName: null,
      signatureHeader: null,
      clientIp: null,
    });
    expect(out.result).toBe('rejected_misconfigured');
    expect(out.reason).toMatch(/malformed verification_config/);
  });

  it('returns rejected_misconfigured when verification_config is invalid JSON', async () => {
    const deps: VerifyInboundDeps = {
      db: fakeDb(null),
      secretStore: fakeSecretStore({}),
      genericSourceManager: fakeGenericSourceManager({
        routing_key: ROUTING,
        verification_method: 'hmac_sha256',
        verification_config: '{not-json',
      }),
    };
    const out = await verifyInboundWebhook(deps, {
      routingKey: ROUTING,
      body: Buffer.from(BODY),
      headers: {},
      signatureHeaderName: null,
      signatureHeader: null,
      clientIp: null,
    });
    expect(out.result).toBe('rejected_misconfigured');
  });

  it('returns rejected_unknown_source when no row exists', async () => {
    const deps: VerifyInboundDeps = {
      db: fakeDb(null),
      secretStore: fakeSecretStore({}),
      genericSourceManager: fakeGenericSourceManager(null),
    };
    const out = await verifyInboundWebhook(deps, {
      routingKey: ROUTING,
      body: Buffer.from(BODY),
      headers: {},
      signatureHeaderName: null,
      signatureHeader: null,
      clientIp: null,
    });
    expect(out.result).toBe('rejected_unknown_source');
    expect(out.reason).toMatch(/generic_webhook_sources/);
  });
});

describe('verifyInboundWebhook (generic, bearer_token)', () => {
  const ROUTING = 'generic:org-1:src-bear';
  const TOKEN = 'tok_abc123';
  const BODY = '{}';

  function gmRow(config: object) {
    return fakeGenericSourceManager({
      routing_key: ROUTING,
      verification_method: 'bearer_token',
      verification_config: JSON.stringify(config),
    });
  }

  it('accepts a matching Bearer token in Authorization header', async () => {
    const deps: VerifyInboundDeps = {
      db: fakeDb(null),
      secretStore: fakeSecretStore({}),
      genericSourceManager: gmRow({ token: TOKEN }),
    };
    const out = await verifyInboundWebhook(deps, {
      routingKey: ROUTING,
      body: Buffer.from(BODY),
      headers: { authorization: `Bearer ${TOKEN}` },
      signatureHeaderName: null,
      signatureHeader: null,
      clientIp: null,
    });
    expect(out).toEqual({ result: 'accepted' });
  });

  it('rejects a wrong Bearer token', async () => {
    const deps: VerifyInboundDeps = {
      db: fakeDb(null),
      secretStore: fakeSecretStore({}),
      genericSourceManager: gmRow({ token: TOKEN }),
    };
    const out = await verifyInboundWebhook(deps, {
      routingKey: ROUTING,
      body: Buffer.from(BODY),
      headers: { authorization: 'Bearer nope-not-the-right-one' },
      signatureHeaderName: null,
      signatureHeader: null,
      clientIp: null,
    });
    expect(out.result).toBe('rejected_signature');
  });
});

describe('verifyInboundWebhook (generic, ip_allowlist)', () => {
  const ROUTING = 'generic:org-1:src-ip';
  const ALLOW = ['10.0.0.1', '192.168.1.42'];

  function gmRow() {
    return fakeGenericSourceManager({
      routing_key: ROUTING,
      verification_method: 'ip_allowlist',
      verification_config: JSON.stringify({ allowlist: ALLOW }),
    });
  }

  it('accepts an allowlisted client IP', async () => {
    const deps: VerifyInboundDeps = {
      db: fakeDb(null),
      secretStore: fakeSecretStore({}),
      genericSourceManager: gmRow(),
    };
    const out = await verifyInboundWebhook(deps, {
      routingKey: ROUTING,
      body: Buffer.from('{}'),
      headers: {},
      signatureHeaderName: null,
      signatureHeader: null,
      clientIp: '10.0.0.1',
    });
    expect(out).toEqual({ result: 'accepted' });
  });

  it('rejects an IP outside the allowlist', async () => {
    const deps: VerifyInboundDeps = {
      db: fakeDb(null),
      secretStore: fakeSecretStore({}),
      genericSourceManager: gmRow(),
    };
    const out = await verifyInboundWebhook(deps, {
      routingKey: ROUTING,
      body: Buffer.from('{}'),
      headers: {},
      signatureHeaderName: null,
      signatureHeader: null,
      clientIp: '203.0.113.7',
    });
    expect(out.result).toBe('rejected_signature');
  });

  it('rejects when no clientIp was forwarded', async () => {
    const deps: VerifyInboundDeps = {
      db: fakeDb(null),
      secretStore: fakeSecretStore({}),
      genericSourceManager: gmRow(),
    };
    const out = await verifyInboundWebhook(deps, {
      routingKey: ROUTING,
      body: Buffer.from('{}'),
      headers: {},
      signatureHeaderName: null,
      signatureHeader: null,
      clientIp: null,
    });
    expect(out.result).toBe('rejected_signature');
  });
});

describe('verifyInboundWebhook (generic, none)', () => {
  it('always accepts when verification_method=none', async () => {
    const deps: VerifyInboundDeps = {
      db: fakeDb(null),
      secretStore: fakeSecretStore({}),
      genericSourceManager: fakeGenericSourceManager({
        routing_key: 'generic:org-1:src-none',
        verification_method: 'none',
        verification_config: '{}',
      }),
    };
    const out = await verifyInboundWebhook(deps, {
      routingKey: 'generic:org-1:src-none',
      body: Buffer.from('{}'),
      headers: {},
      signatureHeaderName: null,
      signatureHeader: null,
      clientIp: null,
    });
    expect(out).toEqual({ result: 'accepted' });
  });
});
