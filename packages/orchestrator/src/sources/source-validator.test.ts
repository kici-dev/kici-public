import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetAuthenticated = vi.fn();

vi.mock('@octokit/auth-app', () => ({
  createAppAuth: vi.fn(),
}));

vi.mock('@octokit/rest', () => {
  return {
    Octokit: class {
      apps = { getAuthenticated: mockGetAuthenticated };
    },
  };
});

import { validateGitHubSource } from './source-validator.js';

describe('validateGitHubSource', () => {
  beforeEach(() => {
    mockGetAuthenticated.mockReset();
  });

  it('returns { valid: true, appName, slug } on successful validation', async () => {
    mockGetAuthenticated.mockResolvedValueOnce({
      data: { name: 'My KiCI App', slug: 'my-kici-app' },
    });

    const result = await validateGitHubSource('12345', 'PEM-KEY-DATA');

    expect(result).toEqual({ valid: true, appName: 'My KiCI App', slug: 'my-kici-app' });
  });

  it('returns { valid: false, error } on auth failure', async () => {
    mockGetAuthenticated.mockRejectedValueOnce(new Error('Bad credentials'));

    const result = await validateGitHubSource('12345', 'INVALID-KEY');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Bad credentials');
  });

  it('returns { valid: false, error } on network error', async () => {
    mockGetAuthenticated.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND api.github.com'));

    const result = await validateGitHubSource('12345', 'PEM-KEY-DATA');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('ENOTFOUND');
  });
});
