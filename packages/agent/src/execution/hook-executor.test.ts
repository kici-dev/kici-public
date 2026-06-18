import { describe, it, expect, vi } from 'vitest';
import type { HookConfig, HookFn, OutcomeMetadata, HookContext } from '@kici-dev/sdk';
import type { StepContext } from '@kici-dev/sdk';
import type { RunnerToAgentMessage } from './sandbox/ipc-protocol.js';
import { executeHook, buildOutcomeMetadata } from './hook-executor.js';

// --- Helpers ---

function stubStepContext(overrides: Partial<StepContext> = {}): StepContext {
  return {
    $: {} as any,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
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

function stubOutcome(overrides: Partial<OutcomeMetadata> = {}): OutcomeMetadata {
  return {
    status: 'success',
    stepOutputs: {},
    duration: 1000,
    ...overrides,
  };
}

function collectMessages(): {
  messages: RunnerToAgentMessage[];
  sendIpc: (msg: RunnerToAgentMessage) => void;
} {
  const messages: RunnerToAgentMessage[] = [];
  return { messages, sendIpc: (msg) => messages.push(msg) };
}

// --- buildOutcomeMetadata ---

describe('buildOutcomeMetadata', () => {
  it('calculates duration from startTime', () => {
    const startTime = Date.now() - 5000;
    const result = buildOutcomeMetadata({
      status: 'success',
      stepOutputs: {},
      startTime,
    });

    // Duration should be approximately 5000ms (allow 200ms tolerance)
    expect(result.duration).toBeGreaterThanOrEqual(4800);
    expect(result.duration).toBeLessThanOrEqual(5200);
  });

  it('includes status, reason, failedStep, stepOutputs', () => {
    const result = buildOutcomeMetadata({
      status: 'failed',
      reason: 'Step build failed',
      failedStep: 'build',
      stepOutputs: { build: { version: '1.0' } },
      startTime: Date.now() - 1000,
    });

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('Step build failed');
    expect(result.failedStep).toBe('build');
    expect(result.stepOutputs).toEqual({ build: { version: '1.0' } });
  });
});

// --- executeHook ---

describe('executeHook', () => {
  it('calls hook.run with merged context including outcome metadata', async () => {
    const hookRun = vi.fn<(ctx: HookContext) => Promise<void>>().mockResolvedValue(undefined);
    const hook: HookConfig = { name: 'my-hook', type: 'onSuccess', run: hookRun };
    const ctx = stubStepContext();
    const outcome = stubOutcome();
    const { sendIpc } = collectMessages();

    await executeHook({
      hook,
      stepContext: ctx,
      outcome,
      hookType: 'onSuccess',
      stepIndex: 5,
      sendIpc,
    });

    expect(hookRun).toHaveBeenCalledOnce();
    const receivedCtx = hookRun.mock.calls[0][0];
    expect(receivedCtx.outcome).toEqual(outcome);
    // Original ctx fields are preserved
    expect(receivedCtx.workflow.name).toBe('test-wf');
  });

  it('sends IPC step.start with step_type hook:{hookType} before running', async () => {
    const hook: HookConfig = {
      name: 'pre-hook',
      type: 'beforeStep',
      run: vi.fn<(ctx: HookContext) => Promise<void>>().mockResolvedValue(undefined),
    };
    const { messages, sendIpc } = collectMessages();

    await executeHook({
      hook,
      stepContext: stubStepContext(),
      outcome: stubOutcome(),
      hookType: 'beforeStep',
      stepIndex: 3,
      sendIpc,
    });

    const startMsg = messages.find((m) => m.type === 'step.start');
    expect(startMsg).toBeDefined();
    expect(startMsg).toMatchObject({
      type: 'step.start',
      stepIndex: 3,
      stepName: 'pre-hook',
      step_type: 'hook:beforeStep',
    });
  });

  it('sends IPC step.complete with status success on success', async () => {
    const hook: HookConfig = {
      name: 'cleanup-hook',
      type: 'cleanup',
      run: vi.fn<(ctx: HookContext) => Promise<void>>().mockResolvedValue(undefined),
    };
    const { messages, sendIpc } = collectMessages();

    const result = await executeHook({
      hook,
      stepContext: stubStepContext(),
      outcome: stubOutcome(),
      hookType: 'cleanup',
      stepIndex: 7,
      sendIpc,
    });

    expect(result.success).toBe(true);
    const completeMsg = messages.find((m) => m.type === 'step.complete');
    expect(completeMsg).toBeDefined();
    expect(completeMsg).toMatchObject({
      type: 'step.complete',
      stepIndex: 7,
      status: 'success',
      step_type: 'hook:cleanup',
    });
  });

  it('returns { success: false, error } when hook throws', async () => {
    const hook: HookConfig = {
      name: 'failing-hook',
      type: 'onFailure',
      run: vi.fn<(ctx: HookContext) => Promise<void>>().mockRejectedValue(new Error('hook broke')),
    };
    const { messages, sendIpc } = collectMessages();

    const result = await executeHook({
      hook,
      stepContext: stubStepContext(),
      outcome: stubOutcome(),
      hookType: 'onFailure',
      stepIndex: 2,
      sendIpc,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('hook broke');
    const completeMsg = messages.find((m) => m.type === 'step.complete');
    expect(completeMsg).toMatchObject({
      status: 'failed',
      step_type: 'hook:onFailure',
    });
  });

  it('returns { success: false, error } when hook exceeds timeout', async () => {
    const hook: HookConfig = {
      name: 'slow-hook',
      type: 'cleanup',
      run: vi
        .fn<(ctx: HookContext) => Promise<void>>()
        .mockImplementation(() => new Promise(() => {})), // Never resolves
    };
    const { messages, sendIpc } = collectMessages();

    const result = await executeHook({
      hook,
      stepContext: stubStepContext(),
      outcome: stubOutcome(),
      hookType: 'cleanup',
      stepIndex: 1,
      sendIpc,
      timeout: 100, // Short timeout for test
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
    const completeMsg = messages.find((m) => m.type === 'step.complete');
    expect(completeMsg).toMatchObject({
      status: 'failed',
      step_type: 'hook:cleanup',
    });
  });

  it('normalizes bare HookFn to HookConfig', async () => {
    const bareHookFn: HookFn = vi
      .fn<(ctx: HookContext) => Promise<void>>()
      .mockResolvedValue(undefined);
    const { messages, sendIpc } = collectMessages();

    const result = await executeHook({
      hook: bareHookFn,
      stepContext: stubStepContext(),
      outcome: stubOutcome(),
      hookType: 'onCancel',
      stepIndex: 4,
      sendIpc,
    });

    expect(result.success).toBe(true);
    expect(bareHookFn).toHaveBeenCalledOnce();
    // Should still send IPC messages
    expect(messages.some((m) => m.type === 'step.start')).toBe(true);
    expect(messages.some((m) => m.type === 'step.complete')).toBe(true);
  });

  it('uses hook-level timeout when specified', async () => {
    const hook: HookConfig = {
      name: 'custom-timeout-hook',
      type: 'cleanup',
      timeout: 50, // 50ms timeout on the hook itself
      run: vi
        .fn<(ctx: HookContext) => Promise<void>>()
        .mockImplementation(() => new Promise(() => {})),
    };
    const { sendIpc } = collectMessages();

    const result = await executeHook({
      hook,
      stepContext: stubStepContext(),
      outcome: stubOutcome(),
      hookType: 'cleanup',
      stepIndex: 0,
      sendIpc,
      timeout: 60_000, // This should be overridden by hook.timeout
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('normalizes HookInput object { run, timeout } to HookConfig', async () => {
    const hookInput = {
      run: vi.fn<(ctx: HookContext) => Promise<void>>().mockResolvedValue(undefined),
      timeout: 1000,
    };
    const { sendIpc } = collectMessages();

    const result = await executeHook({
      hook: hookInput,
      stepContext: stubStepContext(),
      outcome: stubOutcome(),
      hookType: 'afterStep',
      stepIndex: 2,
      sendIpc,
    });

    expect(result.success).toBe(true);
    expect(hookInput.run).toHaveBeenCalledOnce();
  });
});
