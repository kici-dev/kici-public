import { describe, it, expect, vi, beforeEach } from 'vitest';

const logOutput: string[] = [];
const consoleOutput: string[] = [];

vi.mock('@kici-dev/core', () => ({
  logger: {
    info: vi.fn((msg: string) => logOutput.push(msg)),
    error: vi.fn((msg: string) => logOutput.push(msg)),
    warn: vi.fn(),
    debug: vi.fn(),
  },
  toErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  sha256File: vi.fn().mockResolvedValue('a'.repeat(64)),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(JSON.stringify({ mediaType: 'x' })),
}));

vi.mock('../provenance-trust-root.js', () => ({
  resolveTrustRoot: vi.fn().mockResolvedValue({ issuer: 'https://i', jwks: { keys: [] } }),
}));

vi.mock('@kici-dev/engine/provenance/verify', () => ({
  verifyKiciBundle: vi.fn(),
}));

import { sha256File } from '@kici-dev/core';
import { resolveTrustRoot } from '../provenance-trust-root.js';
import { verifyKiciBundle } from '@kici-dev/engine/provenance/verify';
import { verifyAttestationCommand } from './verify-attestation.js';

const mockVerify = verifyKiciBundle as unknown as ReturnType<typeof vi.fn>;
const mockResolve = resolveTrustRoot as unknown as ReturnType<typeof vi.fn>;
const mockSha = sha256File as unknown as ReturnType<typeof vi.fn>;

describe('kici verify-attestation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logOutput.length = 0;
    consoleOutput.length = 0;
    mockResolve.mockResolvedValue({ issuer: 'https://i', jwks: { keys: [] } });
    mockSha.mockResolvedValue('a'.repeat(64));
    vi.spyOn(console, 'log').mockImplementation((msg: string) => consoleOutput.push(msg));
  });

  it('returns true and prints PASS when verification succeeds', async () => {
    mockVerify.mockResolvedValue({
      verified: true,
      mode: 'kici',
      checks: {
        schema: 'pass',
        jwt: 'pass',
        dsse: 'pass',
        buildContext: 'pass',
        digest: 'skipped',
      },
      claims: { repository: 'github.com/acme/api', ref: 'refs/heads/main', sha: 'deadbeef' },
      failures: [],
    });
    const ok = await verifyAttestationCommand(undefined, {
      bundle: '/tmp/b.json',
      trustRoot: 'https://i',
    });
    expect(ok).toBe(true);
    expect(logOutput.join('\n')).toContain('PASS');
    expect(logOutput.join('\n')).toContain('github.com/acme/api');
  });

  it('digest-checks the artifact when an artifact path is given', async () => {
    mockVerify.mockResolvedValue({
      verified: true,
      mode: 'kici',
      checks: {},
      claims: {},
      failures: [],
    });
    const ok = await verifyAttestationCommand('/tmp/artifact.tgz', {
      bundle: '/tmp/b.json',
      trustRoot: 'https://i',
    });
    expect(ok).toBe(true);
    expect(mockSha).toHaveBeenCalledWith('/tmp/artifact.tgz');
    expect(mockVerify).toHaveBeenCalledWith(
      expect.objectContaining({ expectedDigest: { alg: 'sha256', hex: 'a'.repeat(64) } }),
    );
  });

  it('returns false and prints FAIL when verification fails', async () => {
    mockVerify.mockResolvedValue({
      verified: false,
      mode: 'kici',
      checks: {},
      failures: ['dsse_signature_invalid'],
    });
    const ok = await verifyAttestationCommand(undefined, {
      bundle: '/tmp/b.json',
      trustRoot: 'https://i',
    });
    expect(ok).toBe(false);
    expect(logOutput.join('\n')).toContain('FAIL');
    expect(logOutput.join('\n')).toContain('dsse_signature_invalid');
  });

  it('emits the structured result with --json', async () => {
    const result = { verified: true, mode: 'kici', checks: {}, claims: {}, failures: [] };
    mockVerify.mockResolvedValue(result);
    const ok = await verifyAttestationCommand(undefined, {
      bundle: '/tmp/b.json',
      trustRoot: 'https://i',
      json: true,
    });
    expect(ok).toBe(true);
    expect(JSON.parse(consoleOutput.join(''))).toMatchObject({ verified: true, mode: 'kici' });
  });

  it('errors (returns false) when --bundle is missing', async () => {
    const ok = await verifyAttestationCommand(undefined, { trustRoot: 'https://i' });
    expect(ok).toBe(false);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('defaults --trust-root to the hosted prod issuer when omitted', async () => {
    mockVerify.mockResolvedValue({
      verified: true,
      mode: 'kici',
      checks: {},
      claims: {},
      failures: [],
    });
    const ok = await verifyAttestationCommand(undefined, { bundle: '/tmp/b.json' });
    expect(ok).toBe(true);
    expect(mockResolve).toHaveBeenCalledWith('https://api.kici.dev');
    expect(logOutput.join('\n')).toContain('Using default trust root https://api.kici.dev');
  });

  it('gives a provenance-not-enabled message when the default issuer returns 503', async () => {
    mockResolve.mockRejectedValue(
      new Error('failed to fetch https://api.kici.dev/.well-known/openid-configuration: 503'),
    );
    const ok = await verifyAttestationCommand(undefined, { bundle: '/tmp/b.json' });
    expect(ok).toBe(false);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(logOutput.join('\n')).toContain('not enabled on the hosted KiCI platform yet');
  });

  it('uses the provided --audience over the default', async () => {
    mockVerify.mockResolvedValue({
      verified: true,
      mode: 'kici',
      checks: {},
      claims: {},
      failures: [],
    });
    await verifyAttestationCommand(undefined, {
      bundle: '/tmp/b.json',
      trustRoot: 'https://i',
      audience: 'custom-aud',
    });
    expect(mockVerify).toHaveBeenCalledWith(
      expect.objectContaining({ expectedAudience: 'custom-aud' }),
    );
  });
});
