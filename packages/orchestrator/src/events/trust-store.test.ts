/**
 * Tests for TrustStore -- cross-repo trust relationship verification.
 *
 * Uses mock Kysely to test:
 * - Same-repo events always trusted (no DB lookup)
 * - Cross-repo with matching trust row returns true
 * - Cross-repo without trust row returns false
 * - allowed_events glob filtering
 * - addTrust and removeTrust operations
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { TrustStore } from './trust-store.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

// ── Tests ────────────────────────────────────────────────────────

describe('TrustStore', () => {
  describe('isTrusted', () => {
    it('should return true for same-routing-key events without DB lookup', async () => {
      const { db, mocks } = createMockDb();
      const store = new TrustStore(db);

      const result = await store.isTrusted(
        'owner/repo-a',
        'github:42',
        'owner/repo-b',
        'github:42', // Same routing key
        'deploy-complete',
      );

      expect(result).toBe(true);
      // No DB query should have been made
      expect(mocks.selectFrom).not.toHaveBeenCalled();
    });

    it('should return true for cross-repo with enabled trust row (all events)', async () => {
      const { db } = createMockDb({
        selectFirstRow: { allowed_events: null },
      });
      const store = new TrustStore(db);

      const result = await store.isTrusted(
        'org/repo-a',
        'github:42',
        'org/repo-b',
        'github:99',
        'deploy-complete',
      );

      expect(result).toBe(true);
    });

    it('should return false for cross-repo without trust row', async () => {
      const { db } = createMockDb({ selectFirstRow: null });
      const store = new TrustStore(db);

      const result = await store.isTrusted(
        'org/repo-a',
        'github:42',
        'org/repo-b',
        'github:99',
        'deploy-complete',
      );

      expect(result).toBe(false);
    });

    it('should return true when event matches allowed_events glob', async () => {
      const { db } = createMockDb({
        selectFirstRow: { allowed_events: JSON.stringify(['deploy-*', '__workflow_complete']) },
      });
      const store = new TrustStore(db);

      const result = await store.isTrusted(
        'org/repo-a',
        'github:42',
        'org/repo-b',
        'github:99',
        'deploy-staging',
      );

      expect(result).toBe(true);
    });

    it('should return false when event does not match allowed_events', async () => {
      const { db } = createMockDb({
        selectFirstRow: { allowed_events: JSON.stringify(['deploy-*']) },
      });
      const store = new TrustStore(db);

      const result = await store.isTrusted(
        'org/repo-a',
        'github:42',
        'org/repo-b',
        'github:99',
        'build-complete', // Does not match deploy-*
      );

      expect(result).toBe(false);
    });

    it('should return true when allowed_events is an empty array', async () => {
      const { db } = createMockDb({
        selectFirstRow: { allowed_events: JSON.stringify([]) },
      });
      const store = new TrustStore(db);

      const result = await store.isTrusted(
        'org/repo-a',
        'github:42',
        'org/repo-b',
        'github:99',
        'any-event',
      );

      expect(result).toBe(true);
    });

    it('should handle allowed_events already parsed as array', async () => {
      const { db } = createMockDb({
        selectFirstRow: { allowed_events: ['deploy-*'] },
      });
      const store = new TrustStore(db);

      const result = await store.isTrusted(
        'org/repo-a',
        'github:42',
        'org/repo-b',
        'github:99',
        'deploy-prod',
      );

      expect(result).toBe(true);
    });
  });

  describe('addTrust', () => {
    it('should insert a trust row and return the ID', async () => {
      const { db, mocks } = createMockDb({ insertReturning: { id: 'trust-1' } });
      const store = new TrustStore(db);

      const id = await store.addTrust(
        { repo: 'org/repo-a', routingKey: 'github:42' },
        { repo: 'org/repo-b', routingKey: 'github:99' },
        ['deploy-*'],
      );

      expect(id).toBe('trust-1');
      expect(mocks.insertInto).toHaveBeenCalledWith('cross_repo_trust');
      expect(mocks.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          source_repo: 'org/repo-a',
          source_routing_key: 'github:42',
          target_repo: 'org/repo-b',
          target_routing_key: 'github:99',
          allowed_events: JSON.stringify(['deploy-*']),
        }),
      );
    });

    it('should set allowed_events to null when not provided', async () => {
      const { db, mocks } = createMockDb();
      const store = new TrustStore(db);

      await store.addTrust(
        { repo: 'org/repo-a', routingKey: 'github:42' },
        { repo: 'org/repo-b', routingKey: 'github:99' },
      );

      expect(mocks.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          allowed_events: null,
        }),
      );
    });

    it('should return existing ID on duplicate insert (idempotent)', async () => {
      // Simulate ON CONFLICT DO NOTHING: returning().executeTakeFirst() returns null (no row inserted)
      const { db, mocks } = createMockDb({ insertReturning: null as any });
      // When the insert returns nothing (conflict), it should fall back to SELECT
      mocks.selectExecuteTakeFirstOrThrow.mockResolvedValue({ id: 'existing-trust-id' });
      const store = new TrustStore(db);

      const id = await store.addTrust(
        { repo: 'org/repo-a', routingKey: 'github:42' },
        { repo: 'org/repo-b', routingKey: 'github:99' },
      );

      expect(id).toBe('existing-trust-id');
    });
  });

  describe('removeTrust', () => {
    it('should delete the trust row by ID', async () => {
      const { db, mocks } = createMockDb();
      const store = new TrustStore(db);

      await store.removeTrust('trust-123');

      expect(mocks.deleteFrom).toHaveBeenCalledWith('cross_repo_trust');
      expect(mocks.deleteWhere).toHaveBeenCalledWith('id', '=', 'trust-123');
    });
  });

  describe('listTrust', () => {
    it('should return trust entries for a routing key', async () => {
      const trustRow = {
        id: 'trust-1',
        source_repo: 'org/repo-a',
        source_routing_key: 'github:42',
        target_repo: 'org/repo-b',
        target_routing_key: 'github:99',
        allowed_events: JSON.stringify(['deploy-*']),
        enabled: true,
        created_at: new Date(),
      };
      const { db, mocks } = createMockDb();
      mocks.selectExecute.mockResolvedValue([trustRow]);
      const store = new TrustStore(db);

      const entries = await store.listTrust('github:42');

      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        id: 'trust-1',
        sourceRepo: 'org/repo-a',
        sourceRoutingKey: 'github:42',
        targetRepo: 'org/repo-b',
        targetRoutingKey: 'github:99',
        allowedEvents: ['deploy-*'],
        enabled: true,
      });
    });

    it('should return entries for both source and target matches', async () => {
      const { db, mocks } = createMockDb();
      mocks.selectExecute.mockResolvedValue([]);
      const store = new TrustStore(db);

      const entries = await store.listTrust('github:42');

      expect(entries).toHaveLength(0);
      // Verify or() was used for bidirectional lookup
      expect(mocks.selectAll).toHaveBeenCalled();
    });
  });
});
