import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GitHubChangedFilesFetcher,
  isRateLimitError,
  withRateLimitRetry,
} from './changed-files.js';

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

let mockOctokitInstance: {
  paginate: ReturnType<typeof vi.fn>;
  rest: {
    pulls: { listFiles: string };
    repos: { compareCommits: ReturnType<typeof vi.fn> };
  };
  auth: ReturnType<typeof vi.fn>;
};

function setupMockOctokit(
  options: {
    paginateResult?: { filename: string }[];
    compareResult?: { filename: string }[];
  } = {},
) {
  mockOctokitInstance = {
    paginate: vi.fn().mockResolvedValue(options.paginateResult ?? []),
    rest: {
      pulls: {
        listFiles: 'pulls.listFiles.endpoint',
      },
      repos: {
        compareCommits: vi.fn().mockResolvedValue({
          data: { files: options.compareResult ?? [] },
        }),
      },
    },
    auth: vi.fn(),
  };
  return mockOctokitInstance;
}

function makePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repository: {
      owner: { login: 'test-owner' },
      name: 'test-repo',
    },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('GitHubChangedFilesFetcher', () => {
  let fetcher: GitHubChangedFilesFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new GitHubChangedFilesFetcher(TEST_CONFIG);
  });

  it('has provider set to github', () => {
    expect(fetcher.provider).toBe('github');
  });

  describe('pull_request events', () => {
    it('returns changed files from paginated listFiles API', async () => {
      const mock = setupMockOctokit({
        paginateResult: [
          { filename: 'src/index.ts' },
          { filename: 'package.json' },
          { filename: 'README.md' },
        ],
      });
      const payload = makePayload({ pull_request: { number: 42 } });

      const result = await fetcher.getChangedFiles(
        'test-owner/test-repo',
        'pull_request',
        payload,
        {
          installationId: 1,
        },
      );

      expect(result).toEqual(['src/index.ts', 'package.json', 'README.md']);
      expect(mock.paginate).toHaveBeenCalledWith(mock.rest.pulls.listFiles, {
        owner: 'test-owner',
        repo: 'test-repo',
        pull_number: 42,
        per_page: 100,
      });
    });

    it('returns empty array when pull_request data is missing', async () => {
      setupMockOctokit();
      const payload = makePayload(); // no pull_request

      const result = await fetcher.getChangedFiles(
        'test-owner/test-repo',
        'pull_request',
        payload,
        { installationId: 1 },
      );

      expect(result).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('push events', () => {
    it('returns changed files from compareCommits API', async () => {
      const mock = setupMockOctokit({
        compareResult: [{ filename: 'src/app.ts' }, { filename: 'tests/app.test.ts' }],
      });
      const payload = makePayload({
        before: 'aaa111',
        after: 'bbb222',
      });

      const result = await fetcher.getChangedFiles('test-owner/test-repo', 'push', payload, {
        installationId: 1,
      });

      expect(result).toEqual(['src/app.ts', 'tests/app.test.ts']);
      expect(mock.rest.repos.compareCommits).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        base: 'aaa111',
        head: 'bbb222',
      });
    });

    it('returns empty array for initial push (zero SHA before)', async () => {
      const mock = setupMockOctokit();
      const payload = makePayload({
        before: '0000000000000000000000000000000000000000',
        after: 'abc123',
      });

      const result = await fetcher.getChangedFiles('test-owner/test-repo', 'push', payload, {
        installationId: 1,
      });

      expect(result).toEqual([]);
      expect(mock.rest.repos.compareCommits).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Initial push'),
        expect.any(Object),
      );
    });

    it('logs warning when >= 300 files returned', async () => {
      const manyFiles = Array.from({ length: 300 }, (_, i) => ({
        filename: `file-${i}.ts`,
      }));
      setupMockOctokit({ compareResult: manyFiles });
      const payload = makePayload({
        before: 'aaa111',
        after: 'bbb222',
      });

      const result = await fetcher.getChangedFiles('test-owner/test-repo', 'push', payload, {
        installationId: 1,
      });

      expect(result).toHaveLength(300);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('300'),
        expect.any(Object),
      );
    });

    it('returns empty array when before/after SHAs are missing', async () => {
      setupMockOctokit();
      const payload = makePayload(); // no before/after

      const result = await fetcher.getChangedFiles('test-owner/test-repo', 'push', payload, {
        installationId: 1,
      });

      expect(result).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('returns empty array for branch deletion (zero SHA after)', async () => {
      const mock = setupMockOctokit();
      const payload = makePayload({
        before: 'abc123',
        after: '0000000000000000000000000000000000000000',
      });

      const result = await fetcher.getChangedFiles('test-owner/test-repo', 'push', payload, {
        installationId: 1,
      });

      expect(result).toEqual([]);
      expect(mock.rest.repos.compareCommits).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Branch deletion'),
        expect.any(Object),
      );
    });
  });

  describe('unknown events', () => {
    it('returns empty array for unknown event type', async () => {
      setupMockOctokit();
      const payload = makePayload();

      const result = await fetcher.getChangedFiles('test-owner/test-repo', 'issues', payload, {
        installationId: 1,
      });

      expect(result).toEqual([]);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Unknown event type'),
        expect.any(Object),
      );
    });
  });

  describe('429 rate limit retry', () => {
    it('retries on 429 and succeeds', async () => {
      const mock = setupMockOctokit();
      const rateLimitError = Object.assign(new Error('rate limited'), { status: 429 });
      mock.rest.repos.compareCommits.mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce({
        data: { files: [{ filename: 'retried.ts' }] },
      });

      const payload = makePayload({ before: 'aaa111', after: 'bbb222' });
      const result = await fetcher.getChangedFiles('test-owner/test-repo', 'push', payload, {
        installationId: 1,
      });

      expect(result).toEqual(['retried.ts']);
      expect(mock.rest.repos.compareCommits).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('rate limited'),
        expect.objectContaining({ attempt: 1 }),
      );
    });

    it('throws non-429 errors immediately without retry', async () => {
      const mock = setupMockOctokit();
      const serverError = Object.assign(new Error('server error'), { status: 500 });
      mock.rest.repos.compareCommits.mockRejectedValueOnce(serverError);

      const payload = makePayload({ before: 'aaa111', after: 'bbb222' });
      await expect(
        fetcher.getChangedFiles('test-owner/test-repo', 'push', payload, { installationId: 1 }),
      ).rejects.toThrow('server error');

      expect(mock.rest.repos.compareCommits).toHaveBeenCalledTimes(1);
    });

    it('throws after exhausting all 429 retries', async () => {
      const mock = setupMockOctokit();
      const rateLimitError = Object.assign(new Error('rate limited'), { status: 429 });
      mock.rest.repos.compareCommits.mockRejectedValue(rateLimitError);

      const payload = makePayload({ before: 'aaa111', after: 'bbb222' });
      await expect(
        fetcher.getChangedFiles('test-owner/test-repo', 'push', payload, { installationId: 1 }),
      ).rejects.toThrow('rate limited');

      // 1 initial + 3 retries = 4 calls
      expect(mock.rest.repos.compareCommits).toHaveBeenCalledTimes(4);
    }, 15_000);

    it('retries 429 on paginated PR listFiles', async () => {
      const mock = setupMockOctokit();
      const rateLimitError = Object.assign(new Error('rate limited'), { status: 429 });
      mock.paginate
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce([{ filename: 'pr-file.ts' }]);

      const payload = makePayload({ pull_request: { number: 10 } });
      const result = await fetcher.getChangedFiles(
        'test-owner/test-repo',
        'pull_request',
        payload,
        { installationId: 1 },
      );

      expect(result).toEqual(['pr-file.ts']);
      expect(mock.paginate).toHaveBeenCalledTimes(2);
    });
  });
});

describe('isRateLimitError', () => {
  it('returns true for error with status 429', () => {
    expect(isRateLimitError(Object.assign(new Error(), { status: 429 }))).toBe(true);
  });

  it('returns false for error with other status', () => {
    expect(isRateLimitError(Object.assign(new Error(), { status: 500 }))).toBe(false);
  });

  it('returns false for plain error', () => {
    expect(isRateLimitError(new Error('no status'))).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});

describe('withRateLimitRetry', () => {
  it('returns result on first success', async () => {
    const result = await withRateLimitRetry(() => Promise.resolve('ok'), 'test');
    expect(result).toBe('ok');
  });

  it('retries on 429 with exponential backoff', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('429'), { status: 429 });
      return 'success';
    };

    const result = await withRateLimitRetry(fn, 'test');
    expect(result).toBe('success');
    expect(calls).toBe(3);
  }, 15_000);
});
