import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LockFileParseError } from '@kici-dev/engine';
import { GitHubLockFileFetcher } from './lock-file.js';

// ── Mocks ────────────────────────────────────────────────────────

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(function () {
    return mockOctokitInstance;
  }),
}));

vi.mock('@octokit/auth-app', () => ({
  createAppAuth: vi.fn(),
}));

// ── Helpers ──────────────────────────────────────────────────────

const TEST_CONFIG = {
  appId: '12345',
  privateKey: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
};

const SAMPLE_LOCK_FILE = {
  schemaVersion: 1,
  source: { file: '.kici/workflows/ci.ts', export: '#default' },
  contentHash: 'test-hash',
  workflows: [
    {
      name: 'ci',
      triggers: [{ _type: 'push', branches: [], paths: [] }],
      jobs: [],
    },
  ],
};

function encodeLockFile(lockFile: object): string {
  return Buffer.from(JSON.stringify(lockFile)).toString('base64');
}

let mockOctokitInstance: {
  request: ReturnType<typeof vi.fn>;
  auth: ReturnType<typeof vi.fn>;
};

function setupMockOctokit(options: {
  data?: object;
  error?: { status: number; message?: string };
  isArray?: boolean;
}) {
  const request = options.error
    ? vi.fn().mockRejectedValue(options.error)
    : vi.fn().mockResolvedValue({ data: options.isArray ? [options.data] : options.data });

  mockOctokitInstance = {
    request,
    auth: vi.fn(),
  };

  return mockOctokitInstance;
}

// ── Tests ────────────────────────────────────────────────────────

describe('GitHubLockFileFetcher', () => {
  let fetcher: GitHubLockFileFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new GitHubLockFileFetcher(TEST_CONFIG);
  });

  it('has provider set to github', () => {
    expect(fetcher.provider).toBe('github');
  });

  it('fetches and returns parsed lock file', async () => {
    const mock = setupMockOctokit({
      data: {
        sha: 'abc123',
        content: encodeLockFile(SAMPLE_LOCK_FILE),
        encoding: 'base64',
      },
    });

    const result = await fetcher.fetchLockFile('owner/repo', 'main', { installationId: 42 });

    expect(result).toEqual(SAMPLE_LOCK_FILE);
    expect(mock.request).toHaveBeenCalledWith(
      'GET /repos/owner/repo/contents/.kici/kici.lock.json',
      {
        ref: 'main',
      },
    );
  });

  it('returns null on 404 error', async () => {
    setupMockOctokit({ error: { status: 404 } });

    const result = await fetcher.fetchLockFile('owner/repo', 'main', { installationId: 42 });

    expect(result).toBeNull();
  });

  it('returns null for directory response (array)', async () => {
    setupMockOctokit({
      data: { name: '.kici', type: 'dir' },
      isArray: true,
    });

    const result = await fetcher.fetchLockFile('owner/repo', 'main', { installationId: 42 });

    expect(result).toBeNull();
  });

  it('throws LockFileParseError on missing content', async () => {
    setupMockOctokit({
      data: { sha: 'abc123' },
    });

    await expect(
      fetcher.fetchLockFile('owner/repo', 'main', { installationId: 42 }),
    ).rejects.toBeInstanceOf(LockFileParseError);
    await expect(
      fetcher.fetchLockFile('owner/repo', 'main', { installationId: 42 }),
    ).rejects.toThrow('has no content');
  });

  it('throws LockFileParseError when content is not valid JSON', async () => {
    setupMockOctokit({
      data: {
        sha: 'bad-json',
        content: Buffer.from('not json{').toString('base64'),
        encoding: 'base64',
      },
    });

    await expect(
      fetcher.fetchLockFile('owner/repo', 'main', { installationId: 42 }),
    ).rejects.toBeInstanceOf(LockFileParseError);
  });

  it('throws LockFileParseError when schemaVersion is missing', async () => {
    setupMockOctokit({
      data: {
        sha: 'no-version',
        content: encodeLockFile({ workflows: [] }),
        encoding: 'base64',
      },
    });

    await expect(
      fetcher.fetchLockFile('owner/repo', 'main', { installationId: 42 }),
    ).rejects.toBeInstanceOf(LockFileParseError);
    await expect(
      fetcher.fetchLockFile('owner/repo', 'main', { installationId: 42 }),
    ).rejects.toThrow('missing or invalid schemaVersion');
  });

  it('rethrows non-404 errors', async () => {
    setupMockOctokit({
      error: { status: 500, message: 'Internal Server Error' },
    });

    await expect(
      fetcher.fetchLockFile('owner/repo', 'main', { installationId: 42 }),
    ).rejects.toEqual({ status: 500, message: 'Internal Server Error' });
  });

  it('splits repoIdentifier correctly for API calls', async () => {
    const mock = setupMockOctokit({
      data: {
        sha: 'abc123',
        content: encodeLockFile(SAMPLE_LOCK_FILE),
        encoding: 'base64',
      },
    });

    await fetcher.fetchLockFile('my-org/my-app', 'feature/auth', { installationId: 99 });

    expect(mock.request).toHaveBeenCalledWith(
      'GET /repos/my-org/my-app/contents/.kici/kici.lock.json',
      { ref: 'feature/auth' },
    );
  });
});
