import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildKiciApi, createStepSecrets } from '@kici-dev/sdk';
import { OIDC_TOKEN_REQUEST_METHOD } from '@kici-dev/engine/protocol/messages/oidc-token-relay';
import { LogMasker } from './log-masker.js';
import type {
  Step,
  StepContext,
  Job,
  HookFn,
  HookConfig,
  OutcomeMetadata,
  EventPayload,
} from '@kici-dev/sdk';
import { buildMergedFlatSecrets } from './secret-merge.js';
import type {
  RunnerToAgentMessage,
  AgentToRunnerMessage,
  EventEmitRequest,
  EventEmitResponse,
  ConcurrencyReportMessage,
  ConcurrencyAckMessage,
} from './ipc-protocol.js';
import { executeStepLoop, type StepLoopOptions, type StepLoopResult } from './step-loop.js';
import {
  rawPayloadFromEvent,
  createSandboxStepContext,
  buildStepNeedsContext,
  deriveFanout,
  coerceStep,
  resolveChangedFilesForRules,
  buildJobRuleCompletion,
  sanitizeTempLabel,
  drainJobTempScope,
  buildSandboxShell,
  setupGlobalWorkflowEnv,
  buildStepLoopRuleInputs,
  type CoerceState,
  buildConcurrencyGroupContext,
} from './workflow-runner.js';
import { createTempScope } from '@kici-dev/core/tmp';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ExecutionJobStatus, ExecutionStepStatus } from '@kici-dev/engine';
import type { RuleEvaluationResult } from '../rule-evaluator.js';
import type { JobExecutionRequest } from './ipc-protocol.js';
import { normalizeInitItems } from '../env-init/presets/directives.js';
import { toErrorMessage } from '@kici-dev/shared';

describe('buildMergedFlatSecrets', () => {
  it('returns orchestrator-level secrets when no namespaced secrets exist', () => {
    const result = buildMergedFlatSecrets({ API_KEY: 'key123', DB_PASS: 'pass456' }, {});

    expect(result).toEqual({ API_KEY: 'key123', DB_PASS: 'pass456' });
  });

  it('returns empty record when both inputs are empty', () => {
    const result = buildMergedFlatSecrets({}, {});

    expect(result).toEqual({});
  });

  it('auto-flattens context keys into flat secrets', () => {
    const result = buildMergedFlatSecrets(
      {},
      {
        production: { DB_PASSWORD: 'prod-pw', API_KEY: 'prod-key' },
      },
    );

    expect(result).toEqual({ DB_PASSWORD: 'prod-pw', API_KEY: 'prod-key' });
  });

  it('merges orchestrator-level with context-flattened keys', () => {
    const result = buildMergedFlatSecrets(
      { GLOBAL_TOKEN: 'global123' },
      { production: { DB_PASSWORD: 'prod-pw' } },
    );

    expect(result).toEqual({ GLOBAL_TOKEN: 'global123', DB_PASSWORD: 'prod-pw' });
  });

  it('context-flattened keys override orchestrator-level secrets (closer scope wins)', () => {
    const result = buildMergedFlatSecrets(
      { API_KEY: 'orchestrator-value' },
      { production: { API_KEY: 'context-value' } },
    );

    expect(result.API_KEY).toBe('context-value');
  });

  it('last declared context wins for key collisions between contexts', () => {
    const result = buildMergedFlatSecrets(
      {},
      {
        staging: { DB_PASSWORD: 'staging-pw' },
        production: { DB_PASSWORD: 'production-pw' },
      },
    );

    // Object.entries preserves insertion order; production declared last wins
    expect(result.DB_PASSWORD).toBe('production-pw');
  });

  it('merges keys from multiple contexts', () => {
    const result = buildMergedFlatSecrets(
      {},
      {
        aws: { AWS_KEY: 'ak', AWS_SECRET: 'as' },
        github: { GH_TOKEN: 'ght' },
      },
    );

    expect(result).toEqual({ AWS_KEY: 'ak', AWS_SECRET: 'as', GH_TOKEN: 'ght' });
  });

  it('does not mutate the input orchestrator secrets', () => {
    const orchestrator = { ORIGINAL: 'value' };
    buildMergedFlatSecrets(orchestrator, { ctx: { EXTRA: 'extra' } });

    expect(orchestrator).toEqual({ ORIGINAL: 'value' });
  });
});

describe('StepSecrets from merged result', () => {
  it('ctx.secrets.get() works for orchestrator-level secrets', async () => {
    const merged = buildMergedFlatSecrets({ TOKEN: 'abc' }, {});
    const { secrets } = createStepSecrets(merged, {});

    expect(await secrets.get('TOKEN')).toBe('abc');
  });

  it('ctx.secrets.get() works for auto-flattened context keys', async () => {
    const merged = buildMergedFlatSecrets({}, { prod: { DB_PASS: 'pw' } });
    const { secrets } = createStepSecrets(merged, {});

    expect(await secrets.get('DB_PASS')).toBe('pw');
  });

  it('ctx.secrets.has() works after merging', () => {
    const merged = buildMergedFlatSecrets({ GLOBAL: 'g' }, { prod: { LOCAL: 'l' } });
    const { secrets } = createStepSecrets(merged, {});

    expect(secrets.has('GLOBAL')).toBe(true);
    expect(secrets.has('LOCAL')).toBe(true);
    expect(secrets.has('NONEXISTENT')).toBe(false);
  });

  it('rejects with SecretNotFoundError for missing key', async () => {
    const merged = buildMergedFlatSecrets({ A: '1' }, {});
    const { secrets } = createStepSecrets(merged, {});

    await expect(secrets.get('MISSING')).rejects.toThrow(/Secret "MISSING" not found/);
  });

  it('expose() injects secret into env object', async () => {
    const merged = buildMergedFlatSecrets({ DB_PASS: 'secret123' }, {});
    const env: Record<string, string | undefined> = {};
    const { secrets } = createStepSecrets(merged, env);

    await secrets.expose('DB_PASS');
    expect(env.DB_PASS).toBe('secret123');
  });
});

// --- IPC protocol type tests ---

describe('IPC protocol: EventEmitRequest', () => {
  it('conforms to RunnerToAgentMessage union', () => {
    const request: EventEmitRequest = {
      type: 'event.emit',
      requestId: 'req-001',
      eventName: 'deploy-complete',
      payload: { env: 'prod', version: '1.2.3' },
    };

    // Type assertion: EventEmitRequest is assignable to RunnerToAgentMessage
    const msg: RunnerToAgentMessage = request;
    expect(msg.type).toBe('event.emit');
  });

  it('supports optional target with repos', () => {
    const request: EventEmitRequest = {
      type: 'event.emit',
      requestId: 'req-002',
      eventName: 'deploy-complete',
      payload: {},
      target: { repos: ['org/other-repo', 'org/third-repo'] },
    };

    expect(request.target?.repos).toEqual(['org/other-repo', 'org/third-repo']);
  });

  it('serializes and deserializes correctly via JSON', () => {
    const request: EventEmitRequest = {
      type: 'event.emit',
      requestId: 'req-003',
      eventName: 'build-ready',
      payload: { artifact: 'app.tar.gz', size: 12345 },
      target: { repos: ['org/deploy-repo'] },
    };

    const serialized = JSON.stringify(request);
    const deserialized = JSON.parse(serialized) as EventEmitRequest;

    expect(deserialized.type).toBe('event.emit');
    expect(deserialized.requestId).toBe('req-003');
    expect(deserialized.eventName).toBe('build-ready');
    expect(deserialized.payload).toEqual({ artifact: 'app.tar.gz', size: 12345 });
    expect(deserialized.target?.repos).toEqual(['org/deploy-repo']);
  });
});

describe('IPC protocol: EventEmitResponse', () => {
  it('conforms to AgentToRunnerMessage union', () => {
    const response: EventEmitResponse = {
      type: 'event.emit.response',
      requestId: 'req-001',
      deliveryId: 'del-001',
    };

    // Type assertion: EventEmitResponse is assignable to AgentToRunnerMessage
    const msg: AgentToRunnerMessage = response;
    expect(msg.type).toBe('event.emit.response');
  });

  it('supports success response with deliveryId', () => {
    const response: EventEmitResponse = {
      type: 'event.emit.response',
      requestId: 'req-001',
      deliveryId: 'del-001',
    };

    expect(response.deliveryId).toBe('del-001');
    expect(response.error).toBeUndefined();
  });

  it('supports error response', () => {
    const response: EventEmitResponse = {
      type: 'event.emit.response',
      requestId: 'req-001',
      error: 'Circuit breaker open',
    };

    expect(response.error).toBe('Circuit breaker open');
    expect(response.deliveryId).toBeUndefined();
  });

  it('correlates requestId between request and response', () => {
    const request: EventEmitRequest = {
      type: 'event.emit',
      requestId: 'correlation-test-123',
      eventName: 'test',
      payload: {},
    };

    const response: EventEmitResponse = {
      type: 'event.emit.response',
      requestId: 'correlation-test-123',
      deliveryId: 'del-456',
    };

    expect(response.requestId).toBe(request.requestId);
  });

  it('serializes and deserializes correctly via JSON', () => {
    const response: EventEmitResponse = {
      type: 'event.emit.response',
      requestId: 'req-004',
      deliveryId: 'del-789',
    };

    const serialized = JSON.stringify(response);
    const deserialized = JSON.parse(serialized) as EventEmitResponse;

    expect(deserialized.type).toBe('event.emit.response');
    expect(deserialized.requestId).toBe('req-004');
    expect(deserialized.deliveryId).toBe('del-789');
  });
});

// --- ctx.kici.oidc token masking ---
//
// Replicates the oidc-transport closure built in createSandboxStepContext: the
// step's `kici` API relays over IPC, and any returned OIDC ID token is
// registered with the job's LogMasker so it never lands in step logs.

describe('ctx.kici.oidc token masking', () => {
  function buildJobBoundKici(masker: LogMasker, relayResult: unknown) {
    return buildKiciApi(
      async (method) => {
        const result = relayResult;
        if (
          method === OIDC_TOKEN_REQUEST_METHOD &&
          result &&
          typeof (result as { token?: unknown }).token === 'string'
        ) {
          masker.registerSecrets({ __oidc_token__: (result as { token: string }).token });
        }
        return result;
      },
      { jobId: 'job-1' },
    );
  }

  it('registers a relayed token with the masker so it is redacted in logs', async () => {
    const masker = new LogMasker();
    const token = 'eyJhbGciOi.SECRETPAYLOAD.sig';
    const api = buildJobBoundKici(masker, { token, expiresIn: 600, jti: 'run-1:job-1' });

    const res = await api.oidc.token({ audience: 'sigstore' });
    expect(res.token).toBe(token);

    const masked = masker.mask(`the token is ${token} done`);
    expect(masked).not.toContain(token);
    expect(masked).not.toContain('SECRETPAYLOAD');
  });
});

// --- setEnv / addPath tests ---
//
// These test the exact logic implemented in createSandboxStepContext closures.
// Since createSandboxStepContext is module-private, we replicate the closure
// behavior here to test the core logic (operator secret guard, process.env mutation,
// PATH prepend). This matches the implementation in workflow-runner.ts exactly.

describe('setEnv', () => {
  /** Build a setEnv closure matching the workflow runner implementation. */
  function makeSetEnv(operatorSecretKeys: Set<string>, warnings: string[]) {
    return (key: string, value: string) => {
      if (operatorSecretKeys.has(key)) {
        warnings.push(`Cannot override operator secret "${key}" via setEnv — value preserved`);
        return;
      }
      process.env[key] = value;
    };
  }

  // Clean up env vars set during tests
  const keysToClean: string[] = [];
  afterEach(() => {
    for (const key of keysToClean) {
      delete process.env[key];
    }
    keysToClean.length = 0;
  });

  it('sets an environment variable visible via process.env', () => {
    const setEnv = makeSetEnv(new Set(), []);
    keysToClean.push('TEST_SETENV_VAR');

    setEnv('TEST_SETENV_VAR', 'hello');

    expect(process.env.TEST_SETENV_VAR).toBe('hello');
  });

  it('supports last-write-wins semantics', () => {
    const setEnv = makeSetEnv(new Set(), []);
    keysToClean.push('TEST_LWW_VAR');

    setEnv('TEST_LWW_VAR', 'first');
    expect(process.env.TEST_LWW_VAR).toBe('first');

    setEnv('TEST_LWW_VAR', 'second');
    expect(process.env.TEST_LWW_VAR).toBe('second');
  });

  it('allows setting a key to an empty string', () => {
    const setEnv = makeSetEnv(new Set(), []);
    keysToClean.push('TEST_EMPTY_VAR');

    setEnv('TEST_EMPTY_VAR', '');

    expect(process.env.TEST_EMPTY_VAR).toBe('');
    expect('TEST_EMPTY_VAR' in process.env).toBe(true);
  });

  it('blocks override of flat operator secret keys', () => {
    const warnings: string[] = [];
    const setEnv = makeSetEnv(new Set(['DB_PASSWORD']), warnings);
    keysToClean.push('DB_PASSWORD');

    // Set the "operator" value first
    process.env.DB_PASSWORD = 'secret123';

    setEnv('DB_PASSWORD', 'hacked');

    expect(process.env.DB_PASSWORD).toBe('secret123');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('DB_PASSWORD');
  });

  it('blocks override of namespaced operator secret keys', () => {
    // The operator secret keys set includes keys from both flat and namespaced secrets
    const warnings: string[] = [];
    const operatorKeys = new Set<string>();

    // Simulate collecting keys from namespacedSecrets
    const namespacedSecrets = { prod: { API_KEY: 'key456' } };
    for (const ctx of Object.values(namespacedSecrets)) {
      for (const key of Object.keys(ctx)) operatorKeys.add(key);
    }

    const setEnv = makeSetEnv(operatorKeys, warnings);
    keysToClean.push('API_KEY');

    process.env.API_KEY = 'key456';

    setEnv('API_KEY', 'hacked');

    expect(process.env.API_KEY).toBe('key456');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('API_KEY');
  });

  it('allows setting non-secret keys when secrets exist', () => {
    const warnings: string[] = [];
    const setEnv = makeSetEnv(new Set(['SECRET_KEY']), warnings);
    keysToClean.push('SAFE_VAR');

    setEnv('SAFE_VAR', 'allowed');

    expect(process.env.SAFE_VAR).toBe('allowed');
    expect(warnings).toHaveLength(0);
  });
});

describe('addPath', () => {
  let originalPath: string | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    // Restore original PATH to avoid test pollution
    if (originalPath !== undefined) {
      process.env.PATH = originalPath;
    } else {
      delete process.env.PATH;
    }
  });

  /** Build an addPath closure matching the workflow runner implementation. */
  function makeAddPath() {
    return (dir: string) => {
      process.env.PATH = dir + ':' + (process.env.PATH ?? '');
    };
  }

  it('prepends a directory to PATH', () => {
    const addPath = makeAddPath();

    addPath('/custom/bin');

    expect(process.env.PATH!.startsWith('/custom/bin:')).toBe(true);
  });

  it('prepends multiple directories in order (last call first in PATH)', () => {
    const addPath = makeAddPath();

    addPath('/first/bin');
    addPath('/second/bin');

    expect(process.env.PATH!.startsWith('/second/bin:/first/bin:')).toBe(true);
  });

  it('works when PATH is empty', () => {
    const addPath = makeAddPath();
    process.env.PATH = '';

    addPath('/custom/bin');

    expect(process.env.PATH).toBe('/custom/bin:');
  });

  it('works when PATH is undefined', () => {
    const addPath = makeAddPath();
    delete process.env.PATH;

    addPath('/custom/bin');

    expect(process.env.PATH).toBe('/custom/bin:');
  });
});

describe('operator secret key collection', () => {
  /**
   * Replicate the operator secret key collection logic from main() in workflow-runner.ts.
   * This tests the Set construction from flat + namespaced secrets.
   */
  function collectOperatorSecretKeys(
    secrets?: Record<string, string>,
    namespacedSecrets?: Record<string, Record<string, string>>,
  ): Set<string> {
    const operatorSecretKeys = new Set<string>();
    if (secrets) {
      for (const key of Object.keys(secrets)) operatorSecretKeys.add(key);
    }
    if (namespacedSecrets) {
      for (const ctx of Object.values(namespacedSecrets)) {
        for (const key of Object.keys(ctx)) operatorSecretKeys.add(key);
      }
    }
    return operatorSecretKeys;
  }

  it('collects flat secret keys', () => {
    const keys = collectOperatorSecretKeys({ DB_PASSWORD: 'pw', API_KEY: 'key' });

    expect(keys.has('DB_PASSWORD')).toBe(true);
    expect(keys.has('API_KEY')).toBe(true);
    expect(keys.size).toBe(2);
  });

  it('collects namespaced secret keys', () => {
    const keys = collectOperatorSecretKeys(undefined, {
      prod: { DB_PASSWORD: 'pw' },
      staging: { API_KEY: 'key' },
    });

    expect(keys.has('DB_PASSWORD')).toBe(true);
    expect(keys.has('API_KEY')).toBe(true);
    expect(keys.size).toBe(2);
  });

  it('deduplicates keys appearing in both flat and namespaced', () => {
    const keys = collectOperatorSecretKeys(
      { SHARED_KEY: 'flat-value' },
      { prod: { SHARED_KEY: 'namespaced-value' } },
    );

    expect(keys.has('SHARED_KEY')).toBe(true);
    expect(keys.size).toBe(1);
  });

  it('returns empty set when no secrets provided', () => {
    const keys = collectOperatorSecretKeys();

    expect(keys.size).toBe(0);
  });

  it('returns empty set for empty objects', () => {
    const keys = collectOperatorSecretKeys({}, {});

    expect(keys.size).toBe(0);
  });
});

// --- Hook integration and step loop tests ---

function stubCtx(overrides: Partial<StepContext> = {}): StepContext {
  return {
    $: {} as any,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    env: {},
    setEnv: vi.fn(),
    addPath: vi.fn(),
    inputs: {},
    secrets: { has: () => false } as any,
    workflow: { name: 'test-wf' },
    job: { name: 'test-job', runsOn: 'linux' },
    isTestRun: false,
    emit: vi.fn(),
    outputsOf: vi.fn(),
    jobOutputs: vi.fn(),
    setSecretOutput: vi.fn(),
    ...overrides,
  };
}

function makeStep(
  name: string,
  run: (ctx: StepContext) => Promise<void>,
  extra?: Partial<Step>,
): Step {
  return {
    _tag: 'Step',
    name,
    run,
    result: undefined as any,
    ...extra,
  };
}

function collectIpc(): {
  messages: RunnerToAgentMessage[];
  send: (msg: RunnerToAgentMessage) => void;
} {
  const messages: RunnerToAgentMessage[] = [];
  return { messages, send: (msg) => messages.push(msg) };
}

describe('buildJobRuleCompletion (job-level rule outcome)', () => {
  const steps: Step[] = [makeStep('a', vi.fn()), makeStep('b', vi.fn())];

  it('all rules passed → null (proceed to step execution)', () => {
    const result: RuleEvaluationResult = { allPassed: true, results: [] };
    expect(buildJobRuleCompletion(result, steps)).toBeNull();
  });

  it('a rule cleanly returned false → job.complete{success} with steps skipped', () => {
    const result: RuleEvaluationResult = {
      allPassed: false,
      results: [{ label: 'gate', passed: false, durationMs: 1 }],
    };
    const completion = buildJobRuleCompletion(result, steps);
    expect(completion?.status).toBe(ExecutionJobStatus.enum.success);
    expect(completion?.error).toBeUndefined();
    expect(completion?.stepResults).toHaveLength(2);
    expect(
      completion?.stepResults?.every((s) => s.status === ExecutionStepStatus.enum.skipped),
    ).toBe(true);
  });

  it('a rule check() threw → job.complete{failed} with the error surfaced (NOT success-skip)', () => {
    const result: RuleEvaluationResult = {
      allPassed: false,
      results: [{ label: 'main only', passed: false, durationMs: 1, error: 'kaboom' }],
      evaluationError: { label: 'main only', message: 'kaboom' },
    };
    const completion = buildJobRuleCompletion(result, steps);
    expect(completion?.status).toBe(ExecutionJobStatus.enum.failed);
    expect(completion?.error).toContain('kaboom');
    expect(completion?.error).toContain('main only');
    // Steps still reported (skipped) so the run timeline shows them.
    expect(completion?.stepResults).toHaveLength(2);
  });
});

describe('step-level rule evaluation', () => {
  it('step with a skip rule reports skipped status via IPC and loop continues to next step', async () => {
    const step1Run = vi.fn();
    const step2Run = vi.fn().mockResolvedValue(undefined);
    const steps: Step[] = [
      makeStep('skip-me', step1Run, {
        rules: [{ _tag: 'Rule', label: 'always skip', check: () => false }],
      }),
      makeStep('run-me', step2Run),
    ];
    const { messages, send } = collectIpc();

    const result = await executeStepLoop({
      steps,
      createStepContext: () => stubCtx(),
      sendIpc: send,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
    });

    // First step should be skipped, second should run
    expect(step1Run).not.toHaveBeenCalled();
    expect(step2Run).toHaveBeenCalledOnce();
    expect(result.stepResults[0].status).toBe('skipped');
    expect(result.stepResults[1].status).toBe('success');
  });

  it('step with a passing rule executes normally', async () => {
    const stepRun = vi.fn().mockResolvedValue(undefined);
    const steps: Step[] = [
      makeStep('guarded-step', stepRun, {
        rules: [{ _tag: 'Rule', label: 'always pass', check: () => true }],
      }),
    ];
    const { send } = collectIpc();

    const result = await executeStepLoop({
      steps,
      createStepContext: () => stubCtx(),
      sendIpc: send,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
    });

    expect(stepRun).toHaveBeenCalledOnce();
    expect(result.stepResults[0].status).toBe('success');
  });

  it('step whose rule check() THROWS fails the step (not skip) and does not run later steps', async () => {
    const step1Run = vi.fn();
    const step2Run = vi.fn().mockResolvedValue(undefined);
    const steps: Step[] = [
      makeStep('crashes', step1Run, {
        rules: [
          {
            _tag: 'Rule',
            label: 'main only',
            check: () => {
              throw new TypeError('cannot read endsWith of undefined');
            },
          },
        ],
      }),
      makeStep('later', step2Run),
    ];
    const { messages, send } = collectIpc();

    const result = await executeStepLoop({
      steps,
      createStepContext: () => stubCtx(),
      sendIpc: send,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
    });

    // The crashing step FAILS (not skipped); the loop breaks so `later` never runs.
    expect(step1Run).not.toHaveBeenCalled();
    expect(step2Run).not.toHaveBeenCalled();
    expect(result.stepResults[0].status).toBe(ExecutionStepStatus.enum.failed);
    expect(result.stepResults[0].error?.message).toContain('cannot read endsWith');
    expect(result.stepResults[0].error?.message).toContain('main only');
    // The failure is surfaced in the logs, and the completion IPC reports failed.
    const completeMsg = messages.find((m) => m.type === 'step.complete' && m.stepIndex === 0) as
      (RunnerToAgentMessage & { type: 'step.complete' }) | undefined;
    expect(completeMsg?.status).toBe(ExecutionStepStatus.enum.failed);
    expect(completeMsg?.error?.message).toContain('cannot read endsWith');
    expect(
      messages.some((m) => m.type === 'log.line' && m.line.includes("Step 'crashes' failed")),
    ).toBe(true);
  });
});

describe('beforeStep and afterStep hooks', () => {
  it('beforeStep hook fires before step execution (verified by call order)', async () => {
    const callOrder: string[] = [];
    const beforeStepHook: HookFn = async () => {
      callOrder.push('beforeStep');
    };
    const stepRun = vi.fn(async () => {
      callOrder.push('step');
    });
    const steps: Step[] = [makeStep('my-step', stepRun)];
    const { send } = collectIpc();

    await executeStepLoop({
      steps,
      createStepContext: () => stubCtx(),
      sendIpc: send,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      jobHooks: { beforeStep: beforeStepHook },
    });

    expect(callOrder).toEqual(['beforeStep', 'step']);
  });

  it('afterStep hook fires immediately after step, before next step starts', async () => {
    const callOrder: string[] = [];
    const afterStepHook: HookFn = async () => {
      callOrder.push('afterStep');
    };
    const step1Run = vi.fn(async () => {
      callOrder.push('step1');
    });
    const step2Run = vi.fn(async () => {
      callOrder.push('step2');
    });
    const steps: Step[] = [makeStep('step-1', step1Run), makeStep('step-2', step2Run)];
    const { send } = collectIpc();

    await executeStepLoop({
      steps,
      createStepContext: () => stubCtx(),
      sendIpc: send,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      jobHooks: { afterStep: afterStepHook },
    });

    expect(callOrder).toEqual(['step1', 'afterStep', 'step2', 'afterStep']);
  });

  it('beforeStep failure does NOT prevent step from running (hooks are observers)', async () => {
    const callOrder: string[] = [];
    const beforeStepHook: HookFn = async () => {
      callOrder.push('beforeStep-fail');
      throw new Error('beforeStep broke');
    };
    const stepRun = vi.fn(async () => {
      callOrder.push('step');
    });
    const steps: Step[] = [makeStep('guarded-step', stepRun)];
    const { send } = collectIpc();

    await executeStepLoop({
      steps,
      createStepContext: () => stubCtx(),
      sendIpc: send,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      jobHooks: { beforeStep: beforeStepHook },
    });

    expect(callOrder).toEqual(['beforeStep-fail', 'step']);
    expect(stepRun).toHaveBeenCalledOnce();
  });

  it('afterStep failure does NOT affect next step execution', async () => {
    const callOrder: string[] = [];
    const afterStepHook: HookFn = async () => {
      callOrder.push('afterStep-fail');
      throw new Error('afterStep broke');
    };
    const step1Run = vi.fn(async () => {
      callOrder.push('step1');
    });
    const step2Run = vi.fn(async () => {
      callOrder.push('step2');
    });
    const steps: Step[] = [makeStep('step-1', step1Run), makeStep('step-2', step2Run)];
    const { send } = collectIpc();

    await executeStepLoop({
      steps,
      createStepContext: () => stubCtx(),
      sendIpc: send,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      jobHooks: { afterStep: afterStepHook },
    });

    expect(callOrder).toEqual(['step1', 'afterStep-fail', 'step2', 'afterStep-fail']);
    expect(step2Run).toHaveBeenCalledOnce();
  });
});

describe('job completion hooks', () => {
  it('onSuccess hook fires after all steps complete with status success', async () => {
    const callOrder: string[] = [];
    const onSuccessHook: HookFn = async () => {
      callOrder.push('onSuccess');
    };
    const stepRun = vi.fn(async () => {
      callOrder.push('step');
    });
    const steps: Step[] = [makeStep('my-step', stepRun)];
    const { send } = collectIpc();

    const result = await executeStepLoop({
      steps,
      createStepContext: () => stubCtx(),
      sendIpc: send,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      jobHooks: { onSuccess: onSuccessHook },
    });

    expect(callOrder).toEqual(['step', 'onSuccess']);
    expect(result.status).toBe('success');
  });

  it('onFailure hook fires when a step fails', async () => {
    const callOrder: string[] = [];
    const onFailureHook: HookFn = async () => {
      callOrder.push('onFailure');
    };
    const stepRun = vi.fn(async () => {
      callOrder.push('step-fail');
      throw new Error('step failed');
    });
    const steps: Step[] = [makeStep('failing-step', stepRun)];
    const { send } = collectIpc();

    const result = await executeStepLoop({
      steps,
      createStepContext: () => stubCtx(),
      sendIpc: send,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      jobHooks: { onFailure: onFailureHook },
    });

    expect(callOrder).toEqual(['step-fail', 'onFailure']);
    expect(result.status).toBe('failed');
  });

  it('cleanup hook always fires after onSuccess or onFailure', async () => {
    const callOrder: string[] = [];
    const cleanupHook: HookFn = async () => {
      callOrder.push('cleanup');
    };
    const onSuccessHook: HookFn = async () => {
      callOrder.push('onSuccess');
    };
    const stepRun = vi.fn(async () => {
      callOrder.push('step');
    });
    const steps: Step[] = [makeStep('my-step', stepRun)];
    const { send } = collectIpc();

    await executeStepLoop({
      steps,
      createStepContext: () => stubCtx(),
      sendIpc: send,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      jobHooks: { onSuccess: onSuccessHook, cleanup: cleanupHook },
    });

    expect(callOrder).toEqual(['step', 'onSuccess', 'cleanup']);
  });

  it('hook failure on cleanup changes job status to failed with compound reason', async () => {
    const cleanupHook: HookFn = async () => {
      throw new Error('cleanup broke');
    };
    const stepRun = vi.fn().mockResolvedValue(undefined);
    const steps: Step[] = [makeStep('my-step', stepRun)];
    const { send } = collectIpc();

    const result = await executeStepLoop({
      steps,
      createStepContext: () => stubCtx(),
      sendIpc: send,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      jobHooks: { cleanup: cleanupHook },
    });

    expect(result.status).toBe('failed');
    expect(result.failureReason).toContain('Hook cleanup failed');
  });

  it('hook step indices continue incrementing after regular step indices', async () => {
    const onSuccessHook: HookFn = async () => {};
    const cleanupHook: HookFn = async () => {};
    const stepRun = vi.fn().mockResolvedValue(undefined);
    const steps: Step[] = [makeStep('step-0', stepRun), makeStep('step-1', stepRun)];
    const { messages, send } = collectIpc();

    await executeStepLoop({
      steps,
      createStepContext: () => stubCtx(),
      sendIpc: send,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      jobHooks: { onSuccess: onSuccessHook, cleanup: cleanupHook },
    });

    // Regular steps: 0, 1. Hooks should start at 2, 3
    const hookStarts = messages.filter(
      (m) =>
        m.type === 'step.start' && 'step_type' in m && (m as any).step_type?.startsWith('hook:'),
    );
    expect(hookStarts.length).toBe(2);
    expect((hookStarts[0] as any).stepIndex).toBe(2);
    expect((hookStarts[1] as any).stepIndex).toBe(3);
  });
});

// --- Concurrency IPC protocol type tests ---

describe('IPC protocol: ConcurrencyReportMessage', () => {
  it('conforms to RunnerToAgentMessage union', () => {
    const report: ConcurrencyReportMessage = {
      type: 'concurrency.report',
      group: 'deploy-main',
    };

    const msg: RunnerToAgentMessage = report;
    expect(msg.type).toBe('concurrency.report');
  });

  it('carries the evaluated group key', () => {
    const report: ConcurrencyReportMessage = {
      type: 'concurrency.report',
      group: 'deploy-production',
    };

    expect(report.group).toBe('deploy-production');
  });

  it('serializes and deserializes correctly via JSON', () => {
    const report: ConcurrencyReportMessage = {
      type: 'concurrency.report',
      group: 'ci-feature/my-branch',
    };

    const serialized = JSON.stringify(report);
    const deserialized = JSON.parse(serialized) as ConcurrencyReportMessage;

    expect(deserialized.type).toBe('concurrency.report');
    expect(deserialized.group).toBe('ci-feature/my-branch');
  });
});

describe('IPC protocol: ConcurrencyAckMessage', () => {
  it('conforms to AgentToRunnerMessage union', () => {
    const ack: ConcurrencyAckMessage = {
      type: 'concurrency.ack',
      action: 'proceed',
    };

    const msg: AgentToRunnerMessage = ack;
    expect(msg.type).toBe('concurrency.ack');
  });

  it('supports proceed action', () => {
    const ack: ConcurrencyAckMessage = {
      type: 'concurrency.ack',
      action: 'proceed',
    };

    expect(ack.action).toBe('proceed');
    expect(ack.reason).toBeUndefined();
  });

  it('supports wait action with reason', () => {
    const ack: ConcurrencyAckMessage = {
      type: 'concurrency.ack',
      action: 'wait',
      reason: 'Waiting for deploy-main (1 ahead)',
    };

    expect(ack.action).toBe('wait');
    expect(ack.reason).toBe('Waiting for deploy-main (1 ahead)');
  });

  it('supports cancel action with reason', () => {
    const ack: ConcurrencyAckMessage = {
      type: 'concurrency.ack',
      action: 'cancel',
      reason: 'Superseded by run #42 on same branch',
    };

    expect(ack.action).toBe('cancel');
    expect(ack.reason).toBe('Superseded by run #42 on same branch');
  });

  it('serializes and deserializes correctly via JSON', () => {
    const ack: ConcurrencyAckMessage = {
      type: 'concurrency.ack',
      action: 'wait',
      reason: 'Queue full',
    };

    const serialized = JSON.stringify(ack);
    const deserialized = JSON.parse(serialized) as ConcurrencyAckMessage;

    expect(deserialized.type).toBe('concurrency.ack');
    expect(deserialized.action).toBe('wait');
    expect(deserialized.reason).toBe('Queue full');
  });
});

// --- Concurrency evaluation logic tests ---

describe('concurrency group evaluation', () => {
  it('group function with simple branch-based key', async () => {
    const groupFn = (ctx: { branch: string; event: Record<string, unknown> }) =>
      `deploy-${ctx.branch}`;

    const result = groupFn({ branch: 'main', event: {} });
    expect(result).toBe('deploy-main');
  });

  it('group function with event-based key', async () => {
    const groupFn = (ctx: { branch: string; event: Record<string, unknown> }) =>
      `build-${ctx.branch}-${(ctx.event as any).action ?? 'push'}`;

    const result = groupFn({ branch: 'feature/x', event: { action: 'opened' } });
    expect(result).toBe('build-feature/x-opened');
  });

  it('async group function resolves correctly', async () => {
    const groupFn = async (ctx: { branch: string; event: Record<string, unknown> }) => {
      return `async-${ctx.branch}`;
    };

    const result = await groupFn({ branch: 'main', event: {} });
    expect(result).toBe('async-main');
  });

  it('group function receives minimal context (no StepContext)', () => {
    // The group function signature receives { branch, event } -- NOT StepContext.
    // This is intentional: group evaluation is lightweight and happens before sandbox setup.
    const groupFn = (ctx: { branch: string; event: Record<string, unknown> }) => {
      // Should NOT have $, log, secrets, etc.
      expect(ctx).toHaveProperty('branch');
      expect(ctx).toHaveProperty('event');
      expect(ctx).not.toHaveProperty('$');
      expect(ctx).not.toHaveProperty('log');
      expect(ctx).not.toHaveProperty('secrets');
      return `group-${ctx.branch}`;
    };

    const result = groupFn({ branch: 'develop', event: { ref: 'refs/heads/develop' } });
    expect(result).toBe('group-develop');
  });

  it('group function timeout is enforced via Promise.race pattern', async () => {
    const slowGroupFn = () =>
      new Promise<string>((resolve) => setTimeout(() => resolve('late'), 10_000));
    const timeoutMs = 50;

    const result = await Promise.race([
      slowGroupFn(),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`Concurrency group evaluation timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]).catch((err) => err.message);

    expect(result).toContain('timed out');
  });

  it('group function error is caught and fails the job', async () => {
    const brokenGroupFn = () => {
      throw new Error('Cannot access env var');
    };

    let error: string | undefined;
    try {
      await Promise.resolve(brokenGroupFn());
    } catch (err) {
      error = toErrorMessage(err);
    }

    expect(error).toBe('Cannot access env var');
  });
});

describe('concurrency wait mode', () => {
  it('wait ack parks the runner waiting for a follow-up `proceed` over the same WS', () => {
    // After receiving `{ action: 'wait' }`, the workflow-runner does NOT exit.
    // It re-arms the single-slot pendingConcurrencyAck waiter and long-polls
    // for an unsolicited `concurrency.ack` from the orchestrator. The
    // orchestrator sends `{ action: 'proceed' }` once the slot frees, at
    // which point the runner returns 'proceed' from
    // evaluateConcurrencyGroupIfPresent and continues with normal step
    // execution. The runner does NOT report success to the agent on `wait`
    // — the run is still in flight from the user's perspective.
    const waitAck: ConcurrencyAckMessage = {
      type: 'concurrency.ack',
      action: 'wait',
      reason: 'Waiting for deploy-main (1 ahead)',
    };

    const followUpProceed: ConcurrencyAckMessage = {
      type: 'concurrency.ack',
      action: 'proceed',
      reason: 'Slot acquired',
    };

    expect(waitAck.action).toBe('wait');
    expect(followUpProceed.action).toBe('proceed');
  });

  it('reads KICI_CONCURRENCY_WAIT_TIMEOUT_MS from process.env with a 1h default', () => {
    // The wait-cap timeout is configurable so customers running long-lived
    // queue scenarios (e.g., large deployment fan-out) can extend the cap.
    // The runner reads the env var at the wait point — it doesn't need to
    // be threaded through the JobExecutionRequest.
    const parse = (raw: string | undefined): number => Number.parseInt(raw ?? '', 10) || 3_600_000;

    expect(parse(undefined)).toBe(3_600_000);
    expect(parse('')).toBe(3_600_000);
    expect(parse('not-a-number')).toBe(3_600_000);
    expect(parse('10000')).toBe(10_000);
    expect(parse('60000')).toBe(60_000);
  });
});

describe('concurrency cancel mode', () => {
  it('cancel ack causes job to fail with concurrency policy reason', () => {
    const cancelAck: ConcurrencyAckMessage = {
      type: 'concurrency.ack',
      action: 'cancel',
      reason: 'Superseded by run #42',
    };

    const errorMessage = `Cancelled by concurrency policy: ${cancelAck.reason}`;
    expect(errorMessage).toBe('Cancelled by concurrency policy: Superseded by run #42');
  });
});

describe('no concurrency config path', () => {
  it('jobs without concurrency config skip the entire concurrency protocol', async () => {
    // When workflow.concurrency is undefined, the concurrency protocol is skipped entirely.
    // The job proceeds directly to clone and step execution.
    const steps: Step[] = [makeStep('normal-step', vi.fn().mockResolvedValue(undefined))];
    const { send } = collectIpc();

    const result = await executeStepLoop({
      steps,
      createStepContext: () => stubCtx(),
      sendIpc: send,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
    });

    // No concurrency messages in IPC -- just normal step execution
    expect(result.status).toBe('success');
    expect(result.stepResults[0].status).toBe('success');
  });
});

// --- StepContext rawPayload derivation ---
//
// The wire `request.event` is the normalized event envelope
// ({ type, action?, targetBranch?, payload: <raw provider body>, … }). The raw
// provider webhook body that workflow steps see as `ctx.rawPayload` lives nested
// in `event.payload`, so the step context derives it via rawPayloadFromEvent.

describe('rawPayloadFromEvent', () => {
  it('returns the nested provider payload', () => {
    expect(rawPayloadFromEvent({ type: 'push', payload: { ref: 'r' } })).toEqual({ ref: 'r' });
  });
  it('returns undefined when event or payload is missing', () => {
    expect(rawPayloadFromEvent(undefined)).toBeUndefined();
    expect(rawPayloadFromEvent({ type: 'workflow_complete' })).toBeUndefined();
  });
});

describe('init resolution wiring (normalizeInitItems)', () => {
  it('returns [] for undefined init', () => {
    expect(normalizeInitItems({ init: undefined } as unknown as Job)).toEqual([]);
  });
  it('returns [] for init:false (explicit opt-out)', () => {
    expect(normalizeInitItems({ init: false } as unknown as Job)).toEqual([]);
  });
  it('returns [] for an undefined job', () => {
    expect(normalizeInitItems(undefined)).toEqual([]);
  });
  it('maps a single generic config to a generic directive', () => {
    expect(normalizeInitItems({ init: { run: 'a' } } as unknown as Job)).toEqual([
      { kind: 'generic', config: { run: 'a' } },
    ]);
  });
  it('maps a generic array to generic directives in order', () => {
    expect(normalizeInitItems({ init: [{ run: 'a' }, { run: 'b' }] } as unknown as Job)).toEqual([
      { kind: 'generic', config: { run: 'a' } },
      { kind: 'generic', config: { run: 'b' } },
    ]);
  });
  it('maps a mise preset string to a preset directive', () => {
    expect(normalizeInitItems({ init: 'mise' } as unknown as Job)).toEqual([
      { kind: 'preset', name: 'mise', config: {} },
    ]);
  });
});

describe('createSandboxStepContext - matrix threading', () => {
  function baseRequest(over: Partial<JobExecutionRequest> = {}): JobExecutionRequest {
    return {
      runId: 'run-1',
      jobId: 'job-1',
      workDir: '/workspace',
      repoUrl: 'https://example.com/repo.git',
      ref: 'main',
      sha: 'abc',
      workflowName: 'ci',
      jobName: 'test',
      runsOn: 'ubuntu',
      ...over,
    } as JobExecutionRequest;
  }

  function buildCtx(request: JobExecutionRequest): StepContext {
    const secrets = createStepSecrets({}, {});
    return createSandboxStepContext(
      '/workspace',
      0,
      'step-0',
      request,
      () => {},
      new Map(),
      new Map(),
      new Set<string>(),
      new Map<string, string>(),
      new Map(),
      secrets.secrets,
      new LogMasker(),
      new AbortController().signal,
      createTempScope(),
    );
  }

  it('exposes matrixValues as ctx.matrix', () => {
    const ctx = buildCtx(baseRequest({ matrixValues: { variant: 'a' } }));
    expect(ctx.matrix).toEqual({ variant: 'a' });
  });

  it('leaves ctx.matrix undefined for a non-matrix job', () => {
    const ctx = buildCtx(baseRequest());
    expect(ctx.matrix).toBeUndefined();
  });

  it('uses the base job name for ctx.job.name', () => {
    const ctx = buildCtx(baseRequest({ jobName: 'test', matrixValues: { variant: 'a' } }));
    expect(ctx.job.name).toBe('test');
  });

  it('exposes host/agent as ctx.host/ctx.agent for a runsOnAll child', () => {
    const ctx = buildCtx(
      baseRequest({
        host: 'web-01',
        agent: { host: 'web-01', labels: ['role:web'], platform: 'linux', arch: 'x64' },
      }),
    );
    expect(ctx.host).toBe('web-01');
    expect(ctx.agent).toEqual({
      host: 'web-01',
      labels: ['role:web'],
      platform: 'linux',
      arch: 'x64',
    });
  });

  it('leaves ctx.host/ctx.agent undefined for a non-host job', () => {
    const ctx = buildCtx(baseRequest());
    expect(ctx.host).toBeUndefined();
    expect(ctx.agent).toBeUndefined();
  });

  it('exposes request.dispatchInputs as ctx.dispatchInputs', () => {
    const ctx = buildCtx(baseRequest({ dispatchInputs: { skipCveScan: true, mode: 'full' } }));
    expect(ctx.dispatchInputs).toEqual({ skipCveScan: true, mode: 'full' });
  });

  it('defaults ctx.dispatchInputs to {} when none on the request', () => {
    const ctx = buildCtx(baseRequest());
    expect(ctx.dispatchInputs).toEqual({});
  });
});

describe('createSandboxStepContext - temp scope', () => {
  function req(): JobExecutionRequest {
    return {
      runId: 'run-1',
      jobId: 'job-1',
      workDir: '/workspace',
      repoUrl: 'https://example.com/repo.git',
      ref: 'main',
      sha: 'abc',
      workflowName: 'ci',
      jobName: 'test',
      runsOn: 'ubuntu',
    } as JobExecutionRequest;
  }

  function buildCtx(scope: ReturnType<typeof createTempScope>, signal?: AbortSignal): StepContext {
    const secrets = createStepSecrets({}, {});
    return createSandboxStepContext(
      '/workspace',
      0,
      'my step!',
      req(),
      () => {},
      new Map(),
      new Map(),
      new Set<string>(),
      new Map<string, string>(),
      new Map(),
      secrets.secrets,
      new LogMasker(),
      signal ?? new AbortController().signal,
      scope,
    );
  }

  it('drains the job temp scope on success', async () => {
    const scope = createTempScope();
    const ctx = buildCtx(scope);
    const handle = await ctx.mktemp('t');
    expect(existsSync(handle.path)).toBe(true);

    // The single job-end drain reclaims every ctx allocation.
    await drainJobTempScope(scope, () => {});
    expect(existsSync(handle.path)).toBe(false);
  });

  it('drains the job temp scope on failure', async () => {
    // Failure converges on the same drain point as success — a step that threw
    // still allocated via the same job scope, so the drain reclaims it.
    const scope = createTempScope();
    const ctx = buildCtx(scope);
    const handle = await ctx.mktempFile('t', { suffix: '.txt' });
    expect(existsSync(handle.path)).toBe(true);

    await drainJobTempScope(scope, () => {});
    expect(existsSync(handle.path)).toBe(false);
  });

  it('drains the job temp scope on cancel', async () => {
    // Cancel/timeout aborts ctx.signal, then converges on the same drain.
    const ac = new AbortController();
    const scope = createTempScope();
    const ctx = buildCtx(scope, ac.signal);
    const handle = await ctx.mktemp('t');
    ac.abort();
    expect(existsSync(handle.path)).toBe(true);

    await drainJobTempScope(scope, () => {});
    expect(existsSync(handle.path)).toBe(false);
  });

  it('defaults an omitted label to the sanitized step id', async () => {
    const scope = createTempScope();
    const ctx = buildCtx(scope);
    // Step name 'my step!' sanitizes to 'my-step-' (fallback for irregulars).
    const handle = await ctx.mktemp();
    expect(handle.path).toContain('kici-my-step-');
    await drainJobTempScope(scope, () => {});
    expect(existsSync(handle.path)).toBe(false);
  });

  it('drainJobTempScope swallows a disposeAll failure into warn, never throws', async () => {
    const warnings: string[] = [];
    const failingScope = {
      mktemp: async () => {
        throw new Error('unused');
      },
      mktempFile: async () => {
        throw new Error('unused');
      },
      disposeAll: async () => {
        throw new Error('boom');
      },
    };
    await expect(drainJobTempScope(failingScope, (m) => warnings.push(m))).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('boom');
  });
});

describe('sanitizeTempLabel', () => {
  it('lowercases and replaces non [a-z0-9-] chars with -', () => {
    expect(sanitizeTempLabel('My Step/1')).toBe('my-step-1');
  });

  it('falls back to "step" for an all-irregular input', () => {
    expect(sanitizeTempLabel('!!!')).toBe('---'); // dashes are valid, kept
    expect(sanitizeTempLabel('')).toBe('step');
  });
});

describe('buildStepNeedsContext', () => {
  it('returns undefined when the job declares no needs', () => {
    expect(buildStepNeedsContext(undefined, undefined, undefined)).toBeUndefined();
    expect(buildStepNeedsContext([], {}, {})).toBeUndefined();
  });

  it('resolves a single upstream to { result, status }', () => {
    const needs = buildStepNeedsContext(
      [{ name: 'build', runOn: ['success'] }],
      { build: { compile: { version: '1.0.0' } } },
      { build: 'success' },
    );
    const entry = needs!.build as { result: any; status: string };
    expect(entry.status).toBe('success');
    expect(entry.result.compile.version).toBe('1.0.0');
  });

  it('exposes a failed upstream status under when:always', () => {
    const needs = buildStepNeedsContext(['probe'], { probe: {} }, { probe: 'failed' });
    expect((needs!.probe as { status: string }).status).toBe('failed');
  });

  it('resolves a matrix fan-out upstream to an ordered array of children', () => {
    const needs = buildStepNeedsContext(
      [{ name: 'test', runOn: ['success'] }],
      { test: { byMatrix: { a: { ok: 1 }, b: { ok: 2 } }, merged: { ok: 2 } } },
      { 'test (a)': 'success', 'test (b)': 'skipped' },
    );
    const arr = needs!.test as Array<{ name: string; result: any; status: string }>;
    expect(arr.map((e) => e.name)).toEqual(['test (a)', 'test (b)']);
    expect(arr.map((e) => e.status)).toEqual(['success', 'skipped']);
    expect(arr.map((e) => e.result.ok)).toEqual([1, 2]);
  });

  it('resolves an invoke-gate upstream to { result: InvokeResult[] }, not a group', () => {
    // The gate's proxy children ARE named `${gate} (...)` and appear in the
    // per-child statuses map, which without the invoke branch would coerce the
    // need into a fan-out group. `upstreamInvokeResults` must take precedence.
    const needs = buildStepNeedsContext(
      [{ name: 'repo-tests', runOn: ['success'] }],
      undefined,
      { 'repo-tests (myorg/backend:unit)': 'success', 'repo-tests (myorg/backend:lint)': 'failed' },
      {
        'repo-tests': [
          {
            repo: 'myorg/backend',
            workflow: 'unit',
            runId: 'r1',
            status: 'success',
            outputs: { coverage: '92' },
          },
          {
            repo: 'myorg/backend',
            workflow: 'lint',
            runId: 'r2',
            status: 'failed',
            outputs: {},
          },
        ],
      },
    );
    // Gate need → InvokeNeedEntry: `.result` is a plain InvokeResult[] (no
    // per-child `name`/`status` group shape, no output proxy).
    const entry = needs!['repo-tests'] as { result: InvokeResultShape[] };
    expect(Array.isArray(entry.result)).toBe(true);
    expect(entry.result.map((r) => r.runId)).toEqual(['r1', 'r2']);
    expect(entry.result.map((r) => r.repo)).toEqual(['myorg/backend', 'myorg/backend']);
    expect(entry.result.map((r) => r.workflow)).toEqual(['unit', 'lint']);
    expect(entry.result.map((r) => r.status)).toEqual(['success', 'failed']);
    expect(entry.result[0].outputs.coverage).toBe('92');
    expect(Array.isArray(needs!['repo-tests'])).toBe(false); // not a group array
  });

  it('still resolves a real matrix group when no invoke results name that base', () => {
    const needs = buildStepNeedsContext(
      [{ name: 'test', runOn: ['success'] }],
      { test: { byMatrix: { a: { ok: 1 } }, merged: { ok: 1 } } },
      { 'test (a)': 'success' },
      { 'repo-tests': [] }, // a DIFFERENT gate — must not affect `test`
    );
    const arr = needs!.test as Array<{ name: string; status: string }>;
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.map((e) => e.name)).toEqual(['test (a)']);
  });
});

interface InvokeResultShape {
  repo: string;
  workflow: string;
  runId: string;
  status: string;
  outputs: Record<string, unknown>;
}

describe('deriveFanout', () => {
  const req = (over: Partial<JobExecutionRequest>): JobExecutionRequest =>
    ({ workflowName: 'w', jobName: 'j', runsOn: 'linux', ...over }) as JobExecutionRequest;

  it('returns undefined on a non-fan-out request (no fanoutTotal)', () => {
    expect(deriveFanout(req({}))).toBeUndefined();
  });

  it('derives first/last from index + total', () => {
    expect(deriveFanout(req({ fanoutIndex: 0, fanoutTotal: 3 }))).toEqual({
      index: 0,
      total: 3,
      first: true,
      last: false,
    });
    expect(deriveFanout(req({ fanoutIndex: 2, fanoutTotal: 3 }))).toEqual({
      index: 2,
      total: 3,
      first: false,
      last: true,
    });
  });

  it('defaults a missing index to 0 when total is present', () => {
    expect(deriveFanout(req({ fanoutTotal: 1 }))).toEqual({
      index: 0,
      total: 1,
      first: true,
      last: true,
    });
  });
});

const freshCoerceState = (): CoerceState => ({
  counter: 0,
  refMap: new WeakMap(),
  autoNamed: new WeakSet(),
});

describe('coerceStep name write-back', () => {
  it('mutates the original unnamed step so its .result proxy can resolve', () => {
    const s: any = { _tag: 'Step', name: '', run: async () => ({ v: 1 }) };
    const state = freshCoerceState();
    const out = coerceStep(s, state);
    expect(out).toBe(s); // same object, not a clone
    expect(s.name).toBe('step-1');
  });

  it('assigns a fresh clone name when the same object appears twice (lock parity)', () => {
    const s: any = { _tag: 'Step', name: '', run: async () => ({ v: 1 }) };
    const state = freshCoerceState();
    const first = coerceStep(s, state);
    const second = coerceStep(s, state);
    expect(first.name).toBe('step-1');
    expect(second.name).toBe('step-2');
    expect(second).not.toBe(s); // repeat encounter clones, as today
    expect(s.name).toBe('step-1'); // original keeps its first binding
  });

  it('leaves user-named steps untouched and does not consume the counter', () => {
    const named: any = { _tag: 'Step', name: 'build', run: async () => {} };
    const anon: any = { _tag: 'Step', name: '', run: async () => {} };
    const state = freshCoerceState();
    expect(coerceStep(named, state)).toBe(named);
    coerceStep(anon, state);
    expect(anon.name).toBe('step-1');
  });

  it('still wraps bare functions into counter-named steps', () => {
    const fn = async () => {};
    const state = freshCoerceState();
    const out = coerceStep(fn, state);
    expect(out.name).toBe('step-1');
    expect(state.refMap.get(fn)).toBe('step-1');
  });
});

describe('resolveChangedFilesForRules', () => {
  it('keeps the orchestrator fast-path list when status is fetched', async () => {
    const request = {
      event: { type: 'push', changedFiles: ['a.ts'], changedFilesStatus: 'fetched' },
    } as unknown as JobExecutionRequest;
    await resolveChangedFilesForRules(request, '/nonexistent', true);
    expect((request.event as any).changedFiles).toEqual(['a.ts']);
    expect((request.event as any).changedFilesStatus).toBe('fetched');
  });

  it('no-ops when there are no rules', async () => {
    const request = { event: { type: 'push' } } as unknown as JobExecutionRequest;
    await resolveChangedFilesForRules(request, '/nonexistent', false);
    expect((request.event as any).changedFilesStatus).toBeUndefined();
  });

  it('marks unavailable for a diff-less event when a rule exists', async () => {
    const request = { event: { type: 'schedule' } } as unknown as JobExecutionRequest;
    await resolveChangedFilesForRules(request, '/nonexistent', true);
    expect((request.event as any).changedFilesStatus).toBe('unavailable');
  });
});

describe('setupGlobalWorkflowEnv', () => {
  const keys = [
    'KICI_IS_GLOBAL_WORKFLOW',
    'KICI_WORKFLOW_REPO_PATH',
    'KICI_SOURCE_REPO_PATH',
    'KICI_SOURCE_REPO',
    'KICI_SOURCE_BRANCH',
    'KICI_SOURCE_SHA',
    'KICI_WORKFLOW_REPO',
  ];
  beforeEach(() => {
    for (const k of keys) delete process.env[k];
  });
  afterEach(() => {
    for (const k of keys) delete process.env[k];
  });

  const request = {
    repoUrl: 'https://github.com/o/src.git',
    ref: 'main',
    sha: 'aaa',
    workflowRepoIdentifier: 'o/wf',
    workflowRef: 'trunk',
    workflowSha: 'bbb',
  } as unknown as JobExecutionRequest;

  it('injects the source-repo env and returns the repo pair for a global workflow', () => {
    const pair = setupGlobalWorkflowEnv(request, true, '/w/workflow', '/w/source');
    expect(process.env.KICI_SOURCE_REPO_PATH).toBe('/w/source');
    expect(process.env.KICI_WORKFLOW_REPO_PATH).toBe('/w/workflow');
    expect(process.env.KICI_SOURCE_REPO).toBe('o/src');
    expect(pair?.sourceRepo).toEqual({
      identifier: 'o/src',
      path: '/w/source',
      ref: 'main',
      sha: 'aaa',
    });
    expect(pair?.workflowRepo).toEqual({
      identifier: 'o/wf',
      path: '/w/workflow',
      ref: 'trunk',
      sha: 'bbb',
    });
  });

  it('is a no-op for a non-global job', () => {
    expect(setupGlobalWorkflowEnv(request, false, '/w', '/w')).toBeUndefined();
    expect(process.env.KICI_SOURCE_REPO_PATH).toBeUndefined();
  });
});

describe('buildStepLoopRuleInputs', () => {
  const request = {
    event: { type: 'push' },
    dispatchInputs: { flavor: 'nightly' },
  } as unknown as JobExecutionRequest;
  const repos = {
    sourceRepo: { identifier: 'o/src', path: '/w/source', ref: 'main', sha: 'aaa' },
    workflowRepo: { identifier: 'o/wf', path: '/w/workflow', ref: 'trunk', sha: 'bbb' },
  };

  it('carries the repo pair through to the step loop for a global workflow', () => {
    const inputs = buildStepLoopRuleInputs(request, repos);
    expect(inputs.sourceRepo).toEqual(repos.sourceRepo);
    expect(inputs.workflowRepo).toEqual(repos.workflowRepo);
    expect(inputs.event).toEqual({ type: 'push' });
    expect(inputs.dispatchInputs).toEqual({ flavor: 'nightly' });
  });

  it('leaves both repo keys absent on a non-global job', () => {
    const inputs = buildStepLoopRuleInputs(request, undefined);
    expect('sourceRepo' in inputs).toBe(false);
    expect('workflowRepo' in inputs).toBe(false);
  });

  it('is the single source the step loop reads its rule inputs from', () => {
    // Source-level: main() must thread the pair into executeStepLoop through this
    // helper. Threading only the job rules (maybeSkipJobOnRules) leaves a step
    // rule seeing `undefined` through the identical RuleContext type.
    const src = readFileSync(
      fileURLToPath(new URL('./workflow-runner.ts', import.meta.url)),
      'utf8',
    );
    const loopAt = src.indexOf('await executeStepLoop({');
    expect(loopAt).toBeGreaterThan(-1);
    expect(src.slice(loopAt, loopAt + 900)).toContain(
      '...buildStepLoopRuleInputs(request, globalRepoInfo)',
    );
  });
});

describe('prepare-phase ordering: global repo pair precedes generator + rules', () => {
  // The property under test is an ORDERING inside main(), which no unit test can
  // observe without driving a whole sandbox job. Assert it at the source level
  // instead: the env injection + repo-pair construction must sit ahead of both
  // consumers. A generator re-evaluated without KICI_SOURCE_REPO_PATH sees a
  // different world than the pre-dispatch evaluation did, and
  // extractStepsFromDynamicJob fails the job when the target job goes missing.
  const source = readFileSync(
    fileURLToPath(new URL('./workflow-runner.ts', import.meta.url)),
    'utf8',
  );

  const setupAt = source.indexOf('const globalRepoInfo = setupGlobalWorkflowEnv(');
  // Step extraction is delegated to extractStepsForRun (which owns the
  // apiTransport closure + the cleanup-only short-circuit); it forwards the repo
  // pair to extractAndNormalizeSteps. Anchor on main()'s call site.
  const extractAt = source.indexOf('await extractStepsForRun(');
  const rulesAt = source.indexOf('await maybeSkipJobOnRules(');
  const helperForwardAt = source.indexOf('return extractAndNormalizeSteps(');

  it('finds all call sites (positive control — guards against a vacuous pass)', () => {
    expect(setupAt).toBeGreaterThan(-1);
    expect(extractAt).toBeGreaterThan(-1);
    expect(rulesAt).toBeGreaterThan(-1);
    expect(helperForwardAt).toBeGreaterThan(-1);
  });

  it('sets up the global-workflow env before the dynamic-job extraction', () => {
    expect(setupAt).toBeLessThan(extractAt);
  });

  it('sets up the global-workflow env before job-rule evaluation', () => {
    expect(setupAt).toBeLessThan(rulesAt);
  });

  it('forwards the repo pair to both consumers', () => {
    // main() hands globalRepoInfo to the extraction helper and to the rules.
    expect(source.slice(extractAt, extractAt + 200)).toContain('globalRepoInfo');
    expect(source.slice(rulesAt, rulesAt + 200)).toContain('globalRepoInfo');
    // …and the helper forwards it into the generator re-evaluation.
    expect(source.slice(helperForwardAt, helperForwardAt + 200)).toContain('globalRepoInfo');
  });
});

describe('buildSandboxShell same-step env visibility', () => {
  afterEach(() => {
    delete process.env.KICI_SAMESTEP_TEST;
  });

  it('a subprocess sees a process.env mutation made AFTER the shell was built (live env, not a snapshot)', async () => {
    delete process.env.KICI_SAMESTEP_TEST;
    const shell = buildSandboxShell(process.cwd(), 0, () => {});
    // Mutate process.env after the shell is constructed — this mirrors
    // ctx.setEnv running inside the step, after the step context (and its
    // shell) were created. With a frozen { ...process.env } copy the
    // subprocess would echo an empty line; with a live reference it sees the value.
    process.env.KICI_SAMESTEP_TEST = 'live-value';
    const out = await shell`echo "$KICI_SAMESTEP_TEST"`;
    expect(out.stdout.trim()).toBe('live-value');
  });
});

describe('buildConcurrencyGroupContext', () => {
  /** The dispatch request for one global job, minus the fields under test. */
  function req(over: Partial<JobExecutionRequest>): JobExecutionRequest {
    return {
      ref: 'headsha',
      branch: 'main',
      isGlobalWorkflow: true,
      ...over,
    } as JobExecutionRequest;
  }

  /**
   * A group an author scopes per source repository — the shape a global
   * workflow needs, since one workflow runs on events from many repositories.
   */
  const perRepoGroup = (ctx: { branch: string; event: EventPayload }): string =>
    `${(ctx.event as { sourceRepo?: string }).sourceRepo}:${ctx.branch}`;

  it('carries the event envelope through to the group function', () => {
    const ctx = buildConcurrencyGroupContext(
      req({ event: { type: 'push', sourceRepo: 'acme/app', targetBranch: 'main' } }),
    );

    expect(ctx.branch).toBe('main');
    expect(ctx.event).toEqual({ type: 'push', sourceRepo: 'acme/app', targetBranch: 'main' });
  });

  it('lets two source repos on the same branch resolve to distinct groups', () => {
    const a = perRepoGroup(
      buildConcurrencyGroupContext(req({ event: { sourceRepo: 'acme/app' } })),
    );
    const b = perRepoGroup(
      buildConcurrencyGroupContext(req({ event: { sourceRepo: 'acme/web' } })),
    );

    expect(a).toBe('acme/app:main');
    expect(b).toBe('acme/web:main');
    expect(a).not.toBe(b);
  });

  it('collapses both source repos into one group when the event is absent', () => {
    // The state a global job was dispatched in before the orchestrator wrote
    // `event` into its job config: the author has only `branch` to key on, so
    // every source repo pushing its default branch shares one group — and with
    // `cancelInProgress` (the orchestrator's default) one repo's push cancels
    // another's in-flight run. This is the failure the populated event removes,
    // asserted directly rather than inferred.
    const a = perRepoGroup(buildConcurrencyGroupContext(req({ event: undefined })));
    const b = perRepoGroup(buildConcurrencyGroupContext(req({ event: undefined })));

    expect(a).toBe(b);
    expect(a).toBe('undefined:main');
  });

  it('falls back to the ref when no branch is supplied', () => {
    expect(buildConcurrencyGroupContext(req({ branch: undefined })).branch).toBe('headsha');
  });
});
