/**
 * Tests for TokenManager.
 *
 * Uses mock Kysely DB to verify:
 * - generateToken returns unique tokens
 * - validate returns info for valid token
 * - validate returns null for wrong token
 * - validate returns null for revoked token
 * - revokeToken marks token as revoked
 * - ensureBootstrapToken generates token when no tokens exist
 * - ensureBootstrapToken returns null when tokens already exist
 * - ensureBootstrapToken uses env override when provided
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { TokenManager } from './token-manager.js';

// ── Mock Kysely builder ─────────────────────────────────────────

import { createMockDb as _createMockDb } from '../__test-helpers__/mock-db.js';

interface MockDbConfig {
  selectFirstRow?: Record<string, unknown> | undefined;
  selectRows?: Record<string, unknown>[];
  insertedRow?: Record<string, unknown>;
}

/**
 * Create a mock Kysely DB for TokenManager tests.
 * Returns { db, updateSet, updateWhere, ... } for backward compatibility.
 */
function createMockDb(opts: MockDbConfig = {}) {
  const { db, mocks } = _createMockDb({
    selectFirstRow: opts.selectFirstRow,
    selectRows: opts.selectRows ?? [],
    insertedRow: opts.insertedRow ?? { id: 'tok-001' },
  });

  return {
    db,
    terminal: null, // Not used in assertions
    executeTakeFirst: mocks.selectExecuteTakeFirst,
    execute: mocks.selectExecute,
    updateSet: mocks.updateSet,
    updateWhere: mocks.updateWhere,
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe('TokenManager', () => {
  describe('generateToken', () => {
    it('returns a 64-char hex token and an id', async () => {
      const { db } = createMockDb({ insertedRow: { id: 'tok-gen-1' } });
      const tm = new TokenManager(db as any);

      const result = await tm.generateToken('test-label', 'admin');

      expect(result.token).toHaveLength(64);
      expect(result.token).toMatch(/^[0-9a-f]{64}$/);
      expect(result.id).toBe('tok-gen-1');
      expect(db.insertInto).toHaveBeenCalledWith('admin_tokens');
    });

    it('returns unique tokens on consecutive calls', async () => {
      let callCount = 0;
      const { db } = createMockDb();
      // Override insertedRow to return different IDs
      const insertReturningAll = vi.fn().mockImplementation(() => ({
        executeTakeFirstOrThrow: vi.fn().mockResolvedValue({ id: `tok-${++callCount}` }),
      }));
      (db.insertInto as ReturnType<typeof vi.fn>).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returningAll: insertReturningAll,
          onConflict: vi.fn(),
        }),
      });

      const tm = new TokenManager(db as any);
      const r1 = await tm.generateToken('token-1', 'owner');
      const r2 = await tm.generateToken('token-2', 'owner');

      expect(r1.token).not.toBe(r2.token);
      expect(r1.id).not.toBe(r2.id);
    });
  });

  describe('validate', () => {
    it('returns token info for valid token', async () => {
      const plaintext = 'a'.repeat(64);
      const tokenHash = createHash('sha256').update(plaintext).digest('hex');

      const row = {
        id: 'tok-v1',
        token_hash: tokenHash,
        label: 'my-token',
        role: 'admin',
        routing_key: 'github:42',
        created_at: new Date(),
        expires_at: null,
        last_used_at: null,
        revoked: false,
      };

      const { db } = createMockDb({ selectFirstRow: row });
      const tm = new TokenManager(db as any);

      const result = await tm.validate(plaintext);

      expect(result).not.toBeNull();
      expect(result!.id).toBe('tok-v1');
      expect(result!.role).toBe('admin');
      expect(result!.routingKey).toBe('github:42');
      expect(result!.label).toBe('my-token');
    });

    it('returns null for wrong token', async () => {
      const { db } = createMockDb({ selectFirstRow: undefined });
      const tm = new TokenManager(db as any);

      const result = await tm.validate('wrong-token');

      expect(result).toBeNull();
    });

    it('returns null for revoked token (query returns nothing)', async () => {
      // The DB query filters revoked=false, so revoked token returns nothing
      const { db } = createMockDb({ selectFirstRow: undefined });
      const tm = new TokenManager(db as any);

      const result = await tm.validate('some-revoked-token');

      expect(result).toBeNull();
    });

    it('updates last_used_at on successful validation', async () => {
      const plaintext = 'b'.repeat(64);
      const row = {
        id: 'tok-v2',
        token_hash: createHash('sha256').update(plaintext).digest('hex'),
        label: 'used-token',
        role: 'owner',
        routing_key: null,
        created_at: new Date(),
        expires_at: null,
        last_used_at: null,
        revoked: false,
      };

      const { db } = createMockDb({ selectFirstRow: row });
      const tm = new TokenManager(db as any);

      await tm.validate(plaintext);

      // updateTable should have been called to update last_used_at
      expect(db.updateTable).toHaveBeenCalledWith('admin_tokens');
    });
  });

  describe('revokeToken', () => {
    it('marks token as revoked', async () => {
      const { db, updateSet } = createMockDb();
      const tm = new TokenManager(db as any);

      await tm.revokeToken('tok-revoke');

      expect(db.updateTable).toHaveBeenCalledWith('admin_tokens');
      expect(updateSet).toHaveBeenCalledWith({ revoked: true });
    });
  });

  describe('ensureBootstrapToken', () => {
    it('generates token when no tokens exist', async () => {
      // selectTakeFirst returns undefined (no existing tokens)
      const { db } = createMockDb({ selectFirstRow: undefined });
      const tm = new TokenManager(db as any);

      const result = await tm.ensureBootstrapToken();

      expect(result).not.toBeNull();
      expect(result).toHaveLength(64);
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns null when tokens already exist', async () => {
      // selectTakeFirst returns a row (tokens exist)
      const { db } = createMockDb({ selectFirstRow: { id: 'existing-tok' } });
      const tm = new TokenManager(db as any);

      const result = await tm.ensureBootstrapToken();

      expect(result).toBeNull();
    });

    it('uses env override when provided', async () => {
      const { db } = createMockDb();
      const tm = new TokenManager(db as any);

      const result = await tm.ensureBootstrapToken('my-custom-bootstrap-token');

      expect(result).toBe('my-custom-bootstrap-token');
      expect(db.insertInto).toHaveBeenCalledWith('admin_tokens');
    });
  });
});
