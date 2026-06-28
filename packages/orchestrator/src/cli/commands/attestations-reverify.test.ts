// Covers surface: cli:kici-admin:attestations reverify
import { describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../../__test-helpers__/mock-db.js';
import { createProvenanceTrustRoot } from '../../provenance/trust-root.js';
import { reverifyAttestations } from './attestations-reverify.js';
import type { CacheStorage } from '../../storage/types.js';
import type { Database } from '../../db/types.js';
import type { Kysely } from 'kysely';

const noStorage = undefined;

describe('reverifyAttestations', () => {
  it('re-evaluates only pending/unverifiable rows by default and updates each', async () => {
    const { db, mocks } = createMockDb();
    mocks.selectExecute.mockResolvedValueOnce([
      { id: 'a1', storage_key: 'k1', verify_status: 'pending' },
      { id: 'a2', storage_key: 'k2', verify_status: 'unverifiable' },
    ]);
    // No issuer configured -> every verdict is `unverifiable` (loop still updates).
    const trustRoot = createProvenanceTrustRoot();

    const result = await reverifyAttestations(db as Kysely<Database>, trustRoot, noStorage, {
      all: false,
    });

    expect(result.scanned).toBe(2);
    expect(result.updated).toBe(2);
    // Default scope filters to pending/unverifiable.
    const whereCall = mocks.selectWhere.mock.calls.find((c) => c[0] === 'verify_status');
    expect(whereCall?.[1]).toBe('in');
    expect(whereCall?.[2]).toEqual(['pending', 'unverifiable']);
    // Each row issued an UPDATE carrying a verify_status.
    expect(mocks.updateSet).toHaveBeenCalledTimes(2);
    expect(mocks.updateSet.mock.calls[0][0]).toHaveProperty('verify_status');
  });

  it('re-evaluates every row when --all is set (no status filter)', async () => {
    const { db, mocks } = createMockDb();
    mocks.selectExecute.mockResolvedValueOnce([
      { id: 'a1', storage_key: 'k1', verify_status: 'verified' },
      { id: 'a2', storage_key: 'k2', verify_status: 'failed' },
      { id: 'a3', storage_key: 'k3', verify_status: 'pending' },
    ]);
    const trustRoot = createProvenanceTrustRoot();

    const result = await reverifyAttestations(db as Kysely<Database>, trustRoot, noStorage, {
      all: true,
    });

    expect(result.scanned).toBe(3);
    expect(result.updated).toBe(3);
    // No verify_status filter when --all.
    const whereCall = mocks.selectWhere.mock.calls.find((c) => c[0] === 'verify_status');
    expect(whereCall).toBeUndefined();
  });

  it('records unverifiable with bundle_unreadable when storage returns null', async () => {
    const { db, mocks } = createMockDb();
    mocks.selectExecute.mockResolvedValueOnce([
      { id: 'a1', storage_key: 'k1', verify_status: 'pending' },
    ]);
    const trustRoot = createProvenanceTrustRoot({
      issuer: 'https://i.example',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ keys: [{ kid: 'k', kty: 'EC' }] }), {
          status: 200,
        })) as typeof fetch,
    });
    const storage = { get: vi.fn(async () => null) } as unknown as CacheStorage;

    await reverifyAttestations(db as Kysely<Database>, trustRoot, storage, { all: false });

    expect(mocks.updateSet.mock.calls[0][0]).toMatchObject({
      verify_status: 'unverifiable',
      verify_reason: 'bundle_unreadable',
    });
  });
});
