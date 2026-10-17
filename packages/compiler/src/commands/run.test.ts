import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@kici-dev/core';
import {
  runRemoteCommand,
  buildTargetSelector,
  buildDispatchInputs,
  lookupDispatchInputsDescriptor,
  describeMissingWorkflow,
  requestRunCancel,
  watchRunHolds,
  withStdoutOnStderr,
} from './run.js';

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
  getSizeWarning: vi.fn().mockReturnValue(null),
  uploadTarball: vi.fn(),
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
      // fails-when: a rejected direct trigger prints "Run started" and polls a run that never existed.
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
      expect(mockClient.runLogs).toHaveBeenNthCalledWith(
        1,
        'org_a',
        'run-123',
        { cursor: 0, logCursor: '' },
        expect.anything(),
      );
      // breaks-if-wrong: an older Platform or orchestrator keeps working
      expect(mockClient.runLogs).toHaveBeenNthCalledWith(
        2,
        'org_a',
        'run-123',
        { cursor: 1 },
        expect.anything(),
      );
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
      expect(mockClient.runLogs).toHaveBeenNthCalledWith(
        2,
        'org_a',
        'run-123',
        { cursor: 1, logCursor: 'c1' },
        expect.anything(),
      );
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
      expect(mockClient.runLogs).toHaveBeenNthCalledWith(
        2,
        'org_a',
        'run-123',
        { cursor: 0, logCursor: '' },
        expect.anything(),
      );
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
      // The overlay includes `.git`, so git steps work.
      const infoCalls = vi.mocked(logger.info).mock.calls.map((c) => String(c[0]));
      expect(infoCalls.some((line) => line.includes('local working tree'))).toBe(true);
      expect(infoCalls.some((line) => line.includes('git steps work'))).toBe(true);
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
