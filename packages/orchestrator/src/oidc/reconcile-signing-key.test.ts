import { describe, expect, it, vi } from 'vitest';
import type { OrchestratorSigningKeyRow } from '../db/types.js';
import type { ActivateIfCurrentResult, UpsertActiveInput } from '../db/repos/signing-keys-repo.js';
import { createKeyCreationGate, reconcileOrchestratorSigningKey } from './reconcile-signing-key.js';
import { SigningKeyStatus } from './signing-key-status.js';
import { wrapPrivateJwk } from './db-signer.js';

const KEY = '0'.repeat(64);
const ISSUER = 'https://orch.example';

/** Minimal in-memory stand-in for OrchestratorSigningKeyRepo. */
function fakeRepo(): {
  getActiveRow: () => Promise<OrchestratorSigningKeyRow | null>;
  upsertActive: (i: UpsertActiveInput) => Promise<boolean>;
  activateIfCurrent: (
    expected: string | null,
    i: UpsertActiveInput,
  ) => Promise<ActivateIfCurrentResult>;
  rows: Map<string, OrchestratorSigningKeyRow>;
} {
  const rows = new Map<string, OrchestratorSigningKeyRow>();
  const active = (): OrchestratorSigningKeyRow | null => {
    for (const r of rows.values()) if (r.status === SigningKeyStatus.enum.active) return r;
    return null;
  };
  const activate = (i: UpsertActiveInput): OrchestratorSigningKeyRow => {
    for (const r of rows.values()) {
      if (r.status === SigningKeyStatus.enum.active) r.status = SigningKeyStatus.enum.retiring;
    }
    const row: OrchestratorSigningKeyRow = {
      kid: i.kid,
      public_jwk: i.public_jwk,
      encrypted_private_jwk: i.encrypted_private_jwk,
      key_version: 1,
      alg: i.alg,
      signer_kind: i.signer_kind,
      key_ref: i.key_ref,
      status: SigningKeyStatus.enum.active,
      revocation_reason: null,
      created_at: new Date(),
      activated_at: new Date(),
      retired_at: null,
      revoked_at: null,
    };
    rows.set(i.kid, row);
    return row;
  };
  return {
    rows,
    async getActiveRow() {
      return active();
    },
    async upsertActive(i: UpsertActiveInput) {
      if (rows.get(i.kid)?.status === SigningKeyStatus.enum.active) return false;
      activate(i);
      return true;
    },
    async activateIfCurrent(expected: string | null, i: UpsertActiveInput) {
      const current = active();
      if ((current?.kid ?? null) !== expected) return { activated: false, active: current };
      return { activated: true, active: activate(i) };
    },
  };
}

describe('reconcileOrchestratorSigningKey (db custody)', () => {
  it('returns null when signing is off', async () => {
    const repo = fakeRepo();
    const result = await reconcileOrchestratorSigningKey({
      repo,
      config: {},
      mayCreateKey: () => true,
      secretKey: KEY,
      audit: vi.fn(),
    });
    expect(result).toBeNull();
    expect(repo.rows.size).toBe(0);
  });

  it('a node allowed to create generates a key when none exists, audits once, and is idempotent', async () => {
    const repo = fakeRepo();
    const audit = vi.fn();
    const deps = {
      repo,
      config: { provenanceSigningIssuer: 'https://orch.example' },
      mayCreateKey: () => true,
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

  it('a node not yet allowed to create waits (returns null, generates nothing)', async () => {
    const repo = fakeRepo();
    const result = await reconcileOrchestratorSigningKey({
      repo,
      config: { provenanceSigningIssuer: 'https://orch.example' },
      mayCreateKey: () => false,
      secretKey: KEY,
      audit: vi.fn(),
    });
    expect(result).toBeNull();
    expect(repo.rows.size).toBe(0);
  });

  it('refuses, and creates nothing, when the active key is of another custody kind', async () => {
    const repo = fakeRepo();
    await repo.upsertActive({
      kid: 'kms-kid',
      public_jwk: {},
      encrypted_private_jwk: null,
      alg: 'ES256',
      signer_kind: 'aws-kms',
      key_ref: 'arn:aws:kms:eu-west-1:1:key/k',
    });
    const activate = vi.spyOn(repo, 'activateIfCurrent');
    // fails-when: an allowed node treats the keyless KMS row as "no key" and replaces it
    await expect(
      reconcileOrchestratorSigningKey({
        repo,
        config: { provenanceSigningIssuer: ISSUER },
        mayCreateKey: () => true,
        secretKey: KEY,
        audit: vi.fn(),
      }),
    ).rejects.toThrow(/kms-kid is held in 'aws-kms' custody/);
    expect(activate).not.toHaveBeenCalled();
    expect(repo.rows.get('kms-kid')?.status).toBe(SigningKeyStatus.enum.active);
  });

  it('db custody without a master key fails loudly', async () => {
    const repo = fakeRepo();
    await expect(
      reconcileOrchestratorSigningKey({
        repo,
        config: { provenanceSigningIssuer: 'https://orch.example' },
        mayCreateKey: () => true,
        secretKey: undefined,
        audit: vi.fn(),
      }),
    ).rejects.toThrow(/KICI_SECRET_KEY/);
  });
});

describe('reconcileOrchestratorSigningKey master-key rotation', () => {
  const OLD_KEY = '1'.repeat(64);

  it('loads a signing key still wrapped under the OLD master key', async () => {
    const repo = fakeRepo();
    // Seed the row as an orchestrator running the previous master key would.
    await reconcileOrchestratorSigningKey({
      repo,
      config: { provenanceSigningIssuer: ISSUER, provenanceSignerKind: 'db' },
      mayCreateKey: () => true,
      secretKey: OLD_KEY,
      audit: vi.fn(),
    });
    const seeded = await repo.getActiveRow();
    expect(seeded?.encrypted_private_jwk).toBeTruthy();

    // Positive control: with the new key alone the boot path throws, which is
    // the failure this fallback exists to remove.
    await expect(
      reconcileOrchestratorSigningKey({
        repo,
        config: { provenanceSigningIssuer: ISSUER, provenanceSignerKind: 'db' },
        mayCreateKey: () => true,
        secretKey: KEY,
        audit: vi.fn(),
      }),
    ).rejects.toThrow();

    const reconciled = await reconcileOrchestratorSigningKey({
      repo,
      config: { provenanceSigningIssuer: ISSUER, provenanceSignerKind: 'db' },
      mayCreateKey: () => true,
      secretKey: KEY,
      oldSecretKey: OLD_KEY,
      audit: vi.fn(),
    });
    expect(await reconciled!.signer.getKid()).toBe(seeded!.kid);
  });
});

describe('reconcileOrchestratorSigningKey boot self-heal', () => {
  const OLD_KEY = '1'.repeat(64);

  it('re-seals a stranded key under the current master key and keeps the same kid', async () => {
    const repo = fakeRepo();
    await reconcileOrchestratorSigningKey({
      repo,
      config: { provenanceSigningIssuer: ISSUER, provenanceSignerKind: 'db' },
      mayCreateKey: () => true,
      secretKey: OLD_KEY,
      audit: vi.fn(),
    });
    const stranded = (await repo.getActiveRow())!;

    const selfHeal = vi.fn(async (row, privateJwk) => {
      const stored = repo.rows.get(row.kid)!;
      // Mirror what selfHealStrandedSigningKey does against the real table.
      stored.encrypted_private_jwk = wrapPrivateJwk(privateJwk, KEY);
      stored.key_version = row.key_version + 1;
    });
    const logWarn = vi.fn();

    const reconciled = await reconcileOrchestratorSigningKey({
      repo,
      config: { provenanceSigningIssuer: ISSUER, provenanceSignerKind: 'db' },
      mayCreateKey: () => true,
      secretKey: KEY,
      oldSecretKey: OLD_KEY,
      selfHeal,
      logWarn,
      audit: vi.fn(),
    });
    expect(selfHeal).toHaveBeenCalledOnce();
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('self-heal'), {
      kid: stranded.kid,
    });
    expect(await reconciled!.signer.getKid()).toBe(stranded.kid);

    // The healed row now opens under the current key ALONE — which is the whole
    // point: the operator can drop KICI_SECRET_KEY_OLD without stranding it.
    const healed = await reconcileOrchestratorSigningKey({
      repo,
      config: { provenanceSigningIssuer: ISSUER, provenanceSignerKind: 'db' },
      mayCreateKey: () => true,
      secretKey: KEY,
      audit: vi.fn(),
    });
    expect(await healed!.signer.getKid()).toBe(stranded.kid);
  });

  it('does not call selfHeal when the row already opens under the current key', async () => {
    const repo = fakeRepo();
    await reconcileOrchestratorSigningKey({
      repo,
      config: { provenanceSigningIssuer: ISSUER, provenanceSignerKind: 'db' },
      mayCreateKey: () => true,
      secretKey: KEY,
      audit: vi.fn(),
    });
    const selfHeal = vi.fn();
    await reconcileOrchestratorSigningKey({
      repo,
      config: { provenanceSigningIssuer: ISSUER, provenanceSignerKind: 'db' },
      mayCreateKey: () => true,
      secretKey: KEY,
      oldSecretKey: OLD_KEY,
      selfHeal,
      audit: vi.fn(),
    });
    expect(selfHeal).not.toHaveBeenCalled();
  });

  it('throws a recovery-pointing error, not a bare AES-GCM failure, when both keys miss', async () => {
    const repo = fakeRepo();
    await reconcileOrchestratorSigningKey({
      repo,
      config: { provenanceSigningIssuer: ISSUER, provenanceSignerKind: 'db' },
      mayCreateKey: () => true,
      secretKey: '2'.repeat(64),
      audit: vi.fn(),
    });
    await expect(
      reconcileOrchestratorSigningKey({
        repo,
        config: { provenanceSigningIssuer: ISSUER, provenanceSignerKind: 'db' },
        mayCreateKey: () => true,
        secretKey: KEY,
        oldSecretKey: OLD_KEY,
        audit: vi.fn(),
      }),
    ).rejects.toThrow(/KICI_SECRET_KEY_OLD/);
  });
});

describe('createKeyCreationGate', () => {
  it('lets the leader create at once', () => {
    const gate = createKeyCreationGate({ isLeader: () => true, graceMs: 2_000, now: () => 0 });
    expect(gate()).toBe(true);
  });

  it('lets a non-leader create only once the grace since its first ask has passed', () => {
    let now = 10_000;
    const gate = createKeyCreationGate({ isLeader: () => false, graceMs: 2_000, now: () => now });
    // breaks-if-wrong: inside the grace the leader keeps the first chance.
    expect(gate()).toBe(false);
    now += 1_999;
    expect(gate()).toBe(false);
    // fails-when: the gate never opens for a non-leader, which is the cluster
    // whose leader has signing disabled never getting a key.
    now += 1;
    expect(gate()).toBe(true);
  });

  it('opens for a node that becomes leader inside the grace', () => {
    let leader = false;
    const gate = createKeyCreationGate({ isLeader: () => leader, graceMs: 2_000, now: () => 0 });
    expect(gate()).toBe(false);
    leader = true;
    expect(gate()).toBe(true);
  });
});
