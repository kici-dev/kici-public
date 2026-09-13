import { describe, it, expect, vi } from 'vitest';
import { convertManifestCode } from './manifest.js';
import {
  runGithubManifestSetup,
  type ManifestSetupDeps,
} from '../../cli/commands/source-manifest.js';

/**
 * Sovereignty invariant: the GitHub App private key is exchanged and stored only
 * on the orchestrator host. It MUST NEVER be sent to the Platform. The CLI talks
 * to the orchestrator's own admin HTTP API; the conversion (which yields the
 * key) is a direct GitHub call. These tests lock that in.
 */
describe('github app private key sovereignty', () => {
  it('conversion targets GitHub only — never the Platform', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ data: { id: 1, slug: 's', pem: 'KEY', webhook_secret: 'w' } });
    await convertManifestCode('c', { octokit: { request } as never });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('POST /app-manifests/{code}/conversions');
    // Nothing addressed to a kici.dev / Platform host was requested here.
    const arg = JSON.stringify(request.mock.calls[0]);
    expect(arg).not.toMatch(/kici\.dev|platform/i);
  });

  it('the private key is posted only to the orchestrator admin sources path', async () => {
    const post = vi.fn().mockResolvedValue({ routingKey: 'github:1', name: 'acme' });
    const client = {
      get: vi.fn().mockResolvedValue({ webhookUrl: 'https://api.kici.dev/webhook/o/github' }),
      post,
    };
    const deps: ManifestSetupDeps = {
      startLoopback: vi.fn().mockResolvedValue({
        formUrl: 'http://127.0.0.1:1/',
        redirectUrl: 'http://127.0.0.1:1/cb',
        waitForCode: vi.fn().mockResolvedValue({ code: 'c', state: 's' }),
        close: vi.fn(),
      }),
      openBrowser: vi.fn(),
      readLine: vi.fn(),
      convert: vi.fn().mockResolvedValue({
        appId: '1',
        slug: 'acme',
        privateKey: 'SECRET-PEM',
        webhookSecret: 'w',
      }),
      waitForInstallation: vi.fn().mockResolvedValue({ installationId: 9, accountLogin: 'acme' }),
      verifyRepoAccess: vi.fn().mockResolvedValue({ repoCount: 1 }),
      writeRecoveryFile: vi.fn(),
    };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runGithubManifestSetup({ name: 'acme' }, client as never, deps);

    // The ONLY destination the private key was sent to is the orchestrator's
    // own admin HTTP API — a relative path, never a Platform URL.
    const keyPosts = post.mock.calls.filter((c) => JSON.stringify(c).includes('SECRET-PEM'));
    expect(keyPosts).toHaveLength(1);
    expect(keyPosts[0][0]).toBe('/api/v1/admin/sources');
    expect(keyPosts[0][0]).not.toMatch(/^https?:\/\//);
  });
});
