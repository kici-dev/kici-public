import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  JoinTokenManager,
  decodeJoinRouting,
  parseToken,
  tokenFingerprint,
  tokenHashOf,
} from './join-token.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

describe('parseToken', () => {
  it('extracts routing and secret from valid token', () => {
    const routing = {
      orgId: 'org-1',
      routingKey: 'github:42',
      expiry: Date.now() + 3600_000,
      role: 'coordinator',
    };
    const routingB64 = Buffer.from(JSON.stringify(routing)).toString('base64url');
    const secretHex = randomBytes(32).toString('hex');
    const token = `kici_join_v1.${routingB64}.${secretHex}`;

    const parsed = parseToken(token);
    expect(parsed.routing.orgId).toBe('org-1');
    expect(parsed.routing.routingKey).toBe('github:42');
    expect(parsed.routing.expiry).toBe(routing.expiry);
    expect(parsed.routing.role).toBe('coordinator');
    expect(parsed.secretHex).toBe(secretHex);
  });

  it('throws on malformed token (wrong prefix)', () => {
    expect(() => parseToken('bad_prefix.abc.def')).toThrow('Invalid join token format');
  });

  it('throws on malformed token (missing parts)', () => {
    expect(() => parseToken('kici_join_v1.only-one-part')).toThrow('Invalid join token format');
  });
});

// --- DB-dependent tests with mocked Kysely ---

describe('JoinTokenManager', () => {
  it('createToken() returns a string matching format kici_join_v1.<base64url>.<hex64>', async () => {
    const { db, mocks } = createMockDb();
    const manager = new JoinTokenManager({ db: db as any });

    const token = await manager.createToken({
      orgId: 'org-1',
      routingKey: 'github:42',
      createdBy: 'admin',
    });

    expect(token).toMatch(/^kici_join_v1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
  });

  it('createToken with role="worker" encodes role in token routing', async () => {
    const { db, mocks } = createMockDb();
    const manager = new JoinTokenManager({ db: db as any });

    const token = await manager.createToken({
      orgId: 'org-1',
      routingKey: 'github:42',
      createdBy: 'admin',
      role: 'worker',
    });

    const parsed = parseToken(token);
    expect(parsed.routing.role).toBe('worker');
  });

  it('createToken with default role uses "coordinator"', async () => {
    const { db, mocks } = createMockDb();
    const manager = new JoinTokenManager({ db: db as any });

    const token = await manager.createToken({
      orgId: 'org-1',
      routingKey: 'github:42',
      createdBy: 'admin',
    });

    const parsed = parseToken(token);
    expect(parsed.routing.role).toBe('coordinator');
  });
});

describe('tokenHashOf', () => {
  // fails-when: the hash is taken over the hex string instead of the secret bytes,
  //   so it no longer matches join_tokens.token_hash.
  it('equals SHA-256 over the secret bytes, computed independently', () => {
    const secretHex = randomBytes(32).toString('hex');
    const independent = createHash('sha256').update(Buffer.from(secretHex, 'hex')).digest('hex');
    expect(tokenHashOf(secretHex)).toBe(independent);
  });
});

describe('tokenFingerprint', () => {
  // fails-when: the fingerprint is a prefix of the hash itself (a log line would
  //   then carry the first 48 bits of the join key root).
  it('is 12 hex characters, stable, and not a prefix of the token hash', () => {
    const hash = tokenHashOf(randomBytes(32).toString('hex'));
    const fp = tokenFingerprint(hash);
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
    expect(tokenFingerprint(hash)).toBe(fp);
    expect(hash.startsWith(fp)).toBe(false);
  });
});

describe('decodeJoinRouting', () => {
  it('decodes the routing part of a token', () => {
    const routing = {
      orgId: 'org-1',
      routingKey: 'github:42',
      expiry: 1_759_400_000_000,
      role: 'worker',
    };
    const b64 = Buffer.from(JSON.stringify(routing)).toString('base64url');
    expect(decodeJoinRouting(b64)).toEqual({
      orgId: 'org-1',
      routingKey: 'github:42',
      expiry: 1_759_400_000_000,
    });
  });

  it('throws on a routing part that is not JSON with orgId, routingKey and expiry', () => {
    expect(() => decodeJoinRouting(Buffer.from('{"orgId":"o"}').toString('base64url'))).toThrow();
    expect(() => decodeJoinRouting('%%%')).toThrow();
  });
});

describe('parseToken routingB64', () => {
  it('returns the routing part exactly as it appears in the token', () => {
    const routingB64 = Buffer.from(
      JSON.stringify({ orgId: 'o', routingKey: 'k', expiry: 1, role: 'coordinator' }),
    ).toString('base64url');
    const token = `kici_join_v1.${routingB64}.${'a'.repeat(64)}`;
    expect(parseToken(token).routingB64).toBe(routingB64);
  });
});
