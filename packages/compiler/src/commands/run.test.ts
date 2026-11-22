import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { makeTempDir } from '@kici-dev/core/tmp';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '@kici-dev/core';
import {
  runRemoteCommand,
  buildTargetSelector,
  buildDispatchInputs,
  lookupDispatchInputsDescriptor,
  describeMissingWorkflow,
  withStdoutOnStderr,
} from './run.js';
import { requestRunCancel, watchRunHolds } from './run-remote-follow.js';
import { GitTagMode } from '../remote/shipped-git/git-ship-types.js';

const mockClient = {
  initUpload: vi.fn(),
  trigger: vi.fn(),
  runStatus: vi.fn(),
  runLogs: vi.fn(),
  cancel: vi.fn(),
};

vi.mock('../remote/config.js', () => ({
  loadGlobalConfig: vi.fn(),
}));

// Capture constructor args so tests can assert org/cluster targeting.
const platformClientConfigs: Record<string, unknown>[] = [];
vi.mock('../remote/platform-client.js', async (importOriginal) => {
  // The log-position helpers are pure, so the poll loop runs the real ones.
  const actual = await importOriginal<typeof import('../remote/platform-client.js')>();
  class MockPlatformRunClient {
    constructor(config: Record<string, unknown>) {
      platformClientConfigs.push(config);
      return mockClient;
    }
  }
  return {
    FIRST_LOG_POSITION: actual.FIRST_LOG_POSITION,
    nextLogPosition: actual.nextLogPosition,
    PlatformRunClient: MockPlatformRunClient,
    AmbiguousClusterError: class extends Error {
      clusters: string[];
      constructor(clusters: string[], m = 'ambiguous') {
        super(m);
        this.name = 'AmbiguousClusterError';
        this.clusters = clusters;
      }
    },
    NoClusterError: class extends Error {
      constructor(m = 'no cluster') {
        super(m);
        this.name = 'NoClusterError';
      }
    },
    AuthenticationError: class extends Error {},
    AccessDeniedError: class extends Error {},
    ConnectionError: class extends Error {},
    HttpStatusError: actual.HttpStatusError,
    NotFoundError: class extends Error {
      constructor(m = 'Resource not found') {
        super(m);
        this.name = 'NotFoundError';
      }
    },
  };
});

// The direct transport's client: same shape, captured constructor args.
const mockDirect = {
  url: 'https://ci.example.com',
  whoami: vi.fn(),
  initUpload: vi.fn(),
  trigger: vi.fn(),
  runStatus: vi.fn(),
  runLogs: vi.fn(),
  cancel: vi.fn(),
  listHolds: vi.fn(),
  decideHold: vi.fn(),
};
const directClientConfigs: Record<string, unknown>[] = [];
vi.mock('../remote/direct-client.js', () => {
  class MockDirectRunClient {
    constructor(config: Record<string, unknown>) {
      directClientConfigs.push(config);
      return mockDirect;
    }
  }
  return {
    DirectRunClient: MockDirectRunClient,
    HoldsUnavailableError: class extends Error {
      constructor(
        m: string,
        readonly status: number,
      ) {
        super(m);
        this.name = 'HoldsUnavailableError';
      }
    },
  };
});

vi.mock('../remote/output/summary.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../remote/output/summary.js')>()),
  formatSummary: vi.fn().mockReturnValue('mock-summary-table'),
  formatErrorHighlight: vi.fn().mockReturnValue('mock-error-highlight'),
  formatMultiFixtureSummary: vi.fn().mockReturnValue('mock-multi-summary'),
}));

vi.mock('../remote/output/json.js', () => ({
  formatJsonResult: vi.fn().mockReturnValue('{"results":[],"summary":{"passed":0}}'),
}));

vi.mock('../remote/output/junit.js', () => ({
  formatJunitResult: vi.fn().mockReturnValue('<?xml version="1.0"?><testsuites></testsuites>'),
}));

const mockHistory = {
  load: vi.fn().mockResolvedValue([]),
  addEntry: vi.fn().mockResolvedValue(undefined),
  updateEntry: vi.fn().mockResolvedValue(undefined),
  getEntries: vi.fn().mockReturnValue([]),
  formatTable: vi.fn().mockReturnValue('no entries'),
};
vi.mock('../remote/history.js', () => ({
  RunHistory: class {
    constructor() {
      Object.assign(this, mockHistory);
    }
  },
}));

vi.mock('../fixtures/compiler.js', () => ({
  compileFixtures: vi.fn(),
  filterFixtures: vi.fn(),
}));

// The checked-out branch the fixture event defaults to.
const mockDetectCurrentBranch = vi.fn<(repoRoot: string) => string | undefined>();
vi.mock('../test-runner/git-detector.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../test-runner/git-detector.js')>()),
  detectCurrentBranch: (repoRoot: string) => mockDetectCurrentBranch(repoRoot),
}));

vi.mock('./compile.js', () => ({
  compileCommand: vi.fn().mockResolvedValue(true),
}));

vi.mock('../remote/uploader.js', () => ({
  createOverlayTarball: vi.fn(),
  gcStaleOverlayDirs: vi.fn(),
  getSizeWarning: vi.fn().mockReturnValue(null),
  uploadTarball: vi.fn(),
}));

// The real diff reads git; these tests pin what run.ts does with its result.
const mockComputeRemoteChangedFiles = vi.fn();
vi.mock('../remote/remote-changed-files.js', () => ({
  computeRemoteChangedFiles: (...args: unknown[]) => mockComputeRemoteChangedFiles(...args),
}));

vi.mock('../remote/secret-upload.js', () => ({
  buildEncryptedSecrets: vi.fn().mockResolvedValue(null),
}));

// readFile serves the inline lock file.
const mockReadFile = vi.fn();
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    readFile: (...args: any[]) => mockReadFile(...args),
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../execution/index.js', () => ({
  resolveKiciDir: vi.fn().mockReturnValue('/mock/.kici'),
  discoverWorkflows: vi.fn().mockResolvedValue({ workflows: [] }),
}));

vi.mock('@kici-dev/core', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
  formatBytes: vi.fn().mockReturnValue('1 KB'),
  toErrorMessage: (err) => (err instanceof Error ? err.message : String(err)),
}));

const overlay = {
  tarballPath: '/tmp/overlay.tar.gz',
  summary: {
    fileCount: 5,
    newFiles: 2,
    modifiedFiles: 3,
    deletedFiles: 0,
    compressedSize: 1024,
    sha: 'abc123',
  },
  manifest: { sha: 'abc123', deletions: [], checksums: {} },
  hasRemote: true,
  warnings: [] as string[],
  git: {
    root: '/tmp/overlay-git',
    files: ['.git/HEAD'],
    baseSha: 'abc123',
    workspaceSha: 'abc123',
    synthetic: false,
    createdTags: [] as string[],
    replacedTags: [] as string[],
    branch: 'main',
    record: { fetchDepth: 1, allTags: false },
    warnings: [] as string[],
  },
  tempDir: { path: '/tmp/overlay', cleanup: async () => {} },
};

/** The `n`th log poll read from `position`, carrying the Ctrl-C signal that stops a read in flight. */
function expectLogPoll(n: number, position: { cursor: number; logCursor?: string }): void {
  expect(mockClient.runLogs).toHaveBeenNthCalledWith(
    n,
    'org_a',
    'run-123',
    position,
    expect.anything(),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
}

describe('kici run command', () => {
  let loadGlobalConfig: ReturnType<typeof vi.fn>;
  let compileFixtures: ReturnType<typeof vi.fn>;
  let filterFixtures: ReturnType<typeof vi.fn>;
  let createOverlayTarball: ReturnType<typeof vi.fn>;
  let gcStaleOverlayDirs: ReturnType<typeof vi.fn>;
  let uploadTarball: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    platformClientConfigs.length = 0;
    directClientConfigs.length = 0;
    // An empty value counts as unset; the developer's own shell never leaks in.
    vi.stubEnv('KICI_ORCHESTRATOR_URL', '');
    vi.stubEnv('KICI_ORCHESTRATOR_TOKEN', '');

    mockHistory.load.mockResolvedValue([]);
    mockHistory.addEntry.mockResolvedValue(undefined);
    mockHistory.updateEntry.mockResolvedValue(undefined);
    mockHistory.getEntries.mockReturnValue([]);
    mockHistory.formatTable.mockReturnValue('no entries');

    const configMod = await import('../remote/config.js');
    loadGlobalConfig = configMod.loadGlobalConfig as ReturnType<typeof vi.fn>;

    const fixtureMod = await import('../fixtures/compiler.js');
    compileFixtures = fixtureMod.compileFixtures as ReturnType<typeof vi.fn>;
    filterFixtures = fixtureMod.filterFixtures as ReturnType<typeof vi.fn>;

    const uploaderMod = await import('../remote/uploader.js');
    createOverlayTarball = uploaderMod.createOverlayTarball as ReturnType<typeof vi.fn>;
    gcStaleOverlayDirs = uploaderMod.gcStaleOverlayDirs as ReturnType<typeof vi.fn>;
    gcStaleOverlayDirs.mockResolvedValue([]);
    uploadTarball = uploaderMod.uploadTarball as ReturnType<typeof vi.fn>;

    loadGlobalConfig.mockResolvedValue({
      pat: 'test-pat',
      platformEndpoint: 'https://platform.invalid',
      activeOrgId: 'org_a',
    });

    createOverlayTarball.mockResolvedValue(overlay);
    // The direct-path tests name these workflows; the CLI checks them against the lock.
    mockReadFile.mockResolvedValue(
      '{"schemaVersion":4,"workflows":[{"name":"ci"},{"name":"deploy"}]}',
    );

    uploadTarball.mockResolvedValue({
      uploadId: 'upload-456',
      cliPublicKey: Buffer.from('clipubkey'),
      encryptedSize: 2048,
    });

    mockClient.initUpload.mockResolvedValue({
      uploadId: 'upload-456',
      signedUrl: 'https://s3.example.com/put-url',
      publicKey: Buffer.from('mockpublickey').toString('base64'),
      expiresIn: 3600,
    });

    mockClient.trigger.mockResolvedValue({ runId: 'run-123', status: 'accepted' });

    mockClient.runLogs.mockResolvedValue({ lines: ['hello'], nextCursor: 1, done: true });
    mockClient.runStatus.mockResolvedValue({
      runId: 'run-123',
      status: 'success',
      jobs: [{ jobId: 'j1', jobName: 'build', status: 'success' }],
      done: true,
    });
    mockClient.cancel.mockResolvedValue({ cancelled: true });
    mockDetectCurrentBranch.mockReturnValue('feature/x');
    mockComputeRemoteChangedFiles.mockReturnValue({});
  });

  const fixture = {
    id: 'push-main',
    sourceFile: '/mock/.kici/tests/push.ts',
    fixture: { id: 'push-main', options: { event: { _tag: 'PushTrigger' }, branch: 'main' } },
  };

  describe('runRemoteCommand — Platform-first flow', () => {
    it('lists available fixtures when no arguments given', async () => {
      compileFixtures.mockResolvedValue([fixture]);
      const result = await runRemoteCommand(undefined, { kiciDir: '.kici' });
      expect(result).toBe(true);
      expect(compileFixtures).toHaveBeenCalled();
    });

    it('reaps stale overlay temp dirs before the overlay, and still runs when that fails', async () => {
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);
      const run = () => runRemoteCommand('push-main', { kiciDir: '.kici', wait: false });

      expect(await run()).toBe(true);
      // fails-when: the GC is never called on the remote path, so killed runs leak for good
      expect(gcStaleOverlayDirs.mock.invocationCallOrder[0]).toBeLessThan(
        createOverlayTarball.mock.invocationCallOrder[0],
      );

      gcStaleOverlayDirs.mockRejectedValue(new Error('EACCES: permission denied'));
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        // breaks-if-wrong: a GC failure must not fail the run it precedes
        expect(await run()).toBe(true);
        expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain(
          'Could not clean up old overlay temp dirs: EACCES',
        );
      } finally {
        stderr.mockRestore();
      }
    });

    it('uploads then triggers via the Platform client', async () => {
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);

      const result = await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false });

      expect(result).toBe(true);
      expect(mockClient.initUpload).toHaveBeenCalledWith(
        'org_a',
        { orchestrator: undefined, defaultCluster: undefined },
        expect.objectContaining({ sha: 'abc123' }),
      );
      expect(mockClient.trigger).toHaveBeenCalledWith(
        'org_a',
        { orchestrator: undefined, defaultCluster: undefined },
        expect.objectContaining({
          fixtureId: 'push-main',
          uploadId: 'upload-456',
          // Always sent, independent of secrets, so the orchestrator can decrypt the overlay.
          cliPublicKey: Buffer.from('clipubkey').toString('base64'),
          fullRepo: true,
        }),
      );
      expect(platformClientConfigs[0]).toEqual({
        platformEndpoint: 'https://platform.invalid',
        token: 'test-pat',
      });
    });

    it('defaults the fixture event to the current branch and the HEAD commit', async () => {
      // push({ branches }) is a filter: it must not set the event ref.
      const unpinned = {
        id: 'push-ci',
        sourceFile: '/mock/.kici/tests/push.ts',
        fixture: {
          id: 'push-ci',
          options: { event: { _tag: 'PushTrigger', branches: [{ pattern: 'main' }] } },
        },
      };
      compileFixtures.mockResolvedValue([unpinned]);
      filterFixtures.mockReturnValue([unpinned]);

      expect(await runRemoteCommand('push-ci', { kiciDir: '.kici', wait: false })).toBe(true);

      const body = mockClient.trigger.mock.calls[0][2];
      // fails-when: the event carries a hardcoded refs/heads/main instead of the checkout (#470)
      expect(body.event.targetBranch).toBe('feature/x');
      expect(body.event.payload.ref).toBe('refs/heads/feature/x');
      // fails-when: the overlay's HEAD SHA is dropped from the event
      expect(body.event.payload.after).toBe('abc123');
      expect(mockDetectCurrentBranch).toHaveBeenCalledWith(expect.stringMatching(/\/mock$/));
    });

    it('warns and falls back to main on a detached HEAD', async () => {
      mockDetectCurrentBranch.mockReturnValue(undefined);
      const unpinned = {
        ...fixture,
        fixture: { ...fixture.fixture, options: { event: { _tag: 'PushTrigger' } } },
      };
      compileFixtures.mockResolvedValue([unpinned]);
      filterFixtures.mockReturnValue([unpinned]);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        expect(await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false })).toBe(true);
        expect(mockClient.trigger.mock.calls[0][2].event.payload.ref).toBe('refs/heads/main');
        expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('HEAD is detached');
      } finally {
        stderr.mockRestore();
      }
    });

    describe('event commits and changed files', () => {
      const tempRoots: string[] = [];

      /** The overlay temp dir as createOverlayTarball leaves it: the tarball and the shipped repository. */
      async function shippedOverlay(extra: Record<string, unknown> = {}) {
        const tempDir = await makeTempDir('overlay');
        tempRoots.push(tempDir.path);
        const tarballPath = join(tempDir.path, 'overlay.tar.gz');
        writeFileSync(tarballPath, 'tarball');
        const root = join(tempDir.path, 'ship');
        mkdirSync(join(root, '.git'), { recursive: true });
        return {
          ...overlay,
          tarballPath,
          tempDir,
          summary: { ...overlay.summary, sha: 'syn456' },
          git: {
            ...overlay.git,
            root,
            workspaceSha: 'syn456',
            parentSha: 'abc123',
            synthetic: true,
            ...extra,
          },
        };
      }

      beforeEach(() => {
        compileFixtures.mockResolvedValue([fixture]);
        filterFixtures.mockReturnValue([fixture]);
      });

      afterEach(() => {
        for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
      });

      it('sends the workspace commit, its parent and the computed changed files', async () => {
        const shipped = await shippedOverlay();
        createOverlayTarball.mockResolvedValue(shipped);
        mockComputeRemoteChangedFiles.mockReturnValue({ files: ['a.txt', 'new.txt'] });

        expect(await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false })).toBe(true);

        const { event } = mockClient.trigger.mock.calls[0][2];
        // fails-when: the event names the developer's HEAD, not the commit the workspace checks out
        expect(event.payload.after).toBe('syn456');
        expect(event.payload.before).toBe('abc123');
        // fails-when: the computed list is not sent, so the agent diffs against the git host
        expect(event.changedFiles).toEqual(['a.txt', 'new.txt']);
        expect(mockComputeRemoteChangedFiles).toHaveBeenCalledWith({
          repoRoot: expect.stringMatching(/\/mock$/),
          shipRoot: shipped.git.root,
          event: expect.objectContaining({ type: 'push', targetBranch: 'main' }),
          workspaceSha: 'syn456',
          parentSha: 'abc123',
        });
      });

      it('prints the warning and sends no list when none is computed', async () => {
        createOverlayTarball.mockResolvedValue(await shippedOverlay());
        mockComputeRemoteChangedFiles.mockReturnValue({ warning: 'no base here' });
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
          expect(await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false })).toBe(true);
          expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('no base here');
        } finally {
          stderr.mockRestore();
        }
        // breaks-if-wrong: an empty list would read as "nothing changed" and skip path-filtered workflows
        expect(mockClient.trigger.mock.calls[0][2].event).not.toHaveProperty('changedFiles');
      });

      it('sends no changed-files list when the .git was skipped', async () => {
        createOverlayTarball.mockResolvedValue({ ...overlay, git: undefined });

        expect(await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false })).toBe(true);

        // fails-when: a run with no shipped .git diffs the developer repository anyway
        expect(mockComputeRemoteChangedFiles).not.toHaveBeenCalled();
        const { event } = mockClient.trigger.mock.calls[0][2];
        expect(event).not.toHaveProperty('changedFiles');
        expect(event.payload).not.toHaveProperty('before');
        expect(event.payload.after).toBe('abc123');
      });

      it('removes the ship directory after computing changed files', async () => {
        const shipped = await shippedOverlay();
        createOverlayTarball.mockResolvedValue(shipped);
        let presentWhileComputing = false;
        mockComputeRemoteChangedFiles.mockImplementation(() => {
          presentWhileComputing = existsSync(shipped.git.root);
          return { files: [] };
        });

        expect(await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false })).toBe(true);

        // breaks-if-wrong: the diff reads the shipped objects, so they must exist while it runs
        expect(presentWhileComputing).toBe(true);
        // fails-when: the full-history ship .git stays in tmp forever
        expect(existsSync(shipped.git.root)).toBe(false);
      });

      it('removes the ship directory when the upload fails', async () => {
        const shipped = await shippedOverlay();
        createOverlayTarball.mockResolvedValue(shipped);
        mockClient.initUpload.mockRejectedValue(new Error('upload refused'));

        expect(await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false })).toBe(false);

        // fails-when: a failed run leaves the shipped history behind
        expect(existsSync(shipped.git.root)).toBe(false);
      });

      it.each<[string, () => void, { wait?: boolean }, boolean]>([
        ['a followed run that succeeds', () => {}, {}, true],
        [
          'a followed run that fails',
          () =>
            mockClient.runStatus.mockResolvedValue({
              runId: 'run-123',
              status: 'failed',
              jobs: [{ jobId: 'j1', jobName: 'build', status: 'failed' }],
              done: true,
            }),
          {},
          false,
        ],
        ['--no-wait', () => {}, { wait: false }, true],
        [
          'an upload error',
          // Replaces the probe below, so the upload never reads the tarball.
          () => uploadTarball.mockReset().mockRejectedValue(new Error('PUT failed')),
          { wait: false },
          false,
        ],
        [
          'a rejected trigger',
          () => mockClient.trigger.mockResolvedValue({ runId: 'r', status: 'rejected' }),
          { wait: false },
          false,
        ],
        [
          'a trigger error',
          () => mockClient.trigger.mockRejectedValue(new Error('relay down')),
          { wait: false },
          false,
        ],
      ])('removes the overlay temp dir after %s', async (_case, arrange, flags, ok) => {
        const shipped = await shippedOverlay();
        createOverlayTarball.mockResolvedValue(shipped);
        let tarballWhileUploading = false;
        uploadTarball.mockImplementationOnce(async (opts: { tarballPath: string }) => {
          tarballWhileUploading = existsSync(opts.tarballPath);
          return { uploadId: 'upload-456', cliPublicKey: Buffer.from('k'), encryptedSize: 1 };
        });
        arrange();

        expect(await runRemoteCommand('push-main', { kiciDir: '.kici', ...flags })).toBe(ok);

        // breaks-if-wrong: the upload reads the tarball, so the dir must outlive it
        expect(tarballWhileUploading).toBe(_case !== 'an upload error');
        // fails-when: cleanup is skipped on this path, so every run leaves its tarball in tmp
        expect(existsSync(shipped.tempDir.path)).toBe(false);
      });

      it('removes the ship directory of a direct workflow run', async () => {
        const shipped = await shippedOverlay();
        createOverlayTarball.mockResolvedValue(shipped);

        expect(await runRemoteCommand(undefined, { workflow: 'ci', wait: false })).toBe(true);

        // fails-when: --workflow, which computes no changed files, leaves the overlay behind
        expect(existsSync(shipped.tempDir.path)).toBe(false);
        expect(mockComputeRemoteChangedFiles).not.toHaveBeenCalled();
        expect(mockClient.trigger.mock.calls[0][2].event.payload.after).toBe('syn456');
      });
    });

    it('prints skipped-environment warnings from the accepted trigger response', async () => {
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);
      mockClient.trigger.mockResolvedValueOnce({
        runId: 'run-123',
        status: 'accepted',
        warnings: [
          "bound environment(s) 'production' are unavailable for this test run and were skipped; running with no environment variables",
        ],
      });

      const result = await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false });

      expect(result).toBe(true);
      const warned = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
      expect(warned.some((m) => m.includes('unavailable for this test run'))).toBe(true);
      expect(warned.some((m) => m.includes('production'))).toBe(true);
    });

    it('prefers --org over config.activeOrgId and passes --orchestrator through', async () => {
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);

      await runRemoteCommand('push-main', {
        kiciDir: '.kici',
        wait: false,
        org: 'org_override',
        orchestrator: 'cluster-x',
      });

      expect(mockClient.trigger).toHaveBeenCalledWith(
        'org_override',
        { orchestrator: 'cluster-x', defaultCluster: undefined },
        expect.anything(),
      );
    });

    it('uses config.defaultClusters[orgId] when --orchestrator is omitted', async () => {
      loadGlobalConfig.mockResolvedValue({
        pat: 'test-pat',
        platformEndpoint: 'https://platform.invalid',
        activeOrgId: 'org_a',
        defaultClusters: { org_a: 'cluster-default' },
      });
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);

      await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false });

      expect(mockClient.trigger).toHaveBeenCalledWith(
        'org_a',
        { orchestrator: undefined, defaultCluster: 'cluster-default' },
        expect.anything(),
      );
    });

    it('errors when no org can be resolved', async () => {
      loadGlobalConfig.mockResolvedValue({
        pat: 'test-pat',
        platformEndpoint: 'https://platform.invalid',
      });
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);

      const result = await runRemoteCommand('push-main', { kiciDir: '.kici' });

      expect(result).toBe(false);
      expect(mockClient.trigger).not.toHaveBeenCalled();
    });

    it('shows login prompt when not authenticated (no PAT)', async () => {
      loadGlobalConfig.mockResolvedValue({});
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);

      const result = await runRemoteCommand('push-main', { kiciDir: '.kici' });

      expect(result).toBe(false);
      expect(mockClient.trigger).not.toHaveBeenCalled();
    });

    it('returns false when no fixtures match the pattern', async () => {
      compileFixtures.mockResolvedValue([]);
      filterFixtures.mockReturnValue([]);
      expect(await runRemoteCommand('nonexistent', { kiciDir: '.kici' })).toBe(false);
    });

    it('--all runs every fixture', async () => {
      const f2 = {
        id: 'pr-open',
        sourceFile: '/mock/.kici/tests/pr.ts',
        fixture: {
          id: 'pr-open',
          options: { event: { _tag: 'PrTrigger', events: ['opened'] }, branch: 'feature' },
        },
      };
      compileFixtures.mockResolvedValue([fixture, f2]);

      const result = await runRemoteCommand(undefined, {
        all: true,
        kiciDir: '.kici',
        wait: false,
      });

      expect(result).toBe(true);
      expect(filterFixtures).not.toHaveBeenCalled();
      expect(mockClient.trigger).toHaveBeenCalledTimes(2);
    });

    it('--workflow runs a direct workflow', async () => {
      const result = await runRemoteCommand(undefined, {
        workflow: 'ci',
        kiciDir: '.kici',
        wait: false,
      });

      expect(result).toBe(true);
      expect(mockClient.trigger).toHaveBeenCalledWith(
        'org_a',
        expect.anything(),
        expect.objectContaining({ workflowName: 'ci', fixtureId: 'direct:ci' }),
      );
      // fails-when: a bare --workflow run reports branch main whatever is checked out
      expect(mockClient.trigger.mock.calls[0][2].event).toMatchObject({
        type: 'manual',
        targetBranch: 'feature/x',
        payload: { after: 'abc123' },
      });
    });

    it('compiles repeated --target values into an AND-combined host selector', async () => {
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);

      const result = await runRemoteCommand('push-main', {
        kiciDir: '.kici',
        wait: false,
        targets: ['role:web', 'dc:eu'],
      });

      expect(result).toBe(true);
      const body = mockClient.trigger.mock.calls[0][2];
      expect(body.target).toEqual({
        values: [
          { include: [{ kind: 'exact', value: 'role:web' }], exclude: [] },
          { include: [{ kind: 'exact', value: 'dc:eu' }], exclude: [] },
        ],
        allowEmpty: false,
      });
    });

    it('omits target from the trigger body when no --target is given', async () => {
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);

      await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false });

      expect(mockClient.trigger.mock.calls[0][2].target).toBeUndefined();
    });

    it('errors when --target-allow-empty is given without --target', async () => {
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);

      const result = await runRemoteCommand('push-main', {
        kiciDir: '.kici',
        wait: false,
        targetAllowEmpty: true,
      });

      expect(result).toBe(false);
      expect(mockClient.trigger).not.toHaveBeenCalled();
    });
  });

  describe('--workflow combined with a fixture', () => {
    const LOCK = '{"schemaVersion":4,"workflows":[{"name":"ci"},{"name":"deploy"}]}';
    const prFixture = {
      id: 'pr-open',
      sourceFile: '/mock/.kici/tests/pr.ts',
      fixture: {
        id: 'pr-open',
        options: { event: { _tag: 'PrTrigger', events: ['opened'] }, branch: 'feature' },
      },
    };

    beforeEach(() => {
      mockReadFile.mockResolvedValue(LOCK);
    });

    // A fixture that names its own workflow.
    const pinned = {
      ...fixture,
      fixture: { ...fixture.fixture, options: { ...fixture.fixture.options, workflowName: 'ci' } },
    };
    const useFixtures = (...fs: (typeof fixture)[]) => {
      compileFixtures.mockResolvedValue(fs);
      filterFixtures.mockReturnValue(fs);
    };

    it("sends the fixture's event to the named workflow only", async () => {
      useFixtures(fixture);

      const result = await runRemoteCommand('push-main', {
        kiciDir: '.kici',
        workflow: 'deploy',
        wait: false,
      });

      expect(result).toBe(true);
      expect(mockClient.trigger).toHaveBeenCalledTimes(1);
      // fails-when: the fixture path drops --workflow (the #462 defect) — workflowName is undefined
      // and the orchestrator trigger-matches every workflow the push event reaches.
      expect(mockClient.trigger).toHaveBeenCalledWith(
        'org_a',
        expect.anything(),
        expect.objectContaining({
          fixtureId: 'push-main',
          workflowName: 'deploy',
          event: expect.objectContaining({ type: 'push', targetBranch: 'main' }),
        }),
      );
    });

    it('runs each fixture a glob matches against the one workflow', async () => {
      useFixtures(fixture, prFixture);

      const result = await runRemoteCommand('*', { kiciDir: '.kici', workflow: 'ci', wait: false });

      expect(result).toBe(true);
      const bodies = mockClient.trigger.mock.calls.map((c) => c[2]);
      // fails-when: only the first fixture carries the workflow, or a fixture's event is replaced.
      expect(bodies.map((b) => [b.fixtureId, b.workflowName, b.event.type])).toEqual([
        ['push-main', 'ci', 'push'],
        ['pr-open', 'ci', 'pull_request'],
      ]);
    });

    it('honours --workflow with --all', async () => {
      compileFixtures.mockResolvedValue([fixture, prFixture]);

      await runRemoteCommand(undefined, {
        all: true,
        kiciDir: '.kici',
        workflow: 'ci',
        wait: false,
      });

      // fails-when: --all drops --workflow, as the fixture path did.
      expect(mockClient.trigger.mock.calls.map((c) => c[2].workflowName)).toEqual(['ci', 'ci']);
    });

    it('overrides a workflowName the fixture sets itself, with a warning', async () => {
      useFixtures(pinned);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      let warned: string;
      try {
        await runRemoteCommand('push-main', { kiciDir: '.kici', workflow: 'deploy', wait: false });
        warned = stderr.mock.calls.map((c) => String(c[0])).join('');
      } finally {
        stderr.mockRestore();
      }
      // fails-when: the fixture's own workflowName wins over the explicit flag.
      expect(mockClient.trigger.mock.calls[0][2].workflowName).toBe('deploy');
      expect(warned).toContain("fixture push-main names workflow 'ci'");
    });

    it("keeps a fixture's own workflowName when --workflow is absent", async () => {
      useFixtures(pinned);

      await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false });

      // breaks-if-wrong: a fixture that pins its own workflow must keep doing so.
      expect(mockClient.trigger.mock.calls[0][2].workflowName).toBe('ci');
    });

    it('shows history for --history --workflow instead of starting a run', async () => {
      const result = await runRemoteCommand(undefined, {
        kiciDir: '.kici',
        workflow: 'ci',
        history: true,
      });

      expect(result).toBe(true);
      // fails-when: the direct-workflow branch runs before --history and starts a run.
      expect(createOverlayTarball).not.toHaveBeenCalled();
      expect(mockClient.trigger).not.toHaveBeenCalled();
      expect(mockHistory.formatTable).toHaveBeenCalled();
    });

    it('refuses a workflow the lock file lacks, naming the available ones', async () => {
      useFixtures(fixture);

      const result = await runRemoteCommand('push-main', {
        kiciDir: '.kici',
        workflow: 'hello-wrld',
        wait: false,
      });

      expect(result).toBe(false);
      // fails-when: an unknown name is uploaded and only rejected later, or the
      // error omits the workflow list.
      expect(createOverlayTarball).not.toHaveBeenCalled();
      expect(mockClient.trigger).not.toHaveBeenCalled();
      const errors = (logger.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
      expect(errors.join('\n')).toContain(
        "Workflow 'hello-wrld' is not in the compiled lock file. Available workflows: ci, deploy",
      );
    });

    it('refuses an unknown workflow on the direct path too', async () => {
      const result = await runRemoteCommand(undefined, {
        kiciDir: '.kici',
        workflow: 'nope',
        wait: false,
      });

      expect(result).toBe(false);
      // fails-when: the direct path skips the lock check and uploads first.
      expect(createOverlayTarball).not.toHaveBeenCalled();
      expect(mockClient.trigger).not.toHaveBeenCalled();
    });

    it('reports a direct run the orchestrator rejects instead of polling it', async () => {
      mockClient.trigger.mockResolvedValueOnce({
        runId: 'run-x',
        status: 'rejected',
        reason: "Workflow 'ci' not found in lock file",
      });

      const result = await runRemoteCommand(undefined, { kiciDir: '.kici', workflow: 'ci' });

      expect(result).toBe(false);
      // fails-when: a rejected direct trigger prints "Run started" and polls a run that never
      // existed.
      expect(mockClient.runStatus).not.toHaveBeenCalled();
      const infos = (logger.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
      expect(infos.some((m) => m.includes('Run started'))).toBe(false);
      const errors = (logger.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
      expect(errors.some((m) => m.includes("Rejected: Workflow 'ci' not found"))).toBe(true);
    });
  });
  describe('compiles workflows before a remote run', () => {
    let compileCommand: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const compileMod = await import('./compile.js');
      compileCommand = compileMod.compileCommand as ReturnType<typeof vi.fn>;
      // clearAllMocks keeps implementations, so the failure case would leak.
      compileCommand.mockResolvedValue(true);
    });

    it('compiles before uploading on the fixture path', async () => {
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);

      await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false });

      expect(compileCommand).toHaveBeenCalledWith(
        expect.objectContaining({ kiciDir: '.kici', check: false }),
      );
      // fails-when: a remote run compiles without the preflight and ships an
      // agent-unrunnable .kici/ silently
      expect(compileCommand).toHaveBeenCalledWith(
        expect.objectContaining({ warnMissingKiciManifest: true }),
      );
      const compileOrder = compileCommand.mock.invocationCallOrder[0];
      const overlayOrder = createOverlayTarball.mock.invocationCallOrder[0];
      expect(compileOrder).toBeLessThan(overlayOrder);
    });

    it('passes --orchestrator-url to the compile so its types refresh reads that orchestrator', async () => {
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);
      vi.stubEnv('KICI_ORCHESTRATOR_TOKEN', 'env-tok');
      mockDirect.whoami.mockResolvedValue({
        tokenId: 't',
        label: 'dev',
        subject: null,
        role: 'admin',
        mode: 'independent',
        orgId: '__default__',
        permissions: { trigger: true, read: true },
      });
      mockDirect.initUpload.mockResolvedValue({
        uploadId: 'u',
        signedUrl: 'http://s/put',
        publicKey: Buffer.from('k').toString('base64'),
        expiresIn: 1,
      });
      mockDirect.trigger.mockResolvedValue({ runId: 'r', status: 'accepted' });

      await runRemoteCommand('push-main', {
        kiciDir: '.kici',
        wait: false,
        orchestratorUrl: 'https://ci.example.com',
      });

      // fails-when: the compile's types refresh falls back to a saved Platform login
      expect(compileCommand).toHaveBeenCalledWith(
        expect.objectContaining({ orchestratorUrl: 'https://ci.example.com' }),
      );
    });

    it('aborts the run (no upload, no dispatch) when compile fails', async () => {
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);
      compileCommand.mockResolvedValue(false);

      const result = await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false });

      expect(result).toBe(false);
      expect(createOverlayTarball).not.toHaveBeenCalled();
      expect(mockClient.trigger).not.toHaveBeenCalled();
    });

    it('compiles before uploading on the --workflow direct path', async () => {
      await runRemoteCommand(undefined, {
        kiciDir: '.kici',
        workflow: 'deploy',
        wait: false,
      });

      expect(compileCommand).toHaveBeenCalled();
      const compileOrder = compileCommand.mock.invocationCallOrder[0];
      const overlayOrder = createOverlayTarball.mock.invocationCallOrder[0];
      expect(compileOrder).toBeLessThan(overlayOrder);
    });

    it('does not compile when listing fixtures or showing history', async () => {
      compileFixtures.mockResolvedValue([fixture]);
      await runRemoteCommand(undefined, { kiciDir: '.kici' }); // list fixtures
      expect(compileCommand).not.toHaveBeenCalled();

      await runRemoteCommand(undefined, { kiciDir: '.kici', history: true }); // history
      expect(compileCommand).not.toHaveBeenCalled();
    });

    it('compiles quietly under --json so stdout stays pure JSON', async () => {
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await runRemoteCommand('push-main', { kiciDir: '.kici', json: true });

      // The compile + auto-types success lines must be suppressed so they never
      // precede the JSON result on stdout.
      expect(compileCommand).toHaveBeenCalledWith(expect.objectContaining({ quiet: true }));
      spy.mockRestore();
    });

    it('compiles quietly under --quiet', async () => {
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);

      await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false, quiet: true });

      expect(compileCommand).toHaveBeenCalledWith(expect.objectContaining({ quiet: true }));
    });

    it('compiles non-quietly for a plain human run', async () => {
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);

      await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false });

      expect(compileCommand).toHaveBeenCalledWith(expect.objectContaining({ quiet: false }));
    });
  });

  describe('direct transport', () => {
    const WHOAMI = {
      tokenId: 'tok-1',
      label: 'dev',
      subject: 'dev@x',
      role: 'admin',
      mode: 'independent',
      orgId: '__default__',
      permissions: { trigger: true, read: true },
    };

    beforeEach(() => {
      mockDirect.whoami.mockResolvedValue(WHOAMI);
      mockDirect.initUpload.mockResolvedValue({
        uploadId: 'upload-d',
        signedUrl: 'http://127.0.0.1:14333/kici-cache/x?X-Amz-Signature=sig',
        publicKey: Buffer.from('orchpub').toString('base64'),
        expiresIn: 3600,
      });
      mockDirect.trigger.mockResolvedValue({ runId: 'run-d', status: 'accepted' });
      mockDirect.runLogs.mockResolvedValue({ lines: ['x'], nextCursor: 1, done: true });
      mockDirect.runStatus.mockResolvedValue({
        runId: 'run-d',
        status: 'success',
        jobs: [],
        done: true,
      });
      mockDirect.cancel.mockResolvedValue({ cancelled: true });
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);
    });

    it('runs on the --orchestrator-url orchestrator, never the Platform', async () => {
      vi.stubEnv('KICI_ORCHESTRATOR_TOKEN', 'env-tok');
      const result = await runRemoteCommand('push-main', {
        kiciDir: '.kici',
        wait: false,
        orchestratorUrl: 'https://ci.example.com/',
      });
      expect(result).toBe(true);
      expect(directClientConfigs).toEqual([{ url: 'https://ci.example.com', token: 'env-tok' }]);
      expect(mockDirect.whoami).toHaveBeenCalledTimes(1);
      expect(mockDirect.whoami.mock.invocationCallOrder[0]).toBeLessThan(
        mockDirect.initUpload.mock.invocationCallOrder[0],
      );
      expect(mockDirect.trigger).toHaveBeenCalledWith(
        expect.objectContaining({ fixtureId: 'push-main', uploadId: 'upload-d', fullRepo: true }),
      );
      // fails-when: the flag is ignored and the run goes through the Platform relay
      expect(platformClientConfigs).toHaveLength(0);
      expect(mockClient.trigger).not.toHaveBeenCalled();
    });

    it('uses a saved direct target without a flag', async () => {
      loadGlobalConfig.mockResolvedValue({
        pat: 'test-pat',
        platformEndpoint: 'https://platform.invalid',
        activeOrgId: 'org_a',
        direct: { url: 'https://ci.example.com', token: 'saved-tok' },
      });
      await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false });
      expect(directClientConfigs).toEqual([{ url: 'https://ci.example.com', token: 'saved-tok' }]);
      expect(mockClient.trigger).not.toHaveBeenCalled();
    });

    it('ignores an env URL without a token and keeps the Platform login', async () => {
      vi.stubEnv('KICI_ORCHESTRATOR_URL', 'ws://host:4000/ws');
      await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false });
      // breaks-if-wrong: an agent host's own socket URL must not move a run off the Platform
      expect(directClientConfigs).toHaveLength(0);
      expect(mockClient.trigger).toHaveBeenCalled();
    });

    it('stops before any upload when the token cannot start runs', async () => {
      vi.stubEnv('KICI_ORCHESTRATOR_TOKEN', 'aud');
      mockDirect.whoami.mockResolvedValue({
        ...WHOAMI,
        role: 'auditor',
        permissions: { trigger: false, read: true },
      });
      const result = await runRemoteCommand('push-main', {
        kiciDir: '.kici',
        orchestratorUrl: 'https://ci.example.com',
      });
      expect(result).toBe(false);
      expect(mockDirect.initUpload).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('cannot start runs'));
    });

    it('warns about --org and --routing-key on a direct run and still runs', async () => {
      vi.stubEnv('KICI_ORCHESTRATOR_TOKEN', 'env-tok');
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const result = await runRemoteCommand('push-main', {
          kiciDir: '.kici',
          wait: false,
          orchestratorUrl: 'https://ci.example.com',
          org: 'org_x',
          routingKey: 'github:1',
        });
        expect(result).toBe(true);
        const written = stderr.mock.calls.map((c) => String(c[0])).join('');
        expect(written).toContain('the orchestrator chooses the organization');
        expect(written).toContain('v1.0.0');
      } finally {
        stderr.mockRestore();
      }
    });

    /** A running run whose first log poll delivers Ctrl-C, as the terminal would. */
    function interruptFirstPoll(): void {
      vi.stubEnv('KICI_ORCHESTRATOR_TOKEN', 'env-tok');
      mockDirect.runLogs.mockImplementationOnce(async () => {
        process.emit('SIGINT');
        return { lines: [], nextCursor: 0, done: false };
      });
      mockDirect.runStatus.mockResolvedValueOnce({
        runId: 'run-d',
        status: 'running',
        jobs: [],
        done: false,
      });
      mockDirect.listHolds.mockResolvedValue([]);
    }

    /** Hold the next cancel request open; the returned function answers it. */
    function holdNextCancel(): (answer: { cancelled: boolean }) => void {
      let answer: (v: { cancelled: boolean }) => void = () => {};
      mockDirect.cancel.mockImplementationOnce(
        () => new Promise<{ cancelled: boolean }>((resolve) => (answer = resolve)),
      );
      return (v) => answer(v);
    }

    it('cancels through the orchestrator on SIGINT', async () => {
      interruptFirstPoll();
      const result = await runRemoteCommand('push-main', {
        kiciDir: '.kici',
        quiet: true,
        orchestratorUrl: 'https://ci.example.com',
      });
      expect(result).toBe(false);
      expect(mockDirect.cancel).toHaveBeenCalledWith('run-d');
    });

    it('returns only after the cancel request on SIGINT has settled', async () => {
      interruptFirstPoll();
      const answer = holdNextCancel();
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        let settled = false;
        const done = runRemoteCommand('push-main', {
          kiciDir: '.kici',
          quiet: true,
          orchestratorUrl: 'https://ci.example.com',
        }).finally(() => (settled = true));

        await vi.waitFor(() => expect(mockDirect.cancel).toHaveBeenCalledWith('run-d'));
        // Several poll intervals pass while the orchestrator has not answered.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        // fails-when: the poll loop returns as soon as Ctrl-C sets its flag, so the
        // CLI reports and exits while the cancel request is still in flight
        expect(settled).toBe(false);

        answer({ cancelled: true });
        expect(await done).toBe(false);
        const written = stderr.mock.calls.map((c) => String(c[0])).join('');
        expect(written).toContain('Cancelled run run-d.');
      } finally {
        stderr.mockRestore();
      }
    }, 10_000);

    it('exits at once on a second SIGINT while the cancel is pending', async () => {
      interruptFirstPoll();
      const answer = holdNextCancel();
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const done = runRemoteCommand('push-main', {
          kiciDir: '.kici',
          quiet: true,
          orchestratorUrl: 'https://ci.example.com',
        });
        await vi.waitFor(() => expect(mockDirect.cancel).toHaveBeenCalled());
        expect(exit).not.toHaveBeenCalled();
        process.emit('SIGINT');
        expect(exit).toHaveBeenCalledWith(130);
        // breaks-if-wrong: the second Ctrl-C must not send a second cancel
        expect(mockDirect.cancel).toHaveBeenCalledTimes(1);
        answer({ cancelled: true });
        await done;
      } finally {
        exit.mockRestore();
        stderr.mockRestore();
      }
    });

    it('does not start the next fixture of a batch after Ctrl-C', async () => {
      interruptFirstPoll();
      compileFixtures.mockResolvedValue([fixture, { ...fixture, id: 'push-other' }]);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const result = await runRemoteCommand(undefined, {
          kiciDir: '.kici',
          all: true,
          quiet: true,
          orchestratorUrl: 'https://ci.example.com',
        });
        expect(result).toBe(false);
        // fails-when: a cancelled result does not end the serial loop, so Ctrl-C
        // cancels one run and the CLI starts the next fixture's run
        expect(mockDirect.trigger).toHaveBeenCalledTimes(1);
      } finally {
        stderr.mockRestore();
      }
    });

    it('records the orchestrator URL in the run history', async () => {
      vi.stubEnv('KICI_ORCHESTRATOR_TOKEN', 'env-tok');
      await runRemoteCommand('push-main', {
        kiciDir: '.kici',
        wait: false,
        orchestratorUrl: 'https://ci.example.com',
      });
      expect(mockHistory.addEntry).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'https://ci.example.com' }),
      );
    });

    it('names the upload address and setting when the upload fails', async () => {
      vi.stubEnv('KICI_ORCHESTRATOR_TOKEN', 'env-tok');
      uploadTarball.mockImplementation(async () => {
        throw new Error('fetch failed');
      });
      const result = await runRemoteCommand('push-main', {
        kiciDir: '.kici',
        wait: false,
        orchestratorUrl: 'https://ci.example.com',
      });
      expect(result).toBe(false);
      const printed = (logger.info as ReturnType<typeof vi.fn>).mock.calls
        .concat((logger.error as ReturnType<typeof vi.fn>).mock.calls)
        .map((c) => String(c[0]))
        .join('\n');
      expect(printed).toContain('http://127.0.0.1:14333');
      expect(printed).toContain('KICI_STORAGE_UPLOAD_ENDPOINT');
      expect(printed).not.toContain('X-Amz-Signature');
    });
  });

  describe('watchRunHolds', () => {
    it('prints an unavailable-holds message once and stops listing', async () => {
      const { HoldsUnavailableError } = await import('../remote/direct-client.js');
      const list = vi.fn(async () => {
        throw new HoldsUnavailableError('Held runs are answered through the KiCI Platform', 409);
      });
      const transport = {
        kind: 'direct' as const,
        holds: {
          list,
          context: vi.fn(),
          approve: vi.fn(),
          reject: vi.fn(),
          answerHint: vi.fn(),
        },
      };
      const state = { seen: new Set<string>(), unavailable: false };
      for (let i = 0; i < 3; i++) await watchRunHolds('run-1', state, transport, {});
      expect(list).toHaveBeenCalledTimes(1);
      const printed = (logger.info as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
        String(c[0]).includes('answered through the KiCI Platform'),
      );
      expect(printed).toHaveLength(1);
    });
  });

  describe('buildTargetSelector', () => {
    it('returns undefined for no targets', () => {
      expect(buildTargetSelector(undefined, false)).toBeUndefined();
      expect(buildTargetSelector([], false)).toBeUndefined();
    });

    it('compiles each target string into one include value, AND-combined', () => {
      expect(buildTargetSelector(['role:web', 'dc:eu'], true)).toEqual({
        values: [
          { include: [{ kind: 'exact', value: 'role:web' }], exclude: [] },
          { include: [{ kind: 'exact', value: 'dc:eu' }], exclude: [] },
        ],
        allowEmpty: true,
      });
    });

    it('throws when allowEmpty is set without any targets', () => {
      expect(() => buildTargetSelector(undefined, true)).toThrow(/--target-allow-empty/);
      expect(() => buildTargetSelector([], true)).toThrow(/--target-allow-empty/);
    });
  });

  describe('log polling', () => {
    it('advances the cursor and stops on done', async () => {
      mockClient.runLogs
        .mockResolvedValueOnce({ lines: ['a'], nextCursor: 1, done: false })
        .mockResolvedValueOnce({ lines: ['b', 'c'], nextCursor: 3, done: true });
      mockClient.runStatus
        .mockResolvedValueOnce({ runId: 'run-123', status: 'running', jobs: [], done: false })
        .mockResolvedValueOnce({
          runId: 'run-123',
          status: 'success',
          jobs: [{ jobId: 'j1', jobName: 'build', status: 'success' }],
          done: true,
        });
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);

      const result = await runRemoteCommand('push-main', { kiciDir: '.kici', quiet: true });

      expect(result).toBe(true);
      // The first poll starts the per-file cursor; this server answers without
      // one, so the second poll falls back to the numeric cursor alone.
      expectLogPoll(1, { cursor: 0, logCursor: '' });
      // breaks-if-wrong: an older Platform or orchestrator keeps working
      expectLogPoll(2, { cursor: 1 });
    });

    it('follows the per-file cursor when the server offers one', async () => {
      mockClient.runLogs
        .mockResolvedValueOnce({ lines: ['a'], nextCursor: 1, nextLogCursor: 'c1', done: false })
        .mockResolvedValueOnce({ lines: ['b'], nextCursor: 2, nextLogCursor: 'c2', done: true });
      mockClient.runStatus
        .mockResolvedValueOnce({ runId: 'run-123', status: 'running', jobs: [], done: false })
        .mockResolvedValueOnce({ runId: 'run-123', status: 'success', jobs: [], done: true });
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);

      await runRemoteCommand('push-main', { kiciDir: '.kici', quiet: true });

      // fails-when: the loop keeps sending the numeric cursor, so a step file
      // that sorts before an already-read file loses lines
      expectLogPoll(2, { cursor: 1, logCursor: 'c1' });
    });

    it('retries while a freshly triggered run is not yet readable on the Platform', async () => {
      const { NotFoundError } = await import('../remote/platform-client.js');
      // The trigger returns the run id before the Platform's view of the run
      // lands, so the first poll 404s. The poll must retry, not fail the run.
      mockClient.runLogs
        .mockRejectedValueOnce(new NotFoundError('Run not found'))
        .mockResolvedValueOnce({ lines: ['a'], nextCursor: 1, done: true });
      mockClient.runStatus.mockResolvedValueOnce({
        runId: 'run-123',
        status: 'success',
        jobs: [{ jobId: 'j1', jobName: 'build', status: 'success' }],
        done: true,
      });
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);

      const result = await runRemoteCommand('push-main', { kiciDir: '.kici', quiet: true });

      expect(result).toBe(true);
      expect(mockClient.runLogs).toHaveBeenCalledTimes(2);
      // The retry re-reads from the same cursor — no log lines were consumed.
      expectLogPoll(2, { cursor: 0, logCursor: '' });
    });

    it('surfaces a 404 once the run has already been read', async () => {
      const { NotFoundError } = await import('../remote/platform-client.js');
      mockClient.runLogs
        .mockResolvedValueOnce({ lines: ['a'], nextCursor: 1, done: false })
        .mockRejectedValueOnce(new NotFoundError('Run not found'));
      mockClient.runStatus.mockResolvedValueOnce({
        runId: 'run-123',
        status: 'running',
        jobs: [],
        done: false,
      });
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);

      const result = await runRemoteCommand('push-main', { kiciDir: '.kici', quiet: true });

      expect(result).toBe(false);
      expect(mockClient.runLogs).toHaveBeenCalledTimes(2);
    });

    it('reports a failed run as failure', async () => {
      mockClient.runStatus.mockResolvedValue({
        runId: 'run-123',
        status: 'failed',
        jobs: [{ jobId: 'j1', jobName: 'build', status: 'failed' }],
        done: true,
      });
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);

      const result = await runRemoteCommand('push-main', { kiciDir: '.kici', quiet: true });
      expect(result).toBe(false);
    });
  });

  describe('a fixture that matches several workflows', () => {
    /** Two runs, one per workflow; `outcome` sets each run's final status. */
    function twoRuns(outcome: Record<string, 'success' | 'failed'>): void {
      mockClient.trigger.mockResolvedValue({
        runId: 'run-a',
        runs: [
          { runId: 'run-a', workflowName: 'wf-a', jobIds: ['ja'] },
          { runId: 'run-b', workflowName: 'wf-b', jobIds: ['jb'] },
        ],
        status: 'accepted',
      });
      mockClient.runLogs.mockImplementation(async (_org: string, runId: string) => ({
        lines: [`line of ${runId}`],
        lineJobNames: ['build'],
        nextCursor: 1,
        done: true,
      }));
      mockClient.runStatus.mockImplementation(async (_org: string, runId: string) => ({
        runId,
        status: outcome[runId],
        jobs: [{ jobId: `j-${runId}`, jobName: 'build', status: outcome[runId] }],
        done: true,
      }));
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);
    }

    it('asks for one run per workflow and follows every run', async () => {
      twoRuns({ 'run-a': 'success', 'run-b': 'success' });
      const result = await runRemoteCommand('push-main', { kiciDir: '.kici', quiet: true });

      // breaks-if-wrong: every run passing passes the command
      expect(result).toBe(true);
      expect(mockClient.trigger).toHaveBeenCalledWith(
        'org_a',
        expect.anything(),
        expect.objectContaining({ acceptsMultipleRuns: true }),
      );
      // fails-when: the CLI follows only the deprecated top-level runId
      const polled = new Set(mockClient.runStatus.mock.calls.map((c) => c[1]));
      expect(polled).toEqual(new Set(['run-a', 'run-b']));
      // One history entry per run, each naming its workflow.
      expect(mockHistory.addEntry).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'run-a', workflowName: 'wf-a' }),
      );
      expect(mockHistory.addEntry).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'run-b', workflowName: 'wf-b' }),
      );
      expect(mockHistory.updateEntry).toHaveBeenCalledWith(
        'run-b',
        expect.objectContaining({ status: 'success' }),
      );
    });

    it('fails when any one run fails, even the second', async () => {
      twoRuns({ 'run-a': 'success', 'run-b': 'failed' });
      const { formatJsonResult } = await import('../remote/output/json.js');
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const result = await runRemoteCommand('push-main', { kiciDir: '.kici', json: true });
        // fails-when: the exit code reads only the first run's status
        expect(result).toBe(false);
        const [results] = vi.mocked(formatJsonResult).mock.calls[0]!;
        expect(results[0]).toMatchObject({
          runId: 'run-a',
          status: 'failed',
          runs: [
            { runId: 'run-a', workflowName: 'wf-a', status: 'success' },
            { runId: 'run-b', workflowName: 'wf-b', status: 'failed' },
          ],
        });
        // fails-when: a job does not say which workflow defines it
        expect(results[0]!.jobs.map((j) => `${j.workflowName}/${j.name}`)).toEqual([
          'wf-a/build',
          'wf-b/build',
        ]);
      } finally {
        spy.mockRestore();
      }
    });

    it('prints one Run started line per run, naming its workflow', async () => {
      twoRuns({ 'run-a': 'success', 'run-b': 'success' });
      await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false });
      const lines = vi.mocked(logger.info).mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('Run started: run-a (wf-a)'))).toBe(true);
      // fails-when: --no-wait names only the first run
      expect(lines.some((l) => l.includes('Run started: run-b (wf-b)'))).toBe(true);
    });

    it('keeps following the other runs when one run cannot be read', async () => {
      const { NotFoundError } = await import('../remote/platform-client.js');
      twoRuns({ 'run-a': 'success', 'run-b': 'success' });
      const logs = mockClient.runLogs.getMockImplementation()!;
      let bPolls = 0;
      mockClient.runLogs.mockImplementation(
        async (org: string, runId: string, ...rest: unknown[]) => {
          if (runId === 'run-b' && bPolls++ > 0) throw new NotFoundError('Run not found');
          if (runId === 'run-b') return { lines: [], nextCursor: 0, done: false };
          return logs(org, runId, ...rest);
        },
      );
      mockClient.runStatus.mockImplementation(async (_org: string, runId: string) => ({
        runId,
        status: runId === 'run-b' ? 'running' : 'success',
        jobs: [],
        done: runId !== 'run-b',
      }));
      const result = await runRemoteCommand('push-main', { kiciDir: '.kici', quiet: true });
      // breaks-if-wrong: the unreadable run still fails the command
      expect(result).toBe(false);
      // fails-when: run-b's error aborts the follow before run-a's final status is recorded
      expect(mockHistory.updateEntry).toHaveBeenCalledWith(
        'run-a',
        expect.objectContaining({ status: 'success' }),
      );
      // breaks-if-wrong: history keeps a status its readers know
      expect(mockHistory.updateEntry).toHaveBeenCalledWith(
        'run-b',
        expect.objectContaining({ status: 'failed' }),
      );
    });

    it("prints each failed job's error block with only that job's lines", async () => {
      const { formatErrorHighlight } = await import('../remote/output/summary.js');
      mockClient.trigger.mockResolvedValue({ runId: 'run-a', status: 'accepted' });
      mockClient.runLogs.mockResolvedValue({
        lines: ['lint says no', 'build log', 'test says no'],
        lineJobNames: ['lint', 'build', 'test'],
        nextCursor: 3,
        done: true,
      });
      mockClient.runStatus.mockResolvedValue({
        runId: 'run-a',
        status: 'failed',
        jobs: [
          { jobId: '1', jobName: 'lint', status: 'failed' },
          { jobId: '2', jobName: 'build', status: 'success' },
          { jobId: '3', jobName: 'test', status: 'failed' },
        ],
        done: true,
      });
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        expect(await runRemoteCommand('push-main', { kiciDir: '.kici' })).toBe(false);
      } finally {
        out.mockRestore();
      }
      // fails-when: the streamed lines are not filed under the job that wrote them
      expect(vi.mocked(formatErrorHighlight).mock.calls).toEqual([
        ['lint', ['lint says no']],
        ['test', ['test says no']],
      ]);
    });

    it('falls back to one block of the run tail when the line job names do not line up', async () => {
      const { formatErrorHighlight } = await import('../remote/output/summary.js');
      mockClient.trigger.mockResolvedValue({ runId: 'run-a', status: 'accepted' });
      mockClient.runLogs.mockResolvedValue({
        lines: ['one', 'two'],
        lineJobNames: ['lint'],
        nextCursor: 2,
        done: true,
      });
      mockClient.runStatus.mockResolvedValue({
        runId: 'run-a',
        status: 'failed',
        jobs: [{ jobId: '1', jobName: 'lint', status: 'failed' }],
        done: true,
      });
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        await runRemoteCommand('push-main', { kiciDir: '.kici' });
      } finally {
        out.mockRestore();
      }
      // breaks-if-wrong: a malformed attribution never files lines under the wrong job
      expect(vi.mocked(formatErrorHighlight).mock.calls).toEqual([['lint', ['one', 'two']]]);
    });

    it('cancels every run on Ctrl-C', async () => {
      twoRuns({ 'run-a': 'success', 'run-b': 'success' });
      mockClient.runStatus.mockImplementation(async (_org: string, runId: string) => ({
        runId,
        status: 'running',
        jobs: [],
        done: false,
      }));
      mockClient.runLogs.mockImplementationOnce(async () => {
        process.emit('SIGINT');
        return { lines: [], nextCursor: 0, done: false };
      });
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const result = await runRemoteCommand('push-main', { kiciDir: '.kici', quiet: true });
        expect(result).toBe(false);
        // fails-when: Ctrl-C cancels only the run whose poll it interrupted
        expect(mockClient.cancel.mock.calls.map((c) => c[1]).sort()).toEqual(['run-a', 'run-b']);
      } finally {
        stderr.mockRestore();
      }
    });
  });

  describe('cluster ambiguity', () => {
    it('prints the cluster list and fails on AmbiguousClusterError', async () => {
      const { AmbiguousClusterError } = await import('../remote/platform-client.js');
      mockClient.initUpload.mockRejectedValue(
        new AmbiguousClusterError(['cluster-1', 'cluster-2']),
      );
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);

      const result = await runRemoteCommand('push-main', { kiciDir: '.kici' });

      expect(result).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('cluster-1, cluster-2'));
    });
  });

  describe('--json output', () => {
    it('keeps stdout as pure JSON', async () => {
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await runRemoteCommand('push-main', { kiciDir: '.kici', json: true });

      expect(spy).toHaveBeenCalledWith('{"results":[],"summary":{"passed":0}}');
      spy.mockRestore();
    });
  });

  describe('fullRepo uniform model — always upload the local working tree', () => {
    beforeEach(() => {
      mockReadFile.mockResolvedValue('{"schemaVersion":4,"workflows":[]}');
      compileFixtures.mockResolvedValue([fixture]);
      filterFixtures.mockReturnValue([fixture]);
    });

    it('forces the full working tree selection regardless of remote', async () => {
      // The default overlay mock has hasRemote: true; the run still requests the
      // full working tree (the orchestrator never clones for a relayed run).
      await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false });
      // fails-when: the run ships no .git, or one other than a depth-1 default-tags clone
      // with the synthetic commit on and no synthetic tag
      expect(createOverlayTarball).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          fullWorkingTree: true,
          git: { depth: 1, tags: GitTagMode.Default, commit: true, syntheticTags: [] },
        }),
      );
    });

    it('sends inlineLockFile, fullRepo, and the overlay key even WITH a remote', async () => {
      // The default overlay mock has hasRemote: true.
      await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false });

      expect(mockReadFile).toHaveBeenCalledWith('/mock/.kici/kici.lock.json', 'utf-8');
      expect(mockClient.trigger).toHaveBeenCalledWith(
        'org_a',
        expect.anything(),
        expect.objectContaining({
          inlineLockFile: '{"schemaVersion":4,"workflows":[]}',
          fullRepo: true,
          cliPublicKey: Buffer.from('clipubkey').toString('base64'),
        }),
      );
    });

    it('suppresses the working-tree status line under --json', async () => {
      vi.mocked(logger.info).mockClear();
      await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false, json: true });
      expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('local working tree'));
    });

    it('emits the working-tree status line in human mode', async () => {
      vi.mocked(logger.info).mockClear();
      await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false });
      // The overlay includes a `.git` built like a checkout of the repository.
      const infoCalls = vi.mocked(logger.info).mock.calls.map((c) => String(c[0]));
      expect(infoCalls.some((line) => line.includes('local working tree'))).toBe(true);
      expect(infoCalls.some((line) => line.includes('over a checkout of your repository'))).toBe(
        true,
      );
    });

    it('says no .git ships when the .git build was skipped', async () => {
      vi.mocked(logger.info).mockClear();
      createOverlayTarball.mockResolvedValue({ ...overlay, git: undefined });
      await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false });
      const infoCalls = vi.mocked(logger.info).mock.calls.map((c) => String(c[0]));
      // fails-when: the status line claims a .git that the overlay does not carry
      expect(infoCalls.some((line) => line.includes('over a checkout'))).toBe(false);
      expect(infoCalls.some((line) => line.includes('Git: '))).toBe(false);
      expect(infoCalls.some((line) => line.includes('no .git ships'))).toBe(true);
    });

    it('prints each overlay warning on stderr, also under --json', async () => {
      const warning = 'Not uploading the files of these submodules: vendor/sub.';
      createOverlayTarball.mockResolvedValue({ ...overlay, warnings: [warning] });
      const stderr: string[] = [];
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
        stderr.push(String(chunk));
        return true;
      });
      try {
        await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false, json: true });
      } finally {
        spy.mockRestore();
      }
      // fails-when: a warning is only logged through the stdout logger, which --json silences
      expect(stderr.some((line) => line.includes(warning))).toBe(true);
    });

    describe('git requirement, status lines and the overlay report', () => {
      const pushMainTrigger = {
        _type: 'push',
        branches: [{ type: 'glob', pattern: 'main' }],
        paths: [],
      };
      const lockJob = (name: string, checkoutOptions?: Record<string, unknown>) => ({
        _type: 'static',
        name,
        steps: [],
        needs: [],
        ...(checkoutOptions && { checkoutOptions }),
      });
      /** `w1` asks fetchDepth 0, `w2` asks nothing; a push to main matches both. */
      const SCOPED_LOCK = JSON.stringify({
        schemaVersion: 4,
        workflows: [
          {
            name: 'w1',
            contentHash: '',
            compileSchemaVersion: 0,
            triggers: [pushMainTrigger],
            jobs: [lockJob('release', { fetchDepth: 0 })],
          },
          {
            name: 'w2',
            contentHash: '',
            compileSchemaVersion: 0,
            triggers: [pushMainTrigger],
            jobs: [lockJob('plain')],
          },
        ],
      });
      const gitOption = (): Record<string, unknown> =>
        (createOverlayTarball.mock.calls[0][1] as { git: Record<string, unknown> }).git;
      const plainInfo = (): string[] =>
        vi.mocked(logger.info).mock.calls.map((c) => stripVTControlCharacters(String(c[0])));
      /** Serve the real JSON formatter, so stdout carries what a user gets. */
      const useRealJson = async () => {
        const actual = await vi.importActual<typeof import('../remote/output/json.js')>(
          '../remote/output/json.js',
        );
        const mod = await import('../remote/output/json.js');
        vi.mocked(mod.formatJsonResult).mockImplementation(actual.formatJsonResult);
      };
      const jsonStdout = async (run: () => Promise<boolean>): Promise<Record<string, any>> => {
        const lines: string[] = [];
        const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
          lines.push(String(line));
        });
        try {
          await run();
        } finally {
          spy.mockRestore();
        }
        expect(lines).toHaveLength(1);
        return JSON.parse(lines[0]);
      };
      const reportingOverlay = {
        ...overlay,
        summary: { ...overlay.summary, compressedSize: 7777, fileCount: 42, sha: 'syn456' },
        git: {
          ...overlay.git,
          baseSha: 'abc123',
          workspaceSha: 'syn456',
          synthetic: true,
          createdTags: ['v9.9.9'],
          // What shipped differs from the request (depth 1, default tags).
          record: { fetchDepth: 3, allTags: true },
        },
      };
      const expectedReport = {
        compressedSize: 7777,
        fileCount: 42,
        git: {
          depth: 1,
          tags: GitTagMode.Default,
          // fails-when: the JSON reports only the request, not the shipped record
          shipped: { fetchDepth: 3, allTags: true },
          synthetic: true,
          workspaceSha: 'syn456',
          baseSha: 'abc123',
          syntheticTags: ['v9.9.9'],
        },
      };

      it('passes the lock-derived git options to the overlay builder', async () => {
        mockReadFile.mockResolvedValue(SCOPED_LOCK);
        await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false });
        // fails-when: the requirement ignores the lock and ships depth 1
        expect(createOverlayTarball).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ git: expect.objectContaining({ depth: 0 }) }),
        );
        // The lock is read before the overlay is built, to size its .git.
        expect(mockReadFile.mock.invocationCallOrder[0]).toBeLessThan(
          createOverlayTarball.mock.invocationCallOrder[0],
        );
      });

      it('lets the flags override the lock per dimension', async () => {
        mockReadFile.mockResolvedValue(SCOPED_LOCK);
        await runRemoteCommand('push-main', {
          kiciDir: '.kici',
          wait: false,
          git: { gitDepth: 3, gitTags: false, commit: true, tags: [] },
        });
        expect(gitOption()).toEqual(expect.objectContaining({ depth: 3, tags: GitTagMode.None }));
        expect(plainInfo()).toContain('Git: depth 3, no tags (--git-depth 3; --no-git-tags)');
      });

      it('scopes the requirement to the fixture workflowName', async () => {
        mockReadFile.mockResolvedValue(SCOPED_LOCK);
        const pinned = {
          ...fixture,
          fixture: {
            ...fixture.fixture,
            options: { ...fixture.fixture.options, workflowName: 'w2' },
          },
        };
        compileFixtures.mockResolvedValue([pinned]);
        filterFixtures.mockReturnValue([pinned]);
        await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false });
        // fails-when: the event match (w1 and w2) sizes the .git instead of the named workflow
        expect(gitOption().depth).toBe(1);
      });

      it('scopes the requirement to --workflow on a direct run', async () => {
        mockReadFile.mockResolvedValue(SCOPED_LOCK);
        await runRemoteCommand(undefined, { kiciDir: '.kici', workflow: 'w1', wait: false });
        expect(gitOption().depth).toBe(0);
        createOverlayTarball.mockClear();
        await runRemoteCommand(undefined, { kiciDir: '.kici', workflow: 'w2', wait: false });
        expect(gitOption().depth).toBe(1);
      });

      it('passes the raw commit flags through', async () => {
        await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false });
        // fails-when: the CLI resolves the default message or author itself
        expect(gitOption().commitMessage).toBeUndefined();
        expect(gitOption().commitAuthor).toBeUndefined();

        createOverlayTarball.mockClear();
        const author = { name: 'Ada', email: 'ada@example.com' };
        await runRemoteCommand('push-main', {
          kiciDir: '.kici',
          wait: false,
          git: { commit: false, commitMessage: 'msg', commitAuthor: author, tags: ['v1'] },
        });
        expect(gitOption()).toEqual(
          expect.objectContaining({
            commit: false,
            commitMessage: 'msg',
            commitAuthor: author,
            syntheticTags: ['v1'],
          }),
        );
      });

      it('prints the Git and Workspace commit lines in human mode', async () => {
        vi.mocked(logger.info).mockClear();
        await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false });
        expect(plainInfo()).toContain('Git: depth 1, default tags (default)');
        expect(plainInfo()).toContain('Workspace commit: abc123 (HEAD)');
        expect(plainInfo()).toContain(
          'Running your local working tree over a checkout of your repository',
        );
      });

      it('names the synthetic commit and its base HEAD', async () => {
        createOverlayTarball.mockResolvedValue(reportingOverlay);
        vi.mocked(logger.info).mockClear();
        await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false });
        expect(plainInfo()).toContain(
          'Workspace commit: syn456 (synthetic commit over HEAD abc123)',
        );
      });

      it('prints a line per replaced tag, on stderr under --json', async () => {
        const line = (name: string) =>
          `Tag '${name}' replaces the tag of that name from your repository in the remote workspace.`;
        createOverlayTarball.mockResolvedValue({
          ...overlay,
          git: { ...overlay.git, createdTags: ['v1', 'v2'], replacedTags: ['v1', 'v2'] },
        });
        vi.mocked(logger.info).mockClear();
        await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false });
        expect(plainInfo()).toEqual(expect.arrayContaining([line('v1'), line('v2')]));

        const stderr: string[] = [];
        const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
          stderr.push(stripVTControlCharacters(String(chunk)));
          return true;
        });
        vi.mocked(logger.info).mockClear();
        try {
          await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false, json: true });
        } finally {
          spy.mockRestore();
        }
        // fails-when: --json silences the stdout logger and the replacement goes unreported
        expect(stderr).toEqual(expect.arrayContaining([`${line('v1')}\n`, `${line('v2')}\n`]));
        expect(plainInfo().some((l) => l.includes('replaces the tag'))).toBe(false);
      });

      it('puts the overlay report into --json results', async () => {
        await useRealJson();
        createOverlayTarball.mockResolvedValue(reportingOverlay);
        const parsed = await jsonStdout(() =>
          runRemoteCommand('push-main', { kiciDir: '.kici', json: true }),
        );
        expect(parsed.results[0].overlay).toEqual(expectedReport);
      });

      it('puts the overlay report into --workflow --json results', async () => {
        await useRealJson();
        mockReadFile.mockResolvedValue(SCOPED_LOCK);
        createOverlayTarball.mockResolvedValue(reportingOverlay);
        const parsed = await jsonStdout(() =>
          runRemoteCommand(undefined, { kiciDir: '.kici', workflow: 'w2', json: true }),
        );
        // fails-when: only runSingleFixture attaches overlay
        expect(parsed.results[0].fixtureId).toBe('direct:w2');
        expect(parsed.results[0].overlay).toEqual(expectedReport);
      });

      it('hands each programmatic run its own default git flags', async () => {
        await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false });
        await runRemoteCommand('push-main', { kiciDir: '.kici', wait: false });
        const tagsOf = (n: number) =>
          (createOverlayTarball.mock.calls[n][1] as { git: { syntheticTags: string[] } }).git
            .syntheticTags;
        expect(tagsOf(0)).toEqual([]);
        // fails-when: one module-level default array is shared, so a mutation by one run
        // leaks into the next
        expect(tagsOf(0)).not.toBe(tagsOf(1));
      });

      it('prints the same human-mode lines for a direct --workflow run, and no result document', async () => {
        mockReadFile.mockResolvedValue(SCOPED_LOCK);
        vi.mocked(logger.info).mockClear();
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
          const ok = await runRemoteCommand(undefined, {
            kiciDir: '.kici',
            workflow: 'w2',
            wait: false,
          });
          expect(ok).toBe(true);
          // fails-when: the human-mode direct run starts rendering a result document
          expect(spy).not.toHaveBeenCalled();
        } finally {
          spy.mockRestore();
        }
        // fails-when: a change silently adds, drops or reorders a human-mode line
        expect(plainInfo()).toEqual([
          'Platform: https://platform.invalid',
          'Organization: org_a',
          'Running workflow "w2" directly (bypassing triggers)',
          'Creating overlay tarball...',
          'Running your local working tree over a checkout of your repository',
          'Git: depth 1, default tags (default)',
          'Workspace commit: abc123 (HEAD)',
          '5 files changed, 2 new, 0 deleted (1 KB compressed)',
          'Initializing upload...',
          'Uploading overlay...',
          'Run started: run-123',
        ]);
      });

      it('fails before compiling on an invalid --tag', async () => {
        const compileMod = await import('./compile.js');
        const result = await runRemoteCommand('push-main', {
          kiciDir: '.kici',
          git: { commit: true, tags: ['a..b'] },
        });
        expect(result).toBe(false);
        // fails-when: the tag is only checked once the overlay is being built
        expect(compileMod.compileCommand).not.toHaveBeenCalled();
        expect(createOverlayTarball).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining("--tag 'a..b' is not a valid tag name"),
        );
      });
    });
  });
});

describe('buildDispatchInputs', () => {
  const desc = {
    skipCveScan: { type: 'boolean' as const, optional: false, nullable: false, default: false },
  };
  it('returns raw pairs after validating', () => {
    expect(buildDispatchInputs(['skipCveScan=true'], desc)).toEqual({ skipCveScan: 'true' });
  });
  it('throws on an invalid value', () => {
    expect(() => buildDispatchInputs(['skipCveScan=maybe'], desc)).toThrow();
  });
  it('throws on an unknown key', () => {
    expect(() => buildDispatchInputs(['nope=1'], desc)).toThrow(/nope/);
  });
  it('returns {} for no pairs', () => {
    expect(buildDispatchInputs([], desc)).toEqual({});
  });
  it('skips validation when no descriptor (forwards raw)', () => {
    expect(buildDispatchInputs(['anything=1'], undefined)).toEqual({ anything: '1' });
  });
});

describe('lookupDispatchInputsDescriptor', () => {
  const lock = JSON.stringify({
    workflows: [
      {
        name: 'deploy-prod',
        triggers: [
          {
            _type: 'dispatch',
            types: ['deploy-prod'],
            inputs: { skipCveScan: { type: 'boolean', optional: false, nullable: false } },
          },
        ],
      },
      { name: 'other', triggers: [{ _type: 'push' }] },
    ],
  });
  it('returns the named workflow dispatch inputs', () => {
    expect(lookupDispatchInputsDescriptor(lock, 'deploy-prod')).toEqual({
      skipCveScan: { type: 'boolean', optional: false, nullable: false },
    });
  });
  it('returns undefined for a workflow with no dispatch inputs', () => {
    expect(lookupDispatchInputsDescriptor(lock, 'other')).toBeUndefined();
  });
  it('returns undefined for missing lock', () => {
    expect(lookupDispatchInputsDescriptor(undefined, 'deploy-prod')).toBeUndefined();
  });
  it('merges across workflows when no name given', () => {
    expect(lookupDispatchInputsDescriptor(lock, undefined)).toEqual({
      skipCveScan: { type: 'boolean', optional: false, nullable: false },
    });
  });
});

describe('withStdoutOnStderr', () => {
  function captureStreams() {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const origStdout = process.stdout.write;
    const origStderr = process.stderr.write;
    process.stdout.write = ((c: unknown) => {
      stdoutChunks.push(String(c));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((c: unknown) => {
      stderrChunks.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    const restore = () => {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    };
    return { stdoutChunks, stderrChunks, restore };
  }

  it('redirects stdout writes to stderr inside the callback, then restores stdout', async () => {
    const { stdoutChunks, stderrChunks, restore } = captureStreams();
    try {
      const result = await withStdoutOnStderr(async () => {
        // Simulates a user workflow's module-top-level console.log during compile.
        process.stdout.write('CAPTURE_MARKER_MODULE_TOPLEVEL\n');
        return 'ok';
      });
      // After the guard returns, stdout is live again.
      process.stdout.write('AFTER\n');

      expect(result).toBe('ok');
      expect(stderrChunks).toContain('CAPTURE_MARKER_MODULE_TOPLEVEL\n');
      expect(stdoutChunks).not.toContain('CAPTURE_MARKER_MODULE_TOPLEVEL\n');
      expect(stdoutChunks).toContain('AFTER\n');
    } finally {
      restore();
    }
  });

  it('restores stdout even when the callback throws', async () => {
    const { stdoutChunks, restore } = captureStreams();
    try {
      await expect(
        withStdoutOnStderr(async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      process.stdout.write('AFTER_THROW\n');
      expect(stdoutChunks).toContain('AFTER_THROW\n');
    } finally {
      restore();
    }
  });
});

describe('requestRunCancel', () => {
  function captureStderr(): { text: () => string; restore: () => void } {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return {
      text: () => spy.mock.calls.map((c) => String(c[0])).join(''),
      restore: () => spy.mockRestore(),
    };
  }

  it('reports a run that had already finished', async () => {
    const err = captureStderr();
    try {
      await requestRunCancel({ cancel: async () => ({ cancelled: false }) }, 'run-x', {
        quiet: true,
      });
      expect(err.text()).toContain('Run run-x had already finished; nothing to cancel.');
    } finally {
      err.restore();
    }
  });

  it('reports a failed cancel request instead of throwing', async () => {
    const err = captureStderr();
    try {
      await requestRunCancel(
        {
          cancel: async () => {
            throw new Error('Connection refused');
          },
        },
        'run-x',
        { quiet: true },
      );
      expect(err.text()).toContain('Could not cancel run run-x: Connection refused.');
    } finally {
      err.restore();
    }
  });

  it('stops waiting for an orchestrator that never answers', async () => {
    const err = captureStderr();
    try {
      // fails-when: the wait is unbounded, so this promise never settles and
      // the CLI hangs after Ctrl-C until a second one
      await requestRunCancel({ cancel: () => new Promise(() => {}) }, 'run-x', { quiet: true }, 50);
      expect(err.text()).toContain('the orchestrator did not answer within 0.05s');
    } finally {
      err.restore();
    }
  });
});

describe('describeMissingWorkflow', () => {
  const lock = JSON.stringify({ workflows: [{ name: 'ci' }, { name: 'hello-world' }] });

  it('accepts a workflow the lock file contains', () => {
    // breaks-if-wrong: a real workflow name must never be refused.
    expect(describeMissingWorkflow(lock, 'hello-world')).toBeUndefined();
  });

  it('names the available workflows for an unknown one', () => {
    // fails-when: the check passes an unknown name, or drops the list.
    expect(describeMissingWorkflow(lock, 'hello')).toBe(
      "Workflow 'hello' is not in the compiled lock file. Available workflows: ci, hello-world.",
    );
  });

  it('says so when the lock file has no workflows', () => {
    expect(describeMissingWorkflow('{"workflows":[]}', 'ci')).toBe(
      "Workflow 'ci' is not in the compiled lock file. The lock file has no workflows.",
    );
  });

  it('leaves an unparsable lock file to the orchestrator', () => {
    expect(describeMissingWorkflow('not json', 'ci')).toBeUndefined();
  });
});
