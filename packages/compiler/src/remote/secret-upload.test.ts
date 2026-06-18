import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { decryptJson } from '@kici-dev/core';

vi.mock('../local-executor/secret-loader.js', () => ({
  loadLocalSecrets: vi.fn(async () => ({
    flat: { TOKEN: 'abc' },
    contexts: { db: { URL: 'postgres://x' } },
  })),
}));

import { buildEncryptedSecrets, parseContextFlags } from './secret-upload.js';

function recipient() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKeyB64: Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).toString('base64'),
    privateKey: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' })),
  };
}

type Blob = { flat: Record<string, string>; contexts: Record<string, Record<string, string>> };

describe('parseContextFlags', () => {
  it('parses ctx.key=value into a nested map', () => {
    expect(parseContextFlags(['db.URL=postgres://y', 'api.TOKEN=t'])).toEqual({
      db: { URL: 'postgres://y' },
      api: { TOKEN: 't' },
    });
  });
  it('keeps = inside the value', () => {
    expect(parseContextFlags(['db.DSN=a=b=c'])).toEqual({ db: { DSN: 'a=b=c' } });
  });
  it('skips malformed flags (no dot or no equals)', () => {
    expect(parseContextFlags(['nodot', 'db.NOEQ', 'db.K=v'])).toEqual({ db: { K: 'v' } });
  });
  it('returns empty for undefined/empty', () => {
    expect(parseContextFlags(undefined)).toEqual({});
    expect(parseContextFlags([])).toEqual({});
  });
});

describe('buildEncryptedSecrets', () => {
  it('encrypts loaded local secrets to the orchestrator public key', async () => {
    const r = recipient();
    const result = await buildEncryptedSecrets('/repo/.kici', [], [], r.publicKeyB64);
    expect(result).not.toBeNull();
    const decoded = decryptJson<Blob>(
      result!.encryptedSecrets,
      Buffer.from(result!.cliPublicKey, 'base64'),
      r.privateKey,
    );
    expect(decoded.flat.TOKEN).toBe('abc');
    expect(decoded.contexts.db.URL).toBe('postgres://x');
  });

  it('folds --context flags into the blob contexts (overriding file contexts)', async () => {
    const r = recipient();
    const result = await buildEncryptedSecrets(
      '/repo/.kici',
      [],
      ['db.URL=postgres://override', 'api.KEY=secret'],
      r.publicKeyB64,
    );
    expect(result).not.toBeNull();
    const decoded = decryptJson<Blob>(
      result!.encryptedSecrets,
      Buffer.from(result!.cliPublicKey, 'base64'),
      r.privateKey,
    );
    expect(decoded.contexts.db.URL).toBe('postgres://override');
    expect(decoded.contexts.api.KEY).toBe('secret');
  });

  it('returns null when there are no local secrets, no --env, and no --context', async () => {
    const { loadLocalSecrets } = await import('../local-executor/secret-loader.js');
    vi.mocked(loadLocalSecrets).mockResolvedValueOnce({ flat: {}, contexts: {} });
    const r = recipient();
    const result = await buildEncryptedSecrets('/repo/.kici', [], [], r.publicKeyB64);
    expect(result).toBeNull();
  });

  it('returns non-null when ONLY a --context flag is present', async () => {
    const { loadLocalSecrets } = await import('../local-executor/secret-loader.js');
    vi.mocked(loadLocalSecrets).mockResolvedValueOnce({ flat: {}, contexts: {} });
    const r = recipient();
    const result = await buildEncryptedSecrets('/repo/.kici', [], ['db.K=v'], r.publicKeyB64);
    expect(result).not.toBeNull();
    const decoded = decryptJson<Blob>(
      result!.encryptedSecrets,
      Buffer.from(result!.cliPublicKey, 'base64'),
      r.privateKey,
    );
    expect(decoded.contexts.db.K).toBe('v');
  });
});
