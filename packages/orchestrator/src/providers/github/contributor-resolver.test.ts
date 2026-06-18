import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubContributorResolver } from './contributor-resolver.js';

// ── Mocks ────────────────────────────────────────────────────────

const { mockLogger } = vi.hoisted(() => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { mockLogger };
});

vi.mock('@kici-dev/shared', () => ({
  createLogger: () => mockLogger,

  toErrorMessage: (err) => (err instanceof Error ? err.message : String(err)),
}));

const mockGetCollaboratorPermissionLevel = vi.fn();
const mockOctokitInstance = {
  repos: { getCollaboratorPermissionLevel: mockGetCollaboratorPermissionLevel },
  auth: vi.fn(),
};

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(function () {
    return mockOctokitInstance;
  }),
}));

vi.mock('@octokit/auth-app', () => ({
  createAppAuth: vi.fn(),
}));

// ── Helpers ──────────────────────────────────────────────────────

const TEST_CONFIG = { appId: '123', privateKey: 'test-key' };
const TEST_CREDENTIALS = { installationId: 456 };

// ── Tests ────────────────────────────────────────────────────────

describe('GitHubContributorResolver', () => {
  let resolver: GitHubContributorResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    resolver = new GitHubContributorResolver(TEST_CONFIG);
  });

  it('has provider set to github', () => {
    expect(resolver.provider).toBe('github');
  });

  describe('permission mapping', () => {
    it.each([
      ['admin', 'admin'],
      ['maintain', 'write'],
      ['write', 'write'],
      ['triage', 'read'],
      ['read', 'read'],
      ['none', 'none'],
    ])('maps GitHub "%s" to KiCI "%s"', async (githubPerm, expectedPerm) => {
      mockGetCollaboratorPermissionLevel.mockResolvedValue({
        data: { permission: githubPerm },
      });

      const result = await resolver.resolveContributor('owner/repo', 'testuser', TEST_CREDENTIALS);

      expect(result.permission).toBe(expectedPerm);
      expect(result.username).toBe('testuser');
      expect(result.isForkPR).toBe(false);
    });
  });

  describe('error handling', () => {
    it('returns none on 403 (insufficient app permissions)', async () => {
      mockGetCollaboratorPermissionLevel.mockRejectedValue({ status: 403 });

      const result = await resolver.resolveContributor('owner/repo', 'testuser', TEST_CREDENTIALS);

      expect(result.permission).toBe('none');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'GitHub App lacks permission to check collaborator level',
        expect.any(Object),
      );
    });

    it('returns none on 404 (not a collaborator)', async () => {
      mockGetCollaboratorPermissionLevel.mockRejectedValue({ status: 404 });

      const result = await resolver.resolveContributor('owner/repo', 'testuser', TEST_CREDENTIALS);

      expect(result.permission).toBe('none');
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'User is not a collaborator',
        expect.any(Object),
      );
    });

    it('rethrows unexpected errors', async () => {
      const error = new Error('Network failure');
      mockGetCollaboratorPermissionLevel.mockRejectedValue(error);

      await expect(
        resolver.resolveContributor('owner/repo', 'testuser', TEST_CREDENTIALS),
      ).rejects.toThrow('Network failure');
    });
  });

  it('passes correct owner/repo/username to GitHub API', async () => {
    mockGetCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'write' },
    });

    await resolver.resolveContributor('myorg/myrepo', 'contributor', TEST_CREDENTIALS);

    expect(mockGetCollaboratorPermissionLevel).toHaveBeenCalledWith({
      owner: 'myorg',
      repo: 'myrepo',
      username: 'contributor',
    });
  });
});
