import { describe, expect, it, vi } from 'vitest';
import type { OrchestratorSigningKeyRow } from '../db/types.js';
import type { UpsertActiveInput } from '../db/repos/signing-keys-repo.js';
import { reconcileOrchestratorSigningKey } from './reconcile-signing-key.js';

const KEY = '0'.repeat(64);

/** Minimal in-memory stand-in for OrchestratorSigningKeyRepo (getActiveRow/upsertActive). */
function fakeRepo(): {
  getActiveRow: () => Promise<OrchestratorSigningKeyRow | null>;
  upsertActive: (i: UpsertActiveInput) => Promise<boolean>;
  rows: Map<string, OrchestratorSigningKeyRow>;
} {
  const rows = new Map<string, OrchestratorSigningKeyRow>();
  return {
    rows,
    async getActiveRow() {
      for (const r of rows.values()) if (r.status === 'active') return r;
      return null;
    },
    async upsertActive(i: UpsertActiveInput) {
      const existing = rows.get(i.kid);
      if (existing?.status === 'active') return false;
      for (const r of rows.values()) if (r.status === 'active') r.status = 'retiring';
      rows.set(i.kid, {
        kid: i.kid,
        public_jwk: i.public_jwk,
        encrypted_private_jwk: i.encrypted_private_jwk,
        key_version: 1,
        alg: i.alg,
        signer_kind: i.signer_kind,
        key_ref: i.key_ref,
        status: 'active',
        revocation_reason: null,
        created_at: new Date(),
        activated_at: new Date(),
        retired_at: null,
        revoked_at: null,
      });
      return true;
    },
  };
}

describe('reconcileOrchestratorSigningKey (db custody)', () => {
  it('returns null when signing is off', async () => {
    const repo = fakeRepo();
    const result = await reconcileOrchestratorSigningKey({
      repo,
      config: {},
      isLeader: () => true,
      secretKey: KEY,
      audit: vi.fn(),
    });
    expect(result).toBeNull();
    expect(repo.rows.size).toBe(0);
  });

  it('leader generates a key when none exists, audits once, and is idempotent', async () => {
    const repo = fakeRepo();
    const audit = vi.fn();
    const deps = {
      repo,
      config: { provenanceSigningIssuer: 'https://orch.example' },
      isLeader: () => true,
      secretKey: KEY,
      audit,
    };
    const first = await reconcileOrchestratorSigningKey(deps);
    expect(first).not.toBeNull();
    expect(repo.rows.size).toBe(1);
    const kid = await first!.signer.getKid();
    expect([...repo.rows.keys()]).toEqual([kid]);
    expect(audit).toHaveBeenCalledTimes(1);

    // Second reconcile loads the existing active row — no new key, no new audit.
    const second = await reconcileOrchestratorSigningKey(deps);
    expect(await second!.signer.getKid()).toBe(kid);
    expect(repo.rows.size).toBe(1);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('a non-leader with no active row waits (returns null, generates nothing)', async () => {
    const repo = fakeRepo();
    const result = await reconcileOrchestratorSigningKey({
      repo,
      config: { provenanceSigningIssuer: 'https://orch.example' },
      isLeader: () => false,
      secretKey: KEY,
      audit: vi.fn(),
    });
    expect(result).toBeNull();
    expect(repo.rows.size).toBe(0);
  });

  it('db custody without a master key fails loudly', async () => {
    const repo = fakeRepo();
    await expect(
      reconcileOrchestratorSigningKey({
        repo,
        config: { provenanceSigningIssuer: 'https://orch.example' },
        isLeader: () => true,
        secretKey: undefined,
        audit: vi.fn(),
      }),
    ).rejects.toThrow(/KICI_SECRET_KEY/);
  });
});
