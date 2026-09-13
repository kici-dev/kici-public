import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';
import { CommandSigner } from './command-signer.js';

/**
 * Build a throwaway signer command script that answers `get-public-jwk` and
 * `sign` using a real ES256 keypair, so the CommandSigner round-trip is verified
 * end-to-end against genuine crypto (not a stub signature).
 */
describe('CommandSigner', () => {
  let dir: string;
  let scriptPath: string;
  let publicJwk: JWK;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    publicJwk = await exportJWK(publicKey);
    const privateJwk = await exportJWK(privateKey);
    dir = mkdtempSync(join(tmpdir(), 'kici-cmd-signer-'));
    const keyFile = join(dir, 'priv.json');
    writeFileSync(keyFile, JSON.stringify(privateJwk));
    scriptPath = join(dir, 'signer.mjs');
    // A tiny Node signer honoring the documented contract.
    // Self-contained: only Node globals (no jose import — the script runs from a
    // tmpdir where the workspace node_modules is not resolvable).
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const sub = process.argv[2];
const privateJwk = JSON.parse(readFileSync(${JSON.stringify(keyFile)}, 'utf8'));
if (sub === 'get-public-jwk') {
  const { d, ...pub } = privateJwk;
  process.stdout.write(JSON.stringify(pub));
} else if (sub === 'sign') {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const data = Buffer.from(Buffer.concat(chunks).toString('utf8'), 'base64');
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data);
  process.stdout.write(Buffer.from(sig).toString('base64'));
} else {
  process.exit(2);
}
`,
    );
    chmodSync(scriptPath, 0o755);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the public JWK and signs verifiably via the external command', async () => {
    const signer = await CommandSigner.create({ command: scriptPath });
    expect(signer.signerKind).toBe('command');
    expect(signer.keyRef).toBe(scriptPath);

    const data = new TextEncoder().encode('provenance signing input');
    const sig = await signer.sign(data);
    expect(sig.length).toBe(64);

    const pub = (await importJWK(publicJwk, 'ES256')) as CryptoKey;
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pub,
      sig as unknown as BufferSource,
      data as unknown as BufferSource,
    );
    expect(ok).toBe(true);
  });
});
