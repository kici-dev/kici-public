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

vi.mock('../provenance-trust-root.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../provenance-trust-root.js')>()),
  resolveTrustRoot: vi
    .fn()
    .mockResolvedValue({ issuer: 'https://i', jwks: { keys: [] }, warnings: [] }),
}));

vi.mock('@kici-dev/engine/provenance/verify', () => ({
  verifyKiciBundle: vi.fn(),
}));

vi.mock('../remote/config.js', () => ({
  loadGlobalConfig: vi.fn().mockResolvedValue({}),
  getConfigPath: () => '/home/u/.kici/config',
}));

import { sha256File } from '@kici-dev/core';
import { InsecureTrustRootError, resolveTrustRoot } from '../provenance-trust-root.js';
import { verifyKiciBundle } from '@kici-dev/engine/provenance/verify';
import { loadGlobalConfig } from '../remote/config.js';
import { verifyAttestationCommand } from './verify-attestation.js';

const mockVerify = verifyKiciBundle as unknown as ReturnType<typeof vi.fn>;
const mockResolve = resolveTrustRoot as unknown as ReturnType<typeof vi.fn>;
const mockSha = sha256File as unknown as ReturnType<typeof vi.fn>;
const mockLoadConfig = loadGlobalConfig as unknown as ReturnType<typeof vi.fn>;

describe('kici verify-attestation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logOutput.length = 0;
    consoleOutput.length = 0;
    mockResolve.mockResolvedValue({ issuer: 'https://i', jwks: { keys: [] }, warnings: [] });
    mockSha.mockResolvedValue('a'.repeat(64));
    mockLoadConfig.mockResolvedValue({}); // no configured orchestrator by default
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
      claims: {
        repository: 'github.com/acme/api',
        ref: 'refs/heads/main',
        sha: 'deadbeef',
        org_id: 'org_acme',
        source_origin: 'triggered',
        provider: 'github',
      },
      failures: [],
    });
    const ok = await verifyAttestationCommand(undefined, {
      bundle: '/tmp/b.json',
      trustRoot: 'https://i',
    });
    expect(ok).toBe(true);
    expect(logOutput.join('\n')).toContain('PASS');
    expect(logOutput.join('\n')).toContain('github.com/acme/api');
    expect(logOutput.join('\n')).toContain('origin org=org_acme');
    expect(logOutput.join('\n')).toContain('provider=github');
  });

  it('prints origin + an unmistakable run-remote source line', async () => {
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
      claims: {
        repository: 'local/x',
        ref: 'main',
        sha: 'main',
        kici_run_id: 'r1',
        kici_job_id: 'j1',
        org_id: 'org_abc123',
        source_origin: 'run-remote',
        provider: 'local',
      },
      failures: [],
    });
    const ok = await verifyAttestationCommand(undefined, {
      bundle: '/tmp/b.json',
      trustRoot: 'https://api.kici.dev',
    });
    expect(ok).toBe(true);
    const out = logOutput.join('\n');
    expect(out).toContain('origin org=org_abc123');
    expect(out.toLowerCase()).toContain('kici run remote');
    expect(out).toContain('caller-supplied');
  });

  it('prints an offline-backfill marker on a PASS', async () => {
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
      attestationOrigin: 'offline-backfill',
      claims: {
        repository: 'acme/app',
        ref: 'main',
        sha: 'deadbeef',
        kici_run_id: 'r1',
        kici_job_id: 'j1',
      },
      failures: [],
    });
    const ok = await verifyAttestationCommand(undefined, {
      bundle: '/tmp/b.json',
      trustRoot: 'https://api.kici.dev',
    });
    expect(ok).toBe(true);
    const out = logOutput.join('\n').toLowerCase();
    expect(out).toContain('offline-backfill');
    expect(out).toContain('minted later');
  });

  it('prints a deferred marker on a PASS', async () => {
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
      attestationOrigin: 'deferred',
      claims: { repository: 'acme/app', kici_run_id: 'r1', kici_job_id: 'j1' },
      failures: [],
    });
    const ok = await verifyAttestationCommand(undefined, {
      bundle: '/tmp/b.json',
      trustRoot: 'https://api.kici.dev',
    });
    expect(ok).toBe(true);
    expect(logOutput.join('\n').toLowerCase()).toContain('deferred');
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

  it('fails with both remedies when no trust root and no orchestrator are configured', async () => {
    // fails-when: the command still falls back to the hosted Platform issuer.
    const ok = await verifyAttestationCommand(undefined, { bundle: '/tmp/b.json' });
    expect(ok).toBe(false);
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
    const out = logOutput.join('\n');
    expect(out).toContain('--trust-root');
    // fails-when: the remedy names `kici login`, which never sets the
    // orchestrator endpoint, instead of the config field the default reads.
    expect(out).toContain('set "endpoint" in /home/u/.kici/config');
    expect(out).not.toContain('kici login');
  });

  it('defaults --trust-root to the CONFIGURED ORCHESTRATOR when one is set', async () => {
    // breaks-if-wrong: the configured orchestrator must still be the default.
    mockLoadConfig.mockResolvedValue({ endpoint: 'https://orch.example' });
    mockVerify.mockResolvedValue({
      verified: true,
      mode: 'kici',
      checks: {},
      claims: {},
      failures: [],
    });
    const ok = await verifyAttestationCommand(undefined, { bundle: '/tmp/b.json' });
    expect(ok).toBe(true);
    expect(mockResolve).toHaveBeenCalledWith('https://orch.example', { allowInsecure: false });
    expect(logOutput.join('\n')).toContain('configured orchestrator');
  });

  it('gives a provenance-not-enabled message when the default issuer returns 503', async () => {
    mockLoadConfig.mockResolvedValue({ endpoint: 'https://orch.example' });
    mockResolve.mockRejectedValue(
      new Error('failed to fetch https://orch.example/.well-known/openid-configuration: 503'),
    );
    const ok = await verifyAttestationCommand(undefined, { bundle: '/tmp/b.json' });
    expect(ok).toBe(false);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(logOutput.join('\n')).toContain(
      'build provenance signing is not enabled on your configured orchestrator',
    );
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

  describe('a plain-HTTP trust root on a host that is not loopback', () => {
    const verified = { verified: true, mode: 'kici', checks: {}, claims: {}, failures: [] };
    let stderr: string[];
    beforeEach(() => {
      stderr = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        stderr.push(String(chunk));
        return true;
      });
      mockVerify.mockResolvedValue(verified);
    });

    // fails-when: the refusal goes to stdout (the logger), or the command
    // still verifies — CI reads the exit code and stdout.
    it('refuses with exit 1, the reason on stderr, and nothing on stdout', async () => {
      mockResolve.mockRejectedValue(new InsecureTrustRootError('http://10.0.0.5:10143/x'));
      const ok = await verifyAttestationCommand(undefined, {
        bundle: '/tmp/b.json',
        trustRoot: 'http://10.0.0.5:10143',
        json: true,
      });
      expect(ok).toBe(false);
      expect(mockVerify).not.toHaveBeenCalled();
      expect(consoleOutput).toEqual([]);
      expect(logOutput).toEqual([]);
      const err = stderr.join('');
      expect(err).toContain('http://10.0.0.5:10143/x');
      expect(err).toContain('--allow-insecure-trust-root');
    });

    // breaks-if-wrong: with the flag the command still verifies, and --json
    // stdout stays parseable while the warning goes to stderr.
    it('verifies with --allow-insecure-trust-root and warns on stderr only', async () => {
      mockResolve.mockResolvedValue({
        issuer: 'http://10.0.0.5:10143',
        jwks: { keys: [] },
        warnings: ['trust root URL http://10.0.0.5:10143 is plain HTTP'],
      });
      const ok = await verifyAttestationCommand(undefined, {
        bundle: '/tmp/b.json',
        trustRoot: 'http://10.0.0.5:10143',
        json: true,
        allowInsecureTrustRoot: true,
      });
      expect(ok).toBe(true);
      expect(mockResolve).toHaveBeenCalledWith('http://10.0.0.5:10143', { allowInsecure: true });
      expect(JSON.parse(consoleOutput.join(''))).toMatchObject({ verified: true });
      expect(stderr.join('')).toContain('Warning: trust root URL http://10.0.0.5:10143');
    });
  });
});
