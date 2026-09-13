import { describe, it, expect, vi } from 'vitest';
import type { Step, StepContext, OutputsMap } from '@kici-dev/sdk';
import type { RunnerToAgentMessage } from './ipc-protocol.js';
import { executeStepLoop, type JobHooks } from './step-loop.js';

function stubStepContext(): StepContext {
  return {
    $: {} as any,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    env: {},
    setEnv: vi.fn(),
    addPath: vi.fn(),
    inputs: {},
    secrets: { has: () => false } as any,
    workflow: { name: 'wf' },
    job: { name: 'job', runsOn: 'linux' },
    isTestRun: false,
    emit: vi.fn(),
    outputsOf: vi.fn(),
    jobOutputs: vi.fn(),
    setSecretOutput: vi.fn(),
  } as unknown as StepContext;
}

function makeStep(name: string): Step {
  return { _tag: 'Step', name, run: async () => {}, result: {} as any } as Step;
}

async function runLoop(
  jobHooks?: JobHooks,
  opts?: { steps?: Step[]; forceInitialFailure?: boolean },
): Promise<RunnerToAgentMessage[]> {
  const messages: RunnerToAgentMessage[] = [];
  await executeStepLoop({
    steps: opts?.steps ?? [makeStep('s1')],
    createStepContext: () => stubStepContext(),
    sendIpc: (m) => messages.push(m),
    defaultTimeoutMs: 30_000,
    outputsMap: new Map() as OutputsMap,
    event: {},
    env: {},
    ...(jobHooks ? { jobHooks } : {}),
    ...(opts?.forceInitialFailure ? { forceInitialFailure: true } : {}),
    startTime: Date.now(),
  });
  return messages;
}

describe('runJobCompletionHooks emits completion marker', () => {
  it('sends completion-hooks-done exactly once when no hooks are declared', async () => {
    const messages = await runLoop();
    expect(messages.filter((m) => m.type === 'completion-hooks-done')).toHaveLength(1);
  });

  it('sends completion-hooks-done exactly once after declared hooks run', async () => {
    const messages = await runLoop({ onSuccess: async () => {}, cleanup: async () => {} });
    expect(messages.filter((m) => m.type === 'completion-hooks-done')).toHaveLength(1);
  });
});

describe('forceInitialFailure (cleanup-only re-run)', () => {
  it('runs onFailure + cleanup (not onSuccess) with no steps', async () => {
    const ran: string[] = [];
    const messages = await runLoop(
      {
        onSuccess: async () => {
          ran.push('onSuccess');
        },
        onFailure: async () => {
          ran.push('onFailure');
        },
        cleanup: async () => {
          ran.push('cleanup');
        },
      },
      { steps: [], forceInitialFailure: true },
    );
    expect(ran).toEqual(['onFailure', 'cleanup']);
    expect(messages.filter((m) => m.type === 'completion-hooks-done')).toHaveLength(1);
  });
});
