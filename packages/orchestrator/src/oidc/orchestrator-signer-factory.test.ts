import { describe, expect, it } from 'vitest';
import {
  buildExternalSigner,
  isProvenanceSigningEnabled,
  resolveSignerKind,
} from './orchestrator-signer-factory.js';

describe('orchestrator signer factory', () => {
  it('signing is off when no issuer is configured', () => {
    expect(isProvenanceSigningEnabled({})).toBe(false);
    expect(isProvenanceSigningEnabled({ provenanceSigningIssuer: 'https://orch.example' })).toBe(
      true,
    );
  });

  it('defaults the custody kind to db', () => {
    expect(resolveSignerKind({ provenanceSigningIssuer: 'https://orch.example' })).toBe('db');
    expect(
      resolveSignerKind({
        provenanceSigningIssuer: 'https://orch.example',
        provenanceSignerKind: 'command',
      }),
    ).toBe('command');
  });

  it('rejects an invalid custody kind', () => {
    expect(() => resolveSignerKind({ provenanceSignerKind: 'gcp-kms' })).toThrow();
  });

  it('returns null for db custody and when signing is off (external factory)', async () => {
    expect(await buildExternalSigner({})).toBeNull();
    expect(
      await buildExternalSigner({ provenanceSigningIssuer: 'https://orch.example' }),
    ).toBeNull();
  });

  it('throws when an external kind is selected but its config is incomplete', async () => {
    await expect(
      buildExternalSigner({
        provenanceSigningIssuer: 'https://orch.example',
        provenanceSignerKind: 'aws-kms',
      }),
    ).rejects.toThrow(/aws-kms/);
    await expect(
      buildExternalSigner({
        provenanceSigningIssuer: 'https://orch.example',
        provenanceSignerKind: 'command',
      }),
    ).rejects.toThrow(/command/);
  });
});
