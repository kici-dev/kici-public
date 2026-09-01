import { describe, it, expect, vi } from 'vitest';
import { GitCredentialBroker } from './credential-broker.js';

const secretResolver = (values: Record<string, string>) =>
  ({
    resolveNamed: vi.fn(async (_org: string, _scope: string, key: string) => values[key] ?? null),
  }) as never;

const noSource = async () => null;

describe('GitCredentialBroker', () => {
  it('returns a static token unscoped — a PAT cannot be narrowed', async () => {
    const broker = new GitCredentialBroker({
      secretResolver: secretResolver({ FORGE_PAT: 'pat-value' }),
      sourceAuth: noSource,
      mint: vi.fn(),
    });
    const result = await broker.resolve({
      orgId: 'org-1',
      repositories: ['acme/app'],
      ref: { kind: 'token', tokenSecret: 'ci:FORGE_PAT', user: 'oauth2' },
      permissions: { contents: 'read' },
    });

    expect(result.kind).toBe('basic');
    expect(result.user).toBe('oauth2');
    expect(result.secret).toBe('pat-value');
    // Requested contents:read, but nothing was actually enforced. Say so.
    expect(result.grant).toEqual({ scoped: false });
    expect(result.expiresAt).toBeNull();
  });

  it('resolves the secret against the context named in the qualified ref', async () => {
    const resolver = secretResolver({ FORGE_PAT: 'pat-value' });
    const broker = new GitCredentialBroker({
      secretResolver: resolver,
      sourceAuth: noSource,
      mint: vi.fn(),
    });
    await broker.resolve({
      orgId: 'org-1',
      repositories: ['acme/app'],
      ref: { kind: 'token', tokenSecret: 'prod:FORGE_PAT' },
    });
    expect(
      (resolver as unknown as { resolveNamed: ReturnType<typeof vi.fn> }).resolveNamed,
    ).toHaveBeenCalledWith('org-1', 'prod', 'FORGE_PAT', expect.anything());
  });

  it('returns runtime material verbatim through the *Value half', async () => {
    const resolver = secretResolver({});
    const broker = new GitCredentialBroker({
      secretResolver: resolver,
      sourceAuth: noSource,
      mint: vi.fn(),
    });
    const result = await broker.resolve({
      orgId: 'org-1',
      repositories: ['acme/app'],
      ref: { kind: 'token', tokenValue: 'runtime-material' },
    });
    expect(result.secret).toBe('runtime-material');
    // No secret-store lookup happens for material.
    expect(
      (resolver as unknown as { resolveNamed: ReturnType<typeof vi.fn> }).resolveNamed,
    ).not.toHaveBeenCalled();
  });

  it('returns an ssh key as kind ssh, unscoped and non-expiring', async () => {
    const broker = new GitCredentialBroker({
      secretResolver: secretResolver({ DEPLOY_KEY: '-----BEGIN PRIVATE KEY-----' }),
      sourceAuth: noSource,
      mint: vi.fn(),
    });
    const result = await broker.resolve({
      orgId: 'org-1',
      repositories: ['acme/app'],
      ref: { kind: 'ssh', privateKeySecret: 'ci:DEPLOY_KEY' },
    });
    expect(result.kind).toBe('ssh');
    expect(result.grant).toEqual({ scoped: false });
    expect(result.expiresAt).toBeNull();
  });

  it('mints an app credential and reports the granted permissions', async () => {
    const mint = vi.fn().mockResolvedValue({
      token: 'ghs_x',
      expiresAt: '2026-08-22T05:51:29Z',
      grantedPermissions: { contents: 'write', workflows: 'write' },
      repositorySelection: 'selected',
    });
    const broker = new GitCredentialBroker({
      secretResolver: secretResolver({ APP_ID: '11', INSTALL_ID: '22', APP_KEY: 'pem' }),
      sourceAuth: noSource,
      mint,
    });
    const result = await broker.resolve({
      orgId: 'org-1',
      repositories: ['kici-dev/kici-forge-app-token-tester'],
      ref: {
        kind: 'app',
        appIdSecret: 'ci:APP_ID',
        installationIdSecret: 'ci:INSTALL_ID',
        privateKeySecret: 'ci:APP_KEY',
      },
      permissions: { contents: 'write', workflows: 'write' },
    });

    expect(mint).toHaveBeenCalledWith(
      expect.objectContaining({ appId: '11', installationId: '22', privateKey: 'pem' }),
    );
    expect(result.kind).toBe('basic');
    expect(result.user).toBe('x-access-token');
    expect(result.grant).toEqual({
      scoped: true,
      permissions: { contents: 'write', workflows: 'write' },
    });
    expect(result.expiresAt).toBe('2026-08-22T05:51:29Z');
  });

  it('reports a narrower grant rather than the request', async () => {
    const mint = vi.fn().mockResolvedValue({
      token: 'ghs_x',
      expiresAt: null,
      grantedPermissions: { contents: 'read' },
      repositorySelection: 'selected',
    });
    const broker = new GitCredentialBroker({
      secretResolver: secretResolver({ APP_ID: '11', INSTALL_ID: '22', APP_KEY: 'pem' }),
      sourceAuth: noSource,
      mint,
    });
    const result = await broker.resolve({
      orgId: 'org-1',
      repositories: ['a/b'],
      ref: {
        kind: 'app',
        appIdSecret: 'ci:APP_ID',
        installationIdSecret: 'ci:INSTALL_ID',
        privateKeySecret: 'ci:APP_KEY',
      },
      permissions: { contents: 'write' },
    });
    expect(result.grant).toEqual({ scoped: true, permissions: { contents: 'read' } });
  });

  it('throws naming the missing secret, not a generic failure', async () => {
    const broker = new GitCredentialBroker({
      secretResolver: secretResolver({}),
      sourceAuth: noSource,
      mint: vi.fn(),
    });
    await expect(
      broker.resolve({
        orgId: 'org-1',
        repositories: ['a/b'],
        ref: { kind: 'token', tokenSecret: 'ci:MISSING_PAT' },
      }),
    ).rejects.toThrow(/MISSING_PAT/);
  });

  it('falls back to the source credential when no ref is supplied', async () => {
    const broker = new GitCredentialBroker({
      secretResolver: secretResolver({}),
      sourceAuth: async () => ({ kind: 'basic' as const, user: 'x-access-token', secret: 'src' }),
      mint: vi.fn(),
    });
    const result = await broker.resolve({ orgId: 'org-1', repositories: ['a/b'] });
    expect(result.secret).toBe('src');
    expect(result.grant).toEqual({ scoped: false });
  });

  it('throws actionably when no source credential is configured', async () => {
    const broker = new GitCredentialBroker({
      secretResolver: secretResolver({}),
      sourceAuth: noSource,
      mint: vi.fn(),
    });
    await expect(broker.resolve({ orgId: 'org-1', repositories: ['a/b'] })).rejects.toThrow(
      /No source credential is configured for 'a\/b'/,
    );
  });

  describe('the reserved needs: context', () => {
    it('resolves a secret output inherited from an upstream job', async () => {
      const broker = new GitCredentialBroker({
        secretResolver: secretResolver({}),
        sourceAuth: noSource,
        mint: vi.fn(),
        secretOutputs: async (_runId, _jobId, key) =>
          key === 'FORGE_TOKEN' ? 'inherited-token' : null,
      });
      const result = await broker.resolve({
        orgId: 'org-1',
        repositories: ['a/b'],
        ref: { kind: 'token', tokenSecret: 'needs:FORGE_TOKEN' },
        runId: 'run-1',
        jobId: 'job-2',
      });
      expect(result.secret).toBe('inherited-token');
    });

    it('names the producing job requirement when the output is absent', async () => {
      const broker = new GitCredentialBroker({
        secretResolver: secretResolver({}),
        sourceAuth: noSource,
        mint: vi.fn(),
        secretOutputs: async () => null,
      });
      await expect(
        broker.resolve({
          orgId: 'org-1',
          repositories: ['a/b'],
          ref: { kind: 'token', tokenSecret: 'needs:ABSENT' },
          runId: 'run-1',
          jobId: 'job-2',
        }),
      ).rejects.toThrow(/setSecretOutput\('ABSENT'/);
    });

    it('does not reach the ordinary secret store for a needs: reference', async () => {
      const resolver = secretResolver({ FORGE_TOKEN: 'wrong-source' });
      const broker = new GitCredentialBroker({
        secretResolver: resolver,
        sourceAuth: noSource,
        mint: vi.fn(),
        secretOutputs: async () => 'right-source',
      });
      const result = await broker.resolve({
        orgId: 'org-1',
        repositories: ['a/b'],
        ref: { kind: 'token', tokenSecret: 'needs:FORGE_TOKEN' },
        runId: 'run-1',
        jobId: 'job-2',
      });
      expect(result.secret).toBe('right-source');
      expect(
        (resolver as unknown as { resolveNamed: ReturnType<typeof vi.fn> }).resolveNamed,
      ).not.toHaveBeenCalled();
    });
  });
});
