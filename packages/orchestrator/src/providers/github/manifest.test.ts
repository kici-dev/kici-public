import { describe, it, expect, vi } from 'vitest';
import {
  buildGithubAppManifest,
  convertManifestCode,
  waitForInstallation,
  verifyRepoAccess,
} from './manifest.js';

describe('buildGithubAppManifest', () => {
  const m = buildGithubAppManifest({
    name: 'acme-prod',
    webhookUrl: 'https://api.kici.dev/webhook/org_x/github',
    redirectUrl: 'http://127.0.0.1:51823/cb',
  });

  it('bakes in KiCI permissions and events', () => {
    expect(m.default_permissions).toMatchObject({
      contents: 'read',
      metadata: 'read',
      pull_requests: 'read',
      checks: 'write',
      members: 'read',
    });
    expect(m.default_events).toEqual(
      expect.arrayContaining(['push', 'pull_request', 'check_run', 'check_suite']),
    );
  });

  it('configures an active webhook with the supplied url', () => {
    expect(m.hook_attributes).toEqual({
      url: 'https://api.kici.dev/webhook/org_x/github',
      active: true,
    });
    expect(m.url).toBe('https://kici.dev'); // homepage; required field
    expect(m.redirect_url).toBe('http://127.0.0.1:51823/cb');
    expect(m.public).toBe(false);
  });

  it('does not carry a webhook secret — GitHub generates it during registration', () => {
    // GitHub's manifest schema has no webhook-secret field; the secret comes
    // back on the conversion response. A baked-in secret would be silently
    // ignored and create a Platform/GitHub mismatch.
    expect(JSON.stringify(m)).not.toContain('secret');
  });

  it('omits setup_url when not supplied', () => {
    expect(m.setup_url).toBeUndefined();
  });
});

describe('convertManifestCode', () => {
  it('converts a manifest code into app credentials', async () => {
    const request = vi.fn().mockResolvedValue({
      data: {
        id: 12345,
        slug: 'acme-prod',
        pem: '-----BEGIN…',
        webhook_secret: 'deadbeef',
        client_id: 'Iv1.x',
        client_secret: 'sec',
        html_url: 'https://github.com/apps/acme-prod',
      },
    });
    const creds = await convertManifestCode('tmpcode', { octokit: { request } as never });
    expect(request).toHaveBeenCalledWith('POST /app-manifests/{code}/conversions', {
      code: 'tmpcode',
    });
    expect(creds).toEqual({
      appId: '12345',
      slug: 'acme-prod',
      privateKey: '-----BEGIN…',
      webhookSecret: 'deadbeef',
      clientId: 'Iv1.x',
      clientSecret: 'sec',
      htmlUrl: 'https://github.com/apps/acme-prod',
    });
  });

  it('throws a clear error when GitHub returns no webhook secret', async () => {
    const request = vi.fn().mockResolvedValue({
      data: { id: 1, slug: 's', pem: 'p', webhook_secret: null },
    });
    await expect(convertManifestCode('c', { octokit: { request } as never })).rejects.toThrow(
      /webhook secret/i,
    );
  });
});

describe('waitForInstallation', () => {
  it('waits until an installation appears', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [{ id: 99, account: { login: 'acme' } }] });
    let t = 0;
    const res = await waitForInstallation(
      { appId: '1', privateKey: 'pem' },
      { timeoutMs: 10_000, pollMs: 1, now: () => (t += 1), appOctokit: { request } as never },
    );
    expect(res).toEqual({ installationId: 99, accountLogin: 'acme' });
  });

  it('times out when no installation appears', async () => {
    const request = vi.fn().mockResolvedValue({ data: [] });
    let t = 0;
    await expect(
      waitForInstallation(
        { appId: '1', privateKey: 'pem' },
        { timeoutMs: 5, pollMs: 1, now: () => (t += 10), appOctokit: { request } as never },
      ),
    ).rejects.toThrow(/timed out/i);
  });
});

describe('verifyRepoAccess', () => {
  it('verifies repo access via an installation token', async () => {
    const request = vi.fn().mockResolvedValue({ data: { total_count: 3 } });
    const res = await verifyRepoAccess({ appId: '1', privateKey: 'pem' }, 99, {
      octokit: { request } as never,
    });
    expect(request).toHaveBeenCalledWith('GET /installation/repositories', expect.anything());
    expect(res).toEqual({ repoCount: 3 });
  });
});
