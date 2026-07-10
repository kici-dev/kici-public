import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { localTrustRootCommand } from './local-trust-root.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-trust-root-'));
  process.env.KICI_CONFIG_DIR = tmp;
});
afterEach(() => {
  delete process.env.KICI_CONFIG_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('localTrustRootCommand', () => {
  it('fails clearly when the plane has no published dev identity', async () => {
    const out = path.join(tmp, 'tr.json');
    const ok = await localTrustRootCommand(out);
    expect(ok).toBe(false);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('writes a { issuer: kici-local, jwks } trust root from the published public JWK', async () => {
    // Simulate the plane orchestrator having published its public JWK.
    const devDir = path.join(tmp, 'local', 'dev-identity');
    fs.mkdirSync(devDir, { recursive: true });
    const pubJwk = { kty: 'EC', crv: 'P-256', x: 'X', y: 'Y', alg: 'ES256', use: 'sig', kid: 'k1' };
    fs.writeFileSync(path.join(devDir, 'identity.pub.jwk'), JSON.stringify(pubJwk));

    const out = path.join(tmp, 'tr.json');
    const ok = await localTrustRootCommand(out);
    expect(ok).toBe(true);

    const written = JSON.parse(fs.readFileSync(out, 'utf-8'));
    expect(written.issuer).toBe('kici-local');
    // Never the prod issuer — kici-local can't masquerade.
    expect(written.issuer).not.toBe('https://api.kici.dev');
    expect(written.jwks.keys).toHaveLength(1);
    expect(written.jwks.keys[0].kid).toBe('k1');
  });

  it('rejects an empty output path', async () => {
    expect(await localTrustRootCommand('')).toBe(false);
  });
});
