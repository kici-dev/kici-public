import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubFileContentsFetcher } from './file-contents.js';

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

const TEST_INSTALLATION_ID = 42;

function encodeUtf8(content: string): string {
  return Buffer.from(content, 'utf-8').toString('base64');
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

describe('GitHubFileContentsFetcher', () => {
  let fetcher: GitHubFileContentsFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new GitHubFileContentsFetcher(TEST_CONFIG, TEST_INSTALLATION_ID);
  });

  it('has provider set to github', () => {
    expect(fetcher.provider).toBe('github');
  });

  it('fetches and returns decoded file contents on 200', async () => {
    const body = 'name: ci\non: [push]\n';
    const mock = setupMockOctokit({
      data: {
        sha: 'abc123',
        size: body.length,
        content: encodeUtf8(body),
        encoding: 'base64',
      },
    });

    const result = await fetcher.getFileContents('owner', 'repo', '.kici/workflows/ci.ts', 'main');

    expect(result).toEqual({ present: true, bytes: body });
    expect(mock.request).toHaveBeenCalledTimes(1);
    expect(mock.request).toHaveBeenCalledWith(
      'GET /repos/owner/repo/contents/.kici/workflows/ci.ts',
      { ref: 'main' },
    );
  });

  it('returns { present: false } on 404', async () => {
    const mock = setupMockOctokit({ error: { status: 404 } });

    const result = await fetcher.getFileContents('owner', 'repo', 'missing.txt', 'main');

    expect(result).toEqual({ present: false });
    expect(mock.request).toHaveBeenCalledTimes(1);
  });

  it('returns { present: false } for a directory (array) response', async () => {
    setupMockOctokit({
      data: { name: 'dir', type: 'dir' },
      isArray: true,
    });

    const result = await fetcher.getFileContents('owner', 'repo', 'src', 'main');

    expect(result).toEqual({ present: false });
  });

  it('surfaces an over-1-MiB file as present without bytes and does not fetch a raw blob', async () => {
    // Real GitHub Contents API behavior for files > 1 MiB with the default
    // (object) media type: empty content + encoding "none" + a size above the
    // limit. The fetcher must NOT issue a second (raw blob) request.
    const mock = setupMockOctokit({
      data: {
        sha: 'big123',
        size: 2 * 1024 * 1024,
        content: '',
        encoding: 'none',
      },
    });

    const result = await fetcher.getFileContents('owner', 'repo', 'big.bin', 'main');

    expect(result).toEqual({ present: true });
    expect(result.bytes).toBeUndefined();
    // Exactly one request -- no raw blob download bypass.
    expect(mock.request).toHaveBeenCalledTimes(1);
  });

  it('decodes inline base64 content even when it exceeds 1 MiB (no cap in the fetcher)', async () => {
    // When GitHub DOES return inline base64 content, the fetcher decodes and
    // returns it verbatim regardless of size -- the 1 MiB match cap lives in
    // the matcher (Task 8), not here.
    const big = 'x'.repeat(1024 * 1024 + 128);
    setupMockOctokit({
      data: {
        sha: 'inline-big',
        size: big.length,
        content: encodeUtf8(big),
        encoding: 'base64',
      },
    });

    const result = await fetcher.getFileContents('owner', 'repo', 'inline-big.txt', 'main');

    expect(result.present).toBe(true);
    expect(result.bytes).toBe(big);
  });

  it('rethrows non-404 errors', async () => {
    setupMockOctokit({ error: { status: 500, message: 'Internal Server Error' } });

    await expect(fetcher.getFileContents('owner', 'repo', 'file.txt', 'main')).rejects.toEqual({
      status: 500,
      message: 'Internal Server Error',
    });
  });

  it('encodes path segments individually, preserving slashes', async () => {
    const mock = setupMockOctokit({
      data: { sha: 's', size: 1, content: encodeUtf8('x'), encoding: 'base64' },
    });

    await fetcher.getFileContents('my-org', 'my-app', 'a dir/my file.ts', 'feature/auth');

    expect(mock.request).toHaveBeenCalledWith(
      'GET /repos/my-org/my-app/contents/a%20dir/my%20file.ts',
      { ref: 'feature/auth' },
    );
  });
});
