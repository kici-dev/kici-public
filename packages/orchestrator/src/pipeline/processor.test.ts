import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @kici-dev/shared to intercept logger calls for the
// multi-provider fallback log-level elevation tests (Plan 28.6.2-07 Task 3).
const { mockPipelineLogger } = vi.hoisted(() => {
  const mockPipelineLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { mockPipelineLogger };
});

vi.mock('@kici-dev/shared', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    createLogger: () => mockPipelineLogger,
  };
});

import {
  EventLogStatus,
  ExecutionJobStatus,
  InitFailureCategory,
  installGateJobId,
  LockFileParseError,
  SCHEMA_VERSION,
} from '@kici-dev/engine';
import { AgentJobFailedError } from '../cache/agent-job-failed-error.js';
import {
  processWebhook,
  anyTriggerHasPathPatterns,
  resolveLockFileWithFallback,
  storePendingJobContext,
  consumePendingJobContext,
  dispatchReadyJob,
  cleanupPendingJobContexts,
  restorePendingJobContexts,
  clearPendingJobContextsMap,
  trackEvalGate,
  openEvalGate,
  isEvalGatePending,
  clearEvalGatesForRun,
  extractDefaultBranch,
  hasPendingHold,
  PENDING_HOLD_READ_ATTEMPTS,
  summarizeDecision,
  DECISION_TRACE_MAX_CHECKS,
  capDecisionSummaries,
  DECISION_TRACE_MAX_BYTES,
  type ProcessingDeps,
} from './processor.js';
import type { WorkflowDecision } from '@kici-dev/engine';
import type { WebhookInfo } from '../webhook/handler.js';
import type { ProviderBundle } from '../provider-registry.js';
import { ProviderRegistry } from '../provider-registry.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';
import { HeldRunStatus } from '../contexts/held-runs.js';

// -- Mock helpers --

function createMockDedup(options: { exists?: boolean } = {}) {
  const alreadySeen = options.exists ?? false;
  return {
    exists: vi.fn().mockResolvedValue(alreadySeen),
    mark: vi.fn().mockResolvedValue(undefined),
    // The pipeline dedups via the atomic claim: it wins (true) for a fresh
    // delivery and loses (false) when the delivery already exists (duplicate).
    claim: vi.fn().mockResolvedValue(!alreadySeen),
    cleanup: vi.fn().mockResolvedValue(0),
  };
}

function createMockLockFileCache(lockFile: unknown = null) {
  return {
    get: vi.fn().mockResolvedValue(lockFile),
    getStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0 }),
  };
}

function createMockDispatcher() {
  return {
    dispatch: vi.fn().mockResolvedValue({ status: 'dispatched', agentId: 'agent-1', jobId: 'j1' }),
    onAgentAvailable: vi.fn().mockResolvedValue(undefined),
    onAgentDisconnect: vi.fn().mockResolvedValue(undefined),
    onJobComplete: vi.fn(),
  };
}

function createMockPlatformClient() {
  return {
    send: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    state: 'authenticated' as const,
    getBufferedCount: vi.fn().mockReturnValue(0),
    getReconnectDelay: vi.fn().mockReturnValue(1000),
  };
}

function createMockProviderBundle(): ProviderBundle {
  return {
    normalizer: {
      provider: 'github' as const,
      extractRoutingKey: vi.fn().mockReturnValue('github:12345'),
      extractDeliveryId: vi.fn().mockReturnValue('delivery-123'),
      extractEventType: vi.fn().mockReturnValue('pull_request'),
      verifySignature: vi.fn().mockReturnValue(true),
      normalizeEvent: vi.fn().mockImplementation((eventType, action, payload) => {
        const p = payload as Record<string, unknown>;
        if (eventType === 'pull_request') {
          const pr = p.pull_request as
            | {
                base?: { ref?: string };
                head?: { ref?: string };
              }
            | undefined;
          return {
            type: 'pull_request' as const,
            action: action ?? undefined,
            targetBranch: pr?.base?.ref ?? 'main',
            sourceBranch: pr?.head?.ref,
            baseBranch: pr?.base?.ref ?? 'main',
            payload: p,
            provider: 'github' as const,
          };
        }
        if (eventType === 'push') {
          const ref = p.ref as string | undefined;
          if (!ref) return null;
          const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
          return {
            type: 'push' as const,
            targetBranch: branch,
            payload: p,
            provider: 'github' as const,
          };
        }
        return null;
      }),
      extractRepoIdentifier: vi.fn().mockImplementation((payload: unknown) => {
        const p = payload as Record<string, unknown>;
        const repo = p.repository as { full_name?: string } | undefined;
        return repo?.full_name ?? null;
      }),
      extractRef: vi.fn().mockImplementation((eventType: string, payload: unknown) => {
        const p = payload as Record<string, unknown>;
        if (eventType === 'push') return (p.after as string) ?? 'HEAD';
        if (
          eventType === 'pull_request' ||
          eventType === 'pull_request_review' ||
          eventType === 'pull_request_review_comment'
        ) {
          const pr = p.pull_request as { head?: { sha?: string } } | undefined;
          return pr?.head?.sha ?? 'HEAD';
        }
        return 'HEAD';
      }),
      extractCredentials: vi.fn().mockImplementation((payload: unknown) => {
        const p = payload as Record<string, unknown>;
        const installation = p.installation as Record<string, unknown> | undefined;
        const installationId =
          installation && typeof installation.id === 'number' ? installation.id : null;
        return { installationId };
      }),
    },
    lockFileFetcher: {
      provider: 'github' as const,
      fetchLockFile: vi.fn().mockResolvedValue(null),
    },
    changedFilesFetcher: {
      provider: 'github' as const,
      getChangedFiles: vi
        .fn()
        .mockResolvedValue({ files: ['src/app.ts', 'src/index.ts'], status: 'fetched' }),
    },
    cloneTokenProvider: {
      provider: 'github' as const,
      createCloneToken: vi.fn().mockResolvedValue('ghs_token123'),
    },
    repoUrlBuilder: {
      provider: 'github' as const,
      buildCloneUrl: vi.fn().mockImplementation((id: string) => `https://github.com/${id}.git`),
      buildRawFileUrl: vi
        .fn()
        .mockImplementation(
          (id: string, ref: string, path: string) => `https://github.com/${id}/raw/${ref}/${path}`,
        ),
    },
  };
}

function createMockProviderRegistry(bundle?: ProviderBundle): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register('github', bundle ?? createMockProviderBundle());
  return registry;
}

function basePrInfo(overrides: Partial<WebhookInfo> = {}): WebhookInfo {
  return {
    routingKey: 'github:12345',
    deliveryId: 'delivery-123',
    event: 'pull_request',
    action: 'opened',
    provider: 'github',
    payload: {
      action: 'opened',
      repository: { full_name: 'myorg/myrepo', owner: { login: 'myorg' }, name: 'myrepo' },
      pull_request: {
        base: { ref: 'main' },
        head: { ref: 'feature/auth', sha: 'abc123' },
        number: 1,
      },
      installation: { id: 42 },
    },
    ...overrides,
  };
}

function basePushInfo(overrides: Partial<WebhookInfo> = {}): WebhookInfo {
  return {
    routingKey: 'github:12345',
    deliveryId: 'delivery-456',
    event: 'push',
    action: null,
    provider: 'github',
    payload: {
      ref: 'refs/heads/main',
      repository: { full_name: 'myorg/myrepo', owner: { login: 'myorg' }, name: 'myrepo' },
      before: 'aaa',
      after: 'bbb',
      installation: { id: 42 },
    },
    ...overrides,
  };
}

function matchingLockFile() {
  return {
    schemaVersion: 1,
    source: { file: '.kici/workflows/ci.ts', export: '#default' },
    contentHash: 'test-hash',
    workflows: [
      {
        name: 'CI',
        triggers: [
          {
            _type: 'pr',
            events: ['opened', 'synchronize'],
            targetBranches: [],
            sourceBranches: [],
            paths: [],
          },
        ],
        jobs: [
          {
            _type: 'static',
            name: 'build',
            runsOn: [{ kind: 'exact', value: 'linux' }],
            needs: [],
            steps: [{ name: 'Build', hasOutputs: false }],
          },
          {
            _type: 'static',
            name: 'test',
            runsOn: [{ kind: 'exact', value: 'linux' }],
            needs: [],
            steps: [{ name: 'Test', hasOutputs: false }],
          },
        ],
      },
    ],
  };
}

function noMatchLockFile() {
  return {
    schemaVersion: 1,
    source: { file: '.kici/workflows/ci.ts', export: '#default' },
    contentHash: 'test-hash',
    workflows: [
      {
        name: 'Deploy',
        triggers: [
          {
            _type: 'push',
            branches: [{ type: 'glob', pattern: 'release/*' }],
            paths: [],
          },
        ],
        jobs: [
          {
            _type: 'static',
            name: 'deploy',
            runsOn: [{ kind: 'exact', value: 'linux' }],
            needs: [],
            steps: [{ name: 'Deploy', hasOutputs: false }],
          },
        ],
      },
    ],
  };
}

function createMockCheckRunReporter() {
  return {
    setPending: vi.fn(),
    setPendingAwait: vi.fn().mockResolvedValue(undefined),
    updateJobStatus: vi.fn(),
    updateWorkflowStatus: vi.fn(),
  };
}

function createMockAgentRegistry(
  agents: Array<{ platform: string; arch: string }> = [{ platform: 'linux', arch: 'x64' }],
) {
  return {
    findAvailable: vi.fn().mockReturnValue(agents),
    get: vi.fn(),
    getByWs: vi.fn(),
    getActiveCount: vi.fn().mockReturnValue(agents.length),
  };
}

function createDeps(overrides: Partial<ProcessingDeps> = {}): ProcessingDeps {
  return {
    dedup: createMockDedup(),
    providerRegistry: createMockProviderRegistry(),
    lockFileCache: createMockLockFileCache(matchingLockFile()) as any,
    dispatcher: createMockDispatcher() as any,
    platformClient: createMockPlatformClient() as any,
    ...overrides,
  };
}

// -- Processor tests --

describe('processWebhook', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches jobs for matching trigger', async () => {
    const deps = createDeps();
    await processWebhook(basePrInfo(), deps);

    // 2 static jobs dispatched
    expect(deps.dispatcher.dispatch).toHaveBeenCalledTimes(2);

    // Verify job input shape has provider and providerContext (not installationId)
    const firstCall = (deps.dispatcher.dispatch as any).mock.calls[0][0];
    expect(firstCall.workflowName).toBe('CI');
    expect(firstCall.jobName).toBe('build');
    expect(firstCall.runsOnLabels).toEqual(['linux']);
    expect(firstCall.deliveryId).toBe('delivery-123');
    expect(firstCall.provider).toBe('github');
    expect(firstCall.providerContext).toEqual({ installationId: 42 });
    // Verify repoUrl is built via repoUrlBuilder
    expect(firstCall.repoUrl).toBe('https://github.com/myorg/myrepo.git');
    // Verify the normalized event envelope is passed through for agent-side
    // rule evaluation (raw provider payload nested at event.payload).
    expect(firstCall.jobConfig.event).toBeDefined();
    expect(typeof firstCall.jobConfig.event).toBe('object');
    expect((firstCall.jobConfig.event as { payload?: unknown }).payload).toBeDefined();
  });

  it('dispatches PR jobs with source branch ref (not target branch)', async () => {
    const deps = createDeps();
    await processWebhook(basePrInfo(), deps);

    // PR base is "main" (target), head is "feature/auth" (source)
    const firstCall = (deps.dispatcher.dispatch as any).mock.calls[0][0];
    expect(firstCall.ref).toBe('feature/auth'); // source branch, not "main"
    expect(firstCall.sha).toBe('abc123'); // head SHA
  });

  it('expands a static matrix job into N dispatches each carrying matrixValues', async () => {
    const deps = createDeps({
      lockFileCache: createMockLockFileCache({
        schemaVersion: 1,
        source: { file: '.kici/workflows/ci.ts', export: '#default' },
        contentHash: 'test-hash',
        workflows: [
          {
            name: 'CI',
            triggers: [
              {
                _type: 'pr',
                events: ['opened'],
                targetBranches: [],
                sourceBranches: [],
                paths: [],
              },
            ],
            jobs: [
              {
                _type: 'static',
                name: 'test',
                runsOn: [{ kind: 'exact', value: 'linux' }],
                needs: [],
                steps: [{ name: 'Test', hasOutputs: false }],
                matrix: { _type: 'static', values: { variant: ['a', 'b'] } },
              },
            ],
          },
        ],
      }) as any,
    });
    await processWebhook(basePrInfo(), deps);

    // One matrix job with two combinations => two dispatches.
    expect(deps.dispatcher.dispatch).toHaveBeenCalledTimes(2);
    const calls = (deps.dispatcher.dispatch as any).mock.calls.map((c: any[]) => c[0]);
    const byName = Object.fromEntries(calls.map((c: any) => [c.jobName, c]));

    expect(Object.keys(byName).sort()).toEqual(['test (a)', 'test (b)']);
    for (const [expandedName, variant] of [
      ['test (a)', 'a'],
      ['test (b)', 'b'],
    ] as const) {
      const call = byName[expandedName];
      expect(call.jobName).toBe(expandedName);
      // The dispatch envelope carries matrixValues + baseJobName, NOT the raw matrix.
      expect(call.jobConfig.matrixValues).toEqual({ variant });
      expect(call.jobConfig.baseJobName).toBe('test');
      expect(call.jobConfig.name).toBe(expandedName);
      expect(call.jobConfig.matrix).toBeUndefined();
      expect(call.jobConfig.include).toBeUndefined();
      expect(call.jobConfig.exclude).toBeUndefined();
    }
  });

  it('feeds matrixValues into the execution tracker per matrix child', async () => {
    const onExecutionStarted = vi.fn().mockResolvedValue(undefined);
    // The run is registered before the dispatch loop, so its jobs land in
    // `addJobsToRun` rather than in the `onExecutionStarted` call.
    const addJobsToRun = vi.fn().mockResolvedValue(undefined);
    const deps = createDeps({
      executionTracker: {
        onExecutionStarted,
        addJobsToRun,
        holdRunForPendingJobs: vi.fn(() => true),
        releasePendingJobsHold: vi.fn(),
      } as any,
      lockFileCache: createMockLockFileCache({
        schemaVersion: 1,
        source: { file: '.kici/workflows/ci.ts', export: '#default' },
        contentHash: 'test-hash',
        workflows: [
          {
            name: 'CI',
            triggers: [
              {
                _type: 'pr',
                events: ['opened'],
                targetBranches: [],
                sourceBranches: [],
                paths: [],
              },
            ],
            jobs: [
              {
                _type: 'static',
                name: 'test',
                runsOn: [{ kind: 'exact', value: 'linux' }],
                needs: [],
                steps: [{ name: 'Test', hasOutputs: false }],
                matrix: { _type: 'static', values: ['a', 'b'] },
              },
            ],
          },
        ],
      }) as any,
    });
    await processWebhook(basePrInfo(), deps);

    expect(onExecutionStarted).toHaveBeenCalledTimes(1);
    expect(addJobsToRun).toHaveBeenCalledTimes(1);
    const dispatchedArg = addJobsToRun.mock.calls[0][1] as Array<{
      jobName: string;
      matrixValues?: Record<string, unknown>;
    }>;
    const tracked = Object.fromEntries(dispatchedArg.map((j) => [j.jobName, j.matrixValues]));
    expect(tracked['test (a)']).toEqual({ value: 'a' });
    expect(tracked['test (b)']).toEqual({ value: 'b' });
  });

  it('dispatches push jobs with target branch ref', async () => {
    const deps = createDeps({
      lockFileCache: createMockLockFileCache({
        schemaVersion: 1,
        source: { file: '.kici/workflows/ci.ts', export: '#default' },
        workflows: [
          {
            name: 'CI',
            triggers: [{ _type: 'push', branches: [], paths: [] }],
            jobs: [
              {
                _type: 'static',
                name: 'build',
                runsOn: [{ kind: 'exact', value: 'linux' }],
                needs: [],
                steps: [{ name: 'Build', hasOutputs: false }],
              },
            ],
          },
        ],
      }) as any,
    });
    await processWebhook(basePushInfo(), deps);

    const firstCall = (deps.dispatcher.dispatch as any).mock.calls[0][0];
    expect(firstCall.ref).toBe('main'); // push: targetBranch (no sourceBranch)
    expect(firstCall.sha).toBe('bbb'); // payload.after
  });

  it('skips with no matching trigger (metrics updated)', async () => {
    const deps = createDeps({
      lockFileCache: createMockLockFileCache(noMatchLockFile()) as any,
    });
    await processWebhook(basePrInfo(), deps);

    // No dispatch -- push-only triggers won't match PR event
    expect(deps.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('skips silently when lock file is missing', async () => {
    const deps = createDeps({
      lockFileCache: createMockLockFileCache(null) as any,
    });
    await processWebhook(basePrInfo(), deps);

    expect(deps.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('skips when provider is not registered', async () => {
    const emptyRegistry = new ProviderRegistry();
    const deps = createDeps({ providerRegistry: emptyRegistry });
    await processWebhook(basePrInfo(), deps);

    expect(deps.lockFileCache.get).not.toHaveBeenCalled();
    expect(deps.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns immediately on dedup hit', async () => {
    const deps = createDeps({
      dedup: createMockDedup({ exists: true }) as any,
    });
    await processWebhook(basePrInfo(), deps);

    expect(deps.lockFileCache.get).not.toHaveBeenCalled();
    expect(deps.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('forwards decision trace via platformClient.send()', async () => {
    const deps = createDeps();
    await processWebhook(basePrInfo(), deps);

    expect(deps.platformClient!.send).toHaveBeenCalledTimes(1);
    const msg = (deps.platformClient!.send as any).mock.calls[0][0];
    expect(msg.type).toBe('execution.event');
    expect(msg.event).toBe('started');
    expect(msg.data.matchedWorkflows).toBe(1);
    expect(msg.data.repoIdentifier).toBe('myorg/myrepo');
  });

  it('buffers decision trace when platformClient is disconnected', async () => {
    const mockPlatform = createMockPlatformClient();
    (mockPlatform as any).state = 'disconnected';
    const deps = createDeps({ platformClient: mockPlatform as any });

    await processWebhook(basePrInfo(), deps);

    // send() is still called -- it handles buffering internally
    expect(mockPlatform.send).toHaveBeenCalledTimes(1);
  });

  it('dispatched job triggers dispatcher onDispatch callback', async () => {
    const mockDispatcher = createMockDispatcher();
    const deps = createDeps({ dispatcher: mockDispatcher as any });

    await processWebhook(basePrInfo(), deps);

    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(2);
    const firstResult = await mockDispatcher.dispatch.mock.results[0].value;
    expect(firstResult.status).toBe('dispatched');
  });

  it('skips unknown event type', async () => {
    const info: WebhookInfo = {
      routingKey: 'github:12345',
      deliveryId: 'delivery-789',
      event: 'issues',
      action: 'opened',
      provider: 'github',
      payload: {
        repository: { full_name: 'myorg/myrepo', owner: { login: 'myorg' }, name: 'myrepo' },
      },
    };
    const deps = createDeps();
    await processWebhook(info, deps);

    expect(deps.lockFileCache.get).not.toHaveBeenCalled();
    expect(deps.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('skips when no platformClient in independent mode', async () => {
    const deps = createDeps({ platformClient: undefined });
    await processWebhook(basePrInfo(), deps);

    // Jobs still dispatched
    expect(deps.dispatcher.dispatch).toHaveBeenCalledTimes(2);
  });

  it('handles push events correctly', async () => {
    const pushLockFile = {
      schemaVersion: 1,
      source: { file: '.kici/workflows/deploy.ts', export: '#default' },
      contentHash: 'test-hash',
      workflows: [
        {
          name: 'Deploy',
          triggers: [
            {
              _type: 'push',
              branches: [{ type: 'glob', pattern: 'main' }],
              paths: [],
            },
          ],
          jobs: [
            {
              _type: 'static',
              name: 'deploy',
              runsOn: [{ kind: 'exact', value: 'linux' }],
              needs: [],
              steps: [{ name: 'Deploy', hasOutputs: false }],
            },
          ],
        },
      ],
    };

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(pushLockFile) as any,
    });
    await processWebhook(basePushInfo(), deps);

    expect(deps.dispatcher.dispatch).toHaveBeenCalledTimes(1);
    const jobInput = (deps.dispatcher.dispatch as any).mock.calls[0][0];
    expect(jobInput.workflowName).toBe('Deploy');
    expect(jobInput.jobName).toBe('deploy');
    expect(jobInput.ref).toBe('main');
    expect(jobInput.provider).toBe('github');
    expect(jobInput.providerContext).toEqual({ installationId: 42 });
  });

  it('skips dynamic jobs (only dispatches static jobs)', async () => {
    const lockFileWithDynamic = {
      schemaVersion: 1,
      source: { file: '.kici/workflows/ci.ts', export: '#default' },
      contentHash: 'test-hash',
      workflows: [
        {
          name: 'CI',
          triggers: [
            {
              _type: 'pr',
              events: ['opened'],
              targetBranches: [],
              sourceBranches: [],
              paths: [],
            },
          ],
          jobs: [
            {
              _type: 'static',
              name: 'build',
              runsOn: [{ kind: 'exact', value: 'linux' }],
              needs: [],
              steps: [{ name: 'Build', hasOutputs: false }],
            },
            {
              _type: 'dynamic',
              source: { file: '.kici/workflows/ci.ts', index: 1 },
            },
          ],
        },
      ],
    };

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(lockFileWithDynamic) as any,
    });
    await processWebhook(basePrInfo(), deps);

    // Only 1 static job dispatched, dynamic skipped
    expect(deps.dispatcher.dispatch).toHaveBeenCalledTimes(1);
    const jobInput = (deps.dispatcher.dispatch as any).mock.calls[0][0];
    expect(jobInput.jobName).toBe('build');
  });

  it('dispatches dynamic eval job for dynamic-only workflow (no static jobs)', async () => {
    const dynamicOnlyLockFile = {
      schemaVersion: 1,
      source: { file: '.kici/workflows/infra.ts', export: '#default' },
      contentHash: 'dynamic-only-hash',
      workflows: [
        {
          name: 'dynamic-only-infra',
          triggers: [
            {
              _type: 'push',
              branches: [{ type: 'glob', pattern: 'main' }],
              paths: [],
            },
          ],
          jobs: [
            {
              _type: 'dynamic',
              source: { file: '.kici/workflows/infra.ts', index: 0 },
            },
          ],
        },
      ],
    };

    const mockPendingDynamics = {
      track: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves (fire-and-forget)
      resolve: vi.fn(),
      reject: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      cleanup: vi.fn(),
    };

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(dynamicOnlyLockFile) as any,
      pendingDynamics: mockPendingDynamics as any,
    });
    await processWebhook(basePushInfo(), deps);

    // Give fire-and-forget async task a tick to dispatch
    await new Promise((r) => setTimeout(r, 50));

    // Verify eval job was dispatched (dynamic-only workflow produces 1 dispatch)
    expect(deps.dispatcher.dispatch).toHaveBeenCalledTimes(1);
    const dispatchCall = (deps.dispatcher.dispatch as any).mock.calls[0][0];
    expect(dispatchCall.jobName).toBe('__dynamic__dynamic-only-infra__0');
    expect(dispatchCall.workflowName).toBe('dynamic-only-infra');
    expect(dispatchCall.runsOnLabels).toContain('kici:role:init-runner');
    expect(dispatchCall.jobConfig.dynamicJobFn).toBe(true);
    expect(dispatchCall.jobConfig.source).toEqual({ file: '.kici/workflows/infra.ts', index: 0 });
  });

  it('resolves a dynamic matrix via the init flow into N child dispatches', async () => {
    const matrixLockFile = {
      schemaVersion: 1,
      source: { file: '.kici/workflows/ci.ts', export: '#default' },
      contentHash: 'test-hash',
      workflows: [
        {
          name: 'CI',
          triggers: [
            { _type: 'pr', events: ['opened'], targetBranches: [], sourceBranches: [], paths: [] },
          ],
          jobs: [
            {
              _type: 'static',
              name: 'test',
              runsOn: [{ kind: 'exact', value: 'linux' }],
              needs: [],
              steps: [{ name: 'Test', hasOutputs: false }],
              matrix: {
                _type: 'dynamic',
                source: { file: '.kici/workflows/ci.ts', jobName: 'test' },
              },
            },
          ],
        },
      ],
    };

    const mockPendingInits = {
      track: vi.fn().mockResolvedValue({
        matrixValues: [{ variant: 'a' }, { variant: 'b' }],
      }),
      resolve: vi.fn(),
      reject: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      cleanup: vi.fn(),
    };

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(matrixLockFile) as any,
      pendingInits: mockPendingInits as any,
      executionTracker: makeDynamicTrackerMock() as any,
      db: createMockDb().db as any,
    });
    await processWebhook(basePrInfo(), deps);
    // Let the fire-and-forget deferred-init resolution run.
    await new Promise((r) => setTimeout(r, 50));

    const calls = (deps.dispatcher.dispatch as any).mock.calls.map((c: any[]) => c[0]);
    // 1 init eval dispatch + 2 resolved matrix children.
    const initCall = calls.find((c: any) => c.jobConfig?.initOnly === true);
    expect(initCall).toBeDefined();
    expect(initCall.jobConfig.dynamicMatrix).toBe(true);

    const childCalls = calls.filter((c: any) => c.jobName?.startsWith('test ('));
    const byName = Object.fromEntries(childCalls.map((c: any) => [c.jobName, c]));
    expect(Object.keys(byName).sort()).toEqual(['test (a)', 'test (b)']);
    expect(byName['test (a)'].jobConfig.matrixValues).toEqual({ variant: 'a' });
    expect(byName['test (b)'].jobConfig.matrixValues).toEqual({ variant: 'b' });
    expect(byName['test (a)'].jobConfig.matrix).toBeUndefined();
  });

  function dynamicOnlyLockFileFixture() {
    return {
      schemaVersion: 1,
      source: { file: '.kici/workflows/infra.ts', export: '#default' },
      contentHash: 'dynamic-only-hash',
      workflows: [
        {
          name: 'dynamic-only-infra',
          triggers: [{ _type: 'push', branches: [{ type: 'glob', pattern: 'main' }], paths: [] }],
          jobs: [{ _type: 'dynamic', source: { file: '.kici/workflows/infra.ts', index: 0 } }],
        },
      ],
    };
  }

  function makeDynamicTrackerMock() {
    return {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      onJobStatus: vi.fn().mockResolvedValue(undefined),
      onStepStatus: vi.fn(),
      updateJobHeartbeat: vi.fn(),
      getExecutionContext: vi.fn(),
      getJobName: vi.fn(),
      recordInitFailureRun: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('records matrix_expansion when the dynamic eval reject carries it', async () => {
    const mockTracker = makeDynamicTrackerMock();
    const mockPendingDynamics = {
      track: vi.fn().mockRejectedValue(
        new AgentJobFailedError('boom', {
          scope: 'job',
          category: InitFailureCategory.enum.matrix_expansion,
          message: 'boom',
          jobName: 'build',
        }),
      ),
      resolve: vi.fn(),
      reject: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      cleanup: vi.fn(),
    };

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(dynamicOnlyLockFileFixture()) as any,
      pendingDynamics: mockPendingDynamics as any,
      executionTracker: mockTracker as any,
    });
    await processWebhook(basePushInfo(), deps);
    await new Promise((r) => setTimeout(r, 50));

    expect(mockTracker.onJobStatus).toHaveBeenCalled();
    const failedCall = mockTracker.onJobStatus.mock.calls.find(
      (args: unknown[]) => args[2] === 'failed',
    );
    expect(failedCall).toBeDefined();
    const [, , , , , data] = failedCall as unknown[];
    expect(data).toMatchObject({
      initFailure: {
        scope: 'job',
        category: InitFailureCategory.enum.matrix_expansion,
        jobName: 'build',
      },
    });
  });

  it('falls back to dynamic_eval when the dynamic eval reject carries no category', async () => {
    const mockTracker = makeDynamicTrackerMock();
    const mockPendingDynamics = {
      track: vi.fn().mockRejectedValue(new AgentJobFailedError('boom')),
      resolve: vi.fn(),
      reject: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      cleanup: vi.fn(),
    };

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(dynamicOnlyLockFileFixture()) as any,
      pendingDynamics: mockPendingDynamics as any,
      executionTracker: mockTracker as any,
    });
    await processWebhook(basePushInfo(), deps);
    await new Promise((r) => setTimeout(r, 50));

    const failedCall = mockTracker.onJobStatus.mock.calls.find(
      (args: unknown[]) => args[2] === 'failed',
    );
    expect(failedCall).toBeDefined();
    const [, , , , , data] = failedCall as unknown[];
    expect(data).toMatchObject({
      initFailure: { scope: 'job', category: InitFailureCategory.enum.dynamic_eval },
    });
  });

  function genMatrixLockFileFixture(contentHash: string) {
    return {
      schemaVersion: 1,
      source: { file: '.kici/workflows/infra.ts', export: '#default' },
      contentHash,
      workflows: [
        {
          name: 'gen-matrix-infra',
          triggers: [{ _type: 'push', branches: [{ type: 'glob', pattern: 'main' }], paths: [] }],
          jobs: [{ _type: 'dynamic', source: { file: '.kici/workflows/infra.ts', index: 0 } }],
        },
      ],
    };
  }

  it('fans out a generated job with a static matrix into N child dispatches', async () => {
    // The agent's eval resolves to generated LockJob[]; one carries a static matrix.
    const generatedJobs = [
      {
        _type: 'static',
        name: 'gen-matrix',
        runsOn: [{ kind: 'exact', value: 'linux' }],
        needs: [],
        steps: [{ name: 'run', hasOutputs: false }],
        matrix: { _type: 'static', values: { variant: ['a', 'b'] } },
      },
      {
        _type: 'static',
        name: 'gen-plain',
        runsOn: [{ kind: 'exact', value: 'linux' }],
        needs: [],
        steps: [{ name: 'run', hasOutputs: false }],
      },
    ];

    const mockPendingDynamics = {
      track: vi.fn().mockResolvedValue(generatedJobs),
      resolve: vi.fn(),
      reject: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      cleanup: vi.fn(),
    };
    const mockTracker = makeDynamicTrackerMock();

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(genMatrixLockFileFixture('gen-matrix-hash')) as any,
      pendingDynamics: mockPendingDynamics as any,
      executionTracker: mockTracker as any,
      db: createMockDb().db as any,
    });
    await processWebhook(basePushInfo(), deps);
    await new Promise((r) => setTimeout(r, 50));

    const calls = (deps.dispatcher.dispatch as any).mock.calls.map((c: any[]) => c[0]);

    // Two matrix children, named with the combination suffix.
    const childCalls = calls.filter(
      (c: any) => typeof c.jobName === 'string' && c.jobName.startsWith('gen-matrix ('),
    );
    const byName = Object.fromEntries(childCalls.map((c: any) => [c.jobName, c]));
    expect(Object.keys(byName).sort()).toEqual(['gen-matrix (a)', 'gen-matrix (b)']);
    expect(byName['gen-matrix (a)'].jobConfig.matrixValues).toEqual({ variant: 'a' });
    expect(byName['gen-matrix (b)'].jobConfig.matrixValues).toEqual({ variant: 'b' });
    expect(byName['gen-matrix (a)'].jobConfig.baseJobName).toBe('gen-matrix');
    expect(byName['gen-matrix (a)'].jobConfig.matrix).toBeUndefined();

    // The non-matrix generated job passes through 1:1.
    expect(calls.some((c: any) => c.jobName === 'gen-plain')).toBe(true);

    // matrixValues are threaded into the execution tracker per child.
    const tracked = mockTracker.addJobsToRun.mock.calls.flatMap((c: any[]) => c[1]);
    const trackedMatrix = tracked.filter(
      (j: any) => typeof j.jobName === 'string' && j.jobName.startsWith('gen-matrix ('),
    );
    expect(
      trackedMatrix
        .map((j: any) => j.matrixValues)
        .sort((a: any, b: any) => (a.variant < b.variant ? -1 : 1)),
    ).toEqual([{ variant: 'a' }, { variant: 'b' }]);
  });

  it('records matrix_expansion for a generated job whose matrix exceeds the cap, dispatching the rest', async () => {
    // One generated job's matrix resolves to > MAX_FANOUT_JOBS (256) combinations.
    const overCap = Array.from({ length: 300 }, (_, i) => `v${i}`);
    const generatedJobs = [
      {
        _type: 'static',
        name: 'gen-bad',
        runsOn: [{ kind: 'exact', value: 'linux' }],
        needs: [],
        steps: [{ name: 'run', hasOutputs: false }],
        matrix: { _type: 'static', values: { variant: overCap } },
      },
      {
        _type: 'static',
        name: 'gen-good',
        runsOn: [{ kind: 'exact', value: 'linux' }],
        needs: [],
        steps: [{ name: 'run', hasOutputs: false }],
      },
    ];

    const mockPendingDynamics = {
      track: vi.fn().mockResolvedValue(generatedJobs),
      resolve: vi.fn(),
      reject: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      cleanup: vi.fn(),
    };
    const mockTracker = makeDynamicTrackerMock();

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(genMatrixLockFileFixture('gen-fail-hash')) as any,
      pendingDynamics: mockPendingDynamics as any,
      executionTracker: mockTracker as any,
      db: createMockDb().db as any,
    });
    await processWebhook(basePushInfo(), deps);
    await new Promise((r) => setTimeout(r, 50));

    const calls = (deps.dispatcher.dispatch as any).mock.calls.map((c: any[]) => c[0]);
    // The good generated job still dispatches.
    expect(calls.some((c: any) => c.jobName === 'gen-good')).toBe(true);
    // The bad job is not dispatched (no children).
    expect(
      calls.some((c: any) => typeof c.jobName === 'string' && c.jobName.startsWith('gen-bad')),
    ).toBe(false);

    // matrix_expansion failure recorded for the bad job.
    const failedCall = mockTracker.onJobStatus.mock.calls.find(
      (args: unknown[]) => args[2] === 'failed',
    );
    expect(failedCall).toBeDefined();
    const [, , , , , data] = failedCall as unknown[];
    expect(data).toMatchObject({
      initFailure: { category: InitFailureCategory.enum.matrix_expansion, jobName: 'gen-bad' },
    });
  });

  it('atomically claims the delivery id', async () => {
    const deps = createDeps();
    await processWebhook(basePrInfo(), deps);

    // Single atomic claim replaces the historic exists()-then-mark().
    expect(deps.dedup.claim).toHaveBeenCalledWith('delivery-123');
  });

  it('passes lock file fetcher to cache.get()', async () => {
    const bundle = createMockProviderBundle();
    const registry = createMockProviderRegistry(bundle);
    const deps = createDeps({ providerRegistry: registry });
    await processWebhook(basePrInfo(), deps);

    // Verify lockFileCache.get was called with the provider's fetcher
    expect(deps.lockFileCache.get).toHaveBeenCalledWith(
      bundle.lockFileFetcher,
      'myorg/myrepo',
      'abc123',
      { installationId: 42 },
    );
  });

  it('uses changedFilesFetcher from provider bundle when triggers have path patterns', async () => {
    const bundle = createMockProviderBundle();
    const registry = createMockProviderRegistry(bundle);
    // Lock file with path patterns triggers the changedFilesFetcher call
    const lockWithPaths = {
      schemaVersion: 1,
      source: { file: '.kici/workflows/ci.ts', export: '#default' },
      contentHash: 'test-hash',
      workflows: [
        {
          name: 'CI',
          triggers: [
            {
              _type: 'pr',
              events: ['opened', 'synchronize'],
              targetBranches: [],
              sourceBranches: [],
              paths: ['src/**'],
            },
          ],
          jobs: [
            {
              _type: 'static',
              name: 'build',
              runsOn: [{ kind: 'exact', value: 'linux' }],
              needs: [],
              steps: [{ name: 'Build', hasOutputs: false }],
            },
          ],
        },
      ],
    };
    const deps = createDeps({
      providerRegistry: registry,
      lockFileCache: createMockLockFileCache(lockWithPaths) as any,
    });
    await processWebhook(basePrInfo(), deps);

    expect(bundle.changedFilesFetcher.getChangedFiles).toHaveBeenCalledWith(
      'myorg/myrepo',
      'pull_request',
      expect.any(Object),
      { installationId: 42 },
    );
  });

  it('skips changedFilesFetcher when no triggers have path patterns', async () => {
    const bundle = createMockProviderBundle();
    const registry = createMockProviderRegistry(bundle);
    // Default matchingLockFile has empty paths arrays
    const deps = createDeps({ providerRegistry: registry });
    await processWebhook(basePrInfo(), deps);

    expect(bundle.changedFilesFetcher.getChangedFiles).not.toHaveBeenCalled();
  });

  it('unavailable changed files → path-filtered workflow still matches, event-log row is annotated', async () => {
    const bundle = createMockProviderBundle();
    // Fetcher reports the diff is unavailable (e.g. a provider capability gap).
    (bundle.changedFilesFetcher.getChangedFiles as any).mockResolvedValue({
      files: [],
      status: 'unavailable',
    });
    const registry = createMockProviderRegistry(bundle);
    const lockWithPaths = {
      schemaVersion: 1,
      source: { file: '.kici/workflows/ci.ts', export: '#default' },
      contentHash: 'test-hash',
      workflows: [
        {
          name: 'CI',
          triggers: [
            {
              _type: 'pr',
              events: ['opened', 'synchronize'],
              targetBranches: [],
              sourceBranches: [],
              paths: ['src/**'],
            },
          ],
          jobs: [
            {
              _type: 'static',
              name: 'build',
              runsOn: [{ kind: 'exact', value: 'linux' }],
              needs: [],
              steps: [{ name: 'Build', hasOutputs: false }],
            },
          ],
        },
      ],
    };
    const mockEventLog = { record: vi.fn().mockResolvedValue(undefined) };
    const deps = createDeps({
      providerRegistry: registry,
      lockFileCache: createMockLockFileCache(lockWithPaths) as any,
      eventLog: mockEventLog as any,
    });

    await processWebhook(basePrInfo(), deps);

    // Conservative match: the path-filtered workflow ran despite an empty diff.
    expect(deps.dispatcher.dispatch).toHaveBeenCalled();
    // The processed event-log row carries the degraded annotation (not a silent
    // processed / matched 0).
    expect(mockEventLog.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        status: 'processed',
        errorMessage: expect.stringContaining('changed files unavailable'),
      }),
    );
  });

  it('uses repoUrlBuilder from provider bundle for clone URL', async () => {
    const bundle = createMockProviderBundle();
    const registry = createMockProviderRegistry(bundle);
    const deps = createDeps({ providerRegistry: registry });
    await processWebhook(basePrInfo(), deps);

    expect(bundle.repoUrlBuilder.buildCloneUrl).toHaveBeenCalledWith('myorg/myrepo');
  });

  // -- Commit status integration tests --

  it('calls checkRunReporter.setPendingAwait() on matching workflow', async () => {
    const mockReporter = createMockCheckRunReporter();
    const deps = createDeps({ checkRunReporter: mockReporter as any });
    await processWebhook(basePrInfo(), deps);

    expect(mockReporter.setPendingAwait).toHaveBeenCalledTimes(1);
    expect(mockReporter.setPendingAwait).toHaveBeenCalledWith({
      provider: 'github',
      owner: 'myorg',
      repo: 'myrepo',
      sha: 'abc123',
      workflowName: 'CI',
      jobNames: ['build', 'test'],
      installationId: 42,
      routingKey: 'github:12345',
      runId: expect.any(String),
      requestId: undefined,
    });
  });

  it('calls checkRunReporter.setPendingAwait() BEFORE dispatcher.dispatch()', async () => {
    const callOrder: string[] = [];

    const mockReporter = createMockCheckRunReporter();
    mockReporter.setPendingAwait.mockImplementation(async () => {
      callOrder.push('setPendingAwait');
    });

    const mockDispatcher = createMockDispatcher();
    mockDispatcher.dispatch.mockImplementation(() => {
      callOrder.push('dispatch');
      return Promise.resolve({ status: 'dispatched', agentId: 'a1', jobId: 'j1' });
    });

    const deps = createDeps({
      checkRunReporter: mockReporter as any,
      dispatcher: mockDispatcher as any,
    });
    await processWebhook(basePrInfo(), deps);

    // setPendingAwait should appear before any dispatch calls
    const pendingIndex = callOrder.indexOf('setPendingAwait');
    const firstDispatchIndex = callOrder.indexOf('dispatch');
    expect(pendingIndex).toBeLessThan(firstDispatchIndex);
  });

  it('does not call checkRunReporter when no workflows match', async () => {
    const mockReporter = createMockCheckRunReporter();
    const deps = createDeps({
      lockFileCache: createMockLockFileCache(noMatchLockFile()) as any,
      checkRunReporter: mockReporter as any,
    });
    await processWebhook(basePrInfo(), deps);

    expect(mockReporter.setPendingAwait).not.toHaveBeenCalled();
  });

  it('does not call checkRunReporter when not provided', async () => {
    // Default deps have no checkRunReporter -- should work without it
    const deps = createDeps();
    await processWebhook(basePrInfo(), deps);

    // No error thrown -- pipeline works without checkRunReporter
    expect(deps.dispatcher.dispatch).toHaveBeenCalledTimes(2);
  });

  it('calls checkRunReporter.setPending() with correct push event data', async () => {
    const pushLockFile = {
      schemaVersion: 1,
      source: { file: '.kici/workflows/deploy.ts', export: '#default' },
      contentHash: 'test-hash',
      workflows: [
        {
          name: 'Deploy',
          triggers: [
            {
              _type: 'push',
              branches: [{ type: 'glob', pattern: 'main' }],
              paths: [],
            },
          ],
          jobs: [
            {
              _type: 'static',
              name: 'deploy',
              runsOn: [{ kind: 'exact', value: 'linux' }],
              needs: [],
              steps: [{ name: 'Deploy', hasOutputs: false }],
            },
          ],
        },
      ],
    };

    const mockReporter = createMockCheckRunReporter();
    const deps = createDeps({
      lockFileCache: createMockLockFileCache(pushLockFile) as any,
      checkRunReporter: mockReporter as any,
    });
    await processWebhook(basePushInfo(), deps);

    expect(mockReporter.setPendingAwait).toHaveBeenCalledWith({
      provider: 'github',
      owner: 'myorg',
      repo: 'myrepo',
      sha: 'bbb',
      workflowName: 'Deploy',
      jobNames: ['deploy'],
      installationId: 42,
      routingKey: 'github:12345',
      runId: expect.any(String),
      requestId: undefined,
    });
  });

  // -- Execution tracker integration tests (regression for C-1: executionTracker was omitted) --

  it('calls executionTracker.onExecutionStarted() when provided', async () => {
    const mockTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
      onJobStatus: vi.fn(),
      onStepStatus: vi.fn(),
      updateJobHeartbeat: vi.fn(),
      getExecutionContext: vi.fn(),
      getJobName: vi.fn(),
    };
    const deps = createDeps({ executionTracker: mockTracker as any });
    await processWebhook(basePrInfo(), deps);

    // 2 static jobs dispatched, so onExecutionStarted should be called once per workflow
    expect(mockTracker.onExecutionStarted).toHaveBeenCalledTimes(1);
    expect(mockTracker.onExecutionStarted).toHaveBeenCalledWith(
      expect.any(String), // runId
      'CI', // workflowName
      'github', // provider
      'myorg/myrepo', // repoIdentifier
      'main', // branch (target branch for context)
      'abc123', // sha
      'delivery-123', // deliveryId
      { installationId: 42 }, // credentials
      expect.any(Object), // decision summary
      // The run is registered before the dispatch loop, so it starts with no
      // jobs; they arrive through `addJobsToRun` once every dispatch returned.
      [], // dispatchedJobs
      'github:12345', // routingKey
      undefined, // dispatchedContexts (no contexts declared)
      expect.any(String), // triggerEvent
      undefined, // commitMessage (no head_commit in test fixture)
      undefined, // parentRunId
      undefined, // triggeredBy
      undefined, // originalRunId
      undefined, // concurrency (no concurrency config in test workflow)
      undefined, // workflowTimeoutMs (no timeout config in test workflow)
      undefined, // checkMode (apply mode — no check-mode override in test fixture)
      false, // localWorkingTree (github webhook, not a `kici run remote` upload)
      undefined, // triggerActorUsername (no sender in the test PR fixture)
      undefined, // triggerActorUserId (no sender in the test PR fixture)
      undefined, // triggeredByAgentLabel (webhook-triggered, not agent)
      null, // prNumber (no PR number in the test fixture)
    );
    expect(mockTracker.addJobsToRun).toHaveBeenCalledTimes(1);
    expect(mockTracker.addJobsToRun.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jobName: 'build' }),
        expect.objectContaining({ jobName: 'test' }),
      ]),
    );
  });

  it('passes workflow concurrency config to executionTracker', async () => {
    const lockFile = matchingLockFile();
    // Add concurrency config to the workflow
    (lockFile.workflows[0] as any).concurrency = {
      hasGroup: true,
      cancelInProgress: false,
      max: 3,
    };
    const mockTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
      onJobStatus: vi.fn(),
      onStepStatus: vi.fn(),
      updateJobHeartbeat: vi.fn(),
      getExecutionContext: vi.fn(),
      getJobName: vi.fn(),
    };
    const deps = createDeps({
      executionTracker: mockTracker as any,
      lockFileCache: createMockLockFileCache(lockFile) as any,
    });
    await processWebhook(basePrInfo(), deps);

    expect(mockTracker.onExecutionStarted).toHaveBeenCalledTimes(1);
    const call = mockTracker.onExecutionStarted.mock.calls[0];
    // Index from the FRONT of the (long) onExecutionStarted signature so this
    // assertion survives new trailing optional args (e.g. localWorkingTree).
    // See execution-tracker.ts onExecutionStarted(): concurrency is arg 17,
    // workflowTimeoutMs 18, checkMode 19.
    const CONCURRENCY_ARG = 17;
    expect(call[CONCURRENCY_ARG]).toEqual({ cancelInProgress: false, max: 3 });
    expect(call[CONCURRENCY_ARG + 1]).toBeUndefined(); // workflowTimeoutMs
    expect(call[CONCURRENCY_ARG + 2]).toBeUndefined(); // checkMode
  });

  it('does not call executionTracker when not provided', async () => {
    // Default deps have no executionTracker -- should work without it
    const deps = createDeps({ executionTracker: undefined });
    await processWebhook(basePrInfo(), deps);

    // No error thrown -- pipeline works without executionTracker
    expect(deps.dispatcher.dispatch).toHaveBeenCalledTimes(2);
  });

  it('only includes static job names in setPending (skips dynamic)', async () => {
    const lockFileWithDynamic = {
      schemaVersion: 1,
      source: { file: '.kici/workflows/ci.ts', export: '#default' },
      contentHash: 'test-hash',
      workflows: [
        {
          name: 'CI',
          triggers: [
            {
              _type: 'pr',
              events: ['opened'],
              targetBranches: [],
              sourceBranches: [],
              paths: [],
            },
          ],
          jobs: [
            {
              _type: 'static',
              name: 'build',
              runsOn: [{ kind: 'exact', value: 'linux' }],
              needs: [],
              steps: [{ name: 'Build', hasOutputs: false }],
            },
            {
              _type: 'dynamic',
              source: { file: '.kici/workflows/ci.ts', index: 1 },
            },
          ],
        },
      ],
    };

    const mockReporter = createMockCheckRunReporter();
    const deps = createDeps({
      lockFileCache: createMockLockFileCache(lockFileWithDynamic) as any,
      checkRunReporter: mockReporter as any,
    });
    await processWebhook(basePrInfo(), deps);

    expect(mockReporter.setPendingAwait).toHaveBeenCalledWith(
      expect.objectContaining({
        jobNames: ['build'], // Only static job, dynamic is excluded
      }),
    );
  });

  // -- Platform-aware cache lookup tests --

  it('uses platform-agnostic bundle cache and platform-specific dep cache', async () => {
    const mockSourceCache = {
      has: vi.fn().mockResolvedValue(true),
      getUrl: vi.fn().mockResolvedValue('https://s3.example.com/bundle.js'),
      getUploadUrl: vi.fn(),
      get: vi.fn(),
      store: vi.fn(),
      remove: vi.fn(),
    };
    const mockDepCache = {
      has: vi.fn().mockResolvedValue(true),
      getUrl: vi.fn().mockResolvedValue('https://s3.example.com/deps.tar.gz'),
      getUrlAndHash: vi
        .fn()
        .mockResolvedValue({ url: 'https://s3.example.com/deps.tar.gz', hash: 'abc123' }),
      getUploadUrl: vi.fn(),
      store: vi.fn(),
      remove: vi.fn(),
    };
    const mockAgentRegistry = createMockAgentRegistry([{ platform: 'darwin', arch: 'arm64' }]);

    const base = matchingLockFile();
    const lockFile = {
      ...base,
      lockfileHash: 'lock-hash-123',
      workflows: [
        {
          ...base.workflows[0],
          contentHash: 'test-hash',
        },
      ],
    };

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(lockFile) as any,
      sourceCache: mockSourceCache as any,
      depCache: mockDepCache as any,
      agentRegistry: mockAgentRegistry as any,
    });
    await processWebhook(basePrInfo(), deps);

    // agentRegistry should be queried with representative labels
    expect(mockAgentRegistry.findAvailable).toHaveBeenCalledWith(['linux']);

    // Bundle cache is platform-agnostic (no platform/arch params)
    expect(mockSourceCache.has).toHaveBeenCalledWith('test-hash');
    expect(mockSourceCache.getUrl).toHaveBeenCalledWith('test-hash');

    // Dep cache remains platform-specific (uses agent's platform/arch)
    expect(mockDepCache.has).toHaveBeenCalledWith('lock-hash-123', 'darwin', 'arm64');
    expect(mockDepCache.getUrlAndHash).toHaveBeenCalledWith('lock-hash-123', 'darwin', 'arm64');
  });

  it('bundle cache calls are platform-agnostic regardless of available agents', async () => {
    const mockSourceCache = {
      has: vi.fn().mockResolvedValue(true),
      getUrl: vi.fn().mockResolvedValue('https://s3.example.com/bundle.js'),
      getUploadUrl: vi.fn(),
      get: vi.fn(),
      store: vi.fn(),
      remove: vi.fn(),
    };
    const mockAgentRegistry = createMockAgentRegistry([]); // No agents

    const base = matchingLockFile();
    const lockFile = {
      ...base,
      workflows: [{ ...base.workflows[0], contentHash: 'test-hash' }],
    };

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(lockFile) as any,
      sourceCache: mockSourceCache as any,
      agentRegistry: mockAgentRegistry as any,
    });
    await processWebhook(basePrInfo(), deps);

    // Bundle cache is platform-agnostic -- no platform/arch args even without agents
    expect(mockSourceCache.has).toHaveBeenCalledWith('test-hash');
  });

  it('bundle cache calls are platform-agnostic when agentRegistry is not provided', async () => {
    const mockSourceCache = {
      has: vi.fn().mockResolvedValue(true),
      getUrl: vi.fn().mockResolvedValue('https://s3.example.com/bundle.js'),
      getUploadUrl: vi.fn(),
      get: vi.fn(),
      store: vi.fn(),
      remove: vi.fn(),
    };

    const base = matchingLockFile();
    const lockFile = {
      ...base,
      workflows: [{ ...base.workflows[0], contentHash: 'test-hash' }],
    };

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(lockFile) as any,
      sourceCache: mockSourceCache as any,
      // No agentRegistry
    });
    await processWebhook(basePrInfo(), deps);

    // Bundle cache is platform-agnostic -- no platform/arch args
    expect(mockSourceCache.has).toHaveBeenCalledWith('test-hash');
  });

  it('dispatches build job with kici:role:builder + platform labels on cache miss', async () => {
    const mockSourceCache = {
      has: vi.fn().mockResolvedValue(false), // cache miss
      getUrl: vi.fn(),
      getUploadUrl: vi.fn().mockResolvedValue('https://s3.example.com/upload'),
      get: vi.fn(),
      store: vi.fn(),
      remove: vi.fn(),
    };
    const mockBuildCoordinator = {
      ensureBuild: vi.fn().mockImplementation(async (_key: string, cb: () => Promise<void>) => {
        await cb();
      }),
    };
    const mockPendingBuilds = {
      track: vi.fn().mockResolvedValue(undefined),
    };
    const mockAgentRegistry = createMockAgentRegistry([{ platform: 'linux', arch: 'x64' }]);

    const base = matchingLockFile();
    const lockFile = {
      ...base,
      workflows: [{ ...base.workflows[0], contentHash: 'content-hash-123' }],
    };

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(lockFile) as any,
      sourceCache: mockSourceCache as any,
      buildCoordinator: mockBuildCoordinator as any,
      pendingBuilds: mockPendingBuilds as any,
      agentRegistry: mockAgentRegistry as any,
    });
    await processWebhook(basePrInfo(), deps);

    // buildCoordinator.ensureBuild should have been called
    expect(mockBuildCoordinator.ensureBuild).toHaveBeenCalledTimes(1);

    // dispatcher should have dispatched the build job
    const dispatchCalls = (deps.dispatcher.dispatch as any).mock.calls;
    const buildCall = dispatchCalls.find(
      (c: any[]) => c[0].jobName && c[0].jobName.startsWith('__build__'),
    );
    expect(buildCall).toBeDefined();
    expect(buildCall[0].runsOnLabels).toEqual([
      'kici:role:builder',
      'kici:os:linux',
      'kici:arch:x64',
    ]);
  });

  // -- RunCoordinator integration tests --

  it('routes through coordinator when coordinator is present and peers are connected', async () => {
    const mockCoordinator = {
      hasConnectedPeers: vi.fn().mockReturnValue(true),
      routeJobs: vi.fn().mockResolvedValue({
        localJobs: [{ jobName: 'build', jobId: 'j1' }],
        reroutedJobs: [{ jobName: 'test', peerId: 'peer-1' }],
        failedJobs: [],
      }),
      handleIncomingReroute: vi.fn(),
      onPeerJobProgress: vi.fn(),
      onPeerJobComplete: vi.fn(),
      cancelRun: vi.fn(),
    };

    const deps = createDeps({ coordinator: mockCoordinator as any });
    await processWebhook(basePrInfo(), deps);

    // Coordinator should be called instead of direct dispatcher
    expect(mockCoordinator.routeJobs).toHaveBeenCalledTimes(1);

    // routeJobs should receive RunContext and jobs
    const [runCtx, jobs] = mockCoordinator.routeJobs.mock.calls[0];
    expect(runCtx.workflowName).toBe('CI');
    expect(runCtx.repoIdentifier).toBe('myorg/myrepo');
    expect(jobs).toHaveLength(2); // 'build' and 'test' from matching lock file

    // Direct dispatcher should NOT be called (coordinator handles dispatch)
    expect(deps.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('falls back to direct dispatch when coordinator has no connected peers', async () => {
    const mockCoordinator = {
      hasConnectedPeers: vi.fn().mockReturnValue(false),
      routeJobs: vi.fn(),
    };

    const deps = createDeps({ coordinator: mockCoordinator as any });
    await processWebhook(basePrInfo(), deps);

    // Coordinator.routeJobs should NOT be called
    expect(mockCoordinator.routeJobs).not.toHaveBeenCalled();

    // Direct dispatch should be used instead
    expect(deps.dispatcher.dispatch).toHaveBeenCalledTimes(2);
  });

  it('works unchanged when coordinator is not provided (backward compat)', async () => {
    // Default deps have no coordinator -- existing behavior
    const deps = createDeps({ coordinator: undefined });
    await processWebhook(basePrInfo(), deps);

    // Direct dispatch as usual
    expect(deps.dispatcher.dispatch).toHaveBeenCalledTimes(2);
  });

  it('tracks locally dispatched jobs from coordinator in execution tracker', async () => {
    const mockCoordinator = {
      hasConnectedPeers: vi.fn().mockReturnValue(true),
      routeJobs: vi.fn().mockResolvedValue({
        localJobs: [
          { jobName: 'build', jobId: 'j1' },
          { jobName: 'test', jobId: 'j2' },
        ],
        reroutedJobs: [],
        failedJobs: [],
      }),
    };

    const mockTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
      onJobStatus: vi.fn(),
      onStepStatus: vi.fn(),
      updateJobHeartbeat: vi.fn(),
      getExecutionContext: vi.fn(),
      getJobName: vi.fn(),
    };

    const deps = createDeps({
      coordinator: mockCoordinator as any,
      executionTracker: mockTracker as any,
    });
    await processWebhook(basePrInfo(), deps);

    // Execution tracker should be called with locally dispatched jobs
    expect(mockTracker.onExecutionStarted).toHaveBeenCalledTimes(1);
    // Jobs are registered after the dispatch loop, via `addJobsToRun`.
    const dispatchedJobs = mockTracker.addJobsToRun.mock.calls[0][1];
    expect(dispatchedJobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jobName: 'build' }),
        expect.objectContaining({ jobName: 'test' }),
      ]),
    );
  });

  // -- Secret resolution failure tests --

  it('skips workflow dispatch when secret resolution fails', async () => {
    const mockSecretResolver = {
      resolveForJob: vi.fn().mockRejectedValue(new Error('Decryption key not found')),
    };

    const mockDispatcher = createMockDispatcher();

    // Lock file with contexts declared to trigger secret resolution
    const lockFile = {
      schemaVersion: 1,
      source: { file: '.kici/workflows/ci.ts', export: '#default' },
      contentHash: 'test-hash',
      workflows: [
        {
          name: 'CI',
          contexts: ['production'],
          triggers: [
            {
              _type: 'pr',
              events: ['opened'],
              targetBranches: [],
              sourceBranches: [],
              paths: [],
            },
          ],
          jobs: [
            {
              _type: 'static',
              name: 'deploy',
              runsOn: [{ kind: 'exact', value: 'linux' }],
              needs: [],
              steps: [{ name: 'Deploy', hasOutputs: false }],
            },
          ],
        },
      ],
    };

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(lockFile) as any,
      secretResolver: mockSecretResolver as any,
      dispatcher: mockDispatcher as any,
    });

    await processWebhook(basePrInfo(), deps);

    // Dispatcher should NOT be called (workflow skipped due to secret resolution failure)
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('records init-failure run when secret resolution rejects', async () => {
    const mockSecretResolver = {
      resolveForJob: vi.fn().mockRejectedValue(new Error('Decryption key not found')),
    };
    const mockDispatcher = createMockDispatcher();
    const mockTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
      onJobStatus: vi.fn(),
      onStepStatus: vi.fn(),
      updateJobHeartbeat: vi.fn(),
      getExecutionContext: vi.fn(),
      getJobName: vi.fn(),
      recordInitFailureRun: vi.fn().mockResolvedValue(undefined),
    };

    const lockFile = {
      schemaVersion: 1,
      source: { file: '.kici/workflows/ci.ts', export: '#default' },
      contentHash: 'test-hash',
      workflows: [
        {
          name: 'CI',
          contexts: ['production'],
          triggers: [
            {
              _type: 'pr',
              events: ['opened'],
              targetBranches: [],
              sourceBranches: [],
              paths: [],
            },
          ],
          jobs: [
            {
              _type: 'static',
              name: 'deploy',
              runsOn: [{ kind: 'exact', value: 'linux' }],
              needs: [],
              steps: [{ name: 'Deploy', hasOutputs: false }],
            },
          ],
        },
      ],
    };

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(lockFile) as any,
      secretResolver: mockSecretResolver as any,
      dispatcher: mockDispatcher as any,
      executionTracker: mockTracker as any,
    });

    await processWebhook(basePrInfo(), deps);

    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    expect(mockTracker.recordInitFailureRun).toHaveBeenCalledTimes(1);
    const call = mockTracker.recordInitFailureRun.mock.calls[0][0];
    expect(call.workflowName).toBe('CI');
    expect(call.provider).toBe('github');
    expect(call.repoIdentifier).toBe('myorg/myrepo');
    expect(call.sha).toBe('abc123');
    expect(call.routingKey).toBe('github:12345');
    expect(call.initFailure).toMatchObject({
      scope: 'run',
      category: InitFailureCategory.enum.secret_resolution,
    });
    expect(call.initFailure.message).toContain('Decryption key not found');
  });

  it('records a lock_resolution init-failure run when the inbound lock is corrupt', async () => {
    const mockTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
      onJobStatus: vi.fn(),
      onStepStatus: vi.fn(),
      updateJobHeartbeat: vi.fn(),
      getExecutionContext: vi.fn(),
      getJobName: vi.fn(),
      recordInitFailureRun: vi.fn().mockResolvedValue(undefined),
    };
    const mockEventLog = { record: vi.fn().mockResolvedValue(undefined) };
    const corruptCache = {
      get: vi.fn().mockRejectedValue(new LockFileParseError('myorg/myrepo', 'main', 'bad json')),
      getStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0 }),
    };
    const mockDispatcher = createMockDispatcher();

    const deps = createDeps({
      lockFileCache: corruptCache as any,
      executionTracker: mockTracker as any,
      eventLog: mockEventLog as any,
      dispatcher: mockDispatcher as any,
    });

    await processWebhook(basePushInfo(), deps);

    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    expect(mockTracker.recordInitFailureRun).toHaveBeenCalledTimes(1);
    const call = mockTracker.recordInitFailureRun.mock.calls[0][0];
    expect(call.repoIdentifier).toBe('myorg/myrepo');
    expect(call.provider).toBe('github');
    expect(call.routingKey).toBe('github:12345');
    expect(call.initFailure).toMatchObject({
      scope: 'run',
      category: InitFailureCategory.enum.lock_resolution,
    });
    expect(call.initFailure.message.length).toBeGreaterThan(0);
    // An event_log row is recorded with lockfile_corrupt.
    expect(mockEventLog.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ status: 'lockfile_corrupt' }),
    );
  });

  it('does NOT record a run for a plain absent lock file (miss path unchanged)', async () => {
    const mockTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
      onJobStatus: vi.fn(),
      onStepStatus: vi.fn(),
      updateJobHeartbeat: vi.fn(),
      getExecutionContext: vi.fn(),
      getJobName: vi.fn(),
      recordInitFailureRun: vi.fn().mockResolvedValue(undefined),
    };
    const mockEventLog = { record: vi.fn().mockResolvedValue(undefined) };

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(null) as any,
      executionTracker: mockTracker as any,
      eventLog: mockEventLog as any,
    });

    await processWebhook(basePushInfo(), deps);

    expect(mockTracker.recordInitFailureRun).not.toHaveBeenCalled();
    // The miss path records a lockfile_missing (not lockfile_corrupt) event row.
    expect(mockEventLog.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ status: 'lockfile_missing' }),
    );
  });

  /**
   * The delivery is acknowledged before the pipeline runs, so nothing a
   * post-acknowledgement failure decides can reach the sender. The event-log row
   * is the per-delivery record of it, and the dashboard's failed-delivery count
   * reads exactly `event_log.status = 'failed'` — with no writer that count is
   * structurally always zero.
   */
  it('records a failed event-log row when the pipeline throws', async () => {
    const mockEventLog = { record: vi.fn().mockResolvedValue(undefined) };
    const explodingCache = {
      get: vi.fn().mockRejectedValue(new Error('lock store unreachable')),
      getStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0 }),
    };
    const deps = createDeps({
      lockFileCache: explodingCache as any,
      eventLog: mockEventLog as any,
    });

    // The error still propagates: the caller reverts the queue row to
    // `buffered` for the drain pass, which it cannot do if the throw is eaten.
    await expect(processWebhook(basePushInfo(), deps)).rejects.toThrow('lock store unreachable');

    expect(mockEventLog.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        status: EventLogStatus.enum.failed,
        errorMessage: expect.stringContaining('lock store unreachable'),
      }),
    );
  });

  it('still rethrows when the failed-row write itself fails', async () => {
    // The row is best-effort; the propagation is not. Swallowing here would
    // mark the delivery processed and lose it.
    const mockEventLog = { record: vi.fn().mockRejectedValue(new Error('event_log down')) };
    const explodingCache = {
      get: vi.fn().mockRejectedValue(new Error('lock store unreachable')),
      getStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0 }),
    };
    const deps = createDeps({
      lockFileCache: explodingCache as any,
      eventLog: mockEventLog as any,
    });

    await expect(processWebhook(basePushInfo(), deps)).rejects.toThrow('lock store unreachable');
  });

  it('records no failed row when the pipeline completes', async () => {
    // The negative control: the status is written by a throw, not by every
    // delivery, so an unconditional writer would pass the assertion above.
    const mockEventLog = { record: vi.fn().mockResolvedValue(undefined) };
    const deps = createDeps({ eventLog: mockEventLog as any });

    await processWebhook(basePushInfo(), deps);

    const statuses = mockEventLog.record.mock.calls.map((c) => (c[2] as { status: string }).status);
    expect(statuses).not.toContain(EventLogStatus.enum.failed);
    expect(statuses.length).toBeGreaterThan(0);
  });

  it('records init-failure run when install-secrets rejects', async () => {
    const mockDispatcher = createMockDispatcher();
    const mockTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
      onJobStatus: vi.fn(),
      onStepStatus: vi.fn(),
      updateJobHeartbeat: vi.fn(),
      getExecutionContext: vi.fn(),
      getJobName: vi.fn(),
      recordInitFailureRun: vi.fn().mockResolvedValue(undefined),
    };

    // Lock file declares an installEnv reference whose `<env>:<secret>` form is
    // malformed — install-secrets resolver rejects with a parse error, exercising
    // the install_secrets early-exit.
    const lockFile = {
      schemaVersion: 1,
      source: { file: '.kici/workflows/ci.ts', export: '#default' },
      contentHash: 'test-hash',
      workflows: [
        {
          name: 'CI',
          installEnv: ['malformed-no-colon-reference'],
          triggers: [
            {
              _type: 'pr',
              events: ['opened'],
              targetBranches: [],
              sourceBranches: [],
              paths: [],
            },
          ],
          jobs: [
            {
              _type: 'static',
              name: 'deploy',
              runsOn: [{ kind: 'exact', value: 'linux' }],
              needs: [],
              steps: [{ name: 'Deploy', hasOutputs: false }],
            },
          ],
        },
      ],
    };

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(lockFile) as any,
      dispatcher: mockDispatcher as any,
      executionTracker: mockTracker as any,
    });

    await processWebhook(basePrInfo(), deps);

    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    expect(mockTracker.recordInitFailureRun).toHaveBeenCalledTimes(1);
    const call = mockTracker.recordInitFailureRun.mock.calls[0][0];
    expect(call.initFailure).toMatchObject({
      scope: 'run',
      category: InitFailureCategory.enum.install_secrets,
    });
  });

  it('tags synthetic rejected-* jobs with context_rules init_failure', async () => {
    const rejectReason = 'Rejected by protection rules';
    const mockDispatcher = createMockDispatcher();
    // Override dispatch to return a rejection result for the dispatched job.
    mockDispatcher.dispatch = vi.fn().mockResolvedValue({
      status: 'rejected',
      reason: rejectReason,
    });
    const mockTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
      onJobStatus: vi.fn().mockResolvedValue(undefined),
      onStepStatus: vi.fn(),
      updateJobHeartbeat: vi.fn(),
      getExecutionContext: vi.fn(),
      getJobName: vi.fn(),
      recordInitFailureRun: vi.fn().mockResolvedValue(undefined),
    };

    const lockFile = {
      schemaVersion: 1,
      source: { file: '.kici/workflows/ci.ts', export: '#default' },
      contentHash: 'test-hash',
      workflows: [
        {
          name: 'CI',
          triggers: [
            {
              _type: 'pr',
              events: ['opened'],
              targetBranches: [],
              sourceBranches: [],
              paths: [],
            },
          ],
          jobs: [
            {
              _type: 'static',
              name: 'deploy',
              runsOn: [{ kind: 'exact', value: 'linux' }],
              needs: [],
              steps: [{ name: 'Deploy', hasOutputs: false }],
            },
          ],
        },
      ],
    };

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(lockFile) as any,
      dispatcher: mockDispatcher as any,
      executionTracker: mockTracker as any,
    });

    await processWebhook(basePrInfo(), deps);

    // Dispatcher should be called for the rejected job.
    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);

    // The synthetic rejected-* job should be marked failed with the structured
    // init_failure carrying scope=job, category=context_rules, the reject
    // reason as message, and the job name.
    expect(mockTracker.onJobStatus).toHaveBeenCalled();
    const rejectedCall = mockTracker.onJobStatus.mock.calls.find(
      (args: unknown[]) =>
        typeof args[1] === 'string' && (args[1] as string).startsWith('rejected-'),
    );
    expect(rejectedCall).toBeDefined();
    // Signature: (runId, jobId, status, timestamp, durationMs?, data?)
    const [, jobId, , , , data] = rejectedCall as unknown[];
    expect(jobId).toMatch(/^rejected-/);
    expect(data).toMatchObject({
      error: rejectReason,
      initFailure: {
        scope: 'job',
        category: InitFailureCategory.enum.context_rules,
        message: rejectReason,
        jobName: 'deploy',
      },
    });
  });

  it('tags no-agent-available rejections with no_agent category', async () => {
    const rejectReason = 'No agent for label kici:os:linux available';
    const mockDispatcher = createMockDispatcher();
    // Override dispatch to return a no-agent rejection result.
    mockDispatcher.dispatch = vi.fn().mockResolvedValue({
      status: 'rejected',
      reason: rejectReason,
    });
    const mockTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
      onJobStatus: vi.fn().mockResolvedValue(undefined),
      onStepStatus: vi.fn(),
      updateJobHeartbeat: vi.fn(),
      getExecutionContext: vi.fn(),
      getJobName: vi.fn(),
      recordInitFailureRun: vi.fn().mockResolvedValue(undefined),
    };

    const lockFile = {
      schemaVersion: 1,
      source: { file: '.kici/workflows/ci.ts', export: '#default' },
      contentHash: 'test-hash',
      workflows: [
        {
          name: 'CI',
          triggers: [
            {
              _type: 'pr',
              events: ['opened'],
              targetBranches: [],
              sourceBranches: [],
              paths: [],
            },
          ],
          jobs: [
            {
              _type: 'static',
              name: 'deploy',
              runsOn: [{ kind: 'exact', value: 'linux' }],
              needs: [],
              steps: [{ name: 'Deploy', hasOutputs: false }],
            },
          ],
        },
      ],
    };

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(lockFile) as any,
      dispatcher: mockDispatcher as any,
      executionTracker: mockTracker as any,
    });

    await processWebhook(basePrInfo(), deps);

    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);

    // The synthetic rejected-* job should be marked failed with the structured
    // init_failure carrying category=no_agent because the reason string matches
    // the no-agent regex.
    expect(mockTracker.onJobStatus).toHaveBeenCalled();
    const rejectedCall = mockTracker.onJobStatus.mock.calls.find(
      (args: unknown[]) =>
        typeof args[1] === 'string' && (args[1] as string).startsWith('rejected-'),
    );
    expect(rejectedCall).toBeDefined();
    const [, jobId, , , , data] = rejectedCall as unknown[];
    expect(jobId).toMatch(/^rejected-/);
    expect(data).toMatchObject({
      error: rejectReason,
      initFailure: {
        scope: 'job',
        category: InitFailureCategory.enum.no_agent,
        message: rejectReason,
        jobName: 'deploy',
      },
    });
  });

  it('tags build-job dispatch rejections with build_coordination init_failure', async () => {
    // Cache-miss path forces the orchestrator to dispatch a synthetic
    // __build__<workflow> job. Reject that dispatch so the synthetic-rejected
    // path inside runBuildJob calls failRun with the build_coordination
    // init_failure (recorded against the synthetic execution_runs row that was
    // just inserted by onExecutionStarted).
    const buildRejectReason = 'Builder backend unavailable';
    const mockSourceCache = {
      has: vi.fn().mockResolvedValue(false),
      getUrl: vi.fn(),
      getUploadUrl: vi.fn().mockResolvedValue('https://s3.example.com/upload'),
      get: vi.fn(),
      store: vi.fn(),
      remove: vi.fn(),
    };
    const mockBuildCoordinator = {
      ensureBuild: vi.fn().mockImplementation(async (_key: string, cb: () => Promise<void>) => {
        await cb();
      }),
    };
    const mockAgentRegistry = createMockAgentRegistry([{ platform: 'linux', arch: 'x64' }]);
    const mockDispatcher = createMockDispatcher();
    mockDispatcher.dispatch = vi.fn().mockImplementation(async (input: { jobName: string }) => {
      if (input.jobName.startsWith('__build__')) {
        return { status: 'rejected', reason: buildRejectReason };
      }
      return { status: 'dispatched', agentId: 'agent-1', jobId: 'j1' };
    });
    const mockTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
      onJobStatus: vi.fn().mockResolvedValue(undefined),
      onStepStatus: vi.fn(),
      updateJobHeartbeat: vi.fn(),
      getExecutionContext: vi.fn(),
      getJobName: vi.fn(),
      failRun: vi.fn().mockResolvedValue(undefined),
      onBuildFailed: vi.fn().mockResolvedValue(undefined),
      onBuildFailedBeforeTracking: vi.fn().mockResolvedValue(undefined),
    };

    const base = matchingLockFile();
    const lockFile = {
      ...base,
      workflows: [{ ...base.workflows[0], contentHash: 'content-hash-build-coord' }],
    };

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(lockFile) as any,
      sourceCache: mockSourceCache as any,
      buildCoordinator: mockBuildCoordinator as any,
      agentRegistry: mockAgentRegistry as any,
      dispatcher: mockDispatcher as any,
      executionTracker: mockTracker as any,
    });

    await processWebhook(basePrInfo(), deps);

    // The synthetic-rejected build job path should call failRun with a structured
    // build_coordination init_failure so the dashboard banner can explain why
    // the run was killed before any work happened.
    expect(mockTracker.failRun).toHaveBeenCalledTimes(1);
    const [, reason, initFailure] = mockTracker.failRun.mock.calls[0] as unknown[];
    expect(reason).toContain(buildRejectReason);
    expect(initFailure).toMatchObject({
      scope: 'run',
      category: InitFailureCategory.enum.build_coordination,
    });
    expect((initFailure as { message: string }).message).toContain(buildRejectReason);
  });

  /**
   * Zero-based position of `initFailure` in `onBuildFailedBeforeTracking`'s
   * positional signature (runId, workflowName, provider, repoIdentifier, ref,
   * sha, deliveryId, providerContext, routingKey, triggerEvent, commitMessage,
   * failureReason, initFailure, provenance).
   */
  const ON_BUILD_FAILED_INIT_FAILURE_ARG = 12;

  it('tags build-coordinator failures (pre-tracking) with build_coordination init_failure', async () => {
    // Build-coordinator timeout path: ensureBuild throws BEFORE its inner closure
    // gets to call onExecutionStarted, so buildJobTrackedEarly stays false and
    // recordBuildFailure routes the failure through onBuildFailedBeforeTracking,
    // which must also carry the structured build_coordination init_failure.
    const coordinatorError = new Error('Build coordinator timed out after 30s');
    const mockSourceCache = {
      has: vi.fn().mockResolvedValue(false),
      getUrl: vi.fn(),
      getUploadUrl: vi.fn().mockResolvedValue('https://s3.example.com/upload'),
      get: vi.fn(),
      store: vi.fn(),
      remove: vi.fn(),
    };
    const mockBuildCoordinator = {
      ensureBuild: vi.fn().mockImplementation(async () => {
        // Reject without invoking the inner callback so onExecutionStarted is
        // never reached → buildJobTrackedEarly stays false.
        throw coordinatorError;
      }),
    };
    const mockAgentRegistry = createMockAgentRegistry([{ platform: 'linux', arch: 'x64' }]);
    const mockTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
      onJobStatus: vi.fn().mockResolvedValue(undefined),
      onStepStatus: vi.fn(),
      updateJobHeartbeat: vi.fn(),
      getExecutionContext: vi.fn(),
      getJobName: vi.fn(),
      failRun: vi.fn().mockResolvedValue(undefined),
      onBuildFailed: vi.fn().mockResolvedValue(undefined),
      onBuildFailedBeforeTracking: vi.fn().mockResolvedValue(undefined),
    };

    const base = matchingLockFile();
    const lockFile = {
      ...base,
      workflows: [{ ...base.workflows[0], contentHash: 'content-hash-coord-timeout' }],
    };

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(lockFile) as any,
      sourceCache: mockSourceCache as any,
      buildCoordinator: mockBuildCoordinator as any,
      agentRegistry: mockAgentRegistry as any,
      executionTracker: mockTracker as any,
    });

    await processWebhook(basePrInfo(), deps);

    // recordBuildFailure routes through onBuildFailedBeforeTracking because no
    // run row was tracked early. Indexed rather than read off the end: the
    // trailing `provenance` arg sits after init_failure, so `length - 1` would
    // silently start asserting against the wrong argument.
    expect(mockTracker.onBuildFailedBeforeTracking).toHaveBeenCalledTimes(1);
    const call = mockTracker.onBuildFailedBeforeTracking.mock.calls[0] as unknown[];
    const initFailureArg = call[ON_BUILD_FAILED_INIT_FAILURE_ARG];
    expect(initFailureArg).toMatchObject({
      scope: 'run',
      category: InitFailureCategory.enum.build_coordination,
    });
    expect((initFailureArg as { message: string }).message).toContain(coordinatorError.message);
  });

  // -- Registration extraction tests --

  it('extracts and stores registrations on push to default branch', async () => {
    const pushLockFile = {
      schemaVersion: 1,
      source: { file: '.kici/workflows/events.ts', export: '#default' },
      contentHash: 'test-hash',
      workflows: [
        {
          name: 'OnDeploy',
          triggers: [
            {
              _type: 'kici_event',
              eventName: 'deploy-complete',
            },
          ],
          jobs: [
            {
              _type: 'static',
              name: 'notify',
              runsOn: [{ kind: 'exact', value: 'linux' }],
              needs: [],
              steps: [{ name: 'Notify', hasOutputs: false }],
            },
          ],
        },
        {
          name: 'Deploy',
          triggers: [
            {
              _type: 'push',
              branches: [{ type: 'glob', pattern: 'main' }],
              paths: [],
            },
          ],
          jobs: [
            {
              _type: 'static',
              name: 'deploy',
              runsOn: [{ kind: 'exact', value: 'linux' }],
              needs: [],
              steps: [{ name: 'Deploy', hasOutputs: false }],
            },
          ],
        },
      ],
    };

    const mockRegistrationStore = {
      replaceAll: vi.fn().mockResolvedValue(undefined),
      bumpVersion: vi.fn().mockResolvedValue(2),
      getAll: vi.fn(),
      getVersion: vi.fn(),
    };
    const mockRegistrationIndex = {
      refreshIfNeeded: vi.fn().mockResolvedValue(undefined),
      loadFromDb: vi.fn(),
      getByTriggerType: vi.fn(),
      getByEventType: vi.fn(),
      getGlobalByTriggerType: vi.fn().mockReturnValue([]),
      getGlobalByOrgAndTriggerType: vi.fn().mockReturnValue([]),
    };

    const pushInfo = basePushInfo({
      payload: {
        ref: 'refs/heads/main',
        repository: {
          full_name: 'myorg/myrepo',
          owner: { login: 'myorg' },
          name: 'myrepo',
          default_branch: 'main',
        },
        before: 'aaa',
        after: 'bbb',
        installation: { id: 42 },
      },
    });

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(pushLockFile) as any,
      registrationStore: mockRegistrationStore as any,
      registrationIndex: mockRegistrationIndex as any,
    });
    await processWebhook(pushInfo, deps);

    // Registration store should be called with BOTH workflows: the kici_event
    // one and the push-triggered one. made git triggers registerable
    // so cross-source dispatch can resolve them by (customer_id, repo).
    expect(mockRegistrationStore.replaceAll).toHaveBeenCalledTimes(1);
    expect(mockRegistrationStore.replaceAll).toHaveBeenCalledWith(
      'myorg/myrepo',
      expect.arrayContaining([
        expect.objectContaining({ name: 'OnDeploy' }),
        expect.objectContaining({ name: 'Deploy' }),
      ]),
      expect.any(String), // routingKey
      expect.any(Object), // credentials
      expect.any(Object), // options
    );
    const extractedWorkflows = mockRegistrationStore.replaceAll.mock.calls[0][1];
    expect(extractedWorkflows).toHaveLength(2);

    expect(mockRegistrationStore.bumpVersion).toHaveBeenCalledTimes(1);
    expect(mockRegistrationIndex.refreshIfNeeded).toHaveBeenCalledWith(2);
  });

  it('skips registration extraction on push to non-default branch', async () => {
    const pushLockFile = {
      schemaVersion: 1,
      source: { file: '.kici/workflows/events.ts', export: '#default' },
      contentHash: 'test-hash',
      workflows: [
        {
          name: 'OnDeploy',
          triggers: [{ _type: 'kici_event', eventName: 'deploy-complete' }],
          jobs: [
            {
              _type: 'static',
              name: 'notify',
              runsOn: [{ kind: 'exact', value: 'linux' }],
              needs: [],
              steps: [{ name: 'Notify', hasOutputs: false }],
            },
          ],
        },
      ],
    };

    const mockRegistrationStore = {
      replaceAll: vi.fn(),
      bumpVersion: vi.fn(),
    };
    const mockRegistrationIndex = {
      refreshIfNeeded: vi.fn(),
      getGlobalByTriggerType: vi.fn().mockReturnValue([]),
      getGlobalByOrgAndTriggerType: vi.fn().mockReturnValue([]),
    };

    const pushInfo = basePushInfo({
      payload: {
        ref: 'refs/heads/feature/new-thing',
        repository: {
          full_name: 'myorg/myrepo',
          owner: { login: 'myorg' },
          name: 'myrepo',
          default_branch: 'main',
        },
        before: 'aaa',
        after: 'bbb',
        installation: { id: 42 },
      },
    });

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(pushLockFile) as any,
      registrationStore: mockRegistrationStore as any,
      registrationIndex: mockRegistrationIndex as any,
    });
    await processWebhook(pushInfo, deps);

    // Registration store should NOT be called for non-default branch
    expect(mockRegistrationStore.replaceAll).not.toHaveBeenCalled();
    expect(mockRegistrationStore.bumpVersion).not.toHaveBeenCalled();
  });

  it('skips registration extraction on non-push events', async () => {
    const mockRegistrationStore = {
      replaceAll: vi.fn(),
      bumpVersion: vi.fn(),
    };
    const mockRegistrationIndex = {
      refreshIfNeeded: vi.fn(),
      getGlobalByTriggerType: vi.fn().mockReturnValue([]),
      getGlobalByOrgAndTriggerType: vi.fn().mockReturnValue([]),
    };

    const deps = createDeps({
      registrationStore: mockRegistrationStore as any,
      registrationIndex: mockRegistrationIndex as any,
    });
    // basePrInfo is a pull_request event
    await processWebhook(basePrInfo(), deps);

    expect(mockRegistrationStore.replaceAll).not.toHaveBeenCalled();
  });

  it('skips registration for local provider (file:// sources)', async () => {
    const pushLockFile = {
      schemaVersion: 1,
      source: { file: '.kici/workflows/events.ts', export: '#default' },
      contentHash: 'test-hash',
      workflows: [
        {
          name: 'OnDeploy',
          triggers: [{ _type: 'kici_event', eventName: 'deploy-complete' }],
          jobs: [
            {
              _type: 'static',
              name: 'notify',
              runsOn: [{ kind: 'exact', value: 'linux' }],
              needs: [],
              steps: [{ name: 'Notify', hasOutputs: false }],
            },
          ],
        },
      ],
    };

    const mockRegistrationStore = {
      replaceAll: vi.fn(),
      bumpVersion: vi.fn(),
    };
    const mockRegistrationIndex = {
      refreshIfNeeded: vi.fn(),
      getGlobalByTriggerType: vi.fn().mockReturnValue([]),
      getGlobalByOrgAndTriggerType: vi.fn().mockReturnValue([]),
    };

    // Default-branch push but from an internal source
    const pushInfo = basePushInfo({
      provider: 'local',
      payload: {
        ref: 'refs/heads/main',
        repository: {
          full_name: 'myorg/myrepo',
          owner: { login: 'myorg' },
          name: 'myrepo',
          default_branch: 'main',
        },
        before: 'aaa',
        after: 'bbb',
        installation: { id: 42 },
      },
    });

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(pushLockFile) as any,
      registrationStore: mockRegistrationStore as any,
      registrationIndex: mockRegistrationIndex as any,
    });
    await processWebhook(pushInfo, deps);

    // Internal sources must NOT re-register workflows — the real provider
    // source owns the registration set. See processor.ts comment at 5.1.
    expect(mockRegistrationStore.replaceAll).not.toHaveBeenCalled();
    expect(mockRegistrationStore.bumpVersion).not.toHaveBeenCalled();
  });

  it('emits registration.updated event after registration extraction', async () => {
    const pushLockFile = {
      schemaVersion: 1,
      source: { file: '.kici/workflows/events.ts', export: '#default' },
      contentHash: 'test-hash',
      workflows: [
        {
          name: 'OnDeploy',
          triggers: [{ _type: 'kici_event', eventName: 'deploy-complete' }],
          jobs: [
            {
              _type: 'static',
              name: 'notify',
              runsOn: [{ kind: 'exact', value: 'linux' }],
              needs: [],
              steps: [{ name: 'Notify', hasOutputs: false }],
            },
          ],
        },
      ],
    };

    const mockRegistrationStore = {
      replaceAll: vi.fn().mockResolvedValue(undefined),
      bumpVersion: vi.fn().mockResolvedValue(3),
    };
    const mockRegistrationIndex = {
      refreshIfNeeded: vi.fn().mockResolvedValue(undefined),
      getGlobalByTriggerType: vi.fn().mockReturnValue([]),
      getGlobalByOrgAndTriggerType: vi.fn().mockReturnValue([]),
    };
    const mockEventRouter = {
      emit: vi.fn().mockResolvedValue('evt-1'),
    };

    const pushInfo = basePushInfo({
      payload: {
        ref: 'refs/heads/main',
        repository: {
          full_name: 'myorg/myrepo',
          owner: { login: 'myorg' },
          name: 'myrepo',
          default_branch: 'main',
        },
        before: 'aaa',
        after: 'bbb',
        installation: { id: 42 },
      },
    });

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(pushLockFile) as any,
      registrationStore: mockRegistrationStore as any,
      registrationIndex: mockRegistrationIndex as any,
      eventRouter: mockEventRouter as any,
    });
    await processWebhook(pushInfo, deps);

    expect(mockEventRouter.emit).toHaveBeenCalledWith({
      eventName: 'registration.updated',
      payload: {
        repo: 'myorg/myrepo',
        workflowCount: 1,
        workflows: ['OnDeploy'],
      },
      sourceRepo: 'myorg/myrepo',
      sourceRoutingKey: 'github:12345',
    });
  });

  // -- Ephemeral key pair generation tests --

  it('generates ephemeral key pair and stores in DB when db and secretKey are provided', async () => {
    const insertValues: Array<Record<string, unknown>> = [];
    const mockDb = {
      insertInto: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          insertValues.push(vals);
          return { execute: vi.fn().mockResolvedValue(undefined) };
        }),
      }),
    };

    const deps = createDeps({
      db: mockDb as any,
      secretKey: 'a'.repeat(64), // Valid 32-byte hex secret key
    });
    await processWebhook(basePrInfo(), deps);

    // Should have inserted into run_ephemeral_keys
    expect(mockDb.insertInto).toHaveBeenCalledWith('run_ephemeral_keys');
    expect(insertValues).toHaveLength(1);
    expect(insertValues[0]).toEqual(
      expect.objectContaining({
        run_id: expect.any(String),
        encrypted_private_key: expect.any(String),
        public_key: expect.any(String),
      }),
    );

    // Public key should be base64 encoded
    const pubKey = insertValues[0].public_key as string;
    expect(() => Buffer.from(pubKey, 'base64')).not.toThrow();
    expect(Buffer.from(pubKey, 'base64').length).toBeGreaterThan(0);

    // Encrypted private key should be base64 encoded
    const encKey = insertValues[0].encrypted_private_key as string;
    expect(() => Buffer.from(encKey, 'base64')).not.toThrow();
  });

  it('includes runPublicKey in dispatched job config when db and secretKey are provided', async () => {
    const insertValues: Array<Record<string, unknown>> = [];
    const mockDb = {
      insertInto: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          insertValues.push(vals);
          return { execute: vi.fn().mockResolvedValue(undefined) };
        }),
      }),
    };

    const mockDispatcher = createMockDispatcher();
    const deps = createDeps({
      db: mockDb as any,
      secretKey: 'a'.repeat(64),
      dispatcher: mockDispatcher as any,
    });
    await processWebhook(basePrInfo(), deps);

    // Verify both dispatch calls include runPublicKey in jobConfig
    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 2; i++) {
      const jobInput = mockDispatcher.dispatch.mock.calls[i][0];
      expect(jobInput.jobConfig.runPublicKey).toBeTruthy();
      expect(typeof jobInput.jobConfig.runPublicKey).toBe('string');
    }

    // runPublicKey should match what was stored in DB
    const storedPubKey = insertValues[0].public_key;
    const dispatchedPubKey = mockDispatcher.dispatch.mock.calls[0][0].jobConfig.runPublicKey;
    expect(dispatchedPubKey).toBe(storedPubKey);
  });

  it('does not include runPublicKey when db is not provided', async () => {
    const mockDispatcher = createMockDispatcher();
    const deps = createDeps({
      dispatcher: mockDispatcher as any,
      // No db or secretKey
    });
    await processWebhook(basePrInfo(), deps);

    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(2);
    const jobInput = mockDispatcher.dispatch.mock.calls[0][0];
    expect(jobInput.jobConfig.runPublicKey).toBeUndefined();
  });

  it('dispatches without runPublicKey when key generation fails', async () => {
    const mockDb = {
      insertInto: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          execute: vi.fn().mockRejectedValue(new Error('DB connection lost')),
        }),
      }),
    };

    const mockDispatcher = createMockDispatcher();
    const deps = createDeps({
      db: mockDb as any,
      secretKey: 'a'.repeat(64),
      dispatcher: mockDispatcher as any,
    });

    // Should not throw -- gracefully handles key generation failure
    await processWebhook(basePrInfo(), deps);

    // Jobs should still be dispatched (without runPublicKey)
    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(2);
    const jobInput = mockDispatcher.dispatch.mock.calls[0][0];
    expect(jobInput.jobConfig.runPublicKey).toBeUndefined();
  });

  it('includes runPublicKey in coordinator-routed jobs when db and secretKey are provided', async () => {
    const mockDb = {
      insertInto: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          execute: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    };

    const mockCoordinator = {
      hasConnectedPeers: vi.fn().mockReturnValue(true),
      routeJobs: vi.fn().mockResolvedValue({
        localJobs: [{ jobName: 'build', jobId: 'j1' }],
        reroutedJobs: [],
        failedJobs: [],
      }),
    };

    const deps = createDeps({
      db: mockDb as any,
      secretKey: 'a'.repeat(64),
      coordinator: mockCoordinator as any,
    });
    await processWebhook(basePrInfo(), deps);

    // routeJobs should have been called with jobs containing runPublicKey
    expect(mockCoordinator.routeJobs).toHaveBeenCalledTimes(1);
    const jobs = mockCoordinator.routeJobs.mock.calls[0][1];
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job.jobConfig.runPublicKey).toBeTruthy();
    }
  });

  it('does not record execution on secret resolution failure when executionTracker is not provided', async () => {
    const mockSecretResolver = {
      resolveForJob: vi.fn().mockRejectedValue(new Error('Not authorized')),
    };

    const mockDispatcher = createMockDispatcher();

    const lockFile = {
      schemaVersion: 1,
      source: { file: '.kici/workflows/ci.ts', export: '#default' },
      contentHash: 'test-hash',
      workflows: [
        {
          name: 'CI',
          contexts: ['staging'],
          triggers: [
            {
              _type: 'pr',
              events: ['opened'],
              targetBranches: [],
              sourceBranches: [],
              paths: [],
            },
          ],
          jobs: [
            {
              _type: 'static',
              name: 'build',
              runsOn: [{ kind: 'exact', value: 'linux' }],
              needs: [],
              steps: [{ name: 'Build', hasOutputs: false }],
            },
          ],
        },
      ],
    };

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(lockFile) as any,
      secretResolver: mockSecretResolver as any,
      executionTracker: undefined,
      dispatcher: mockDispatcher as any,
    });

    // Should not throw -- gracefully handles missing tracker
    await processWebhook(basePrInfo(), deps);

    // Dispatcher should NOT be called (workflow skipped)
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// — Cross-source webhook dispatch
// ─────────────────────────────────────────────────────────────────────

/**
 * Build a provider bundle that mimics the real GenericWebhookNormalizer:
 *   - normalizeEvent returns event.type='generic_webhook' with the user
 *     event name in event.action (THIS is what creates Pitfall 1)
 *   - extractRepoIdentifier returns null (generic webhooks have no repo)
 */
function createGenericProviderBundle(): ProviderBundle {
  return {
    normalizer: {
      provider: 'generic' as const,
      extractRoutingKey: vi.fn(),
      extractDeliveryId: vi.fn(),
      extractEventType: vi.fn(),
      verifySignature: vi.fn().mockReturnValue(true),
      normalizeEvent: vi
        .fn()
        .mockImplementation((eventType: string, _action: string | null, payload: unknown) => ({
          // CRITICAL: type is the literal 'generic_webhook' — the matcher would
          // never accept this against a user-defined webhook trigger. The
          // cross-source branch in processWebhook MUST construct a synthetic
          // event with type=eventType (the user event name) before calling
          // matchAllWorkflows. This is the Pitfall 1 fix.
          type: 'generic_webhook' as const,
          action: eventType !== 'default' ? eventType : undefined,
          targetBranch: '__generic__',
          payload: (payload as Record<string, unknown>) ?? {},
          provider: 'generic' as const,
        })),
      extractRepoIdentifier: vi.fn().mockReturnValue(null),
      extractRef: vi.fn().mockReturnValue('HEAD'),
      extractCredentials: vi.fn().mockReturnValue({}),
    },
  };
}

/**
 * Build a provider bundle for a "registered source" (e.g. github:42) that the
 * cross-source dispatch path will resolve via providerRegistry.getByRoutingKey.
 */
function createRegisteredBundle(token: string | null = 'token-from-reg-bundle'): ProviderBundle {
  return {
    normalizer: {
      provider: 'github' as const,
      extractRoutingKey: vi.fn(),
      extractDeliveryId: vi.fn(),
      extractEventType: vi.fn(),
      verifySignature: vi.fn().mockReturnValue(true),
      normalizeEvent: vi.fn(),
      extractRepoIdentifier: vi.fn(),
      extractRef: vi.fn().mockReturnValue('HEAD'),
      extractCredentials: vi.fn().mockReturnValue({}),
    },
    cloneTokenProvider: {
      provider: 'github' as const,
      createCloneToken: vi.fn().mockResolvedValue(token),
    },
    repoUrlBuilder: {
      provider: 'github' as const,
      buildCloneUrl: vi.fn().mockImplementation((id: string) => `https://github.com/${id}.git`),
      buildRawFileUrl: vi.fn(),
    },
  };
}

/**
 * Build a webhook-trigger registration row consumable by RegistrationIndex
 * mocks. Mirrors RegisteredWorkflow shape from registration-index.ts.
 */
function makeWebhookRegistration(opts: {
  id: string;
  customerId: string;
  routingKey: string;
  repoIdentifier: string;
  workflowName: string;
  events: string[];
  disabled?: boolean;
  /** Optional override for the registration's lockEntry jobs array. Defaults
   * to a single static `do-thing` job (CS-1..CS-9 shape). Use this to inject
   * dynamic-fn entries or mixed static+dynamic-fn workflows for CS-10/CS-11/CS-12. */
  jobs?: unknown[];
}) {
  const defaultJobs = [
    {
      _type: 'static' as const,
      name: 'do-thing',
      runsOn: [{ kind: 'exact', value: 'linux' }],
      needs: [],
      steps: [{ name: 'Run', hasOutputs: false }],
    },
  ];
  return {
    id: opts.id,
    repoIdentifier: opts.repoIdentifier,
    workflowName: opts.workflowName,
    lockEntry: {
      name: opts.workflowName,
      source: { file: '.kici/workflows/foo.ts', export: '#default' },
      contentHash: 'reg-content-hash',
      compileSchemaVersion: 1,
      triggers: [
        {
          _type: 'webhook' as const,
          events: opts.events,
          actions: [],
        },
      ],
      jobs: opts.jobs ?? defaultJobs,
    },
    triggerTypes: ['webhook'],
    routingKey: opts.routingKey,
    providerContext: { installationId: 7 },
    disabled: opts.disabled ?? false,
    isGlobal: false,
    customerId: opts.customerId,
    commitSha: 'reg-sha-1',
    sourceFile: '.kici/workflows/foo.ts',
  };
}

function baseGenericInfo(overrides: Partial<WebhookInfo> = {}): WebhookInfo {
  return {
    routingKey: 'generic:kiciStg00001:stg-generic',
    deliveryId: 'generic:kiciStg00001:stg-generic:delivery-1',
    event: 'foo',
    action: null,
    provider: 'generic',
    payload: { hello: 'world' },
    ...overrides,
  };
}

describe('processWebhook — cross-source webhook dispatch (phase 28.4)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function makeCrossSourceDeps(opts: {
    registrations: ReturnType<typeof makeWebhookRegistration>[];
    registeredBundle?: ProviderBundle;
    /** Mock db for resolveOrgId; if absent, falls back to '__default__' */
    db?: unknown;
    /** Optional pending-dynamics tracker mock (CS-10, CS-11). */
    pendingDynamics?: unknown;
    /** Optional pending-inits tracker mock (CS-12). */
    pendingInits?: unknown;
    /** Optional execution tracker mock (dynamic-eval init-failure cases). */
    executionTracker?: unknown;
  }): ProcessingDeps {
    const genericBundle = createGenericProviderBundle();
    const registeredBundle = opts.registeredBundle ?? createRegisteredBundle();

    const registry = new ProviderRegistry();
    // Register the inbound generic source by exact routing key
    registry.registerByRoutingKey('generic:kiciStg00001:stg-generic', genericBundle);
    // Register the cross-source target bundle by exact routing key
    registry.registerByRoutingKey('github:42', registeredBundle);

    const mockRegistrationStore = {
      getVersion: vi.fn().mockResolvedValue(1),
    };

    const mockRegistrationIndex = {
      getByOrgAndEvent: vi.fn().mockImplementation((customerId: string, eventName: string) => {
        return opts.registrations
          .filter((r) => r.customerId === customerId && !r.disabled)
          .filter((r) =>
            r.lockEntry.triggers.some(
              (t: { _type: string; events?: string[] }) =>
                t._type === 'webhook' && (t.events ?? []).includes(eventName),
            ),
          );
      }),
      refreshIfNeeded: vi.fn().mockResolvedValue(undefined),
      getGlobalByTriggerType: vi.fn().mockReturnValue([]),
      getGlobalByOrgAndTriggerType: vi.fn().mockReturnValue([]),
    };

    return createDeps({
      providerRegistry: registry,
      registrationStore: mockRegistrationStore as any,
      registrationIndex: mockRegistrationIndex as any,
      db: opts.db as any,
      pendingDynamics: opts.pendingDynamics as any,
      pendingInits: opts.pendingInits as any,
      executionTracker: opts.executionTracker as any,
    });
  }

  // CS-1 (WHK-CROSS-01 happy path): single matched registration in same org
  it('CS-1: dispatches single matched cross-source registration', async () => {
    const reg = makeWebhookRegistration({
      id: 'reg-1',
      customerId: '__default__', // resolveOrgId falls back to __default__ when no db
      routingKey: 'github:42',
      repoIdentifier: 'orgA/repo1',
      workflowName: 'react-to-foo',
      events: ['foo'],
    });

    const deps = makeCrossSourceDeps({ registrations: [reg] });
    await processWebhook(baseGenericInfo(), deps);

    expect(deps.dispatcher.dispatch).toHaveBeenCalledTimes(1);
    const call = (deps.dispatcher.dispatch as any).mock.calls[0][0];
    expect(call.workflowName).toBe('react-to-foo');
    expect(call.routingKey).toBe('github:42');
    expect(call.deliveryId).toBe('generic:kiciStg00001:stg-generic:delivery-1:reg-1');
    expect(call.provider).toBe('github');
    // providerContext is the registration's context (with token if issued)
    expect(call.providerContext.installationId).toBe(7);
    expect(call.providerContext.token).toBe('token-from-reg-bundle');
    // repoUrl built from the REGISTRATION's repo via the registered bundle
    expect(call.repoUrl).toBe('https://github.com/orgA/repo1.git');
    // jobConfig carries the cross-source provenance fields
    expect(call.jobConfig.crossSource).toBe(true);
    expect(call.jobConfig.inboundEventName).toBe('foo');
    expect(call.jobConfig.inboundRoutingKey).toBe('generic:kiciStg00001:stg-generic');
  });

  // CS-2 (WHK-CROSS-03): fan-out N>1 with distinct composite dedup keys
  it('CS-2: fans out to N>1 cross-source registrations with distinct dedup keys', async () => {
    const regs = [
      makeWebhookRegistration({
        id: 'reg-A',
        customerId: '__default__',
        routingKey: 'github:42',
        repoIdentifier: 'orgA/repo-a',
        workflowName: 'wf-a',
        events: ['foo'],
      }),
      makeWebhookRegistration({
        id: 'reg-B',
        customerId: '__default__',
        routingKey: 'github:42',
        repoIdentifier: 'orgA/repo-b',
        workflowName: 'wf-b',
        events: ['foo'],
      }),
      makeWebhookRegistration({
        id: 'reg-C',
        customerId: '__default__',
        routingKey: 'github:42',
        repoIdentifier: 'orgA/repo-c',
        workflowName: 'wf-c',
        events: ['foo'],
      }),
    ];

    const deps = makeCrossSourceDeps({ registrations: regs });
    await processWebhook(baseGenericInfo(), deps);

    expect(deps.dispatcher.dispatch).toHaveBeenCalledTimes(3);
    const dispatchCalls = (deps.dispatcher.dispatch as any).mock.calls.map((c: any[]) => c[0]);
    const dedupKeys = dispatchCalls.map((c: any) => c.deliveryId).sort();
    expect(dedupKeys).toEqual([
      'generic:kiciStg00001:stg-generic:delivery-1:reg-A',
      'generic:kiciStg00001:stg-generic:delivery-1:reg-B',
      'generic:kiciStg00001:stg-generic:delivery-1:reg-C',
    ]);

    // dedup.claim called once per registration with distinct composite keys
    const markCalls = (deps.dedup.claim as any).mock.calls.map((c: any[]) => c[0]);
    expect(markCalls).toContain('generic:kiciStg00001:stg-generic:delivery-1:reg-A');
    expect(markCalls).toContain('generic:kiciStg00001:stg-generic:delivery-1:reg-B');
    expect(markCalls).toContain('generic:kiciStg00001:stg-generic:delivery-1:reg-C');
  });

  // CS-3 (Pitfall 1 regression — CRITICAL): synthetic SimulatedEvent has
  // type=inboundEventName, NOT 'generic_webhook'. If the synthetic event
  // construction is ever removed, matchWebhookTrigger will reject every
  // cross-source registration and this test will fail loudly.
  it('CS-3: PITFALL 1 — synthetic event has type=inboundEventName, not generic_webhook', async () => {
    const reg = makeWebhookRegistration({
      id: 'reg-pitfall1',
      customerId: '__default__',
      routingKey: 'github:42',
      repoIdentifier: 'orgA/repo1',
      workflowName: 'pitfall1-wf',
      events: ['foo'],
    });

    const deps = makeCrossSourceDeps({ registrations: [reg] });
    // The matcher (matchAllWorkflows) is invoked inside processWebhook with a
    // synthetic event. We assert downstream behavior: if the synthetic event
    // had type='generic_webhook' (Pitfall 1), the matcher would reject it
    // because the registration's webhook trigger lists events=['foo'], and
    // dispatcher.dispatch would NEVER be called. The fact that dispatch IS
    // called proves the synthetic event was built with type='foo'.
    await processWebhook(baseGenericInfo(), deps);

    expect(deps.dispatcher.dispatch).toHaveBeenCalledTimes(1);

    // Sanity: confirm the inbound generic webhook would have been normalized
    // to event.type='generic_webhook' (the raw normalizer output that would
    // be REJECTED by matchWebhookTrigger if not corrected).
    const genericBundle = (deps.providerRegistry as ProviderRegistry).getByRoutingKey(
      'generic:kiciStg00001:stg-generic',
    )!;
    const rawNormalized = genericBundle.normalizer.normalizeEvent('foo', null, {
      hello: 'world',
    });
    expect(rawNormalized?.type).toBe('generic_webhook');
    expect(rawNormalized?.action).toBe('foo');
  });

  // CS-4 (WHK-CROSS-04): bundle resolved from REGISTRATION's routing key,
  // never from the inbound generic source.
  it('CS-4: resolves provider bundle from registration routing key, not inbound', async () => {
    const registeredBundle = createRegisteredBundle();
    const reg = makeWebhookRegistration({
      id: 'reg-bundle-test',
      customerId: '__default__',
      routingKey: 'github:42',
      repoIdentifier: 'orgA/repo1',
      workflowName: 'bundle-test',
      events: ['foo'],
    });

    const deps = makeCrossSourceDeps({
      registrations: [reg],
      registeredBundle,
    });

    // Spy on getByRoutingKey to capture exactly which routing keys are
    // queried during cross-source dispatch.
    const registry = deps.providerRegistry as ProviderRegistry;
    const getByRoutingKeySpy = vi.spyOn(registry, 'getByRoutingKey');

    await processWebhook(baseGenericInfo(), deps);

    // The cross-source branch must call getByRoutingKey with the
    // REGISTRATION's routing key — not the inbound generic source's key.
    const queriedKeys = getByRoutingKeySpy.mock.calls.map((c) => c[0]);
    expect(queriedKeys).toContain('github:42');
    // The inbound key is queried once at the top of processWebhook to get
    // the inbound bundle, but the cross-source dispatch loop must query
    // 'github:42' separately. Assert clone token was issued via the
    // registered bundle (proves the right bundle was selected).
    expect(registeredBundle.cloneTokenProvider!.createCloneToken).toHaveBeenCalledWith(
      'orgA/repo1',
      reg.providerContext,
    );
  });

  // CS-5: clone-token failure fails fast — no fallback dispatch.
  it('CS-5: clone token failure fails fast — no dispatch, errors counter incremented', async () => {
    const failingBundle = createRegisteredBundle();
    (failingBundle.cloneTokenProvider!.createCloneToken as any).mockRejectedValueOnce(
      new Error('boom: token issuance failed'),
    );

    const reg = makeWebhookRegistration({
      id: 'reg-clone-fail',
      customerId: '__default__',
      routingKey: 'github:42',
      repoIdentifier: 'orgA/repo1',
      workflowName: 'fail-wf',
      events: ['foo'],
    });

    const deps = makeCrossSourceDeps({
      registrations: [reg],
      registeredBundle: failingBundle,
    });

    await processWebhook(baseGenericInfo(), deps);

    // dispatcher.dispatch must NOT be called for this registration
    expect(deps.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  // CS-6 (WHK-CROSS-02 — cross-org isolation): orgB registrations are not
  // returned for an inbound webhook resolving to orgA. We exercise this at
  // the processor level by mocking getByOrgAndEvent so it ONLY returns orgA
  // entries when called with orgA — and asserting the call shape.
  it('CS-6: cross-org isolation — only orgA registrations are dispatched', async () => {
    const orgARegs = [
      makeWebhookRegistration({
        id: 'reg-orgA',
        customerId: '__default__', // == resolved org for this test
        routingKey: 'github:42',
        repoIdentifier: 'orgA/repo',
        workflowName: 'orgA-wf',
        events: ['foo'],
      }),
    ];
    const orgBRegs = [
      makeWebhookRegistration({
        id: 'reg-orgB',
        customerId: 'orgB',
        routingKey: 'github:42',
        repoIdentifier: 'orgB/repo',
        workflowName: 'orgB-wf',
        events: ['foo'],
      }),
    ];

    const deps = makeCrossSourceDeps({ registrations: [...orgARegs, ...orgBRegs] });
    await processWebhook(baseGenericInfo(), deps);

    // Only the orgA registration should have been dispatched
    expect(deps.dispatcher.dispatch).toHaveBeenCalledTimes(1);
    const call = (deps.dispatcher.dispatch as any).mock.calls[0][0];
    expect(call.workflowName).toBe('orgA-wf');

    // The mock getByOrgAndEvent must have been called with the resolved org
    // ('__default__' since no db), NOT with 'orgB'.
    const idx = deps.registrationIndex as any;
    expect(idx.getByOrgAndEvent).toHaveBeenCalledWith('__default__', 'foo');
    expect(idx.getByOrgAndEvent).not.toHaveBeenCalledWith('orgB', 'foo');
  });

  // CS-7 ( — legacy github→github path is byte-identical, never enters
  // the cross-source branch).
  it('CS-7: inbound github webhook does NOT enter cross-source branch', async () => {
    const reg = makeWebhookRegistration({
      id: 'reg-untouched',
      customerId: '__default__',
      routingKey: 'github:42',
      repoIdentifier: 'orgA/repo1',
      workflowName: 'should-not-fire',
      events: ['foo'],
    });

    const mockRegistrationStore = {
      getVersion: vi.fn().mockResolvedValue(1),
    };
    const mockRegistrationIndex = {
      getByOrgAndEvent: vi.fn().mockReturnValue([reg]),
      refreshIfNeeded: vi.fn().mockResolvedValue(undefined),
      getGlobalByTriggerType: vi.fn().mockReturnValue([]),
      getGlobalByOrgAndTriggerType: vi.fn().mockReturnValue([]),
    };

    // Inbound is a github PR (NOT generic) that matches via same-source.
    const deps = createDeps({
      lockFileCache: createMockLockFileCache(matchingLockFile()) as any,
      registrationStore: mockRegistrationStore as any,
      registrationIndex: mockRegistrationIndex as any,
    });
    await processWebhook(basePrInfo(), deps);

    // Same-source PR matched -> 2 static jobs from CI workflow dispatched
    expect(deps.dispatcher.dispatch).toHaveBeenCalledTimes(2);

    // Cross-source path NOT entered: getByOrgAndEvent must never be called
    expect(mockRegistrationIndex.getByOrgAndEvent).not.toHaveBeenCalled();
  });

  // CS-8: dedup replay — second delivery of the same inbound webhook is
  // suppressed at the cross-source level via the composite dedup key.
  it('CS-8: dedup replay suppresses second delivery via composite key', async () => {
    const reg = makeWebhookRegistration({
      id: 'reg-replay',
      customerId: '__default__',
      routingKey: 'github:42',
      repoIdentifier: 'orgA/repo1',
      workflowName: 'replay-wf',
      events: ['foo'],
    });

    // First delivery: dedup.claim wins for both the inbound and composite key.
    const deps1 = makeCrossSourceDeps({ registrations: [reg] });
    await processWebhook(baseGenericInfo(), deps1);
    expect(deps1.dispatcher.dispatch).toHaveBeenCalledTimes(1);

    // Second delivery: the composite key was already claimed (row persisted
    // between deliveries), so its atomic claim loses; the inbound delivery is a
    // fresh id and still wins so the pipeline proceeds to the cross-source step.
    const deps2 = makeCrossSourceDeps({ registrations: [reg] });
    (deps2.dedup.claim as any).mockImplementation(async (key: string) => {
      return key !== 'generic:kiciStg00001:stg-generic:delivery-1:reg-replay';
    });
    await processWebhook(baseGenericInfo(), deps2);
    // dispatcher must NOT be called the second time
    expect(deps2.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  // CS-9: fanout histogram is recorded once per inbound delivery with the
  // event name label and the actual fan-out count.
  it('CS-9: records crossSourceFanoutSize histogram with fan-out count and event label', async () => {
    const regs = [
      makeWebhookRegistration({
        id: 'r1',
        customerId: '__default__',
        routingKey: 'github:42',
        repoIdentifier: 'orgA/repo1',
        workflowName: 'wf1',
        events: ['foo'],
      }),
      makeWebhookRegistration({
        id: 'r2',
        customerId: '__default__',
        routingKey: 'github:42',
        repoIdentifier: 'orgA/repo2',
        workflowName: 'wf2',
        events: ['foo'],
      }),
      makeWebhookRegistration({
        id: 'r3',
        customerId: '__default__',
        routingKey: 'github:42',
        repoIdentifier: 'orgA/repo3',
        workflowName: 'wf3',
        events: ['foo'],
      }),
    ];

    const promMod = await import('../metrics/prometheus.js');
    const recordSpy = vi.spyOn(promMod.crossSourceFanoutSize, 'record');

    const deps = makeCrossSourceDeps({ registrations: regs });
    await processWebhook(baseGenericInfo(), deps);

    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(3, { event: 'foo' });

    recordSpy.mockRestore();
  });

  // CS-10 — a dynamic-fn workflow delivered cross-source MUST queue a
  // `__dynamic__` eval job: the generator is the only thing that knows which
  // jobs the workflow has, so a delivery that dispatched nothing would be a
  // workflow that silently never runs.
  //
  // The org-global path reaches the same guarantee by a different route — the
  // Tier-2 eval round, covered in `process-webhook-globals-eval-round.test.ts`.
  it('CS-10: dynamic-fn workflow cross-source delivered queues __dynamic__ eval job', async () => {
    const reg = makeWebhookRegistration({
      id: 'reg-cs10',
      customerId: '__default__',
      routingKey: 'github:42',
      repoIdentifier: 'orgA/repo-dyn',
      workflowName: 'dyn-only-wf',
      events: ['foo'],
      jobs: [
        {
          _type: 'dynamic' as const,
          source: { file: '.kici/workflows/foo.ts', index: 0 },
        },
      ],
    });

    const mockPendingDynamics = {
      track: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
      resolve: vi.fn(),
      reject: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      cleanup: vi.fn(),
    };

    const deps = makeCrossSourceDeps({
      registrations: [reg],
      pendingDynamics: mockPendingDynamics,
    });
    await processWebhook(baseGenericInfo(), deps);

    // Give the fire-and-forget dynamic dispatch IIFE a tick to run.
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.dispatcher.dispatch).toHaveBeenCalledTimes(1);
    const call = (deps.dispatcher.dispatch as any).mock.calls[0][0];
    expect(call.jobName).toMatch(/^__dynamic__/);
    expect(call.workflowName).toBe('dyn-only-wf');
    expect(call.jobConfig.dynamicJobFn).toBe(true);
    expect(call.jobConfig.source).toEqual({
      file: '.kici/workflows/foo.ts',
      index: 0,
    });
    // Composite dedup key (cross-source override)
    expect(call.deliveryId).toBe('generic:kiciStg00001:stg-generic:delivery-1:reg-cs10');
    // Registration's routing key, not inbound generic
    expect(call.routingKey).toBe('github:42');
    // Repo URL built via the registered bundle's repoUrlBuilder
    expect(call.repoUrl).toBe('https://github.com/orgA/repo-dyn.git');
    // CS-10b regression guard for 28.4-VERIFICATION.md Gap 2: the dispatched
    // ref MUST be the empty string (so the agent's gitClone falls through to
    // the default-branch clone path) and sha MUST be the registration's
    // commitSha (so post-clone SHA verification fetch-deepens to the right
    // commit). The pre-fix code leaked the synthetic '__generic__' placeholder
    // as the dispatched ref, which produced `git clone --branch __generic__`
    // and an invariably failing remote branch lookup against github.com.
    expect(call.ref).toBe('');
    expect(call.sha).toBe('reg-sha-1');
  });

  // CS-11 — mixed static + dynamic-fn workflow cross-source delivery
  // dispatches BOTH the static job and the dynamic eval job.
  it('CS-11: mixed static+dynamic-fn workflow dispatches both job kinds', async () => {
    const reg = makeWebhookRegistration({
      id: 'reg-cs11',
      customerId: '__default__',
      routingKey: 'github:42',
      repoIdentifier: 'orgA/repo-mixed',
      workflowName: 'mixed-wf',
      events: ['foo'],
      jobs: [
        {
          _type: 'static' as const,
          name: 'do-thing',
          runsOn: [{ kind: 'exact', value: 'linux' }],
          needs: [],
          steps: [{ name: 'Run', hasOutputs: false }],
        },
        {
          _type: 'dynamic' as const,
          source: { file: '.kici/workflows/foo.ts', index: 1 },
        },
      ],
    });

    const mockPendingDynamics = {
      track: vi.fn().mockReturnValue(new Promise(() => {})),
      resolve: vi.fn(),
      reject: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      cleanup: vi.fn(),
    };

    const deps = makeCrossSourceDeps({
      registrations: [reg],
      pendingDynamics: mockPendingDynamics,
    });
    await processWebhook(baseGenericInfo(), deps);

    await new Promise((r) => setTimeout(r, 50));

    // Expect at least 2 dispatches: one static `do-thing`, one `__dynamic__` eval.
    expect((deps.dispatcher.dispatch as any).mock.calls.length).toBeGreaterThanOrEqual(2);
    const calls = (deps.dispatcher.dispatch as any).mock.calls.map(
      (c: unknown[]) => c[0] as { jobName: string; deliveryId: string; runId: string },
    );
    const jobNames = calls.map((c) => c.jobName);
    expect(jobNames).toContain('do-thing');
    expect(jobNames.some((n) => n.startsWith('__dynamic__'))).toBe(true);

    // BOTH dispatched jobs share the same composite deliveryId
    const dedupKeys = new Set(calls.map((c) => c.deliveryId));
    expect(dedupKeys.size).toBe(1);
    expect([...dedupKeys][0]).toBe('generic:kiciStg00001:stg-generic:delivery-1:reg-cs11');

    // BOTH dispatched jobs share the same runId (per-decision runId).
    const runIds = new Set(calls.map((c) => c.runId));
    expect(runIds.size).toBe(1);
  });

  // CS-12 — a static job with dynamic context fields reached via
  // cross-source delivery queues an __init__ deferred-init job.
  // Regression guard: deferred init dispatch ( two-phase init model)
  // must work through the delegated path. Before the 28.4-06 refactor,
  // this would never fire on cross-source delivery because the
  // static-only loop never reached the deferred-init builder.
  it('CS-12: static job with dynamic context queues __init__ job', async () => {
    const reg = makeWebhookRegistration({
      id: 'reg-cs12',
      customerId: '__default__',
      routingKey: 'github:42',
      repoIdentifier: 'orgA/repo-init',
      workflowName: 'init-wf',
      events: ['foo'],
      jobs: [
        {
          _type: 'static' as const,
          name: 'needs-init',
          runsOn: [{ kind: 'exact', value: 'linux' }],
          needs: [],
          steps: [{ name: 'Run', hasOutputs: false }],
          // An impure (non-inline) dynamic context element triggers needsInit
          // (the agent resolves it via an init job).
          contexts: [{ value: '', dynamic: true }],
        },
      ],
    });

    const mockPendingInits = {
      track: vi.fn().mockReturnValue(new Promise(() => {})),
      resolve: vi.fn(),
      reject: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      cleanup: vi.fn(),
    };

    const deps = makeCrossSourceDeps({
      registrations: [reg],
      pendingInits: mockPendingInits,
    });
    await processWebhook(baseGenericInfo(), deps);

    // Give the fire-and-forget deferred init dispatch IIFE a tick to run.
    await new Promise((r) => setTimeout(r, 50));

    // At least one dispatch should be an __init__ job.
    const calls = (deps.dispatcher.dispatch as any).mock.calls.map(
      (c: unknown[]) =>
        c[0] as {
          jobName: string;
          deliveryId: string;
          routingKey: string;
          repoUrl: string;
        },
    );
    const initCall = calls.find((c) => c.jobName.startsWith('__init__'));
    expect(initCall).toBeDefined();
    expect(initCall!.deliveryId).toBe('generic:kiciStg00001:stg-generic:delivery-1:reg-cs12');
    expect(initCall!.routingKey).toBe('github:42');
    expect(initCall!.repoUrl).toBe('https://github.com/orgA/repo-init.git');
  });

  // CS-13 — multi-registration fan-out preserves one delegated dispatch per
  // matched registration with distinct composite dedup keys and distinct runIds.
  // Re-asserts CS-2 invariant on the post-refactor delegated path. WHK-CROSS-06.
  it('CS-13: multi-registration fan-out has distinct runIds and composite dedup keys (reg-A/reg-B/reg-C)', async () => {
    const regs = [
      makeWebhookRegistration({
        id: 'reg-A',
        customerId: '__default__',
        routingKey: 'github:42',
        repoIdentifier: 'orgA/repo-a',
        workflowName: 'wf-a',
        events: ['foo'],
      }),
      makeWebhookRegistration({
        id: 'reg-B',
        customerId: '__default__',
        routingKey: 'github:42',
        repoIdentifier: 'orgA/repo-b',
        workflowName: 'wf-b',
        events: ['foo'],
      }),
      makeWebhookRegistration({
        id: 'reg-C',
        customerId: '__default__',
        routingKey: 'github:42',
        repoIdentifier: 'orgA/repo-c',
        workflowName: 'wf-c',
        events: ['foo'],
      }),
    ];

    const deps = makeCrossSourceDeps({ registrations: regs });
    await processWebhook(baseGenericInfo(), deps);

    expect(deps.dispatcher.dispatch).toHaveBeenCalledTimes(3);
    const calls = (deps.dispatcher.dispatch as any).mock.calls.map(
      (c: unknown[]) => c[0] as { deliveryId: string; runId: string },
    );
    const dedupKeys = calls.map((c) => c.deliveryId).sort();
    expect(dedupKeys).toEqual([
      'generic:kiciStg00001:stg-generic:delivery-1:reg-A',
      'generic:kiciStg00001:stg-generic:delivery-1:reg-B',
      'generic:kiciStg00001:stg-generic:delivery-1:reg-C',
    ]);

    // dedup.claim called once per registration with distinct composite keys
    const markCalls = (deps.dedup.claim as any).mock.calls.map((c: unknown[]) => c[0]);
    expect(markCalls).toContain('generic:kiciStg00001:stg-generic:delivery-1:reg-A');
    expect(markCalls).toContain('generic:kiciStg00001:stg-generic:delivery-1:reg-B');
    expect(markCalls).toContain('generic:kiciStg00001:stg-generic:delivery-1:reg-C');

    // Distinct runIds (one per matched decision per registration)
    const runIds = new Set(calls.map((c) => c.runId));
    expect(runIds.size).toBe(3);
  });

  // CS-14 — credentials and clone token come from the registration's bundle,
  // not the inbound generic bundle. regression guard, strengthened on
  // the delegated path. WHK-CROSS-07. Reinforces CS-4 by asserting the
  // registered bundle's token AND installationId propagate into the
  // dispatched QueuedJobInput.providerContext (CS-4 only asserted bundle
  // resolution, not credential propagation through the helper).
  // CS-15 — Phase 3 affirmation for the universal-git provider work.
  //
  // A universal-git-authored workflow is just a cross-source target whose
  // routing key is `generic:<orgId>:<sourceId>` and whose provider bundle
  // is a `UniversalGit*` implementation (normalizer.provider === 'generic',
  // full cloneTokenProvider + repoUrlBuilder). The cross-source dispatch
  // branch already uses `providerRegistry.getByRoutingKey(reg.routingKey)`
  // (processor.ts:3495), so it resolves the universal-git bundle with no
  // code change — this test is the runtime verification required by the
  // re-eval plan.
  //
  // The inbound webhook is a plain `generic:*` source (required to enter
  // the cross-source branch per the `info.provider === 'generic'` guard).
  // The target registration lives on a distinct `generic:*` routing key
  // whose bundle is a universal-git bundle — so this exercises the
  // provider='generic' inbound → provider='generic' target flow with
  // a universal-git provider bundle as the authority for clone + URL.
  it('CS-15: cross-source dispatch to universal-git-authored global workflow', async () => {
    const universalGitBundle: ProviderBundle = {
      normalizer: {
        provider: 'generic' as const,
        extractRoutingKey: vi.fn(),
        extractDeliveryId: vi.fn(),
        extractEventType: vi.fn(),
        verifySignature: vi.fn().mockReturnValue(true),
        normalizeEvent: vi.fn(),
        extractRepoIdentifier: vi.fn(),
        extractRef: vi.fn().mockReturnValue('HEAD'),
        extractCredentials: vi.fn().mockReturnValue({}),
        extractDefaultBranch: vi.fn().mockReturnValue('main'),
      },
      cloneTokenProvider: {
        provider: 'generic' as const,
        createCloneToken: vi.fn().mockResolvedValue('forgejo-pat-secret'),
      },
      repoUrlBuilder: {
        provider: 'generic' as const,
        buildCloneUrl: vi
          .fn()
          .mockImplementation((id: string) => `https://forgejo.example.com/${id}.git`),
        buildRawFileUrl: vi.fn(),
      },
    };

    // Registration points at a universal-git routing key; the helper will
    // call providerRegistry.getByRoutingKey(reg.routingKey) and get back
    // the universal-git bundle above.
    const ugRoutingKey = 'generic:kiciStg00001:forgejo-wf-source';
    const reg = makeWebhookRegistration({
      id: 'reg-cs15',
      customerId: '__default__',
      routingKey: ugRoutingKey,
      repoIdentifier: 'forgejo.example.com/kici-ci/shared-pipelines',
      workflowName: 'shared-global',
      events: ['foo'],
    });

    const genericBundle = createGenericProviderBundle();
    const registry = new ProviderRegistry();
    registry.registerByRoutingKey('generic:kiciStg00001:stg-generic', genericBundle);
    registry.registerByRoutingKey(ugRoutingKey, universalGitBundle);

    const mockRegistrationStore = { getVersion: vi.fn().mockResolvedValue(1) };
    const mockRegistrationIndex = {
      getByOrgAndEvent: vi.fn().mockReturnValue([reg]),
      refreshIfNeeded: vi.fn().mockResolvedValue(undefined),
      getGlobalByTriggerType: vi.fn().mockReturnValue([]),
      getGlobalByOrgAndTriggerType: vi.fn().mockReturnValue([]),
    };

    const deps = createDeps({
      providerRegistry: registry,
      registrationStore: mockRegistrationStore as any,
      registrationIndex: mockRegistrationIndex as any,
    });

    await processWebhook(baseGenericInfo(), deps);

    // Dispatched exactly once through the universal-git bundle.
    expect(deps.dispatcher.dispatch).toHaveBeenCalledTimes(1);
    const call = (deps.dispatcher.dispatch as any).mock.calls[0][0];

    // Registration's routingKey + provider propagate to the queued job.
    expect(call.routingKey).toBe(ugRoutingKey);
    expect(call.provider).toBe('generic');

    // Clone token issued through the universal-git bundle (not the inbound
    // generic bundle, which has no cloneTokenProvider).
    expect(universalGitBundle.cloneTokenProvider!.createCloneToken).toHaveBeenCalledTimes(1);
    expect(universalGitBundle.cloneTokenProvider!.createCloneToken).toHaveBeenCalledWith(
      'forgejo.example.com/kici-ci/shared-pipelines',
      reg.providerContext,
    );
    expect(call.providerContext.token).toBe('forgejo-pat-secret');

    // Clone URL built by the universal-git bundle (forgejo host, not GitHub).
    expect(call.repoUrl).toBe(
      'https://forgejo.example.com/forgejo.example.com/kici-ci/shared-pipelines.git',
    );
    expect(call.jobConfig.workflowRepoUrl).toBe(
      'https://forgejo.example.com/forgejo.example.com/kici-ci/shared-pipelines.git',
    );

    // Cross-source provenance: inbound routing key and event name recorded.
    expect(call.jobConfig.crossSource).toBe(true);
    expect(call.jobConfig.inboundRoutingKey).toBe('generic:kiciStg00001:stg-generic');
    expect(call.jobConfig.inboundEventName).toBe('foo');
    expect(call.jobConfig.workflowRepoIdentifier).toBe(
      'forgejo.example.com/kici-ci/shared-pipelines',
    );
  });

  it('CS-14: clone token + credentials propagate from registration bundle TOKEN-FROM-REG-BUNDLE', async () => {
    const registeredBundle = createRegisteredBundle('TOKEN-FROM-REG-BUNDLE');
    const reg = makeWebhookRegistration({
      id: 'reg-cs14',
      customerId: '__default__',
      routingKey: 'github:42',
      repoIdentifier: 'orgA/repo-creds',
      workflowName: 'creds-wf',
      events: ['foo'],
    });

    const deps = makeCrossSourceDeps({
      registrations: [reg],
      registeredBundle,
    });
    await processWebhook(baseGenericInfo(), deps);

    // Clone token was issued via the REGISTRATION's bundle with the
    // registration's providerContext.
    expect(registeredBundle.cloneTokenProvider!.createCloneToken).toHaveBeenCalledTimes(1);
    expect(registeredBundle.cloneTokenProvider!.createCloneToken).toHaveBeenCalledWith(
      'orgA/repo-creds',
      reg.providerContext,
    );

    // The inbound generic bundle has NO cloneTokenProvider in this test —
    // asserting the registered one was used is sufficient to prove no
    // fallback to the inbound bundle.
    const genericBundle = (deps.providerRegistry as ProviderRegistry).getByRoutingKey(
      'generic:kiciStg00001:stg-generic',
    )!;
    expect(genericBundle.cloneTokenProvider).toBeUndefined();

    // The dispatched job's providerContext carries BOTH the registration's
    // installationId AND the token from the registered bundle.
    expect(deps.dispatcher.dispatch).toHaveBeenCalledTimes(1);
    const call = (deps.dispatcher.dispatch as any).mock.calls[0][0];
    expect(call.providerContext.installationId).toBe(7); // from makeWebhookRegistration default
    expect(call.providerContext.token).toBe('TOKEN-FROM-REG-BUNDLE');
  });
});

describe('processWebhook — context integration', () => {
  function envLockFile(jobOverrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 9,
      source: { file: '.kici/workflows/ci.ts', export: '#default' },
      contentHash: 'test-hash',
      lockfileHash: 'lockfile-hash',
      workflows: [
        {
          name: 'CI',
          contentHash: 'wf-hash',
          compileSchemaVersion: 6,
          triggers: [
            {
              _type: 'pr',
              events: ['opened'],
              targetBranches: [],
              sourceBranches: [],
              paths: [],
            },
          ],
          jobs: [
            {
              _type: 'static',
              name: 'deploy',
              runsOn: [{ kind: 'exact', value: 'linux' }],
              needs: [],
              steps: [{ name: 'Deploy', hasOutputs: false }],
              ...jobOverrides,
            },
          ],
        },
      ],
    };
  }

  function createMockContextStore(matchResult: Record<string, unknown> | null = null) {
    return {
      matchContext: vi.fn().mockResolvedValue(matchResult),
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      getByName: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };
  }

  function createMockVariableStore(vars: Record<string, string> = {}) {
    return {
      getResolvedVars: vi.fn().mockResolvedValue(vars),
      listVars: vi.fn().mockResolvedValue([]),
      setVar: vi.fn(),
      deleteVar: vi.fn(),
      listSourceOverrides: vi.fn().mockResolvedValue([]),
      setSourceOverride: vi.fn(),
      deleteSourceOverride: vi.fn(),
    };
  }

  function createMockHeldRunStore() {
    return {
      create: vi.fn().mockResolvedValue({ id: 'held-1' }),
      createHold: vi.fn().mockResolvedValue({ id: 'held-1' }),
      recordDecision: vi.fn(),
      release: vi.fn(),
      approve: vi.fn(),
      reject: vi.fn(),
      listPending: vi.fn().mockResolvedValue([]),
      listAll: vi.fn().mockResolvedValue([]),
      getByRunAndJob: vi.fn().mockResolvedValue(null),
      expireOverdue: vi.fn().mockResolvedValue(0),
    };
  }

  it('dispatches job normally when no context is declared', async () => {
    const lockFile = envLockFile(); // No context on job
    const mockDispatcher = createMockDispatcher();
    const mockEnvStore = createMockContextStore();

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(lockFile) as any,
      dispatcher: mockDispatcher as any,
      contextStore: mockEnvStore as any,
    });

    await processWebhook(basePrInfo(), deps);

    // Job dispatched normally
    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);
    // Context store NOT called (no context declared)
    expect(mockEnvStore.matchContext).not.toHaveBeenCalled();
  });

  it('dispatches a job whose referenced context is not configured (lenient skip)', async () => {
    const lockFile = envLockFile({ contexts: [{ value: 'production', dynamic: false }] });
    const mockDispatcher = createMockDispatcher();
    const mockEnvStore = createMockContextStore(null); // No env config in DB

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(lockFile) as any,
      dispatcher: mockDispatcher as any,
      contextStore: mockEnvStore as any,
    });

    await processWebhook(basePrInfo(), deps);

    expect(mockEnvStore.matchContext).toHaveBeenCalledWith('__default__', 'production');
    // A bound context with no configured record contributes no protection
    // rules / vars but does not block dispatch — the job still runs, with the
    // declared name recorded as the run context.
    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);
    const jobConfig = mockDispatcher.dispatch.mock.calls[0][0].jobConfig;
    expect(jobConfig.context).toBe('production');
  });

  it('evaluates protection rules and rejects job when context rejects', async () => {
    const lockFile = envLockFile({ contexts: [{ value: 'production', dynamic: false }] });
    const mockDispatcher = createMockDispatcher();
    // Return a disabled context -> always rejected
    const mockEnvStore = createMockContextStore({
      id: 'env-1',
      org_id: '__default__',
      name: 'production',
      type: 'fixed',
      glob_pattern: null,
      enabled: false,
      branch_restrictions: '[]',
      trigger_type_filters: '[]',
      repo_patterns: '[]',
      concurrency_limit: null,
      concurrency_strategy: 'queue',
      concurrency_timeout_ms: 300000,
      required_reviewers: null,
      wait_timer_seconds: null,
      hold_expiry_seconds: 3600,
      minimum_trust: null,
      created_at: new Date(),
      updated_at: new Date(),
      created_by: null,
    });

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(lockFile) as any,
      dispatcher: mockDispatcher as any,
      contextStore: mockEnvStore as any,
    });

    await processWebhook(basePrInfo(), deps);

    // Job should NOT be dispatched (rejected by protection rules)
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  /** Tracker double shaped like the one the dispatcher-rejection tests use. */
  function createRejectionTracker() {
    return {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
      onJobStatus: vi.fn().mockResolvedValue(undefined),
      onStepStatus: vi.fn(),
      updateJobHeartbeat: vi.fn(),
      getExecutionContext: vi.fn(),
      getJobName: vi.fn(),
      recordInitFailureRun: vi.fn().mockResolvedValue(undefined),
    };
  }

  /** A context row that rejects every job bound to it (disabled context). */
  function disabledContextRow(name: string) {
    return {
      id: `env-${name}`,
      org_id: '__default__',
      name,
      type: 'fixed',
      glob_pattern: null,
      enabled: false,
      branch_restrictions: '[]',
      trigger_type_filters: '[]',
      repo_patterns: '[]',
      concurrency_limit: null,
      concurrency_strategy: 'queue',
      concurrency_timeout_ms: 300000,
      required_reviewers: null,
      wait_timer_seconds: null,
      hold_expiry_seconds: 3600,
      minimum_trust: null,
      created_at: new Date(),
      updated_at: new Date(),
      created_by: null,
    };
  }

  /**
   * The `rejected-*` row a context-rule rejection records, or undefined when
   * the rejection left no trace on the run at all.
   */
  function findContextRejectionRow(onJobStatus: ReturnType<typeof vi.fn>) {
    return onJobStatus.mock.calls.find(
      (args: unknown[]) =>
        typeof args[1] === 'string' && (args[1] as string).startsWith('rejected-'),
    );
  }

  it('records a context-rule rejection on the run with the rule reason', async () => {
    // A rejection used to end at a log line and a `continue`: no row, no
    // reason, and — with every job gated — an all-rejected guard that called
    // it `no_agent` / 'No jobs were dispatched for this run', telling the
    // reader no agent was available for a run that was deliberately gated.
    const lockFile = envLockFile({ contexts: [{ value: 'production', dynamic: false }] });
    const mockDispatcher = createMockDispatcher();
    const mockTracker = createRejectionTracker();
    const deps = createDeps({
      lockFileCache: createMockLockFileCache(lockFile) as any,
      dispatcher: mockDispatcher as any,
      contextStore: createMockContextStore(disabledContextRow('production')) as any,
      executionTracker: mockTracker as any,
    });

    await processWebhook(basePrInfo(), deps);

    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    const rejectedCall = findContextRejectionRow(mockTracker.onJobStatus);
    expect(rejectedCall).toBeDefined();
    // Signature: (runId, jobId, status, timestamp, agentId?, data?)
    const [, , status, , , data] = rejectedCall as unknown[];
    expect(status).toBe(ExecutionJobStatus.enum.failed);
    expect(data).toMatchObject({
      initFailure: {
        scope: 'job',
        category: InitFailureCategory.enum.context_rules,
        jobName: 'deploy',
      },
    });
    // The reason names the offending context and the rule that rejected it,
    // rather than a generic string.
    const message = (data as { initFailure: { message: string } }).initFailure.message;
    expect(message).toContain('production');
    expect(message).toContain('disabled');
    expect((data as { error: string }).error).toBe(message);
    // No run-scoped `no_agent` failure: agents were never the problem. Without
    // the rejection on the run, this records `no_agent` with
    // 'No jobs were dispatched for this run'.
    expect(mockTracker.recordInitFailureRun).not.toHaveBeenCalled();
  });

  it('records a partial context-rule rejection while the ungated job dispatches', async () => {
    // The partial case wrote nothing at all: the gated job vanished from the
    // run, so a reader saw a run that silently skipped it.
    const lockFile = envLockFile();
    lockFile.workflows[0].jobs = [
      {
        _type: 'static',
        name: 'deploy',
        runsOn: [{ kind: 'exact', value: 'linux' }],
        needs: [],
        steps: [{ name: 'Deploy', hasOutputs: false }],
        contexts: [{ value: 'production', dynamic: false }],
      } as (typeof lockFile.workflows)[0]['jobs'][0],
      {
        _type: 'static',
        name: 'lint',
        runsOn: [{ kind: 'exact', value: 'linux' }],
        needs: [],
        steps: [{ name: 'Lint', hasOutputs: false }],
      } as (typeof lockFile.workflows)[0]['jobs'][0],
    ];
    const mockDispatcher = createMockDispatcher();
    const mockTracker = createRejectionTracker();
    const deps = createDeps({
      lockFileCache: createMockLockFileCache(lockFile) as any,
      dispatcher: mockDispatcher as any,
      contextStore: createMockContextStore(disabledContextRow('production')) as any,
      executionTracker: mockTracker as any,
    });

    await processWebhook(basePrInfo(), deps);

    // The ungated job still dispatches — a rejection gates one job, not the run.
    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect((mockDispatcher.dispatch as any).mock.calls[0][0].jobName).toBe('lint');

    const rejectedCall = findContextRejectionRow(mockTracker.onJobStatus);
    expect(rejectedCall).toBeDefined();
    const [, , , , , data] = rejectedCall as unknown[];
    expect(data).toMatchObject({
      initFailure: {
        scope: 'job',
        category: InitFailureCategory.enum.context_rules,
        jobName: 'deploy',
      },
    });
  });

  it('creates held run when protection rules return hold action', async () => {
    const lockFile = envLockFile({ contexts: [{ value: 'staging', dynamic: false }] });
    const mockDispatcher = createMockDispatcher();
    const mockHeldRunStore = createMockHeldRunStore();
    // Context with required reviewers -> hold action
    const mockEnvStore = createMockContextStore({
      id: 'env-2',
      org_id: '__default__',
      name: 'staging',
      type: 'fixed',
      glob_pattern: null,
      enabled: true,
      branch_restrictions: '[]',
      trigger_type_filters: '[]',
      repo_patterns: '[]',
      concurrency_limit: null,
      concurrency_strategy: 'queue',
      concurrency_timeout_ms: 300000,
      required_reviewers: '["user1"]',
      wait_timer_seconds: null,
      hold_expiry_seconds: 7200,
      minimum_trust: null,
      created_at: new Date(),
      updated_at: new Date(),
      created_by: null,
    });

    // A bundle with a check-status poster so we can assert the pending check
    // names the approval clauses.
    const mockCheckStatusPoster = { postCheckStatus: vi.fn().mockResolvedValue(undefined) };
    const bundle = createMockProviderBundle();
    (bundle as any).checkStatusPoster = mockCheckStatusPoster;
    const mockAccessLogWriter = { record: vi.fn().mockResolvedValue(undefined) };

    const deps = createDeps({
      providerRegistry: createMockProviderRegistry(bundle),
      lockFileCache: createMockLockFileCache(lockFile) as any,
      dispatcher: mockDispatcher as any,
      contextStore: mockEnvStore as any,
      heldRunStore: mockHeldRunStore as any,
      accessLogWriter: mockAccessLogWriter as any,
      // db so storePendingJobContext (resume path) can persist the held job.
      db: createMockDb().db as any,
    });

    await processWebhook(basePrInfo(), deps);

    // Job should NOT be dispatched (held for approval)
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    // A generalized approval hold should be created (reviewer gate → env trigger)
    expect(mockHeldRunStore.createHold).toHaveBeenCalledTimes(1);
    expect(mockHeldRunStore.createHold.mock.calls[0][0]).toBe('__default__');
    expect(mockHeldRunStore.createHold.mock.calls[0][1]).toMatchObject({
      contextId: 'env-2',
      scope: 'job',
      triggerSource: 'context',
    });
    const requirement = mockHeldRunStore.createHold.mock.calls[0][1].requirement;
    expect(requirement.clauses).toEqual([{ user: 'user1' }]);

    // The pending check names the unsatisfied clause.
    expect(mockCheckStatusPoster.postCheckStatus).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'pending',
      'Held for approval',
      'Awaiting approval: user user1',
      expect.anything(),
    );

    // The hold creation is audited as held_run.request with a system actor.
    expect(mockAccessLogWriter.record).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: '__default__',
        actor: { type: 'system', component: 'dispatcher' },
        action: 'held_run.request',
        target: { type: 'held_run', id: 'held-1' },
        outcome: 'allowed',
      }),
    );
  });

  it('install gate held: pauses workflow dispatch as a workflow-scoped held run', async () => {
    // Workflow-level registries: referencing a reviewer-gated env → the install
    // gate holds, pausing the WHOLE workflow dispatch (no jobs queued).
    const lockFile = {
      schemaVersion: 9,
      source: { file: '.kici/workflows/ci.ts', export: '#default' },
      contentHash: 'test-hash',
      lockfileHash: 'lockfile-hash',
      workflows: [
        {
          name: 'CI',
          contentHash: 'wf-hash',
          compileSchemaVersion: 6,
          registries: [{ url: 'https://npm.example.com/', tokenSecret: 'prod:NPM_TOKEN' }],
          triggers: [
            { _type: 'pr', events: ['opened'], targetBranches: [], sourceBranches: [], paths: [] },
          ],
          jobs: [
            {
              _type: 'static',
              name: 'deploy',
              runsOn: [{ kind: 'exact', value: 'linux' }],
              needs: [],
              steps: [{ name: 'Deploy', hasOutputs: false }],
            },
          ],
        },
      ],
    };
    const mockDispatcher = createMockDispatcher();
    const mockHeldRunStore = createMockHeldRunStore();
    const mockEnvStore = createMockContextStore({
      id: 'env-install',
      org_id: '__default__',
      name: 'prod',
      type: 'fixed',
      glob_pattern: null,
      enabled: true,
      branch_restrictions: '[]',
      trigger_type_filters: '[]',
      repo_patterns: '[]',
      concurrency_limit: null,
      concurrency_strategy: 'queue',
      concurrency_timeout_ms: 300000,
      required_reviewers: '["alice"]',
      wait_timer_seconds: null,
      hold_expiry_seconds: 7200,
      minimum_trust: null,
      created_at: new Date(),
      updated_at: new Date(),
      created_by: null,
    });
    const mockSecretResolver = {
      resolveForJob: vi.fn().mockResolvedValue({ NPM_TOKEN: 'tok' }),
    };
    const mockTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
      onJobStatus: vi.fn().mockResolvedValue(undefined),
      onStepStatus: vi.fn(),
      updateJobHeartbeat: vi.fn(),
      getExecutionContext: vi.fn(),
      getJobName: vi.fn(),
      recordInitFailureRun: vi.fn().mockResolvedValue(undefined),
      recordRunHeld: vi.fn().mockResolvedValue(undefined),
    };

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(lockFile) as any,
      dispatcher: mockDispatcher as any,
      contextStore: mockEnvStore as any,
      secretResolver: mockSecretResolver as any,
      heldRunStore: mockHeldRunStore as any,
      executionTracker: mockTracker as any,
      db: createMockDb().db as any,
    });

    await processWebhook(basePrInfo(), deps);

    // No jobs dispatched, no init-failure recorded — the dispatch is HELD.
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    expect(mockTracker.recordInitFailureRun).not.toHaveBeenCalled();
    // A held execution run row is written.
    expect(mockTracker.recordRunHeld).toHaveBeenCalledTimes(1);
    // A workflow-scoped held_runs row keyed by the synthetic install job id.
    expect(mockHeldRunStore.createHold).toHaveBeenCalledTimes(1);
    expect(mockHeldRunStore.createHold.mock.calls[0][1]).toMatchObject({
      jobId: installGateJobId('CI'),
      scope: 'workflow',
      triggerSource: 'context',
      contextId: 'env-install',
      holdType: 'reviewer',
    });
  });

  it('includes context vars from variable store in dispatched job config', async () => {
    const lockFile = envLockFile({ contexts: [{ value: 'dev', dynamic: false }] });
    const mockDispatcher = createMockDispatcher();
    const envVars = { DB_HOST: 'localhost', API_KEY: 'test-key' };
    const mockVariableStore = createMockVariableStore(envVars);
    // Enabled context with no protection rules
    const mockEnvStore = createMockContextStore({
      id: 'env-3',
      org_id: '__default__',
      name: 'dev',
      type: 'fixed',
      glob_pattern: null,
      enabled: true,
      branch_restrictions: '[]',
      trigger_type_filters: '[]',
      repo_patterns: '[]',
      concurrency_limit: null,
      concurrency_strategy: 'queue',
      concurrency_timeout_ms: 300000,
      required_reviewers: null,
      wait_timer_seconds: null,
      hold_expiry_seconds: 3600,
      minimum_trust: null,
      created_at: new Date(),
      updated_at: new Date(),
      created_by: null,
    });

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(lockFile) as any,
      dispatcher: mockDispatcher as any,
      contextStore: mockEnvStore as any,
      variableStore: mockVariableStore as any,
    });

    await processWebhook(basePrInfo(), deps);

    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);
    const jobConfig = mockDispatcher.dispatch.mock.calls[0][0].jobConfig;
    expect(jobConfig.contextVars).toEqual(envVars);
    expect(jobConfig.context).toBe('dev');
    // Variable store called with correct args
    expect(mockVariableStore.getResolvedVars).toHaveBeenCalledWith(
      '__default__',
      'env-3',
      'github:12345', // routing key from basePrInfo
    );
  });

  it('includes static job env from lock file in job config', async () => {
    const lockFile = envLockFile({ env: { NODE_ENV: 'production', CI: 'true' } });
    const mockDispatcher = createMockDispatcher();

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(lockFile) as any,
      dispatcher: mockDispatcher as any,
    });

    await processWebhook(basePrInfo(), deps);

    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);
    const jobConfig = mockDispatcher.dispatch.mock.calls[0][0].jobConfig;
    expect(jobConfig.jobEnv).toEqual({ NODE_ENV: 'production', CI: 'true' });
  });

  it('skips context evaluation for dynamic context (flag-only)', async () => {
    const lockFile = envLockFile({ contexts: [{ value: '', dynamic: true }] });
    const mockDispatcher = createMockDispatcher();
    const mockEnvStore = createMockContextStore();

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(lockFile) as any,
      dispatcher: mockDispatcher as any,
      contextStore: mockEnvStore as any,
    });

    await processWebhook(basePrInfo(), deps);

    // Job dispatched normally (dynamic env deferred to agent)
    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);
    // Context store NOT called (dynamic)
    expect(mockEnvStore.matchContext).not.toHaveBeenCalled();
  });

  it('dispatches job with pass result from protection rules', async () => {
    const lockFile = envLockFile({ contexts: [{ value: 'staging', dynamic: false }] });
    const mockDispatcher = createMockDispatcher();
    // Enabled context with no restrictive rules -> pass
    const mockEnvStore = createMockContextStore({
      id: 'env-4',
      org_id: '__default__',
      name: 'staging',
      type: 'fixed',
      glob_pattern: null,
      enabled: true,
      branch_restrictions: '[]',
      trigger_type_filters: '[]',
      repo_patterns: '[]',
      concurrency_limit: null,
      concurrency_strategy: 'queue',
      concurrency_timeout_ms: 300000,
      required_reviewers: null,
      wait_timer_seconds: null,
      hold_expiry_seconds: 3600,
      minimum_trust: null,
      created_at: new Date(),
      updated_at: new Date(),
      created_by: null,
    });

    const deps = createDeps({
      lockFileCache: createMockLockFileCache(lockFile) as any,
      dispatcher: mockDispatcher as any,
      contextStore: mockEnvStore as any,
    });

    await processWebhook(basePrInfo(), deps);

    // Job dispatched normally (protection rules passed)
    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('anyTriggerHasPathPatterns', () => {
  it('returns false for empty workflows array', () => {
    expect(anyTriggerHasPathPatterns([])).toBe(false);
  });

  it('returns false for workflows with no path patterns', () => {
    const workflows = [
      {
        name: 'CI',
        contentHash: 'h1',
        compileSchemaVersion: 1,
        triggers: [
          {
            _type: 'pr' as const,
            events: ['opened'],
            targetBranches: [],
            sourceBranches: [],
            paths: [],
          },
        ],
        jobs: [],
      },
    ];
    expect(anyTriggerHasPathPatterns(workflows)).toBe(false);
  });

  it('returns true for workflows with paths filter', () => {
    const workflows = [
      {
        name: 'CI',
        contentHash: 'h1',
        compileSchemaVersion: 1,
        triggers: [
          {
            _type: 'pr' as const,
            events: ['opened'],
            targetBranches: [],
            sourceBranches: [],
            paths: ['src/**'],
          },
        ],
        jobs: [],
      },
    ];
    expect(anyTriggerHasPathPatterns(workflows)).toBe(true);
  });

  it('returns true for workflows with !-prefixed exclusion paths', () => {
    const workflows = [
      {
        name: 'CI',
        contentHash: 'h1',
        compileSchemaVersion: 1,
        triggers: [{ _type: 'push' as const, branches: [], paths: ['!docs/**'] }],
        jobs: [],
      },
    ];
    expect(anyTriggerHasPathPatterns(workflows)).toBe(true);
  });

  it('returns false for non-path trigger types (tag, comment, etc.)', () => {
    const workflows = [
      {
        name: 'Deploy',
        contentHash: 'h2',
        compileSchemaVersion: 1,
        triggers: [
          { _type: 'tag' as const, patterns: [] },
          { _type: 'comment' as const, actions: ['created'] },
        ],
        jobs: [],
      },
    ];
    expect(anyTriggerHasPathPatterns(workflows)).toBe(false);
  });

  it('returns true when at least one trigger across multiple workflows has paths', () => {
    const workflows = [
      {
        name: 'CI',
        contentHash: 'h1',
        compileSchemaVersion: 1,
        triggers: [
          {
            _type: 'pr' as const,
            events: ['opened'],
            targetBranches: [],
            sourceBranches: [],
            paths: [],
          },
        ],
        jobs: [],
      },
      {
        name: 'Lint',
        contentHash: 'h2',
        compileSchemaVersion: 1,
        triggers: [{ _type: 'push' as const, branches: [], paths: ['src/**'] }],
        jobs: [],
      },
    ];
    expect(anyTriggerHasPathPatterns(workflows)).toBe(true);
  });
});

describe('issue_comment /kici approve hold selection', () => {
  /** A bundle whose normalizer understands the `issue_comment` event. */
  function commentBundle() {
    const bundle = createMockProviderBundle();
    (bundle.normalizer.normalizeEvent as ReturnType<typeof vi.fn>).mockImplementation(
      (eventType: string, action: string | null, payload: Record<string, unknown>) => {
        if (eventType === 'issue_comment') {
          return {
            type: 'issue_comment' as const,
            action: action ?? undefined,
            targetBranch: 'main',
            payload,
            provider: 'github' as const,
            senderUsername: 'reviewer-user',
            // An identity link is matched on the immutable numeric id alone, so
            // without it the command is refused before any hold is selected.
            senderUserId: '7001',
          };
        }
        return null;
      },
    );
    return bundle;
  }

  /** The commenter, linked and carrying ci_trust:write — the gate before selection. */
  function trustedCommenter() {
    return {
      identityLinks: [
        {
          userId: 'user-1',
          provider: 'github',
          providerUsername: 'reviewer-user',
          providerUserId: '7001',
        },
      ],
      orgMemberPermissions: new Map([['user-1', 'write' as const]]),
    };
  }

  function commentInfo(deliveryId: string): WebhookInfo {
    return {
      routingKey: 'github:12345',
      deliveryId,
      event: 'issue_comment',
      action: 'created',
      provider: 'github',
      payload: {
        action: 'created',
        repository: { full_name: 'myorg/myrepo', owner: { login: 'myorg' }, name: 'myrepo' },
        comment: { body: '/kici approve' },
        issue: {
          number: 5,
          pull_request: { url: 'https://api.github.com/repos/myorg/myrepo/pulls/5' },
        },
        installation: { id: 42 },
        sender: { login: 'reviewer-user' },
      },
    };
  }

  it('scopes hold selection to the comment repo and PR number', async () => {
    // A `/kici` command must never reach a hold from another PR — or another
    // repo — in the same org. Each selected hold is then terminalized on the
    // commit ITS OWN run acted on, so there is no repo-wide "latest hold's sha"
    // lookup any more: this scoping is the whole of the selection contract.
    const mockHeldRunStore = {
      create: vi.fn().mockResolvedValue(undefined),
      listByQueueType: vi.fn().mockResolvedValue([]),
      listPendingSecurityHoldsForPr: vi.fn().mockResolvedValue([]),
    };

    const deps = createDeps({
      db: { selectFrom: vi.fn() } as any,
      heldRunStore: mockHeldRunStore as any,
      providerRegistry: createMockProviderRegistry(commentBundle()),
      ...trustedCommenter(),
    });

    await processWebhook(commentInfo('delivery-comment-1'), deps);

    expect(mockHeldRunStore.listPendingSecurityHoldsForPr).toHaveBeenCalledWith(
      expect.any(String),
      'myorg/myrepo',
      5,
    );
    // The org-wide list is never reached — it would return holds from every PR.
    expect(mockHeldRunStore.listByQueueType).not.toHaveBeenCalled();
  });

  it('uses the resolved org ID (not __default__) for hold selection', async () => {
    const mockSourcesChain = {
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      executeTakeFirst: vi.fn().mockResolvedValue({ customer_id: 'org-real-123' }),
    };
    const mockDb = { selectFrom: vi.fn().mockReturnValue(mockSourcesChain) };

    const mockHeldRunStore = {
      create: vi.fn().mockResolvedValue(undefined),
      listByQueueType: vi.fn().mockResolvedValue([]),
      listPendingSecurityHoldsForPr: vi.fn().mockResolvedValue([]),
    };

    const deps = createDeps({
      db: mockDb as any,
      heldRunStore: mockHeldRunStore as any,
      providerRegistry: createMockProviderRegistry(commentBundle()),
      ...trustedCommenter(),
    });

    await processWebhook(commentInfo('delivery-comment-2'), deps);

    expect(mockHeldRunStore.listPendingSecurityHoldsForPr).toHaveBeenCalledWith(
      'org-real-123',
      'myorg/myrepo',
      5,
    );
  });
});

// -- Init job dispatch tests --

function dynamicContextLockFile() {
  return {
    schemaVersion: 1,
    source: { file: '.kici/workflows/ci.ts', export: '#default' },
    contentHash: 'test-hash',
    workflows: [
      {
        name: 'Deploy',
        triggers: [
          {
            _type: 'push',
            branches: [],
            paths: [],
          },
        ],
        jobs: [
          {
            _type: 'static',
            name: 'deploy-job',
            runsOn: [{ kind: 'exact', value: 'linux' }],
            needs: [],
            contexts: [{ value: '', dynamic: true }],
            steps: [{ name: 'Deploy', hasOutputs: false }],
          },
        ],
      },
    ],
  };
}

function dynamicEnvOnlyLockFile() {
  return {
    schemaVersion: 1,
    source: { file: '.kici/workflows/ci.ts', export: '#default' },
    contentHash: 'test-hash',
    workflows: [
      {
        name: 'Deploy',
        triggers: [
          {
            _type: 'push',
            branches: [],
            paths: [],
          },
        ],
        jobs: [
          {
            _type: 'static',
            name: 'deploy-job',
            runsOn: [{ kind: 'exact', value: 'linux' }],
            needs: [],
            dynamicEnv: true,
            contexts: [{ value: 'production', dynamic: false }],
            steps: [{ name: 'Deploy', hasOutputs: false }],
          },
        ],
      },
    ],
  };
}

function multipleDynamicJobsLockFile() {
  return {
    schemaVersion: 1,
    source: { file: '.kici/workflows/ci.ts', export: '#default' },
    contentHash: 'test-hash',
    workflows: [
      {
        name: 'Deploy',
        triggers: [
          {
            _type: 'push',
            branches: [],
            paths: [],
          },
        ],
        jobs: [
          {
            _type: 'static',
            name: 'deploy-staging',
            runsOn: [{ kind: 'exact', value: 'linux' }],
            needs: [],
            contexts: [{ value: '', dynamic: true }],
            steps: [{ name: 'Deploy staging', hasOutputs: false }],
          },
          {
            _type: 'static',
            name: 'deploy-prod',
            runsOn: [{ kind: 'exact', value: 'linux' }],
            needs: [],
            dynamicConcurrencyGroup: true,
            steps: [{ name: 'Deploy prod', hasOutputs: false }],
          },
        ],
      },
    ],
  };
}

function createMockPendingInits() {
  return {
    track: vi.fn().mockResolvedValue({ contextNames: ['staging'], env: { NODE_ENV: 'staging' } }),
    resolve: vi.fn(),
    reject: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    cleanup: vi.fn(),
    size: 0,
  };
}

describe('init job dispatch (dynamic fields)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // Helper: wait for deferred init dispatches to complete (they run as fire-and-forget microtasks)
  async function waitForDeferredInits(): Promise<void> {
    // Flush microtask queue multiple times to allow chained async operations to complete
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setImmediate(r));
    }
  }

  it('dispatches init job with __init__ prefix for dynamicContext job', async () => {
    const mockDispatcher = createMockDispatcher();
    const mockPendingInits = createMockPendingInits();
    const deps = createDeps({
      dispatcher: mockDispatcher as any,
      lockFileCache: createMockLockFileCache(dynamicContextLockFile()) as any,
      pendingInits: mockPendingInits as any,
    });

    await processWebhook(basePushInfo(), deps);
    // processWebhook returns immediately; init dispatch is deferred
    await waitForDeferredInits();

    // Should dispatch init job + execution job = 2 calls
    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(2);

    // First call should be the init job (deferred but fires immediately after processWebhook)
    const initCall = mockDispatcher.dispatch.mock.calls[0][0];
    expect(initCall.jobName).toBe('__init__Deploy__deploy-job');
    expect(initCall.runsOnLabels).toEqual([
      'kici:role:init-runner',
      'kici:os:linux',
      'kici:arch:x64',
    ]);
    expect(initCall.jobConfig.initOnly).toBe(true);
    expect(initCall.jobConfig.targetJobName).toBe('deploy-job');
    expect(initCall.jobConfig.dynamicContext).toBe(true);
    expect(initCall.jobConfig.timeoutMs).toBe(60_000);
    expect(initCall.jobConfig.event).toBeDefined();
  });

  it('applies init result contextName to static resolution pipeline', async () => {
    const mockDispatcher = createMockDispatcher();
    const mockPendingInits = createMockPendingInits();
    mockPendingInits.track.mockResolvedValue({ contextNames: ['production'] });

    const deps = createDeps({
      dispatcher: mockDispatcher as any,
      lockFileCache: createMockLockFileCache(dynamicContextLockFile()) as any,
      pendingInits: mockPendingInits as any,
    });

    await processWebhook(basePushInfo(), deps);
    await waitForDeferredInits();

    // Init + execution = 2 dispatches
    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(2);
    expect(mockPendingInits.track).toHaveBeenCalledTimes(1);
  });

  it('preserves static context when only dynamicEnv is set', async () => {
    const mockDispatcher = createMockDispatcher();
    const mockPendingInits = createMockPendingInits();
    mockPendingInits.track.mockResolvedValue({ env: { DEPLOY_TARGET: 'us-east-1' } });

    const deps = createDeps({
      dispatcher: mockDispatcher as any,
      lockFileCache: createMockLockFileCache(dynamicEnvOnlyLockFile()) as any,
      pendingInits: mockPendingInits as any,
    });

    await processWebhook(basePushInfo(), deps);
    await waitForDeferredInits();

    // Init job dispatched for dynamic env
    const initCall = mockDispatcher.dispatch.mock.calls[0][0];
    expect(initCall.jobConfig.initOnly).toBe(true);
    expect(initCall.jobConfig.dynamicEnv).toBe(true);
    expect(initCall.jobConfig.dynamicContext).toBe(false);

    // Execution job dispatched after init (static context 'production' should be preserved)
    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(2);
  });

  it('skips context resolution when init returns undefined contextName', async () => {
    const mockDispatcher = createMockDispatcher();
    const mockPendingInits = createMockPendingInits();
    // Init returns no contextName --: proceed without context resolution
    mockPendingInits.track.mockResolvedValue({});

    const deps = createDeps({
      dispatcher: mockDispatcher as any,
      lockFileCache: createMockLockFileCache(dynamicContextLockFile()) as any,
      pendingInits: mockPendingInits as any,
    });

    await processWebhook(basePushInfo(), deps);
    await waitForDeferredInits();

    // Init + execution = 2 dispatches
    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(2);
    expect(mockPendingInits.track).toHaveBeenCalledTimes(1);
  });

  it('fails parent job when init job fails', async () => {
    const mockDispatcher = createMockDispatcher();
    const mockPendingInits = createMockPendingInits();
    mockPendingInits.track.mockRejectedValue(new Error('Init agent crashed'));

    const deps = createDeps({
      dispatcher: mockDispatcher as any,
      lockFileCache: createMockLockFileCache(dynamicContextLockFile()) as any,
      pendingInits: mockPendingInits as any,
    });

    await processWebhook(basePushInfo(), deps);
    await waitForDeferredInits();

    // Init job dispatched but execution job should NOT be dispatched (failed init)
    // Init dispatch + no execution dispatch = 1 call only
    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it('tags init-failed-* synthetic jobs with dynamic_eval init_failure', async () => {
    const initErrorMessage = 'Init agent crashed';
    const mockDispatcher = createMockDispatcher();
    const mockPendingInits = createMockPendingInits();
    mockPendingInits.track.mockRejectedValue(new Error(initErrorMessage));

    const mockTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      onJobStatus: vi.fn().mockResolvedValue(undefined),
      onStepStatus: vi.fn(),
      updateJobHeartbeat: vi.fn(),
      getExecutionContext: vi.fn(),
      getJobName: vi.fn(),
      recordInitFailureRun: vi.fn().mockResolvedValue(undefined),
    };

    const deps = createDeps({
      dispatcher: mockDispatcher as any,
      lockFileCache: createMockLockFileCache(dynamicContextLockFile()) as any,
      pendingInits: mockPendingInits as any,
      executionTracker: mockTracker as any,
    });

    await processWebhook(basePushInfo(), deps);
    await waitForDeferredInits();

    // The synthetic init-failed-* job is registered against the run so the
    // status update has a job row to attach to.
    const addJobsCall = mockTracker.addJobsToRun.mock.calls.find((args: unknown[]) => {
      const jobs = args[1] as Array<{ jobId: string }>;
      return Array.isArray(jobs) && jobs.some((j) => j.jobId === 'init-failed-deploy-job');
    });
    expect(addJobsCall).toBeDefined();

    // The synthetic job is marked failed with the structured init_failure
    // carrying scope=job, category=dynamic_eval, the init error as message,
    // and the parent job name.
    const failedCall = mockTracker.onJobStatus.mock.calls.find(
      (args: unknown[]) => args[1] === 'init-failed-deploy-job',
    );
    expect(failedCall).toBeDefined();
    const [, , , , , data] = failedCall as unknown[];
    expect(data).toMatchObject({
      error: initErrorMessage,
      initFailure: {
        scope: 'job',
        category: InitFailureCategory.enum.dynamic_eval,
        message: initErrorMessage,
        jobName: 'deploy-job',
      },
    });
  });

  it('deferred init honors a carried matrix_expansion category over the dynamic_eval default', async () => {
    const mockDispatcher = createMockDispatcher();
    const mockPendingInits = createMockPendingInits();
    mockPendingInits.track.mockRejectedValue(
      new AgentJobFailedError('matrix blew up', {
        scope: 'job',
        category: InitFailureCategory.enum.matrix_expansion,
        message: 'matrix blew up',
        jobName: 'deploy-job',
      }),
    );

    const mockTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn(() => true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      onJobStatus: vi.fn().mockResolvedValue(undefined),
      onStepStatus: vi.fn(),
      updateJobHeartbeat: vi.fn(),
      getExecutionContext: vi.fn(),
      getJobName: vi.fn(),
      recordInitFailureRun: vi.fn().mockResolvedValue(undefined),
    };

    const deps = createDeps({
      dispatcher: mockDispatcher as any,
      lockFileCache: createMockLockFileCache(dynamicContextLockFile()) as any,
      pendingInits: mockPendingInits as any,
      executionTracker: mockTracker as any,
    });

    await processWebhook(basePushInfo(), deps);
    await waitForDeferredInits();

    const failedCall = mockTracker.onJobStatus.mock.calls.find(
      (args: unknown[]) => args[1] === 'init-failed-deploy-job',
    );
    expect(failedCall).toBeDefined();
    const [, , , , , data] = failedCall as unknown[];
    expect(data).toMatchObject({
      initFailure: {
        scope: 'job',
        category: InitFailureCategory.enum.matrix_expansion,
        jobName: 'deploy-job',
      },
    });
  });

  it('dispatches separate init jobs for each dynamic job (no coalescing)', async () => {
    const mockDispatcher = createMockDispatcher();
    const mockPendingInits = createMockPendingInits();

    const deps = createDeps({
      dispatcher: mockDispatcher as any,
      lockFileCache: createMockLockFileCache(multipleDynamicJobsLockFile()) as any,
      pendingInits: mockPendingInits as any,
    });

    await processWebhook(basePushInfo(), deps);
    await waitForDeferredInits();

    // 2 init jobs + 2 execution jobs = 4 dispatches
    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(4);
    expect(mockPendingInits.track).toHaveBeenCalledTimes(2);

    // Verify init jobs have different names
    const initCalls = mockDispatcher.dispatch.mock.calls.filter(
      (call: any) => call[0].jobConfig?.initOnly,
    );
    expect(initCalls).toHaveLength(2);
    expect(initCalls[0][0].jobName).toBe('__init__Deploy__deploy-staging');
    expect(initCalls[1][0].jobName).toBe('__init__Deploy__deploy-prod');
  });
});

// -- Inline evaluation tests --

function inlineContextLockFile() {
  return {
    schemaVersion: 1,
    source: { file: '.kici/workflows/ci.ts', export: '#default' },
    contentHash: 'test-hash',
    workflows: [
      {
        name: 'Deploy',
        triggers: [
          {
            _type: 'push',
            branches: [],
            paths: [],
          },
        ],
        jobs: [
          {
            _type: 'static',
            name: 'deploy-job',
            runsOn: [{ kind: 'exact', value: 'linux' }],
            needs: [],
            contexts: [
              {
                value: {
                  _type: 'inline' as const,
                  expression: "(event) => event.payload.ref.split('/').pop()",
                },
                dynamic: true,
              },
            ],
            steps: [{ name: 'Deploy', hasOutputs: false }],
          },
        ],
      },
    ],
  };
}

function inlineContextErrorLockFile() {
  return {
    schemaVersion: 1,
    source: { file: '.kici/workflows/ci.ts', export: '#default' },
    contentHash: 'test-hash',
    workflows: [
      {
        name: 'Deploy',
        triggers: [
          {
            _type: 'push',
            branches: [],
            paths: [],
          },
        ],
        jobs: [
          {
            _type: 'static',
            name: 'deploy-job',
            runsOn: [{ kind: 'exact', value: 'linux' }],
            needs: [],
            contexts: [
              {
                value: {
                  _type: 'inline' as const,
                  expression: '(event) => event.nonExistent.boom',
                },
                dynamic: true,
              },
            ],
            steps: [{ name: 'Deploy', hasOutputs: false }],
          },
        ],
      },
    ],
  };
}

function mixedInlineAndDynamicLockFile() {
  return {
    schemaVersion: 1,
    source: { file: '.kici/workflows/ci.ts', export: '#default' },
    contentHash: 'test-hash',
    workflows: [
      {
        name: 'Deploy',
        triggers: [
          {
            _type: 'push',
            branches: [],
            paths: [],
          },
        ],
        jobs: [
          {
            _type: 'static',
            name: 'deploy-job',
            runsOn: [{ kind: 'exact', value: 'linux' }],
            needs: [],
            contexts: [
              {
                value: {
                  _type: 'inline' as const,
                  expression: "(event) => event.payload.ref.split('/').pop()",
                },
                dynamic: true,
              },
            ],
            dynamicEnv: true,
            // env is NOT inline -- needs init job
            steps: [{ name: 'Deploy', hasOutputs: false }],
          },
        ],
      },
    ],
  };
}

describe('inline evaluation (pure dynamic functions)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /** Wait for deferred init jobs to be dispatched (async microtask flush). */
  async function waitForDeferredInits(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setImmediate(r));
    }
  }

  it('dispatches an init job for an inline context (deferred to the eval agent)', async () => {
    const mockDispatcher = createMockDispatcher();
    const mockPendingInits = createMockPendingInits();
    const deps = createDeps({
      dispatcher: mockDispatcher as any,
      lockFileCache: createMockLockFileCache(inlineContextLockFile()) as any,
      pendingInits: mockPendingInits as any,
    });

    await processWebhook(basePushInfo(), deps);
    await waitForDeferredInits();

    // The orchestrator no longer evaluates the inline expression in-process; the
    // agent's init job resolves it, exactly like an impure dynamic context.
    const initCalls = mockDispatcher.dispatch.mock.calls.filter(
      (call: any) => call[0].jobConfig?.initOnly,
    );
    expect(initCalls).toHaveLength(1);
    expect(mockPendingInits.track).toHaveBeenCalledTimes(1);
  });

  it('dispatches init job when dynamicContext is true but context is undefined (impure, )', async () => {
    const mockDispatcher = createMockDispatcher();
    const mockPendingInits = createMockPendingInits();
    const deps = createDeps({
      dispatcher: mockDispatcher as any,
      lockFileCache: createMockLockFileCache(dynamicContextLockFile()) as any,
      pendingInits: mockPendingInits as any,
    });

    await processWebhook(basePushInfo(), deps);
    await waitForDeferredInits();

    // Should dispatch init job (backward compat for impure functions)
    const initCalls = mockDispatcher.dispatch.mock.calls.filter(
      (call: any) => call[0].jobConfig?.initOnly,
    );
    expect(initCalls).toHaveLength(1);
    expect(mockPendingInits.track).toHaveBeenCalledTimes(1);
  });

  it('does not evaluate a throwing inline expression in-process (deferred to init)', async () => {
    const mockDispatcher = createMockDispatcher();
    const mockPendingInits = createMockPendingInits();
    const deps = createDeps({
      dispatcher: mockDispatcher as any,
      lockFileCache: createMockLockFileCache(inlineContextErrorLockFile()) as any,
      pendingInits: mockPendingInits as any,
    });

    // The inline expression is never run at dispatch, so a throwing expression
    // cannot fail the run here — it defers to the agent's init job.
    await expect(processWebhook(basePushInfo(), deps)).resolves.not.toThrow();
    await waitForDeferredInits();

    const initCalls = mockDispatcher.dispatch.mock.calls.filter(
      (call: any) => call[0].jobConfig?.initOnly,
    );
    expect(initCalls).toHaveLength(1);
  });

  it('dispatches init job for non-inline dynamic field in mixed scenario', async () => {
    const mockDispatcher = createMockDispatcher();
    const mockPendingInits = createMockPendingInits();
    const deps = createDeps({
      dispatcher: mockDispatcher as any,
      lockFileCache: createMockLockFileCache(mixedInlineAndDynamicLockFile()) as any,
      pendingInits: mockPendingInits as any,
    });

    await processWebhook(basePushInfo(), deps);
    await waitForDeferredInits();

    // Should dispatch init job for the non-inline dynamicEnv field
    const initCalls = mockDispatcher.dispatch.mock.calls.filter(
      (call: any) => call[0].jobConfig?.initOnly,
    );
    expect(initCalls).toHaveLength(1);
    // Init job should indicate dynamicEnv needs resolution
    expect(initCalls[0][0].jobConfig.dynamicEnv).toBe(true);
    // The inline context is deferred to the same init job, not resolved in-orch.
    expect(mockPendingInits.track).toHaveBeenCalledTimes(1);
  });
});

// -- PendingJobContext DB persistence tests --

describe('PendingJobContext DB persistence', () => {
  const sampleJobInput = {
    runId: 'run-123',
    workflowName: 'test-wf',
    jobName: 'job-a',
    runsOnLabels: ['linux'],
    jobConfig: { foo: 'bar' },
    repoUrl: 'https://github.com/test/repo',
    ref: 'refs/heads/main',
    sha: 'abc123',
    deliveryId: 'del-1',
    provider: 'github',
    providerContext: { installationId: 42 },
    routingKey: 'github:42',
  };

  const sampleCtx = {
    jobInput: sampleJobInput,
    runsOnLabels: ['linux'],
  };

  function createMockDbForPendingContexts() {
    const insertedRows: Array<Record<string, unknown>> = [];
    const deletedFilters: Array<{ table: string; filters: Array<[string, string]> }> = [];
    let selectRows: Array<Record<string, unknown>> = [];
    // Rows the DELETE ... RETURNING fallback should surface when
    // consumePendingJobContext runs on a peer whose in-memory Map is empty.
    const pendingDbRows = new Map<string, Record<string, unknown>>();

    const mockExecute = vi.fn().mockResolvedValue(undefined);

    const mockDb = {
      insertInto: vi.fn().mockImplementation((table: string) => ({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          insertedRows.push({ ...vals, _table: table });
          return {
            onConflict: vi.fn().mockReturnValue({ execute: mockExecute }),
            execute: mockExecute,
          };
        }),
      })),
      deleteFrom: vi.fn().mockImplementation((table: string) => {
        const filters: Array<[string, string]> = [];
        const chainObj: Record<string, unknown> = {
          where: vi.fn().mockImplementation((col: string, _op: string, val: string) => {
            filters.push([col, val]);
            return chainObj;
          }),
          returning: vi.fn().mockImplementation((_cols: string[]) => {
            return {
              execute: vi.fn().mockImplementation(async () => {
                deletedFilters.push({ table, filters: [...filters] });
                if (table !== 'pending_job_contexts') return [];
                const runId = filters.find(([c]) => c === 'run_id')?.[1];
                const jobName = filters.find(([c]) => c === 'job_name')?.[1];
                if (!runId || !jobName) return [];
                const key = `${runId}:${jobName}`;
                const row = pendingDbRows.get(key);
                if (!row) return [];
                pendingDbRows.delete(key);
                return [row];
              }),
            };
          }),
          execute: vi.fn().mockImplementation(async () => {
            deletedFilters.push({ table, filters: [...filters] });
            if (table === 'pending_job_contexts') {
              const runId = filters.find(([c]) => c === 'run_id')?.[1];
              if (runId) {
                const jobName = filters.find(([c]) => c === 'job_name')?.[1];
                if (jobName) {
                  pendingDbRows.delete(`${runId}:${jobName}`);
                } else {
                  for (const k of [...pendingDbRows.keys()]) {
                    if (k.startsWith(`${runId}:`)) pendingDbRows.delete(k);
                  }
                }
              }
            }
          }),
        };
        return chainObj;
      }),
      selectFrom: vi.fn().mockImplementation((table: string) => {
        if (table === 'execution_runs') {
          // Subquery mock for restorePendingJobContexts terminal run cleanup
          const subqueryChain: Record<string, unknown> = {};
          subqueryChain.select = vi.fn().mockReturnValue(subqueryChain);
          subqueryChain.where = vi.fn().mockReturnValue(subqueryChain);
          return subqueryChain;
        }
        return {
          selectAll: vi.fn().mockReturnValue({
            execute: vi.fn().mockResolvedValue(selectRows),
          }),
        };
      }),
      _insertedRows: insertedRows,
      _deletedFilters: deletedFilters,
      _setSelectRows: (rows: Array<Record<string, unknown>>) => {
        selectRows = rows;
      },
      _seedPendingRow: (runId: string, jobName: string, row: Record<string, unknown>) => {
        pendingDbRows.set(`${runId}:${jobName}`, row);
      },
    };
    return mockDb;
  }

  beforeEach(() => {
    clearPendingJobContextsMap();
  });

  it('storePendingJobContext inserts a row into pending_job_contexts table', async () => {
    const mockDb = createMockDbForPendingContexts();

    await storePendingJobContext(mockDb as any, 'run-123', 'job-a', sampleCtx);

    expect(mockDb.insertInto).toHaveBeenCalledWith('pending_job_contexts');
    expect(mockDb._insertedRows).toHaveLength(1);
    expect(mockDb._insertedRows[0]).toEqual(
      expect.objectContaining({
        run_id: 'run-123',
        job_name: 'job-a',
        job_input: JSON.stringify(sampleJobInput),
        runs_on_labels: JSON.stringify(['linux']),
      }),
    );
  });

  it('storePendingJobContext works without DB (in-memory only)', async () => {
    await storePendingJobContext(undefined, 'run-123', 'job-a', sampleCtx);

    // Verify it's in the map by consuming it
    const result = await consumePendingJobContext(undefined, 'run-123', 'job-a');
    expect(result).toEqual(sampleCtx);
  });

  it('consumePendingJobContext deletes the row from DB and returns the context', async () => {
    const mockDb = createMockDbForPendingContexts();

    // Store first
    await storePendingJobContext(mockDb as any, 'run-123', 'job-a', sampleCtx);

    // Consume
    const result = await consumePendingJobContext(mockDb as any, 'run-123', 'job-a');

    expect(result).toEqual(sampleCtx);
    expect(mockDb.deleteFrom).toHaveBeenCalledWith('pending_job_contexts');
    expect(mockDb._deletedFilters).toHaveLength(1);
    expect(mockDb._deletedFilters[0].filters).toEqual([
      ['run_id', 'run-123'],
      ['job_name', 'job-a'],
    ]);
  });

  it('consumePendingJobContext returns undefined and does not error when no row exists', async () => {
    const mockDb = createMockDbForPendingContexts();

    const result = await consumePendingJobContext(mockDb as any, 'run-999', 'nonexistent');

    expect(result).toBeUndefined();
    // With the cluster fallback, a memory miss now triggers a single
    // DELETE ... RETURNING against the shared DB. With nothing stored,
    // the returning mock yields no rows and the function still returns
    // undefined without throwing.
    expect(mockDb.deleteFrom).toHaveBeenCalledWith('pending_job_contexts');
    expect(mockDb._deletedFilters).toHaveLength(1);
    expect(mockDb._deletedFilters[0].filters).toEqual([
      ['run_id', 'run-999'],
      ['job_name', 'nonexistent'],
    ]);
  });

  it('consumePendingJobContext falls back to DB when another peer stored the context', async () => {
    // Cluster scenario: peer A ingested the webhook and wrote the pending
    // context to the shared DB (+ its own in-memory Map). Peer B ran the
    // rerouted upstream job, so its needs-scheduler is what fires
    // onJobReady — but peer B's Map is empty. We simulate this by seeding
    // the DB-side store and leaving the in-memory Map untouched.
    const mockDb = createMockDbForPendingContexts();
    mockDb._seedPendingRow('cluster-run', 'downstream', {
      job_input: sampleJobInput,
      runs_on_labels: ['linux'],
    });

    const result = await consumePendingJobContext(mockDb as any, 'cluster-run', 'downstream');

    expect(result).toBeDefined();
    expect(result!.jobInput).toEqual(sampleJobInput);
    expect(result!.runsOnLabels).toEqual(['linux']);
    expect(mockDb.deleteFrom).toHaveBeenCalledWith('pending_job_contexts');

    // The fallback's DELETE ... RETURNING must atomically claim the row
    // so a second consumer on another peer sees undefined.
    const second = await consumePendingJobContext(mockDb as any, 'cluster-run', 'downstream');
    expect(second).toBeUndefined();
  });

  it('cleanupPendingJobContexts deletes all rows for a given run_id from DB', async () => {
    const mockDb = createMockDbForPendingContexts();

    // Store two contexts for the same run
    await storePendingJobContext(mockDb as any, 'run-123', 'job-a', sampleCtx);
    await storePendingJobContext(mockDb as any, 'run-123', 'job-b', {
      ...sampleCtx,
      jobInput: { ...sampleJobInput, jobName: 'job-b' },
    });

    // Also store one for a different run (should not be deleted)
    await storePendingJobContext(mockDb as any, 'run-456', 'job-x', sampleCtx);

    await cleanupPendingJobContexts(mockDb as any, 'run-123');

    // DB delete should be called for run-123
    expect(mockDb.deleteFrom).toHaveBeenCalledWith('pending_job_contexts');
    const deleteForCleanup = mockDb._deletedFilters.find(
      (d) => d.filters.length === 1 && d.filters[0][1] === 'run-123',
    );
    expect(deleteForCleanup).toBeDefined();

    // In-memory: run-123 contexts should be gone, run-456 should remain
    const remainingCtx = await consumePendingJobContext(undefined, 'run-456', 'job-x');
    expect(remainingCtx).toEqual(sampleCtx);

    const gonCtx = await consumePendingJobContext(undefined, 'run-123', 'job-a');
    expect(gonCtx).toBeUndefined();
  });

  it('restorePendingJobContexts loads all DB rows into the in-memory Map', async () => {
    const mockDb = createMockDbForPendingContexts();
    mockDb._setSelectRows([
      {
        run_id: 'run-abc',
        job_name: 'job-1',
        job_input: sampleJobInput,
        runs_on_labels: ['linux', 'x64'],
        created_at: new Date(),
      },
      {
        run_id: 'run-abc',
        job_name: 'job-2',
        job_input: { ...sampleJobInput, jobName: 'job-2' },
        runs_on_labels: ['arm64'],
        created_at: new Date(),
      },
    ]);

    const count = await restorePendingJobContexts(mockDb as any);

    expect(count).toBe(2);
    expect(mockDb.selectFrom).toHaveBeenCalledWith('pending_job_contexts');
  });

  it('after restorePendingJobContexts, consumePendingJobContext returns the restored context', async () => {
    const mockDb = createMockDbForPendingContexts();
    mockDb._setSelectRows([
      {
        run_id: 'run-restored',
        job_name: 'job-r',
        job_input: sampleJobInput,
        runs_on_labels: ['linux'],
        created_at: new Date(),
      },
    ]);

    await restorePendingJobContexts(mockDb as any);

    // Consume without DB (just from in-memory map)
    const result = await consumePendingJobContext(undefined, 'run-restored', 'job-r');
    expect(result).toBeDefined();
    expect(result!.jobInput).toEqual(sampleJobInput);
    expect(result!.runsOnLabels).toEqual(['linux']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Plan 28.6.2-06: multi-provider lock-file fallback
// ─────────────────────────────────────────────────────────────────────
//
// These tests cover the cross-provider lock-file resolution helper
// `resolveLockFileWithFallback()` added by Plan 06. The helper lets a
// webhook whose inbound provider bundle cannot resolve a repo's lock
// file fall back to the lock-file fetchers of OTHER provider bundles
// registered against the SAME customer's registrations for the SAME
// repo. Tenant isolation is structural (see
// `registrationIndex.getByOrgAndRepo(customerId, repo)`), the inbound
// routing key is excluded from the fallback set, and the fallback is
// deduped by routingKey.
describe('processWebhook — multi-provider lock-file fallback (28.6.2-06)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Build a push-shaped webhook coming through the internal ingress.
   * The staging stg-ha-smoke failover test sends this shape; the
   * LocalWebhookNormalizer extracts repo.full_name and strips
   * refs/heads/ to produce a push SimulatedEvent.
   */
  function internalPushInfo(
    overrides: Partial<WebhookInfo> = {},
    routingKey = 'generic:kiciStg00001:stg-generic',
  ): WebhookInfo {
    return {
      routingKey,
      deliveryId: `${routingKey}:delivery-lfb-1`,
      event: 'push',
      action: null,
      provider: 'local',
      payload: {
        ref: 'refs/heads/master',
        repository: {
          full_name: 'example-org/test-repo',
          owner: { login: 'example-org' },
          name: 'test-repo',
        },
        before: 'aaa',
        after: 'bbb',
      },
      ...overrides,
    };
  }

  /**
   * Mock bundle whose normalizer mimics the real LocalWebhookNormalizer:
   * type:'push', repo from repository.full_name, ref from payload.ref,
   * credentials={}.
   */
  function createMockInternalBundle(lockFileResult: unknown = null): ProviderBundle {
    return {
      normalizer: {
        provider: 'local' as const,
        extractRoutingKey: vi.fn(),
        extractDeliveryId: vi.fn(),
        extractEventType: vi.fn(),
        verifySignature: vi.fn().mockReturnValue(true),
        normalizeEvent: vi.fn().mockImplementation((eventType: string, _action, payload: any) => {
          if (eventType !== 'push') return null;
          const ref = payload.ref as string;
          const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
          return {
            type: 'push' as const,
            targetBranch: branch,
            payload,
            provider: 'local' as const,
          };
        }),
        extractRepoIdentifier: vi.fn().mockImplementation((payload: any) => {
          return payload?.repository?.full_name ?? null;
        }),
        extractRef: vi.fn().mockImplementation((_eventType: string, payload: any) => {
          return payload?.after ?? 'HEAD';
        }),
        extractCredentials: vi.fn().mockReturnValue({}),
      },
      lockFileFetcher: {
        provider: 'local' as const,
        fetchLockFile: vi.fn().mockResolvedValue(lockFileResult),
      },
      repoUrlBuilder: {
        provider: 'local' as const,
        buildCloneUrl: vi
          .fn()
          .mockImplementation((id: string) => `file:///tmp/internal-repos/${id}`),
        buildRawFileUrl: vi.fn(),
      },
    };
  }

  /**
   * Mock bundle modelling the github provider. Its lockFileFetcher is
   * the fallback target — it requires installationId in credentials.
   */
  function createMockGithubBundle(lockFileResult: unknown = null): ProviderBundle {
    const bundle: ProviderBundle = {
      normalizer: {
        provider: 'github' as const,
        extractRoutingKey: vi.fn(),
        extractDeliveryId: vi.fn(),
        extractEventType: vi.fn(),
        verifySignature: vi.fn().mockReturnValue(true),
        normalizeEvent: vi.fn(),
        extractRepoIdentifier: vi.fn(),
        extractRef: vi.fn(),
        extractCredentials: vi.fn().mockReturnValue({}),
      },
      lockFileFetcher: {
        provider: 'github' as const,
        fetchLockFile: vi.fn().mockResolvedValue(lockFileResult),
      },
      repoUrlBuilder: {
        provider: 'github' as const,
        buildCloneUrl: vi.fn().mockImplementation((id: string) => `https://github.com/${id}.git`),
        buildRawFileUrl: vi.fn(),
      },
    };
    return bundle;
  }

  /**
   * Lock file that matches a push trigger on master for
   * example-org/test-repo (mimics hello-firecracker).
   */
  function helloFirecrackerLockFile() {
    return {
      // A freshly-compiled current lock must carry the engine's SCHEMA_VERSION;
      // the real LockFileCache now rejects any other version as incompatible.
      schemaVersion: SCHEMA_VERSION,
      source: { file: '.kici/workflows/hello-firecracker.ts', export: '#default' },
      contentHash: 'fallback-hash',
      workflows: [
        {
          name: 'hello-firecracker',
          triggers: [{ _type: 'push' as const, branches: [], paths: [] }],
          jobs: [
            {
              _type: 'static' as const,
              name: 'say-hello',
              runsOn: [{ kind: 'exact', value: 'linux' }],
              needs: [],
              steps: [{ name: 'echo', hasOutputs: false }],
            },
          ],
        },
      ],
    };
  }

  function makeRepoRegistration(opts: {
    id: string;
    customerId: string;
    routingKey: string;
    repoIdentifier: string;
    providerContext?: Record<string, unknown>;
    disabled?: boolean;
  }) {
    return {
      id: opts.id,
      repoIdentifier: opts.repoIdentifier,
      workflowName: 'hello-firecracker',
      lockEntry: {
        name: 'hello-firecracker',
        source: { file: '.kici/workflows/hello-firecracker.ts', export: '#default' },
        contentHash: 'reg-hash',
        compileSchemaVersion: 1,
        triggers: [{ _type: 'push' as const, branches: [], paths: [] }],
        jobs: [],
      },
      triggerTypes: ['push'],
      routingKey: opts.routingKey,
      providerContext: opts.providerContext ?? { installationId: 12345 },
      disabled: opts.disabled ?? false,
      isGlobal: false,
      customerId: opts.customerId,
      commitSha: 'reg-sha',
      sourceFile: '.kici/workflows/hello-firecracker.ts',
    };
  }

  /**
   * A real LockFileCache instance (not a mock) — the fallback resolver
   * passes the fallback bundle's fetcher through the cache. Using a
   * real cache proves the cache key is provider-agnostic (a cached hit
   * from a prior webhook would short-circuit the fetcher call), but
   * here we construct a fresh empty cache per test so fetcher calls
   * are observable.
   */
  async function makeFreshLockFileCache() {
    const { LockFileCache } = await import('../lockfile-cache.js');
    return new LockFileCache({ max: 100, ttl: 60_000 });
  }

  async function makeFallbackDeps(opts: {
    inboundBundle: ProviderBundle;
    githubBundle?: ProviderBundle;
    githubRoutingKey?: string;
    registrations: ReturnType<typeof makeRepoRegistration>[];
    /** resolved org id — defaults to 'custA' (non-__default__) */
    customerId?: string;
    /** Supplied only by tests that assert what the run row records. */
    executionTracker?: ProcessingDeps['executionTracker'];
  }): Promise<ProcessingDeps> {
    const registry = new ProviderRegistry();
    registry.registerByRoutingKey('generic:kiciStg00001:stg-generic', opts.inboundBundle);
    if (opts.githubBundle) {
      registry.registerByRoutingKey(opts.githubRoutingKey ?? 'github:42', opts.githubBundle);
    }

    const customerId = opts.customerId ?? 'custA';

    const mockRegistrationIndex = {
      getByOrgAndRepo: vi.fn().mockImplementation((cid: string, repo: string) => {
        return opts.registrations.filter(
          (r) => r.customerId === cid && r.repoIdentifier === repo && !r.disabled,
        );
      }),
      getByOrgAndEvent: vi.fn().mockReturnValue([]),
      refreshIfNeeded: vi.fn().mockResolvedValue(undefined),
      getGlobalByTriggerType: vi.fn().mockReturnValue([]),
      getGlobalByOrgAndTriggerType: vi.fn().mockReturnValue([]),
    };

    const mockDb = {
      selectFrom: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi
              .fn()
              .mockResolvedValueOnce({ customer_id: customerId })
              .mockResolvedValue(undefined),
          }),
        }),
      }),
      // `recordRunStart` stamps the trust context onto the tracked run with a
      // fire-and-forget UPDATE. Only reached once an executionTracker is wired
      // in, so the tests that omit one never touch this branch.
      updateTable: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            execute: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      }),
    };

    return createDeps({
      providerRegistry: registry,
      registrationIndex: mockRegistrationIndex as any,
      lockFileCache: (await makeFreshLockFileCache()) as any,
      db: mockDb as any,
      ...(opts.executionTracker && { executionTracker: opts.executionTracker }),
    });
  }

  // Test 1 — success-first, no fallback fired.
  it('Test 1: inbound fetcher succeeds → no fallback consulted', async () => {
    const inbound = createMockInternalBundle(helloFirecrackerLockFile());
    const githubBundle = createMockGithubBundle(helloFirecrackerLockFile());

    const deps = await makeFallbackDeps({
      inboundBundle: inbound,
      githubBundle,
      registrations: [
        makeRepoRegistration({
          id: 'reg-1',
          customerId: 'custA',
          routingKey: 'github:42',
          repoIdentifier: 'example-org/test-repo',
        }),
      ],
    });

    await processWebhook(internalPushInfo(), deps);

    // Inbound fetcher called exactly once (via lockFileCache).
    expect((inbound.lockFileFetcher!.fetchLockFile as any).mock.calls.length).toBe(1);
    // Fallback fetcher NEVER called because inbound succeeded.
    expect((githubBundle.lockFileFetcher!.fetchLockFile as any).mock.calls.length).toBe(0);
    // Dispatch happened (trigger matched).
    expect((deps.dispatcher.dispatch as any).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  // Test 2 — fallback success (core case).
  it('Test 2: inbound fetcher returns null → fallback resolves via github bundle', async () => {
    const inbound = createMockInternalBundle(null);
    const githubBundle = createMockGithubBundle(helloFirecrackerLockFile());

    const reg = makeRepoRegistration({
      id: 'reg-1',
      customerId: 'custA',
      routingKey: 'github:42',
      repoIdentifier: 'example-org/test-repo',
      providerContext: { installationId: 12345 },
    });

    const deps = await makeFallbackDeps({
      inboundBundle: inbound,
      githubBundle,
      registrations: [reg],
    });

    await processWebhook(internalPushInfo(), deps);

    // Inbound fetcher called first.
    expect((inbound.lockFileFetcher!.fetchLockFile as any).mock.calls.length).toBe(1);
    // Fallback fetcher called next with REGISTRATION'S providerContext.
    const githubCalls = (githubBundle.lockFileFetcher!.fetchLockFile as any).mock.calls;
    expect(githubCalls.length).toBe(1);
    const [repoId, ref, creds] = githubCalls[0];
    expect(repoId).toBe('example-org/test-repo');
    expect(ref).toBe('bbb');
    expect(creds).toEqual({ installationId: 12345 });

    // Trigger matched → dispatch fired.
    expect((deps.dispatcher.dispatch as any).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * The run row's `routing_key` and `provider_context` MUST name the same
   * source, because a re-run rebuilds its provider pair out of exactly those
   * two columns: `resolveRerunProviderBinding` (`pipeline/rerun.ts`) looks the
   * bundle up by `routing_key` and hands it `provider_context` as the
   * credentials, then re-fetches the lock file with that pair.
   *
   * A cross-provider lock-file fallback is the one delivery shape where the
   * dispatch source is not the inbound one, so it is the only shape that can
   * split the pair. `fetchLockFileWithFallbackPhase` swaps all three of
   * `dispatchBundle` / `dispatchCredentials` / `resolvedFallbackRoutingKey`
   * together, and `setupDispatchContext` overlays `info.routingKey` with the
   * fallback key before `onExecutionStarted` writes the row — so both halves
   * come from the fallback registration.
   *
   * If that ever silently drifted so the row recorded the INBOUND key beside
   * the fallback credentials, a re-run would authenticate as the wrong
   * installation and read the wrong tree — either failing outright or
   * re-running against a lock file that is not the one the original run used.
   * Nothing else asserts the pairing, so this is the pin.
   */
  it('records the dispatch routing key with the credentials it came from', async () => {
    const inbound = createMockInternalBundle(null);
    const githubBundle = createMockGithubBundle(helloFirecrackerLockFile());

    const reg = makeRepoRegistration({
      id: 'reg-1',
      customerId: 'custA',
      routingKey: 'github:42',
      repoIdentifier: 'example-org/test-repo',
      providerContext: { installationId: 12345 },
    });

    const onExecutionStarted = vi.fn().mockResolvedValue(undefined);
    const deps = await makeFallbackDeps({
      inboundBundle: inbound,
      githubBundle,
      registrations: [reg],
      executionTracker: {
        onExecutionStarted,
        addJobsToRun: vi.fn().mockResolvedValue(undefined),
        holdRunForPendingJobs: vi.fn(() => true),
        releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
      } as any,
    });

    const inboundInfo = internalPushInfo();
    await processWebhook(inboundInfo, deps);

    // Non-vacuity: the assertion below only discriminates while the inbound
    // source and the fallback source have different routing keys.
    expect(inboundInfo.routingKey).not.toBe(reg.routingKey);

    expect(onExecutionStarted).toHaveBeenCalledTimes(1);
    const startCall = onExecutionStarted.mock.calls[0];
    // Asserted as ONE pair: a row is correct only if BOTH halves name the
    // fallback registration. Either half alone can look right while the row
    // as a whole is unusable for a re-run.
    expect({
      // `onExecutionStarted` is positional: arg 7 is providerContext,
      // arg 10 is routingKey.
      providerContext: startCall[7],
      routingKey: startCall[10],
    }).toEqual({
      providerContext: reg.providerContext,
      routingKey: reg.routingKey,
    });
  });

  // Test 3 — fallback exhaustion (multiple fetchers, none resolve).
  it('Test 3: all fallbacks exhausted → existing no-lock-file path runs, no crash', async () => {
    const inbound = createMockInternalBundle(null);
    const githubBundle1 = createMockGithubBundle(null);
    const githubBundle2 = createMockGithubBundle(null);

    const registry = new ProviderRegistry();
    registry.registerByRoutingKey('generic:kiciStg00001:stg-generic', inbound);
    registry.registerByRoutingKey('github:42', githubBundle1);
    registry.registerByRoutingKey('github:99', githubBundle2);

    const mockRegistrationIndex = {
      getByOrgAndRepo: vi.fn().mockReturnValue([
        makeRepoRegistration({
          id: 'reg-1',
          customerId: 'custA',
          routingKey: 'github:42',
          repoIdentifier: 'example-org/test-repo',
        }),
        makeRepoRegistration({
          id: 'reg-2',
          customerId: 'custA',
          routingKey: 'github:99',
          repoIdentifier: 'example-org/test-repo',
        }),
      ]),
      getByOrgAndEvent: vi.fn().mockReturnValue([]),
      refreshIfNeeded: vi.fn().mockResolvedValue(undefined),
      getGlobalByTriggerType: vi.fn().mockReturnValue([]),
      getGlobalByOrgAndTriggerType: vi.fn().mockReturnValue([]),
    };

    const mockDb = {
      selectFrom: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi
              .fn()
              .mockResolvedValueOnce({ customer_id: 'custA' })
              .mockResolvedValue(undefined),
          }),
        }),
      }),
    };

    const deps = createDeps({
      providerRegistry: registry,
      registrationIndex: mockRegistrationIndex as any,
      lockFileCache: (await makeFreshLockFileCache()) as any,
      db: mockDb as any,
    });

    await processWebhook(internalPushInfo(), deps);

    // Both fallback fetchers called.
    expect((githubBundle1.lockFileFetcher!.fetchLockFile as any).mock.calls.length).toBe(1);
    expect((githubBundle2.lockFileFetcher!.fetchLockFile as any).mock.calls.length).toBe(1);
    // No dispatch (no lock file resolved, no global workflows).
    expect((deps.dispatcher.dispatch as any).mock.calls.length).toBe(0);
  });

  // Test 4 — strict tenant boundary (security).
  it('Test 4: strict tenant boundary — customer B registration is NEVER consulted for customer A webhook', async () => {
    const inbound = createMockInternalBundle(null);
    // Customer B's github bundle exists in the registry with the
    // same repoIdentifier registered under it — but it MUST NOT be
    // reachable from a customer A webhook.
    const customerBGithub = createMockGithubBundle(helloFirecrackerLockFile());

    const registry = new ProviderRegistry();
    registry.registerByRoutingKey('generic:kiciStg00001:stg-generic', inbound);
    registry.registerByRoutingKey('github:99', customerBGithub);

    // registrationIndex returns NO same-customer registrations for custA.
    // Cross-customer registrations would only surface under getByOrgAndRepo('custB', ...)
    const getByOrgAndRepoSpy = vi.fn().mockImplementation((cid: string, _repo: string) => {
      if (cid === 'custA') return [];
      if (cid === 'custB')
        return [
          makeRepoRegistration({
            id: 'reg-custB',
            customerId: 'custB',
            routingKey: 'github:99',
            repoIdentifier: 'example-org/test-repo',
          }),
        ];
      return [];
    });

    const mockRegistrationIndex = {
      getByOrgAndRepo: getByOrgAndRepoSpy,
      getByOrgAndEvent: vi.fn().mockReturnValue([]),
      refreshIfNeeded: vi.fn().mockResolvedValue(undefined),
      getGlobalByTriggerType: vi.fn().mockReturnValue([]),
      getGlobalByOrgAndTriggerType: vi.fn().mockReturnValue([]),
    };

    const mockDb = {
      selectFrom: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi
              .fn()
              .mockResolvedValueOnce({ customer_id: 'custA' })
              .mockResolvedValue(undefined),
          }),
        }),
      }),
    };

    const getByRoutingKeySpy = vi.spyOn(registry, 'getByRoutingKey');

    const deps = createDeps({
      providerRegistry: registry,
      registrationIndex: mockRegistrationIndex as any,
      lockFileCache: (await makeFreshLockFileCache()) as any,
      db: mockDb as any,
    });

    await processWebhook(internalPushInfo(), deps);

    // Only custA was looked up.
    expect(getByOrgAndRepoSpy).toHaveBeenCalledWith('custA', 'example-org/test-repo');
    expect(getByOrgAndRepoSpy).not.toHaveBeenCalledWith('custB', 'example-org/test-repo');
    // Customer B's fetcher NEVER called — strict tenant boundary.
    expect((customerBGithub.lockFileFetcher!.fetchLockFile as any).mock.calls.length).toBe(0);
    // The fallback never consulted github:99 via providerRegistry.
    const queriedKeys = getByRoutingKeySpy.mock.calls.map((c) => c[0]);
    expect(queriedKeys).not.toContain('github:99');
    // No dispatch happened.
    expect((deps.dispatcher.dispatch as any).mock.calls.length).toBe(0);
  });

  // Test 5 — dedupe by routingKey.
  it('Test 5: two registrations with the same routingKey → fallback fetcher called ONCE', async () => {
    const inbound = createMockInternalBundle(null);
    const githubBundle = createMockGithubBundle(helloFirecrackerLockFile());

    const deps = await makeFallbackDeps({
      inboundBundle: inbound,
      githubBundle,
      registrations: [
        makeRepoRegistration({
          id: 'reg-1',
          customerId: 'custA',
          routingKey: 'github:42',
          repoIdentifier: 'example-org/test-repo',
        }),
        makeRepoRegistration({
          id: 'reg-2',
          customerId: 'custA',
          routingKey: 'github:42',
          repoIdentifier: 'example-org/test-repo',
        }),
      ],
    });

    await processWebhook(internalPushInfo(), deps);

    // Fallback fetcher called exactly ONCE despite two registrations
    // sharing the same routingKey.
    expect((githubBundle.lockFileFetcher!.fetchLockFile as any).mock.calls.length).toBe(1);
  });

  // Test 6 (28.6.2-07 Task 3) — fallback no-same-customer log fires at INFO level.
  it('Test 6-07: fallback no-same-customer registrations log fires at info level with full context', async () => {
    // Reset logger spies so earlier tests don't pollute assertions.
    mockPipelineLogger.info.mockClear();
    mockPipelineLogger.debug.mockClear();

    const inbound = createMockInternalBundle(null);

    // No github bundle registered — so no fallback fetchers at all.
    // But registrationIndex returns [] for this customerId + repo,
    // triggering the "no same-customer registrations" miss path.
    const deps = await makeFallbackDeps({
      inboundBundle: inbound,
      registrations: [], // no registrations → getByOrgAndRepo returns []
    });

    await processWebhook(internalPushInfo(), deps);

    // The elevated INFO log fires with the expected message and context.
    const infoLogCalls = mockPipelineLogger.info.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === 'string' &&
        call[0] === 'Multi-provider fallback: no same-customer registrations for repo',
    );
    expect(infoLogCalls.length).toBe(1);
    const logContext = infoLogCalls[0][1] as Record<string, unknown>;
    expect(logContext).toMatchObject({
      inboundRoutingKey: 'generic:kiciStg00001:stg-generic',
      customerId: 'custA',
      repoIdentifier: 'example-org/test-repo',
      attemptedFallbacks: 0,
    });
    expect(logContext.deliveryId).toBeDefined();

    // The message is NOT at debug level (proves the elevation worked).
    const debugLogCalls = mockPipelineLogger.debug.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === 'string' &&
        call[0] === 'Multi-provider fallback: no same-customer registrations for repo',
    );
    expect(debugLogCalls.length).toBe(0);
  });

  // Test 7 — inbound routingKey excluded from fallback set.
  it('Test 7: inbound routingKey excluded from fallback — no self-recursion', async () => {
    // Inbound is now github:42 (not internal). Its fetcher returns
    // null (simulated transient failure). getByOrgAndRepo returns a
    // registration with the SAME routingKey — it must be filtered
    // out so the same fetcher is not invoked twice.
    const inbound = createMockGithubBundle(null);

    const registry = new ProviderRegistry();
    registry.registerByRoutingKey('github:42', inbound);

    const mockRegistrationIndex = {
      getByOrgAndRepo: vi.fn().mockReturnValue([
        makeRepoRegistration({
          id: 'reg-self',
          customerId: 'custA',
          routingKey: 'github:42',
          repoIdentifier: 'myorg/myrepo',
        }),
      ]),
      getByOrgAndEvent: vi.fn().mockReturnValue([]),
      refreshIfNeeded: vi.fn().mockResolvedValue(undefined),
      getGlobalByTriggerType: vi.fn().mockReturnValue([]),
      getGlobalByOrgAndTriggerType: vi.fn().mockReturnValue([]),
    };

    // The github bundle's normalizer needs to handle a push event.
    (inbound.normalizer.normalizeEvent as any).mockImplementation(
      (eventType: string, _action: any, payload: any) => {
        if (eventType !== 'push') return null;
        const ref = payload.ref as string;
        const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
        return {
          type: 'push' as const,
          targetBranch: branch,
          payload,
          provider: 'github' as const,
        };
      },
    );
    (inbound.normalizer.extractRepoIdentifier as any).mockImplementation((payload: any) => {
      return payload?.repository?.full_name ?? null;
    });
    (inbound.normalizer.extractRef as any).mockImplementation(
      (_eventType: string, payload: any) => {
        return payload?.after ?? 'HEAD';
      },
    );

    const mockDb = {
      selectFrom: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi
              .fn()
              .mockResolvedValueOnce({ customer_id: 'custA' })
              .mockResolvedValue(undefined),
          }),
        }),
      }),
    };

    const deps = createDeps({
      providerRegistry: registry,
      registrationIndex: mockRegistrationIndex as any,
      lockFileCache: (await makeFreshLockFileCache()) as any,
      db: mockDb as any,
    });

    const pushInfo: WebhookInfo = {
      routingKey: 'github:42',
      deliveryId: 'github:42:delivery-self',
      event: 'push',
      action: null,
      provider: 'github',
      payload: {
        ref: 'refs/heads/master',
        repository: {
          full_name: 'myorg/myrepo',
          owner: { login: 'myorg' },
          name: 'myrepo',
        },
        before: 'aaa',
        after: 'bbb',
      },
    };

    await processWebhook(pushInfo, deps);

    // Inbound fetcher called exactly ONCE total — dedupe prevents
    // second call via fallback path.
    expect((inbound.lockFileFetcher!.fetchLockFile as any).mock.calls.length).toBe(1);
  });

  // Plan 28.6.2-08: cross-provider dispatch — fallback bundle propagation
  // ─────────────────────────────────────────────────────────────────────
  // These tests verify that when resolveLockFileWithFallback returns
  // resolvedVia='fallback', the dispatch site swaps to the winning bundle's
  // repoUrlBuilder and credentials (Layer 4 of the cross-provider pipeline
  // binding fix).

  // Test A (regression): inbound fetcher succeeds → dispatch uses inbound bundle's repoUrlBuilder.
  it('Test A-08: inbound fetcher succeeds → dispatch uses inbound bundle repoUrl', async () => {
    const inbound = createMockInternalBundle(helloFirecrackerLockFile());
    const githubBundle = createMockGithubBundle(helloFirecrackerLockFile());

    const deps = await makeFallbackDeps({
      inboundBundle: inbound,
      githubBundle,
      registrations: [
        makeRepoRegistration({
          id: 'reg-1',
          customerId: 'custA',
          routingKey: 'github:42',
          repoIdentifier: 'example-org/test-repo',
        }),
      ],
    });

    await processWebhook(internalPushInfo(), deps);

    // Dispatch happened with the INBOUND bundle's repoUrl (file://).
    const dispatchCalls = (deps.dispatcher.dispatch as any).mock.calls;
    expect(dispatchCalls.length).toBeGreaterThanOrEqual(1);
    const firstJobInput = dispatchCalls[0][0];
    expect(firstJobInput.repoUrl).toBe('file:///tmp/internal-repos/example-org/test-repo');
    // providerContext should be the inbound credentials ({}).
    expect(firstJobInput.providerContext).toEqual({});
  });

  // Test B (core fix): fallback fires → dispatch uses winning bundle's repoUrlBuilder + credentials.
  it('Test B-08: fallback fires → dispatch uses winning bundle repoUrl + credentials', async () => {
    const inbound = createMockInternalBundle(null);
    const githubBundle = createMockGithubBundle(helloFirecrackerLockFile());

    const reg = makeRepoRegistration({
      id: 'reg-1',
      customerId: 'custA',
      routingKey: 'github:42',
      repoIdentifier: 'example-org/test-repo',
      providerContext: { installationId: 12345 },
    });

    const deps = await makeFallbackDeps({
      inboundBundle: inbound,
      githubBundle,
      registrations: [reg],
    });

    await processWebhook(internalPushInfo(), deps);

    // Dispatch happened with the GITHUB bundle's repoUrl (https://).
    const dispatchCalls = (deps.dispatcher.dispatch as any).mock.calls;
    expect(dispatchCalls.length).toBeGreaterThanOrEqual(1);
    const firstJobInput = dispatchCalls[0][0];
    expect(firstJobInput.repoUrl).toBe('https://github.com/example-org/test-repo.git');
    // providerContext should be the registration's providerContext, NOT the inbound's {}.
    expect(firstJobInput.providerContext).toEqual({ installationId: 12345 });
  });

  // Test C: fallback fires but winning bundle has no repoUrlBuilder → repoUrl is empty string.
  it('Test C-08: fallback bundle has no repoUrlBuilder → repoUrl is empty string', async () => {
    const inbound = createMockInternalBundle(null);
    // Create a github bundle with lockFileFetcher but NO repoUrlBuilder.
    const githubBundleNoUrl: ProviderBundle = {
      normalizer: {
        provider: 'github' as const,
        extractRoutingKey: vi.fn(),
        extractDeliveryId: vi.fn(),
        extractEventType: vi.fn(),
        verifySignature: vi.fn().mockReturnValue(true),
        normalizeEvent: vi.fn(),
        extractRepoIdentifier: vi.fn(),
        extractRef: vi.fn(),
        extractCredentials: vi.fn().mockReturnValue({}),
      },
      lockFileFetcher: {
        provider: 'github' as const,
        fetchLockFile: vi.fn().mockResolvedValue(helloFirecrackerLockFile()),
      },
      // No repoUrlBuilder!
    };

    const reg = makeRepoRegistration({
      id: 'reg-1',
      customerId: 'custA',
      routingKey: 'github:42',
      repoIdentifier: 'example-org/test-repo',
      providerContext: { installationId: 99999 },
    });

    const deps = await makeFallbackDeps({
      inboundBundle: inbound,
      githubBundle: githubBundleNoUrl,
      registrations: [reg],
    });

    await processWebhook(internalPushInfo(), deps);

    // Dispatch happened — trigger matched.
    const dispatchCalls = (deps.dispatcher.dispatch as any).mock.calls;
    expect(dispatchCalls.length).toBeGreaterThanOrEqual(1);
    const firstJobInput = dispatchCalls[0][0];
    // repoUrl is empty string because the fallback bundle has no repoUrlBuilder.
    expect(firstJobInput.repoUrl).toBe('');
  });
});

describe('resolveLockFileWithFallback — corrupt lock handling', () => {
  function inboundBundle(): ProviderBundle {
    return {
      normalizer: {
        provider: 'local' as const,
        extractRoutingKey: vi.fn(),
        extractDeliveryId: vi.fn(),
        extractEventType: vi.fn(),
        verifySignature: vi.fn(),
        normalizeEvent: vi.fn(),
        extractRepoIdentifier: vi.fn(),
        extractRef: vi.fn(),
        extractCredentials: vi.fn().mockReturnValue({}),
      },
      lockFileFetcher: {
        provider: 'local' as const,
        fetchLockFile: vi.fn(),
      },
      repoUrlBuilder: {
        provider: 'local' as const,
        buildCloneUrl: vi.fn(),
        buildRawFileUrl: vi.fn(),
      },
    };
  }

  const baseArgs = (overrides: Record<string, unknown>) => ({
    inboundBundle: inboundBundle(),
    inboundRoutingKey: 'internal:rk',
    repoIdentifier: 'a/b',
    ref: 'main',
    inboundCredentials: {},
    customerId: 'cust1',
    providerRegistry: {} as never,
    registrationIndex: undefined,
    deliveryId: 'd1',
    ...overrides,
  });

  it('returns resolvedVia=corrupt when the inbound lock is corrupt and nothing resolves', async () => {
    const lockFileCache = {
      get: vi.fn().mockRejectedValue(new LockFileParseError('a/b', 'main', 'bad json')),
    } as never;
    const result = await resolveLockFileWithFallback(
      baseArgs({ lockFileCache }) as Parameters<typeof resolveLockFileWithFallback>[0],
    );
    expect(result.resolvedVia).toBe('corrupt');
    expect(result.lockFile).toBeNull();
    expect(result.corruptError).toBeInstanceOf(LockFileParseError);
  });

  it('returns resolvedVia=miss (not corrupt) when every attempt is a plain absent miss', async () => {
    const lockFileCache = { get: vi.fn().mockResolvedValue(null) } as never;
    const result = await resolveLockFileWithFallback(
      baseArgs({ lockFileCache }) as Parameters<typeof resolveLockFileWithFallback>[0],
    );
    expect(result.resolvedVia).toBe('miss');
    expect(result.lockFile).toBeNull();
    expect(result.corruptError).toBeUndefined();
  });

  it('lets a valid fallback win over a corrupt inbound', async () => {
    const validLock = {
      schemaVersion: 1,
      source: { file: 'x', export: '#default' },
      contentHash: 'h',
      workflows: [],
    };
    // Inbound throws corrupt; the fallback routing key's fetcher resolves a valid lock.
    const lockFileCache = {
      get: vi
        .fn()
        .mockRejectedValueOnce(new LockFileParseError('a/b', 'main', 'bad json'))
        .mockResolvedValueOnce(validLock),
    } as never;
    const fallbackBundle: ProviderBundle = {
      ...inboundBundle(),
      lockFileFetcher: { provider: 'github' as const, fetchLockFile: vi.fn() },
    };
    const registrationIndex = {
      getByOrgAndRepo: vi
        .fn()
        .mockReturnValue([
          { routingKey: 'github:fallback', providerContext: { installationId: 1 } },
        ]),
    } as never;
    const providerRegistry = {
      getByRoutingKey: vi.fn().mockReturnValue(fallbackBundle),
    } as never;
    const result = await resolveLockFileWithFallback(
      baseArgs({
        lockFileCache,
        registrationIndex,
        providerRegistry,
      }) as Parameters<typeof resolveLockFileWithFallback>[0],
    );
    expect(result.resolvedVia).toBe('fallback');
    expect(result.lockFile).not.toBeNull();
    expect(result.corruptError).toBeUndefined();
  });
});

describe('result-aware eval gate', () => {
  it('openEvalGate resolves the tracked promise and returns true', async () => {
    const runId = 'run-eg-1';
    const evalJob = '__dynamic__ci__0';
    const gate = trackEvalGate(runId, evalJob);
    expect(isEvalGatePending(runId, evalJob)).toBe(true);
    const handled = openEvalGate(runId, evalJob);
    expect(handled).toBe(true);
    await expect(gate).resolves.toBeUndefined();
    // Gate is consumed: a second open finds nothing.
    expect(openEvalGate(runId, evalJob)).toBe(false);
    expect(isEvalGatePending(runId, evalJob)).toBe(false);
  });

  it('openEvalGate returns false for an unregistered job (normal dispatch path)', () => {
    expect(openEvalGate('run-eg-2', 'some-regular-job')).toBe(false);
  });

  it('clearEvalGatesForRun drops gates only for the given run', () => {
    const a = trackEvalGate('run-eg-3', '__dynamic__ci__0');
    void a;
    trackEvalGate('run-eg-4', '__dynamic__ci__0');
    clearEvalGatesForRun('run-eg-3');
    expect(isEvalGatePending('run-eg-3', '__dynamic__ci__0')).toBe(false);
    expect(isEvalGatePending('run-eg-4', '__dynamic__ci__0')).toBe(true);
    // cleanup
    clearEvalGatesForRun('run-eg-4');
  });
});

describe('dispatchReadyJob — a pending hold is not dispatchable', () => {
  // The needs scheduler claims a downstream on `needs_satisfied` alone and calls
  // dispatchReadyJob, which had no held_runs check at all. So
  // `job('deploy', { needs: ['build'], approval: true })` reached an agent the
  // moment `build` succeeded, while its hold row still said `pending`.
  //
  // Every release path flips the row to `released` BEFORE dispatching, so this
  // gate cannot block a legitimate resume — the control below is that case.
  function dbWith(holdStatus: string | null) {
    return {
      selectFrom: () => ({
        select: function (this: unknown) {
          return this;
        },
        selectAll: function (this: unknown) {
          return this;
        },
        where: function (this: unknown) {
          return this;
        },
        // The real query filters on `status = pending`, so it yields a row
        // only for a pending hold — the stub mirrors that rather than echoing
        // whatever status it was given.
        executeTakeFirst: async () =>
          holdStatus === 'pending' ? { status: holdStatus } : undefined,
        // The needs gate reads `execution_job_needs` with `execute`. No rows =
        // no needs edges, which reads as dispatchable — the ordinary job these
        // hold-gate cases model.
        execute: async () => [],
      }),
      deleteFrom: () => ({
        where: function (this: unknown) {
          return this;
        },
        execute: async () => undefined,
        returningAll: function (this: unknown) {
          return this;
        },
        executeTakeFirst: async () => undefined,
      }),
    } as never;
  }

  const jobInput = { runId: 'run-hold', jobName: 'deploy', jobConfig: {} } as never;

  it('refuses to dispatch while the hold is pending, and keeps the context', async () => {
    await storePendingJobContext(undefined, 'run-hold', 'deploy', {
      jobInput,
      runsOnLabels: ['default'],
    });
    const dispatch = vi.fn();

    await dispatchReadyJob(
      'run-hold',
      'deploy',
      { dispatch } as never,
      undefined,
      undefined,
      dbWith('pending'),
    );

    expect(dispatch).not.toHaveBeenCalled();
    // The context must survive, or the eventual approval would find nothing to
    // dispatch and the job would be stranded.
    const still = await consumePendingJobContext(undefined, 'run-hold', 'deploy');
    expect(still).toBeDefined();
  });

  it('keeps refusing while a SECOND hold on the same job is still pending', async () => {
    // A job carrying an SDK `requireApproval` AND a security-typed context gate
    // gets TWO `held_runs` rows on one (run_id, job_id), because two independent
    // requirements gate it and it may only run once both are satisfied. This
    // gate is the whole mechanism for that: the query filters on
    // `status = 'pending'` and takes the first match, so releasing one row still
    // yields the other and the job stays held. The stub models exactly that.
    //
    // The stub records its `where` clauses, because the filter is the load-
    // bearing part: without `status = 'pending'` the query would take whichever
    // of the two rows Postgres returned first, and a released row would read as
    // "nothing is holding this job" while the other still gated it.
    const rows = [{ status: 'released' }, { status: 'pending' }];
    const wheres: unknown[][] = [];
    const twoHoldDb = {
      selectFrom: () => ({
        select: function (this: unknown) {
          return this;
        },
        selectAll: function (this: unknown) {
          return this;
        },
        where: function (this: unknown, ...args: unknown[]) {
          wheres.push(args);
          return this;
        },
        executeTakeFirst: async () =>
          // Applied by the query, not assumed by the stub: with no status
          // filter this yields the released row, exactly as Postgres would.
          wheres.some((w) => w[0] === 'status')
            ? rows.find((r) => r.status === 'pending')
            : rows[0],
      }),
      deleteFrom: () => ({
        where: function (this: unknown) {
          return this;
        },
        execute: async () => undefined,
        returningAll: function (this: unknown) {
          return this;
        },
        executeTakeFirst: async () => undefined,
      }),
    } as never;

    await storePendingJobContext(undefined, 'run-two-holds', 'deploy', {
      jobInput: { runId: 'run-two-holds', jobName: 'deploy', jobConfig: {} } as never,
      runsOnLabels: ['default'],
    });
    const dispatch = vi.fn();

    await dispatchReadyJob(
      'run-two-holds',
      'deploy',
      { dispatch } as never,
      undefined,
      undefined,
      twoHoldDb,
    );

    expect(wheres).toContainEqual(['status', '=', HeldRunStatus.Pending]);
    expect(dispatch).not.toHaveBeenCalled();
    // And the resume path survives for whoever answers the second hold.
    expect(await consumePendingJobContext(undefined, 'run-two-holds', 'deploy')).toBeDefined();
  });

  it('dispatches once the hold is released', async () => {
    // The positive control. Identical setup, differing only in hold status —
    // so a gate that refused everything would fail here.
    await storePendingJobContext(undefined, 'run-rel', 'deploy', {
      jobInput: { runId: 'run-rel', jobName: 'deploy', jobConfig: {} } as never,
      runsOnLabels: ['default'],
    });
    const dispatch = vi
      .fn()
      .mockResolvedValue({ status: 'dispatched', agentId: 'a1', jobId: 'j1' });

    await dispatchReadyJob(
      'run-rel',
      'deploy',
      { dispatch } as never,
      undefined,
      undefined,
      dbWith('released'),
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('dispatches when there is no hold at all', async () => {
    // The ordinary needs-gated job: no hold row, nothing to wait for.
    await storePendingJobContext(undefined, 'run-none', 'deploy', {
      jobInput: { runId: 'run-none', jobName: 'deploy', jobConfig: {} } as never,
      runsOnLabels: ['default'],
    });
    const dispatch = vi
      .fn()
      .mockResolvedValue({ status: 'dispatched', agentId: 'a1', jobId: 'j1' });

    await dispatchReadyJob(
      'run-none',
      'deploy',
      { dispatch } as never,
      undefined,
      undefined,
      dbWith(null),
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  /**
   * The gate is the enforcement point for "both requirements answered" on a job
   * carrying two holds, so answering `false` on a read error dispatched a job
   * with neither hold released. It now refuses, and retries first so a single
   * blip does not park the job.
   */
  describe('a hold read that fails', () => {
    function throwingDb(failures: number, calls: { n: number }) {
      return {
        selectFrom: () => ({
          select: function (this: unknown) {
            return this;
          },
          where: function (this: unknown) {
            return this;
          },
          executeTakeFirst: async () => {
            calls.n++;
            if (calls.n <= failures) throw new Error('connection terminated');
            return undefined; // no hold — the job would dispatch if we got here
          },
          // Only the hold read fails here; the needs gate reads cleanly and
          // reports no edges, so this case isolates the hold retry ladder.
          execute: async () => [],
        }),
        deleteFrom: () => ({
          where: function (this: unknown) {
            return this;
          },
          execute: async () => undefined,
          returningAll: function (this: unknown) {
            return this;
          },
          executeTakeFirst: async () => undefined,
        }),
      } as never;
    }

    it('refuses the dispatch once every attempt has failed', async () => {
      const calls = { n: 0 };
      await storePendingJobContext(undefined, 'run-db-down', 'deploy', {
        jobInput: { runId: 'run-db-down', jobName: 'deploy', jobConfig: {} } as never,
        runsOnLabels: ['default'],
      });
      const dispatch = vi.fn();

      await dispatchReadyJob(
        'run-db-down',
        'deploy',
        { dispatch } as never,
        undefined,
        undefined,
        throwingDb(PENDING_HOLD_READ_ATTEMPTS, calls),
      );

      expect(calls.n).toBe(PENDING_HOLD_READ_ATTEMPTS);
      expect(dispatch).not.toHaveBeenCalled();
      // Parked, not lost: the context is still there for the release path and
      // for the needs-scheduler recovery loop on the next start.
      expect(await consumePendingJobContext(undefined, 'run-db-down', 'deploy')).toBeDefined();
    });

    it('dispatches when a transient failure clears within the retries', async () => {
      // Two failures then a success, pinned as a literal rather than derived
      // from PENDING_HOLD_READ_ATTEMPTS: a count expressed in terms of the
      // constant moves with it, so shrinking the budget to 1 would still pass.
      const calls = { n: 0 };
      await storePendingJobContext(undefined, 'run-db-blip', 'deploy', {
        jobInput: { runId: 'run-db-blip', jobName: 'deploy', jobConfig: {} } as never,
        runsOnLabels: ['default'],
      });
      const dispatch = vi
        .fn()
        .mockResolvedValue({ status: 'dispatched', agentId: 'a1', jobId: 'j1' });

      await dispatchReadyJob(
        'run-db-blip',
        'deploy',
        { dispatch } as never,
        undefined,
        undefined,
        throwingDb(2, calls),
      );

      expect(calls.n).toBe(3);
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('budgets enough attempts to ride out a blip', () => {
      // The refusal is only a cheap trade because a single transient error does
      // not park the job. One attempt would make every blip a park.
      expect(PENDING_HOLD_READ_ATTEMPTS).toBeGreaterThanOrEqual(3);
    });

    it('hasPendingHold answers held rather than free when the read never succeeds', async () => {
      const calls = { n: 0 };
      const held = await hasPendingHold(throwingDb(99, calls), 'run-x', 'deploy', {
        attempts: 2,
        retryBaseMs: 0,
      });
      expect(held).toBe(true);
      expect(calls.n).toBe(2);
    });
  });
});

describe('extractDefaultBranch', () => {
  /** Minimal normalizer stub — only the hook this helper reads is populated. */
  function normalizerWith(hook?: (p: Record<string, unknown>) => string | null) {
    return { ...(hook && { extractDefaultBranch: hook }) } as never;
  }

  it('prefers the provider-specific normalizer hook', () => {
    const payload = { repository: { default_branch: 'master' } };
    expect(
      extractDefaultBranch(
        payload,
        normalizerWith(() => 'trunk'),
      ),
    ).toBe('trunk');
  });

  it('falls back to payload.repository.default_branch when the hook returns null', () => {
    const payload = { repository: { default_branch: 'main' } };
    expect(
      extractDefaultBranch(
        payload,
        normalizerWith(() => null),
      ),
    ).toBe('main');
  });

  it('falls back to payload.repository.default_branch when there is no hook', () => {
    const payload = { repository: { default_branch: 'main' } };
    expect(extractDefaultBranch(payload, normalizerWith())).toBe('main');
  });

  it('returns null when neither source names a default branch', () => {
    expect(extractDefaultBranch({}, normalizerWith())).toBeNull();
    expect(
      extractDefaultBranch(
        { repository: {} },
        normalizerWith(() => null),
      ),
    ).toBeNull();
  });
});

describe('summarizeDecision', () => {
  function decisionWithChecks(count: number): WorkflowDecision {
    return {
      workflowName: 'build',
      matched: true,
      matchedTrigger: 0,
      summary: 'Trigger conditions met',
      checks: Array.from({ length: count }, (_, index) => ({
        check: `check-${index}`,
        pattern: 'main',
        value: 'main',
        passed: true,
      })),
    };
  }

  it('forwards every check when the decision is under the cap', () => {
    const summary = summarizeDecision(decisionWithChecks(3));
    expect(summary.checksCount).toBe(3);
    expect(summary.checks).toHaveLength(3);
    expect(summary.checksTruncated).toBeUndefined();
  });

  it('caps the forwarded checks and flags the truncation', () => {
    const summary = summarizeDecision(decisionWithChecks(60));
    expect(summary.checksCount).toBe(60);
    expect(summary.checks).toHaveLength(DECISION_TRACE_MAX_CHECKS);
    expect(summary.checksTruncated).toBe(true);
  });

  it('carries the full trace at exactly the cap without flagging truncation', () => {
    const summary = summarizeDecision(decisionWithChecks(DECISION_TRACE_MAX_CHECKS));
    expect(summary.checks).toHaveLength(DECISION_TRACE_MAX_CHECKS);
    expect(summary.checksTruncated).toBeUndefined();
  });
});

describe('capDecisionSummaries', () => {
  /** A summary whose single check carries a pathological free-text value. */
  function fatSummary(index: number, valueBytes: number): Record<string, unknown> {
    return summarizeDecision({
      workflowName: `wf-${index}`,
      matched: false,
      checks: [
        {
          check: 'bodyMatch (regex)',
          pattern: '^/deploy',
          value: 'x'.repeat(valueBytes),
          passed: false,
        },
      ],
      summary: 'No matching trigger',
    });
  }

  it('passes a small trace through untouched', () => {
    const summaries = [fatSummary(0, 10), fatSummary(1, 10)];
    const capped = capDecisionSummaries(summaries);
    expect(capped).toEqual(summaries);
  });

  it('bounds the serialized payload for a pathological trace', () => {
    // A comment body at the provider's 64 KiB ceiling, fanned out across a
    // hundred comment-triggered workflows: ~6 MB on one frame before the cap.
    const summaries = Array.from({ length: 100 }, (_, i) => fatSummary(i, 65_536));
    const capped = capDecisionSummaries(summaries);

    expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThanOrEqual(DECISION_TRACE_MAX_BYTES);
    // Positive control: it kept something and said what it dropped, rather than
    // silently emitting an empty array.
    expect(capped.length).toBeGreaterThan(1);
    const marker = capped.at(-1)!;
    expect(marker.traceTruncated).toBe(true);
    expect(marker.decisionsOmitted).toBe(100 - (capped.length - 1));
  });

  it('keeps the marker alone when even one decision overruns the budget', () => {
    const capped = capDecisionSummaries([fatSummary(0, DECISION_TRACE_MAX_BYTES * 2)]);
    expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThanOrEqual(DECISION_TRACE_MAX_BYTES);
    expect(capped).toHaveLength(1);
    expect(capped[0]!.decisionsOmitted).toBe(1);
  });
});
