import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  JoinTokenManager,
  decryptBundle,
  deriveKeys,
  encryptBundle,
  parseToken,
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

describe('deriveKeys', () => {
  it('produces 32-byte encryption key and 64-char hex validation hash', () => {
    const secret = randomBytes(32);
    const keys = deriveKeys(secret);

    expect(keys.encryptionKey).toBeInstanceOf(Buffer);
    expect(keys.encryptionKey.length).toBe(32);
    expect(keys.validationHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic (same secret => same keys)', () => {
    const secret = randomBytes(32);
    const keys1 = deriveKeys(secret);
    const keys2 = deriveKeys(secret);

    expect(keys1.encryptionKey.equals(keys2.encryptionKey)).toBe(true);
    expect(keys1.validationHash).toBe(keys2.validationHash);
  });
});

describe('encryptBundle / decryptBundle', () => {
  it('round-trips: encrypt config object, decrypt back to identical object', () => {
    const secret = randomBytes(32);
    const keys = deriveKeys(secret);
    const config = {
      orgId: 'org-1',
      sources: [{ provider: 'github', appId: '42' }],
      secrets: { DB_URL: 'postgres://...' },
    };

    const encrypted = encryptBundle(config, keys.encryptionKey);
    const decrypted = decryptBundle(encrypted, keys.encryptionKey);

    expect(decrypted).toEqual(config);
  });

  it('decryptBundle with wrong key throws', () => {
    const secret1 = randomBytes(32);
    const secret2 = randomBytes(32);
    const keys1 = deriveKeys(secret1);
    const keys2 = deriveKeys(secret2);

    const encrypted = encryptBundle({ test: true }, keys1.encryptionKey);

    expect(() => decryptBundle(encrypted, keys2.encryptionKey)).toThrow();
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

  it('validateAndConsumeToken() rejects expired token', async () => {
    const { db, mocks } = createMockDb();
    const manager = new JoinTokenManager({ db: db as any });

    // Create token that is already expired
    const token = await manager.createToken({
      orgId: 'org-1',
      routingKey: 'github:42',
      createdBy: 'admin',
      expiryMs: -1000, // expired 1 second ago
    });

    // Atomic claim returns 0 rows (UPDATE..WHERE expires_at > NOW() filters it out);
    // disambiguation SELECT then returns the expired row.
    mocks.updateExecuteTakeFirst.mockResolvedValue({ numUpdatedRows: 0n });
    const parsed = parseToken(token);
    const keys = deriveKeys(Buffer.from(parsed.secretHex, 'hex'));
    mocks.selectExecuteTakeFirst.mockResolvedValue({
      token_hash: keys.validationHash,
      consumed_at: null,
      expires_at: new Date(Date.now() - 1000), // expired
    });

    await expect(manager.validateAndConsumeToken(token, 'me')).rejects.toThrow('expired');
  });

  it('validateAndConsumeToken() rejects already-consumed token', async () => {
    const { db, mocks } = createMockDb();
    const manager = new JoinTokenManager({ db: db as any });

    const token = await manager.createToken({
      orgId: 'org-1',
      routingKey: 'github:42',
      createdBy: 'admin',
    });

    // Atomic claim returns 0 rows (UPDATE..WHERE consumed_at IS NULL filters it out);
    // disambiguation SELECT then returns the already-consumed row.
    mocks.updateExecuteTakeFirst.mockResolvedValue({ numUpdatedRows: 0n });
    const parsed = parseToken(token);
    const keys = deriveKeys(Buffer.from(parsed.secretHex, 'hex'));
    mocks.selectExecuteTakeFirst.mockResolvedValue({
      token_hash: keys.validationHash,
      consumed_at: new Date(), // already consumed
      expires_at: new Date(Date.now() + 3600_000),
    });

    await expect(manager.validateAndConsumeToken(token, 'me')).rejects.toThrow('already been used');
  });

  it('validateAndConsumeToken() rejects unknown token (no DB row)', async () => {
    const { db, mocks } = createMockDb();
    const manager = new JoinTokenManager({ db: db as any });

    const token = await manager.createToken({
      orgId: 'org-1',
      routingKey: 'github:42',
      createdBy: 'admin',
    });

    // Atomic claim returns 0 rows AND disambiguation SELECT returns nothing
    // (the token was rotated out of the DB entirely).
    mocks.updateExecuteTakeFirst.mockResolvedValue({ numUpdatedRows: 0n });
    mocks.selectExecuteTakeFirst.mockResolvedValue(undefined);

    await expect(manager.validateAndConsumeToken(token, 'me')).rejects.toThrow(
      'Invalid join token',
    );
  });

  it('validateAndConsumeToken() accepts valid, unexpired, unconsumed token and consumes it', async () => {
    const { db, mocks } = createMockDb();
    const manager = new JoinTokenManager({ db: db as any });

    const token = await manager.createToken({
      orgId: 'org-1',
      routingKey: 'github:42',
      createdBy: 'admin',
    });

    // Atomic claim wins: UPDATE returns numUpdatedRows: 1n.
    mocks.updateExecuteTakeFirst.mockResolvedValue({ numUpdatedRows: 1n });

    const result = await manager.validateAndConsumeToken(token, 'new-orch-instance');
    expect(result.routing.orgId).toBe('org-1');
    expect(result.routing.routingKey).toBe('github:42');
    expect(result.keys.encryptionKey).toBeInstanceOf(Buffer);

    // Verify the UPDATE call carried consumed_by and consumed_at.
    expect(mocks.updateTable).toHaveBeenCalledWith('join_tokens');
    const setCalls = mocks.updateSet.mock.calls;
    expect(setCalls.length).toBe(1);
    expect(setCalls[0][0]).toHaveProperty('consumed_by', 'new-orch-instance');
    expect(setCalls[0][0]).toHaveProperty('consumed_at');
    expect(setCalls[0][0].consumed_at).toBeInstanceOf(Date);

    // Disambiguation SELECT must NOT fire on the happy path.
    expect(mocks.selectFrom).not.toHaveBeenCalled();
  });

  it('validateAndConsumeToken() races: only one of two concurrent claims succeeds', async () => {
    // Simulates the multi-coordinator mesh race: two coords run
    // validateAndConsumeToken on the same token in parallel. The atomic
    // UPDATE..WHERE consumed_at IS NULL means PG awards the row to exactly
    // one of them; the other gets numUpdatedRows: 0n and throws
    // "already been used".
    const { db, mocks } = createMockDb();
    const manager = new JoinTokenManager({ db: db as any });

    const token = await manager.createToken({
      orgId: 'org-1',
      routingKey: 'github:42',
      createdBy: 'admin',
    });

    // First call: claim succeeds. Second call: claim returns 0 rows + the
    // disambiguation SELECT sees the row as already consumed.
    mocks.updateExecuteTakeFirst
      .mockResolvedValueOnce({ numUpdatedRows: 1n })
      .mockResolvedValueOnce({ numUpdatedRows: 0n });
    const parsed = parseToken(token);
    const keys = deriveKeys(Buffer.from(parsed.secretHex, 'hex'));
    mocks.selectExecuteTakeFirst.mockResolvedValue({
      token_hash: keys.validationHash,
      consumed_at: new Date(),
      expires_at: new Date(Date.now() + 3600_000),
    });

    const settled = await Promise.allSettled([
      manager.validateAndConsumeToken(token, 'coord-A'),
      manager.validateAndConsumeToken(token, 'coord-B'),
    ]);
    const winners = settled.filter((s) => s.status === 'fulfilled');
    const losers = settled.filter((s) => s.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toMatchObject({
      message: expect.stringContaining('already been used'),
    });
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

  it('validateAndConsumeToken returns correct role from parsed token', async () => {
    const { db, mocks } = createMockDb();
    const manager = new JoinTokenManager({ db: db as any });

    const token = await manager.createToken({
      orgId: 'org-1',
      routingKey: 'github:42',
      createdBy: 'admin',
      role: 'worker',
    });

    mocks.updateExecuteTakeFirst.mockResolvedValue({ numUpdatedRows: 1n });

    const result = await manager.validateAndConsumeToken(token, 'me');
    expect(result.routing.role).toBe('worker');
  });
});
