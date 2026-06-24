import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@kici-dev/core';
import { runLocalCommand, runRemoteCommand, buildTargetSelector } from './run.js';

// Shared mock PlatformRunClient instance -- all tests configure this
const mockClient = {
  initUpload: vi.fn(),
  trigger: vi.fn(),
  runStatus: vi.fn(),
  runLogs: vi.fn(),
  cancel: vi.fn(),
};

// Mock local executor
const mockExecuteLocal = vi.fn();
vi.mock('../local-executor/index.js', () => ({
  get executeLocal() {
    return mockExecuteLocal;
  },
}));

// Mock dependencies
vi.mock('../remote/config.js', () => ({
  loadGlobalConfig: vi.fn(),
}));

// Capture constructor args so tests can assert org/cluster targeting.
const platformClientConfigs: Record<string, unknown>[] = [];
vi.mock('../remote/platform-client.js', () => {
  class MockPlatformRunClient {
    constructor(config: Record<string, unknown>) {
      platformClientConfigs.push(config);
      return mockClient;
    }
  }
  return {
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
  };
});

vi.mock('../remote/output/summary.js', () => ({
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

vi.mock('../remote/uploader.js', () => ({
  createOverlayTarball: vi.fn(),
  getSizeWarning: vi.fn().mockReturnValue(null),
  uploadTarball: vi.fn(),
}));

vi.mock('../remote/secret-upload.js', () => ({
  buildEncryptedSecrets: vi.fn().mockResolvedValue(null),
}));

// Mock node:fs/promises readFile for inline lock file tests
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

// Suppress logger output in tests
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
};

describe('kici run command', () => {
  let loadGlobalConfig: ReturnType<typeof vi.fn>;
  let compileFixtures: ReturnType<typeof vi.fn>;
  let filterFixtures: ReturnType<typeof vi.fn>;
  let createOverlayTarball: ReturnType<typeof vi.fn>;
  let uploadTarball: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    platformClientConfigs.length = 0;

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
    uploadTarball = uploaderMod.uploadTarball as ReturnType<typeof vi.fn>;

    // Default: authenticated, org-targeted config
    loadGlobalConfig.mockResolvedValue({
      pat: 'test-pat',
      platformEndpoint: 'https://api.kici.dev',
      activeOrgId: 'org_a',
    });

    createOverlayTarball.mockResolvedValue(overlay);
    mockReadFile.mockResolvedValue('{"schemaVersion":4}');

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

    mockExecuteLocal.mockResolvedValue(true);
  });

  describe('runLocalCommand', () => {
    it('calls executeLocal with correct options', async () => {
      const options = { event: 'push', workflow: 'ci', kiciDir: '.kici' };
      const result = await runLocalCommand(options);
      expect(result).toBe(true);
      expect(mockExecuteLocal).toHaveBeenCalledWith(options);
    });

    it('returns false when executeLocal fails', async () => {
      mockExecuteLocal.mockResolvedValue(false);
      expect(await runLocalCommand({ event: 'push' })).toBe(false);
    });
  });

  const fixture = {
    id: 'push-main',
    sourceFile: '/mock/.kici/tests/push.ts',
    fixture: { id: 'push-main', options: { event: { _type: 'push' }, branch: 'main' } },
  };

  describe('runRemoteCommand — Platform-first flow', () => {
    it('lists available fixtures when no arguments given', async () => {
      compileFixtures.mockResolvedValue([fixture]);
      const result = await runRemoteCommand(undefined, { kiciDir: '.kici' });
      expect(result).toBe(true);
      expect(compileFixtures).toHaveBeenCalled();
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
          // Overlay-tarball key is always sent (independent of secrets) so the
          // orchestrator can decrypt the overlay.
          cliPublicKey: Buffer.from('clipubkey').toString('base64'),
          // Every run-remote uploads the full local working tree.
          fullRepo: true,
        }),
      );
      // PlatformRunClient built against the configured Platform endpoint + PAT.
      expect(platformClientConfigs[0]).toEqual({
        platformEndpoint: 'https://api.kici.dev',
        token: 'test-pat',
      });
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
        platformEndpoint: 'https://api.kici.dev',
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
        platformEndpoint: 'https://api.kici.dev',
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
        fixture: { id: 'pr-open', options: { event: { _type: 'pr' }, branch: 'feature' } },
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
      // Second poll uses the advanced cursor from the first nextCursor.
      expect(mockClient.runLogs).toHaveBeenNthCalledWith(
        1,
        'org_a',
        'run-123',
        0,
        expect.anything(),
      );
      expect(mockClient.runLogs).toHaveBeenNthCalledWith(
        2,
        'org_a',
        'run-123',
        1,
        expect.anything(),
      );
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
      expect(createOverlayTarball).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ fullWorkingTree: true }),
      );
    });

    it('sends inlineLockFile, fullRepo, and the overlay key even WITH a remote', async () => {
      // overlay default mock = hasRemote: true → proves the uniform behavior.
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
      // The overlay now includes `.git`, so the message states git steps work
      // (no "will fail" warning).
      const infoCalls = vi.mocked(logger.info).mock.calls.map((c) => String(c[0]));
      expect(infoCalls.some((line) => line.includes('local working tree'))).toBe(true);
      expect(infoCalls.some((line) => line.includes('git steps work'))).toBe(true);
    });
  });
});
