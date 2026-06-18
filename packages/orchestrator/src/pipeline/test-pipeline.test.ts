import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { encryptJson } from '@kici-dev/shared';
import {
  processTestTrigger,
  type TestTriggerInput,
  type TestPipelineDeps,
} from './test-pipeline.js';

// --- Mock helpers ---

function createMockLockFile(workflows: any[] = []) {
  return {
    schemaVersion: 4 as const,
    source: { file: '.kici/workflows/ci.ts', export: '#default' },
    contentHash: 'abc123',
    lockfileHash: 'lock123',
    workflows,
  };
}

function createMockWorkflow(name: string, jobs: any[] = []) {
  return {
    name,
    source: { file: '.kici/workflows/ci.ts', export: '#default' },
    contentHash: 'wf-hash-123',
    triggers: [
      {
        _type: 'push' as const,
        branches: [{ type: 'glob' as const, pattern: 'main' }],
        paths: [],
      },
    ],
    jobs:
      jobs.length > 0
        ? jobs
        : [
            {
              _type: 'static' as const,
              name: 'test-job',
              runsOn: 'default',
              steps: [{ name: 'echo', run: 'echo hello' }],
              needs: [],
              rules: [],
            },
          ],
  };
}

function createMockDeps(overrides: Partial<TestPipelineDeps> = {}): TestPipelineDeps {
  return {
    lockFileCache: {
      get: vi.fn().mockResolvedValue(null),
      getStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0 }),
    } as any,
    dispatcher: {
      dispatch: vi
        .fn()
        .mockResolvedValue({ status: 'dispatched', agentId: 'agent-1', jobId: 'job-1' }),
    } as any,
    agentRegistry: {
      findAvailable: vi.fn().mockReturnValue([]),
    } as any,
    providerRegistry: {
      getByRoutingKey: vi.fn().mockReturnValue({
        normalizer: {},
        lockFileFetcher: { fetchLockFile: vi.fn() },
        repoUrlBuilder: { buildCloneUrl: vi.fn().mockReturnValue('https://example.com/repo.git') },
      }),
    } as any,
    ...overrides,
  };
}

function createMockInput(overrides: Partial<TestTriggerInput> = {}): TestTriggerInput {
  return {
    fixtureId: 'push-main',
    event: {
      type: 'push',
      targetBranch: 'main',
      payload: { ref: 'refs/heads/main' },
    },
    routingKey: 'github:42',
    requestId: 'req-123',
    ...overrides,
  };
}

describe('processTestTrigger', () => {
  let deps: TestPipelineDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('creates execution run with isTestRun=true marker', async () => {
    const lockFile = createMockLockFile([createMockWorkflow('ci')]);
    (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

    const mockDb = {
      updateTable: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            execute: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      }),
    };

    const executionTracker = {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      markTestRun: vi.fn(),
      db: mockDb,
    };

    deps.executionTracker = executionTracker as any;
    const input = createMockInput();

    const result = await processTestTrigger(input, deps);

    expect(result.status).toBe('accepted');
    expect(result.runId).toBeDefined();
    expect(result.jobIds.length).toBeGreaterThan(0);

    // Verify execution tracker was called
    expect(executionTracker.onExecutionStarted).toHaveBeenCalledOnce();
    const trackerArgs = executionTracker.onExecutionStarted.mock.calls[0];
    expect(trackerArgs[0]).toBe(result.runId); // runId
    expect(trackerArgs[1]).toBe('ci'); // workflowName

    // Wait for the async is_test_run update
    await vi.waitFor(() => {
      expect(mockDb.updateTable).toHaveBeenCalledWith('execution_runs');
    });
  });

  it('matches triggers from lock file for push event', async () => {
    const lockFile = createMockLockFile([createMockWorkflow('ci'), createMockWorkflow('deploy')]);
    (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

    const input = createMockInput({
      event: {
        type: 'push',
        targetBranch: 'main',
        payload: { ref: 'refs/heads/main' },
      },
    });

    const result = await processTestTrigger(input, deps);

    // Both workflows have push triggers matching 'main'
    expect(result.status).toBe('accepted');
    expect(result.jobIds.length).toBeGreaterThan(0);
  });

  it('expands a matrix job into N dispatches each carrying matrixValues', async () => {
    const matrixWorkflow = createMockWorkflow('ci', [
      {
        _type: 'static' as const,
        name: 'test-job',
        runsOn: 'default',
        steps: [{ name: 'echo', run: 'echo hello' }],
        needs: [],
        rules: [],
        matrix: { _type: 'static', values: { variant: ['a', 'b'] } },
      },
    ]);
    (deps.lockFileCache.get as any).mockResolvedValue(createMockLockFile([matrixWorkflow]));

    await processTestTrigger(createMockInput(), deps);

    const dispatchSpy = deps.dispatcher.dispatch as any;
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
    const calls = dispatchSpy.mock.calls.map((c: any[]) => c[0]);
    const byName = Object.fromEntries(calls.map((c: any) => [c.jobName, c]));
    expect(Object.keys(byName).sort()).toEqual(['test-job (a)', 'test-job (b)']);
    expect(byName['test-job (a)'].jobConfig.matrixValues).toEqual({ variant: 'a' });
    expect(byName['test-job (a)'].jobConfig.baseJobName).toBe('test-job');
    expect(byName['test-job (a)'].jobConfig.matrix).toBeUndefined();
  });

  it('with workflowName bypasses trigger matching', async () => {
    // Create a workflow whose triggers do NOT match the event
    const lockFile = createMockLockFile([createMockWorkflow('ci')]);
    (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

    const input = createMockInput({
      event: {
        type: 'push',
        targetBranch: 'feature/something',
        payload: {},
      },
      workflowName: 'ci',
    });

    const result = await processTestTrigger(input, deps);

    // Even though the event doesn't match triggers, direct mode should work
    expect(result.status).toBe('accepted');
    expect(result.jobIds.length).toBeGreaterThan(0);
  });

  it('with workflowName rejects unknown workflow', async () => {
    const lockFile = createMockLockFile([createMockWorkflow('ci')]);
    (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

    const input = createMockInput({
      workflowName: 'nonexistent-workflow',
    });

    const result = await processTestTrigger(input, deps);

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('nonexistent-workflow');
    expect(result.reason).toContain('not found');
    expect(result.jobIds).toEqual([]);
  });

  it('with no matching triggers returns rejected status', async () => {
    const lockFile = createMockLockFile([createMockWorkflow('ci')]);
    (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

    const input = createMockInput({
      event: {
        type: 'push',
        targetBranch: 'feature/unmatched',
        payload: {},
      },
    });

    const result = await processTestTrigger(input, deps);

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('No matching workflows');
    expect(result.jobIds).toEqual([]);
  });

  it('deliveryId has test: prefix', async () => {
    const lockFile = createMockLockFile([createMockWorkflow('ci')]);
    (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

    const input = createMockInput();
    const dispatchSpy = deps.dispatcher.dispatch as any;

    await processTestTrigger(input, deps);

    expect(dispatchSpy).toHaveBeenCalled();
    const dispatchArg = dispatchSpy.mock.calls[0][0];
    expect(dispatchArg.deliveryId).toMatch(/^test:/);
  });

  it('uploadId is passed through to job config', async () => {
    const lockFile = createMockLockFile([createMockWorkflow('ci')]);
    (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

    const input = createMockInput({
      uploadId: 'upload-abc-123',
    });

    const dispatchSpy = deps.dispatcher.dispatch as any;

    await processTestTrigger(input, deps);

    expect(dispatchSpy).toHaveBeenCalled();
    const jobConfig = dispatchSpy.mock.calls[0][0].jobConfig;
    expect(jobConfig.tarballUploadId).toBe('upload-abc-123');
    expect(jobConfig.isTestRun).toBe(true);
    expect(jobConfig.fixtureId).toBe('push-main');
  });

  it('rejects when no lock file found', async () => {
    (deps.lockFileCache.get as any).mockResolvedValue(null);

    const input = createMockInput();
    const result = await processTestTrigger(input, deps);

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('No lock file');
  });

  it('rejects when no provider found for routing key', async () => {
    (deps.providerRegistry.getByRoutingKey as any).mockReturnValue(null);

    const input = createMockInput();
    const result = await processTestTrigger(input, deps);

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('No provider found');
  });

  it('returns unique runId', async () => {
    const lockFile = createMockLockFile([createMockWorkflow('ci')]);
    (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

    const input = createMockInput();

    const result1 = await processTestTrigger(input, deps);
    const result2 = await processTestTrigger(input, deps);

    expect(result1.runId).not.toBe(result2.runId);
  });

  it('does not forward the raw fixture secret mapping as testSecrets', async () => {
    const lockFile = createMockLockFile([createMockWorkflow('ci')]);
    (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

    const input = createMockInput({
      secrets: { db: 'test-database', api: 'test-api-key' },
    });

    const dispatchSpy = deps.dispatcher.dispatch as any;
    await processTestTrigger(input, deps);

    // The fixture mapping { contextName: environmentName } is resolved into
    // namespaced secrets, never forwarded verbatim as the dead `testSecrets`
    // field (which only the local test-runner ever consumed).
    const jobConfig = dispatchSpy.mock.calls[0][0].jobConfig;
    expect(jobConfig.testSecrets).toBeUndefined();
  });

  it('rejects when provider has no lockFileFetcher', async () => {
    (deps.providerRegistry.getByRoutingKey as any).mockReturnValue({
      normalizer: {},
      // No lockFileFetcher
    });

    const input = createMockInput();
    const result = await processTestTrigger(input, deps);

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('No provider found');
  });

  describe('inline lock file (fullRepo mode)', () => {
    it('uses inline lock file and skips provider lookup', async () => {
      const lockFile = createMockLockFile([createMockWorkflow('ci')]);
      const input = createMockInput({
        inlineLockFile: JSON.stringify(lockFile),
        fullRepo: true,
        routingKey: 'local:my-project',
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('accepted');
      expect(result.jobIds.length).toBeGreaterThan(0);
      // Provider registry should NOT be called for inline lock file path
      expect(deps.providerRegistry.getByRoutingKey).not.toHaveBeenCalled();
    });

    it('rejects invalid inline lock file JSON', async () => {
      const input = createMockInput({
        inlineLockFile: 'not valid json{{{',
        fullRepo: true,
        routingKey: 'local:my-project',
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('rejected');
      expect(result.reason).toBe('Invalid inline lock file JSON');
    });

    it('propagates fullRepo in jobConfig', async () => {
      const lockFile = createMockLockFile([createMockWorkflow('ci')]);
      const input = createMockInput({
        inlineLockFile: JSON.stringify(lockFile),
        fullRepo: true,
        routingKey: 'local:my-project',
      });

      const dispatchSpy = deps.dispatcher.dispatch as any;
      await processTestTrigger(input, deps);

      expect(dispatchSpy).toHaveBeenCalled();
      const jobConfig = dispatchSpy.mock.calls[0][0].jobConfig;
      expect(jobConfig.fullRepo).toBe(true);
    });

    it('sets repoUrl to empty string for fullRepo (pitfall 2)', async () => {
      const lockFile = createMockLockFile([createMockWorkflow('ci')]);
      const input = createMockInput({
        inlineLockFile: JSON.stringify(lockFile),
        fullRepo: true,
        routingKey: 'local:my-project',
      });

      const dispatchSpy = deps.dispatcher.dispatch as any;
      await processTestTrigger(input, deps);

      expect(dispatchSpy).toHaveBeenCalled();
      const jobInput = dispatchSpy.mock.calls[0][0];
      expect(jobInput.repoUrl).toBe('');
    });
  });

  describe('environment allowLocalExecution gate', () => {
    it('rejects fullRepo run when environment disallows test runs', async () => {
      const workflowWithEnv = createMockWorkflow('ci', [
        {
          _type: 'static' as const,
          name: 'deploy-job',
          runsOn: 'default',
          steps: [{ name: 'deploy', run: 'echo deploy' }],
          needs: [],
          rules: [],
          environment: 'production',
        },
      ]);
      const lockFile = createMockLockFile([workflowWithEnv]);

      const mockDb = {
        selectFrom: vi.fn((table: string) => {
          const chain: any = {
            select: vi.fn(() => chain),
            where: vi.fn(() => chain),
            executeTakeFirst: vi.fn(async () => {
              if (table === 'environments') return { allow_local_execution: false };
              return undefined;
            }),
          };
          return chain;
        }),
      };

      deps.db = mockDb as any;

      const input = createMockInput({
        inlineLockFile: JSON.stringify(lockFile),
        fullRepo: true,
        routingKey: 'local:my-project',
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('does not allow test runs');
      expect(result.reason).toContain('production');
    });

    it('allows fullRepo run when environment has allowLocalExecution=true', async () => {
      const workflowWithEnv = createMockWorkflow('ci', [
        {
          _type: 'static' as const,
          name: 'deploy-job',
          runsOn: 'default',
          steps: [{ name: 'deploy', run: 'echo deploy' }],
          needs: [],
          rules: [],
          environment: 'staging',
        },
      ]);
      const lockFile = createMockLockFile([workflowWithEnv]);

      const mockDb = {
        selectFrom: vi.fn((table: string) => {
          const chain: any = {
            select: vi.fn(() => chain),
            where: vi.fn(() => chain),
            executeTakeFirst: vi.fn(async () => {
              if (table === 'environments') return { allow_local_execution: true };
              return undefined;
            }),
          };
          return chain;
        }),
      };

      deps.db = mockDb as any;

      const input = createMockInput({
        inlineLockFile: JSON.stringify(lockFile),
        fullRepo: true,
        routingKey: 'local:my-project',
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('accepted');
      expect(result.jobIds.length).toBeGreaterThan(0);
    });

    it('rejects real-repo (remote) run when environment disallows test runs', async () => {
      const ORG = 'org-remote-gate';
      const workflowWithEnv = createMockWorkflow('ci', [
        {
          _type: 'static' as const,
          name: 'deploy-job',
          runsOn: 'default',
          steps: [{ name: 'deploy', run: 'echo deploy' }],
          needs: [],
          rules: [],
          environment: 'production',
        },
      ]);
      const lockFile = createMockLockFile([workflowWithEnv]);
      (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

      // db mock answering resolveOrgId (sources -> ORG) and the org-scoped
      // environments lookup. Capture the org_id the gate filters on so we can
      // assert it is the resolved org id, not a name-only query.
      let envQueryOrgId: string | undefined;
      const mockDb = {
        selectFrom: vi.fn((table: string) => ({
          select: vi.fn(() => {
            const chain: any = {
              where: vi.fn((col: string, _op: string, val: string) => {
                if (table === 'environments' && col === 'org_id') envQueryOrgId = val;
                return chain;
              }),
              executeTakeFirst: vi.fn(async () => {
                if (table === 'sources') return { customer_id: ORG };
                if (table === 'generic_webhook_sources') return undefined;
                if (table === 'environments') return { allow_local_execution: false };
                return undefined;
              }),
            };
            return chain;
          }),
        })),
      };

      deps.db = mockDb as any;

      // fullRepo is NOT set -- this is a normal remote test run.
      const input = createMockInput({ routingKey: 'github:42' });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('does not allow test runs');
      expect(result.reason).toContain('production');
      // The env lookup must be scoped by the resolved org id.
      expect(envQueryOrgId).toBe(ORG);
    });

    it('skips environment gate when no db is provided', async () => {
      const lockFile = createMockLockFile([createMockWorkflow('ci')]);
      (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

      const input = createMockInput(); // no deps.db set

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('accepted');
    });
  });

  describe('test-scoped secret resolution', () => {
    const TEST_ORG = 'org-secret-test';

    // Build a db mock that answers both resolveOrgId (sources lookup) and the
    // environments lookup in resolveTestRunSecrets, keyed on the table name.
    function makeSecretDb(envRows: Record<string, { allow_local_execution: boolean }>) {
      return {
        selectFrom: vi.fn((table: string) => ({
          select: vi.fn(() => {
            // Capture the env name from the chained `.where('name', '=', X)`.
            let envName: string | undefined;
            const chain: any = {
              where: vi.fn((col: string, _op: string, val: string) => {
                if (col === 'name') envName = val;
                return chain;
              }),
              executeTakeFirst: vi.fn(async () => {
                if (table === 'sources') return { customer_id: TEST_ORG };
                if (table === 'generic_webhook_sources') return undefined;
                if (table === 'environments') return envName ? envRows[envName] : undefined;
                return undefined;
              }),
            };
            return chain;
          }),
          // execution_runs marker update path used by recordTestExecutionStart.
          updateTable: vi.fn(),
        })),
        updateTable: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => ({ execute: vi.fn().mockResolvedValue(undefined) })),
          })),
        })),
      };
    }

    function captureDispatchedJobConfig(deps: TestPipelineDeps): () => any {
      const dispatch = vi
        .fn()
        .mockResolvedValue({ status: 'dispatched', agentId: 'agent-1', jobId: 'job-1' });
      (deps.dispatcher as any).dispatch = dispatch;
      return () => dispatch.mock.calls[0]?.[0]?.jobConfig;
    }

    /** Generate an orchestrator x25519 keypair as base64 DER (matches route shape). */
    function makeOrchestratorKeypair(): { publicKeyDer: Buffer; privateKeyB64: string } {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
      return {
        publicKeyDer: Buffer.from(publicKey.export({ type: 'spki', format: 'der' })),
        privateKeyB64: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' })).toString(
          'base64',
        ),
      };
    }

    it('resolves test-env namespaced secrets via the fixture mapping', async () => {
      const lockFile = createMockLockFile([createMockWorkflow('ci')]);
      const perEnv = new Map<string, Record<string, string>>([
        ['test-database', { KICI_DATABASE_URL: 'test://db' }],
      ]);
      deps.db = makeSecretDb({ 'test-database': { allow_local_execution: true } }) as any;
      deps.secretResolver = {
        resolveForJob: vi.fn(async (_org: string, env: string) => perEnv.get(env) ?? {}),
      } as any;
      const getJobConfig = captureDispatchedJobConfig(deps);

      const input = createMockInput({
        inlineLockFile: JSON.stringify(lockFile),
        routingKey: 'github:42',
        secrets: { db: 'test-database' },
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('accepted');
      expect(getJobConfig().namespacedSecrets.db.KICI_DATABASE_URL).toBe('test://db');
    });

    it('CLI-uploaded secrets override test-env values', async () => {
      const workflowWithEnv = createMockWorkflow('ci', [
        {
          _type: 'static' as const,
          name: 'test-job',
          runsOn: 'default',
          steps: [{ name: 'echo', run: 'echo hi' }],
          needs: [],
          rules: [],
          environment: 'test-database',
        },
      ]);
      const lockFile = createMockLockFile([workflowWithEnv]);
      const perEnv = new Map<string, Record<string, string>>([
        ['test-database', { KICI_DATABASE_URL: 'shared' }],
      ]);
      deps.db = makeSecretDb({ 'test-database': { allow_local_execution: true } }) as any;
      deps.secretResolver = {
        resolveForJob: vi.fn(async (_org: string, env: string) => perEnv.get(env) ?? {}),
      } as any;
      const getJobConfig = captureDispatchedJobConfig(deps);

      const kp = makeOrchestratorKeypair();
      const { ciphertextB64, senderPublicKeyB64 } = encryptJson(
        { flat: { KICI_DATABASE_URL: 'local' }, contexts: {} },
        kp.publicKeyDer,
      );

      const input = createMockInput({
        inlineLockFile: JSON.stringify(lockFile),
        routingKey: 'github:42',
        encryptedSecrets: ciphertextB64,
        encryptedSecretsKey: senderPublicKeyB64,
        resolvedOverlay: {
          tarballUrl: 'https://example.com/t.tgz',
          cliPublicKey: 'cli-pub',
          orchestratorPrivateKey: kp.privateKeyB64,
        },
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('accepted');
      expect(getJobConfig().secrets.KICI_DATABASE_URL).toBe('local');
    });

    it('rejects when a fixture maps to a non-test-allowed environment', async () => {
      const lockFile = createMockLockFile([createMockWorkflow('ci')]);
      deps.db = makeSecretDb({ production: { allow_local_execution: false } }) as any;
      deps.secretResolver = {
        resolveForJob: vi.fn(async () => ({})),
      } as any;

      const input = createMockInput({
        inlineLockFile: JSON.stringify(lockFile),
        routingKey: 'github:42',
        secrets: { db: 'production' },
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('db');
      expect(result.reason).toContain('production');
    });
  });

  describe('inline (pure dynamic) environment resolution', () => {
    const INLINE_ORG = 'org-inline';

    // db mock answering resolveOrgId (sources -> ORG) and the org-scoped
    // environments lookup keyed on the env name.
    function makeInlineDb(envRows: Record<string, { allow_local_execution: boolean }>) {
      return {
        selectFrom: vi.fn((table: string) => ({
          select: vi.fn(() => {
            let envName: string | undefined;
            const chain: any = {
              where: vi.fn((col: string, _op: string, val: string) => {
                if (col === 'name') envName = val;
                return chain;
              }),
              executeTakeFirst: vi.fn(async () => {
                if (table === 'sources') return { customer_id: INLINE_ORG };
                if (table === 'generic_webhook_sources') return undefined;
                if (table === 'environments') return envName ? envRows[envName] : undefined;
                return undefined;
              }),
            };
            return chain;
          }),
        })),
        updateTable: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => ({ execute: vi.fn().mockResolvedValue(undefined) })),
          })),
        })),
      };
    }

    const inlineEnvExpression =
      "(event) => event.targetBranch === 'master' ? 'test-db' : 'production'";

    function inlineEnvWorkflow() {
      return createMockWorkflow('ci', [
        {
          _type: 'static' as const,
          name: 'deploy-job',
          runsOn: 'default',
          steps: [{ name: 'deploy', run: 'echo deploy' }],
          needs: [],
          rules: [],
          dynamicEnvironment: true,
          environment: { _type: 'inline' as const, expression: inlineEnvExpression },
        },
      ]);
    }

    it('gates on the resolved inline environment name', async () => {
      const lockFile = createMockLockFile([inlineEnvWorkflow()]);
      (deps.lockFileCache.get as any).mockResolvedValue(lockFile);
      deps.db = makeInlineDb({ 'test-db': { allow_local_execution: false } }) as any;

      const input = createMockInput({
        routingKey: 'github:42',
        workflowName: 'ci',
        event: { type: 'push', targetBranch: 'master', payload: {} },
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('rejected');
      expect(result.reason).toMatch(/test-db.*does not allow test runs/);
    });

    it('resolves B1 secrets via the resolved inline environment name', async () => {
      const lockFile = createMockLockFile([inlineEnvWorkflow()]);
      (deps.lockFileCache.get as any).mockResolvedValue(lockFile);
      deps.db = makeInlineDb({ 'test-db': { allow_local_execution: true } }) as any;

      const resolveForJob = vi.fn(async (_org: string, env: string) =>
        env === 'test-db' ? { DB_URL: 'x' } : {},
      );
      deps.secretResolver = { resolveForJob } as any;

      const dispatch = vi
        .fn()
        .mockResolvedValue({ status: 'dispatched', agentId: 'agent-1', jobId: 'job-1' });
      (deps.dispatcher as any).dispatch = dispatch;

      const input = createMockInput({
        routingKey: 'github:42',
        workflowName: 'ci',
        event: { type: 'push', targetBranch: 'master', payload: {} },
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('accepted');
      expect(resolveForJob).toHaveBeenCalledWith(INLINE_ORG, 'test-db');
      const jobConfig = dispatch.mock.calls[0][0].jobConfig;
      expect(jobConfig.secrets.DB_URL).toBe('x');
    });

    it('skips impure dynamic environments (marker set, no inline value)', async () => {
      const impureWorkflow = createMockWorkflow('ci', [
        {
          _type: 'static' as const,
          name: 'impure-job',
          runsOn: 'default',
          steps: [{ name: 'deploy', run: 'echo deploy' }],
          needs: [],
          rules: [],
          dynamicEnvironment: true,
          // NO environment field -- impure dynamic environment.
        },
      ]);
      const lockFile = createMockLockFile([impureWorkflow]);
      (deps.lockFileCache.get as any).mockResolvedValue(lockFile);

      const envQueries: string[] = [];
      const mockDb = {
        selectFrom: vi.fn((table: string) => ({
          select: vi.fn(() => {
            const chain: any = {
              where: vi.fn((col: string, _op: string, val: string) => {
                if (table === 'environments' && col === 'name') envQueries.push(val);
                return chain;
              }),
              executeTakeFirst: vi.fn(async () => {
                if (table === 'sources') return { customer_id: INLINE_ORG };
                return undefined;
              }),
            };
            return chain;
          }),
        })),
        updateTable: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => ({ execute: vi.fn().mockResolvedValue(undefined) })),
          })),
        })),
      };
      deps.db = mockDb as any;

      const resolveForJob = vi.fn(async () => ({}));
      deps.secretResolver = { resolveForJob } as any;

      const input = createMockInput({
        routingKey: 'github:42',
        workflowName: 'ci',
        event: { type: 'push', targetBranch: 'master', payload: {} },
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('accepted');
      // No environment gate query happened for the impure job.
      expect(envQueries).toEqual([]);
      // resolveForJob was never called with an environment for this job.
      expect(resolveForJob).not.toHaveBeenCalled();
    });

    it('rejects the run when inline environment evaluation fails', async () => {
      const failingWorkflow = createMockWorkflow('ci', [
        {
          _type: 'static' as const,
          name: 'broken-job',
          runsOn: 'default',
          steps: [{ name: 'deploy', run: 'echo deploy' }],
          needs: [],
          rules: [],
          dynamicEnvironment: true,
          environment: { _type: 'inline' as const, expression: '(event) => event.nope.deref' },
        },
      ]);
      const lockFile = createMockLockFile([failingWorkflow]);
      (deps.lockFileCache.get as any).mockResolvedValue(lockFile);
      deps.db = makeInlineDb({}) as any;

      const input = createMockInput({
        routingKey: 'github:42',
        workflowName: 'ci',
        event: { type: 'push', targetBranch: 'master', payload: {} },
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('broken-job');
    });
  });

  describe('test dispatch parity', () => {
    const ORG = 'org-parity';

    // db mock answering resolveOrgId (sources -> ORG) and the org-scoped
    // environments gate lookup keyed on the env name.
    function makeParityDb(envRows: Record<string, { allow_local_execution: boolean }>) {
      return {
        selectFrom: vi.fn((table: string) => ({
          select: vi.fn(() => {
            let envName: string | undefined;
            const chain: any = {
              where: vi.fn((col: string, _op: string, val: string) => {
                if (col === 'name') envName = val;
                return chain;
              }),
              executeTakeFirst: vi.fn(async () => {
                if (table === 'sources') return { customer_id: ORG };
                if (table === 'generic_webhook_sources') return undefined;
                if (table === 'environments') return envName ? envRows[envName] : undefined;
                return undefined;
              }),
            };
            return chain;
          }),
        })),
        updateTable: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => ({ execute: vi.fn().mockResolvedValue(undefined) })),
          })),
        })),
      };
    }

    function captureDispatchedJobConfig(deps: TestPipelineDeps): () => any {
      const dispatch = vi
        .fn()
        .mockResolvedValue({ status: 'dispatched', agentId: 'agent-1', jobId: 'job-1' });
      (deps.dispatcher as any).dispatch = dispatch;
      return () => dispatch.mock.calls[0]?.[0]?.jobConfig;
    }

    /** Env store whose matchEnvironment returns a row with the given id. */
    function makeEnvironmentStore(name: string, id: string) {
      return {
        matchEnvironment: vi.fn(async (_org: string, n: string) =>
          n === name ? { id, org_id: ORG, name } : null,
        ),
      } as any;
    }

    function staticEnvWorkflow() {
      return createMockWorkflow('ci', [
        {
          _type: 'static' as const,
          name: 'deploy-job',
          runsOn: 'default',
          steps: [{ name: 'deploy', run: 'echo deploy' }],
          needs: [],
          rules: [],
          environment: 'test-db',
          env: { FOO: 'bar' },
        },
      ]);
    }

    it('passes the fixture envelope, resolved environment, jobEnv and environmentVars to the agent', async () => {
      const lockFile = createMockLockFile([staticEnvWorkflow()]);
      (deps.lockFileCache.get as any).mockResolvedValue(lockFile);
      deps.db = makeParityDb({ 'test-db': { allow_local_execution: true } }) as any;
      deps.environmentStore = makeEnvironmentStore('test-db', 'env-1');
      deps.variableStore = {
        getResolvedVars: vi.fn(async (_org: string, _envId: string, _rk?: string) => ({
          STAGE: 'test',
        })),
      } as any;
      const getJobConfig = captureDispatchedJobConfig(deps);

      const input = createMockInput({
        routingKey: 'github:42',
        workflowName: 'ci',
        event: {
          type: 'push',
          targetBranch: 'master',
          payload: { ref: 'refs/heads/master' },
        },
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('accepted');
      const jobConfig = getJobConfig();
      expect(jobConfig.event).toEqual({
        type: 'push',
        action: undefined,
        targetBranch: 'master',
        sourceBranch: undefined,
        payload: { ref: 'refs/heads/master' },
        changedFiles: undefined,
      });
      expect(jobConfig.environment).toBe('test-db');
      expect(jobConfig.environmentVars).toEqual({ STAGE: 'test' });
      expect(jobConfig.jobEnv).toEqual({ FOO: 'bar' });
      // variable store resolved against the env row's id + routing key.
      expect(deps.variableStore!.getResolvedVars).toHaveBeenCalledWith(ORG, 'env-1', 'github:42');
    });

    it('also passes inline-evaluated jobEnv', async () => {
      const inlineEnvJobWorkflow = createMockWorkflow('ci', [
        {
          _type: 'static' as const,
          name: 'deploy-job',
          runsOn: 'default',
          steps: [{ name: 'deploy', run: 'echo deploy' }],
          needs: [],
          rules: [],
          dynamicEnv: true,
          env: {
            _type: 'inline' as const,
            expression: '(event) => ({ BRANCH: event.targetBranch })',
          },
        },
      ]);
      const lockFile = createMockLockFile([inlineEnvJobWorkflow]);
      (deps.lockFileCache.get as any).mockResolvedValue(lockFile);
      deps.db = makeParityDb({}) as any;
      const getJobConfig = captureDispatchedJobConfig(deps);

      const input = createMockInput({
        routingKey: 'github:42',
        workflowName: 'ci',
        event: { type: 'push', targetBranch: 'master', payload: {} },
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('accepted');
      expect(getJobConfig().jobEnv).toEqual({ BRANCH: 'master' });
    });

    it('omits environmentVars when no variable store is wired', async () => {
      const lockFile = createMockLockFile([staticEnvWorkflow()]);
      (deps.lockFileCache.get as any).mockResolvedValue(lockFile);
      deps.db = makeParityDb({ 'test-db': { allow_local_execution: true } }) as any;
      deps.environmentStore = makeEnvironmentStore('test-db', 'env-1');
      // No variableStore wired.
      const getJobConfig = captureDispatchedJobConfig(deps);

      const input = createMockInput({
        routingKey: 'github:42',
        workflowName: 'ci',
        event: { type: 'push', targetBranch: 'master', payload: { ref: 'refs/heads/master' } },
      });

      const result = await processTestTrigger(input, deps);

      expect(result.status).toBe('accepted');
      const jobConfig = getJobConfig();
      expect(jobConfig.environmentVars).toBeUndefined();
      expect(jobConfig.event).toEqual({
        type: 'push',
        action: undefined,
        targetBranch: 'master',
        sourceBranch: undefined,
        payload: { ref: 'refs/heads/master' },
        changedFiles: undefined,
      });
      expect(jobConfig.environment).toBe('test-db');
      expect(jobConfig.jobEnv).toEqual({ FOO: 'bar' });
    });
  });
});
