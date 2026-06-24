import { describe, it, expect, vi } from 'vitest';
import { fetchGithubAppIdentity } from './manifest.js';

describe('fetchGithubAppIdentity', () => {
  const creds = { appId: '42', privateKey: 'PEM' };

  it('returns the name and slug GitHub reports for the App', async () => {
    const request = vi.fn().mockResolvedValue({
      data: { id: 42, name: 'My KiCI App', slug: 'my-kici-app' },
    });
    const id = await fetchGithubAppIdentity(creds, { appOctokit: { request } });
    expect(id).toEqual({ name: 'My KiCI App', slug: 'my-kici-app' });
    expect(request).toHaveBeenCalledWith('GET /app');
  });

  it('propagates a GitHub API error', async () => {
    const request = vi.fn().mockRejectedValue(new Error('401 Unauthorized'));
    await expect(fetchGithubAppIdentity(creds, { appOctokit: { request } })).rejects.toThrow(
      '401 Unauthorized',
    );
  });
});
