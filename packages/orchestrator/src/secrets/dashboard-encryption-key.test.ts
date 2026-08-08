import { describe, it, expect, vi } from 'vitest';
import {
  generateDashboardEncryptionKey,
  reconcileDashboardEncryptionKey,
} from './dashboard-encryption-key.js';
import { decryptPrivateKey, decryptDashboardSealedWrite } from './ephemeral-keys.js';
import type { DashboardEncryptionKeyRepo } from '../db/repos/dashboard-encryption-keys-repo.js';
import {
  createPublicKey,
  createPrivateKey,
  generateKeyPairSync,
  diffieHellman,
  hkdfSync,
  randomBytes,
  createCipheriv,
} from 'node:crypto';
import type { JWK } from 'jose';

const SECRET = 'a'.repeat(64);

interface Row {
  kid: string;
  public_jwk: unknown;
  encrypted_private_key: string;
  status: string;
}

/** Minimal in-memory repo covering the reconcile's three methods. */
function fakeRepo(seed: Row[] = []) {
  const rows = new Map<string, Row>(seed.map((r) => [r.kid, r]));
  const repo: Pick<DashboardEncryptionKeyRepo, 'getActiveRow' | 'upsertActive' | 'getByKid'> = {
    async getActiveRow() {
      const active = [...rows.values()].find((r) => r.status === 'active');
      return (active ?? null) as never;
    },
    async getByKid(kid: string) {
      return (rows.get(kid) ?? null) as never;
    },
    async upsertActive(input) {
      const existing = rows.get(input.kid);
      if (existing?.status === 'active') return false;
      for (const r of rows.values()) if (r.status === 'active') r.status = 'revoked';
      rows.set(input.kid, {
        kid: input.kid,
        public_jwk: input.public_jwk,
        encrypted_private_key: input.encrypted_private_key,
        status: 'active',
      });
      return true;
    },
  };
  return { repo, rows };
}

/** Node-side stand-in for the browser seal (DER-SPKI eph pubkey + dashboard info). */
function sealToJwk(
  value: string,
  orchPublicJwk: JWK,
): { ephemeralPublicKey: string; encrypted: string } {
  const orchPubDer = createPublicKey({ key: orchPublicJwk as never, format: 'jwk' }).export({
    type: 'spki',
    format: 'der',
  }) as Buffer;
  const eph = generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const shared = diffieHellman({
    privateKey: createPrivateKey({ key: eph.privateKey as Buffer, format: 'der', type: 'pkcs8' }),
    publicKey: createPublicKey({ key: orchPubDer, format: 'der', type: 'spki' }),
  });
  const aes = Buffer.from(
    hkdfSync('sha256', shared, Buffer.alloc(0), 'kici-dashboard-sealed-write', 32),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aes, iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
  return {
    ephemeralPublicKey: (eph.publicKey as Buffer).toString('base64'),
    encrypted: Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64'),
  };
}

describe('generateDashboardEncryptionKey', () => {
  it('produces an OKP/X25519 use:enc JWK with a thumbprint kid', async () => {
    const k = await generateDashboardEncryptionKey(SECRET);
    expect(k.publicJwk.kty).toBe('OKP');
    expect(k.publicJwk.crv).toBe('X25519');
    expect(k.publicJwk.use).toBe('enc');
    expect(k.publicJwk.kid).toBe(k.kid);
    expect(k.kid.length).toBeGreaterThan(0);
  });

  it('wraps the private key so decryptPrivateKey unwraps back to the DER key', async () => {
    const k = await generateDashboardEncryptionKey(SECRET);
    const der = decryptPrivateKey(k.encryptedPrivateKey, SECRET);
    expect(der.length).toBeGreaterThan(0);
    // The unwrapped private key decrypts a browser seal to the published JWK.
    const env = sealToJwk('round-trip', k.publicJwk);
    expect(decryptDashboardSealedWrite(env, der)).toBe('round-trip');
  });
});

describe('reconcileDashboardEncryptionKey', () => {
  it('throws without a secret key', async () => {
    const { repo } = fakeRepo();
    await expect(
      reconcileDashboardEncryptionKey({
        repo,
        isLeader: () => true,
        secretKey: undefined,
        audit: vi.fn(),
      }),
    ).rejects.toThrow(/KICI_SECRET_KEY/);
  });

  it('leader generates + persists exactly one active key and audits once', async () => {
    const { repo, rows } = fakeRepo();
    const audit = vi.fn();
    const resolved = await reconcileDashboardEncryptionKey({
      repo,
      isLeader: () => true,
      secretKey: SECRET,
      audit,
    });
    expect(resolved).not.toBeNull();
    expect([...rows.values()].filter((r) => r.status === 'active')).toHaveLength(1);
    expect(audit).toHaveBeenCalledOnce();
    // The resolved decrypt closure round-trips a seal to the active pubkey.
    const env = sealToJwk('secret', resolved!.publicJwk);
    const der = await resolved!.decryptPrivateKeyDer(resolved!.activeKid);
    expect(der).not.toBeNull();
    expect(decryptDashboardSealedWrite(env, der!)).toBe('secret');
  });

  it('non-leader with an empty repo returns null (waits)', async () => {
    const { repo } = fakeRepo();
    const resolved = await reconcileDashboardEncryptionKey({
      repo,
      isLeader: () => false,
      secretKey: SECRET,
      audit: vi.fn(),
    });
    expect(resolved).toBeNull();
  });

  it('loads an existing active key without regenerating', async () => {
    const { repo } = fakeRepo();
    const first = await reconcileDashboardEncryptionKey({
      repo,
      isLeader: () => true,
      secretKey: SECRET,
      audit: vi.fn(),
    });
    const audit2 = vi.fn();
    const second = await reconcileDashboardEncryptionKey({
      repo,
      isLeader: () => false,
      secretKey: SECRET,
      audit: audit2,
    });
    expect(second?.activeKid).toBe(first?.activeKid);
    expect(audit2).not.toHaveBeenCalled();
  });

  it('decryptPrivateKeyDer returns null for an unknown kid', async () => {
    const { repo } = fakeRepo();
    const resolved = await reconcileDashboardEncryptionKey({
      repo,
      isLeader: () => true,
      secretKey: SECRET,
      audit: vi.fn(),
    });
    expect(await resolved!.decryptPrivateKeyDer('nope')).toBeNull();
  });
});
