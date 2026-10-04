import { describe, it, expect, vi } from 'vitest';
import { fetchGithubAppIdentity } from './manifest.js';

describe('fetchGithubAppIdentity', () => {
  const creds = { appId: '42', privateKey: 'PEM' };

  it('returns the name, slug, events and permissions GitHub reports for the App', async () => {
    const request = vi.fn().mockResolvedValue({
      data: {
        id: 42,
        name: 'My KiCI App',
        slug: 'my-kici-app',
        events: ['push'],
        permissions: { checks: 'write' },
      },
    });
    const id = await fetchGithubAppIdentity(creds, { appOctokit: { request } as never });
    expect(id).toEqual({
      name: 'My KiCI App',
      slug: 'my-kici-app',
      events: ['push'],
      permissions: { checks: 'write' },
    });
    expect(request).toHaveBeenCalledWith('GET /app');
  });

  it('defaults events and permissions to empty when GitHub omits them', async () => {
    const request = vi.fn().mockResolvedValue({
      data: { id: 42, name: 'My KiCI App', slug: 'my-kici-app' },
    });
    const id = await fetchGithubAppIdentity(creds, { appOctokit: { request } as never });
    expect(id).toEqual({ name: 'My KiCI App', slug: 'my-kici-app', events: [], permissions: {} });
  });

  it('propagates a GitHub API error', async () => {
    const request = vi.fn().mockRejectedValue(new Error('401 Unauthorized'));
    await expect(
      fetchGithubAppIdentity(creds, { appOctokit: { request } as never }),
    ).rejects.toThrow('401 Unauthorized');
  });
});
