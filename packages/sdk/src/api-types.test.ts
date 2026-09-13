import { describe, expect, it, vi } from 'vitest';
import { buildKiciApi } from './api-types.js';

describe('buildKiciApi', () => {
  it('infrastructure.list relays the method with empty params', async () => {
    const transport = vi.fn().mockResolvedValue({ scalers: [], agents: [] });
    const api = buildKiciApi(transport, { jobId: 'job-1' });
    await api.infrastructure.list();
    expect(transport).toHaveBeenCalledWith('infrastructure.list', {});
  });

  it('scaler.claimAgentCredentials relays the claim code and returns credentials', async () => {
    const credentials = {
      agentToken: 'kat_secret',
      agentId: 'a1',
      orchestratorUrl: 'wss://h/ws',
      labels: ['cloud=hetzner'],
    };
    const transport = vi.fn().mockResolvedValue(credentials);
    const api = buildKiciApi(transport, { jobId: 'job-1' });
    const result = await api.scaler.claimAgentCredentials('code-abc');
    expect(transport).toHaveBeenCalledWith('scaler.claim-credentials', { claimCode: 'code-abc' });
    expect(result).toEqual(credentials);
  });

  it('oidc.token injects the job-bound jobId and the method constant', async () => {
    const transport = vi
      .fn()
      .mockResolvedValue({ token: 'eyJ.a.b', expiresIn: 600, jti: 'run-1:job-1' });
    const api = buildKiciApi(transport, { jobId: 'job-1' });
    const res = await api.oidc.token({ audience: 'sigstore' });
    expect(res.token).toBe('eyJ.a.b');
    expect(transport).toHaveBeenCalledWith('oidc.token.request', {
      jobId: 'job-1',
      audience: 'sigstore',
    });
  });

  it('oidc.token throws a clear error when no job context is bound', async () => {
    const transport = vi.fn();
    const api = buildKiciApi(transport);
    await expect(api.oidc.token({ audience: 'sigstore' })).rejects.toThrow(
      /only available inside a running job step/i,
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it('inventory.query relays the selector (and an empty object when omitted)', async () => {
    const transport = vi.fn().mockResolvedValue([]);
    const api = buildKiciApi(transport, { jobId: 'job-1' });
    const selector = { include: [[{ kind: 'exact', value: 'role:db' }]] } as const;
    await api.inventory.query(selector);
    expect(transport).toHaveBeenCalledWith('inventory.query', selector);
    await api.inventory.query();
    expect(transport).toHaveBeenLastCalledWith('inventory.query', {});
  });

  it('inventory.get relays the agentId', async () => {
    const transport = vi.fn().mockResolvedValue(null);
    const api = buildKiciApi(transport, { jobId: 'job-1' });
    await api.inventory.get('box-1');
    expect(transport).toHaveBeenCalledWith('inventory.get', { agentId: 'box-1' });
  });

  it('inventory works without a job context (dynamic-job re-eval path)', async () => {
    const transport = vi.fn().mockResolvedValue([]);
    const api = buildKiciApi(transport); // no jobCtx
    await api.inventory.query();
    expect(transport).toHaveBeenCalledWith('inventory.query', {});
  });
});

describe('kici.git.github.getToken', () => {
  it('sends the repository and permissions to the relay method', async () => {
    const transport = vi.fn().mockResolvedValue({
      secret: 'ghs_x',
      expiresAt: '2026-08-22T05:51:29Z',
      grant: { scoped: true, permissions: { contents: 'write' } },
    });
    const api = buildKiciApi(transport, { jobId: 'job-1' });

    const result = await api.git.github.getToken({
      repositories: ['kici-dev/kici-forge-app-token-tester'],
      permissions: { contents: 'write', workflows: 'write' },
    });

    expect(transport).toHaveBeenCalledWith('git.credential.request', {
      jobId: 'job-1',
      repositories: ['kici-dev/kici-forge-app-token-tester'],
      permissions: { contents: 'write', workflows: 'write' },
    });
    expect(result.token).toBe('ghs_x');
    expect(result.granted).toEqual({ scoped: true, permissions: { contents: 'write' } });
  });

  it('sends EVERY repository, not just the first', async () => {
    const transport = vi
      .fn()
      .mockResolvedValue({ secret: 'ghs_x', expiresAt: null, grant: { scoped: false } });
    const api = buildKiciApi(transport, { jobId: 'job-1' });

    await api.git.github.getToken({
      repositories: ['kici-dev/one', 'kici-dev/two'],
      permissions: { contents: 'write' },
    });

    // Truncating to the first entry would hand back a token that silently does
    // not cover the rest, and the clone of the second repo would fail as a 404.
    expect(transport).toHaveBeenCalledWith(
      'git.credential.request',
      expect.objectContaining({ repositories: ['kici-dev/one', 'kici-dev/two'] }),
    );
  });

  it('rejects outside a running job step, like oidc.token', async () => {
    const api = buildKiciApi(vi.fn());
    await expect(
      api.git.github.getToken({ repositories: ['a/b'], permissions: { contents: 'read' } }),
    ).rejects.toThrow(/only available inside a running job step/);
  });

  it('rejects an empty repositories list rather than minting an unscoped token', async () => {
    const api = buildKiciApi(vi.fn(), { jobId: 'job-1' });
    await expect(
      api.git.github.getToken({ repositories: [], permissions: { contents: 'read' } }),
    ).rejects.toThrow(/at least one repository/i);
  });

  it('surfaces an unscoped grant unchanged for a static credential', async () => {
    const transport = vi
      .fn()
      .mockResolvedValue({ secret: 's', expiresAt: null, grant: { scoped: false } });
    const api = buildKiciApi(transport, { jobId: 'job-1' });
    const result = await api.git.github.getToken({
      repositories: ['a/b'],
      permissions: { contents: 'write' },
    });
    expect(result.granted).toEqual({ scoped: false });
    expect(result.expiresAt).toBeNull();
  });
});
