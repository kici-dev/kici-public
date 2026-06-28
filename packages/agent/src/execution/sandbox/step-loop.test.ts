import { describe, it, expect, vi } from 'vitest';
import type { Step, StepContext, HookContext, OutputsMap } from '@kici-dev/sdk';
import type { RunnerToAgentMessage } from './ipc-protocol.js';
import { executeStepLoop, type JobHooks } from './step-loop.js';

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

function collectMessages(): {
  messages: RunnerToAgentMessage[];
  sendIpc: (msg: RunnerToAgentMessage) => void;
} {
  const messages: RunnerToAgentMessage[] = [];
  return { messages, sendIpc: (msg) => messages.push(msg) };
}

function makeStep(name: string, run: (ctx: StepContext) => Promise<void>): Step {
  return {
    _tag: 'Step',
    name,
    run,
    result: {} as any,
  };
}

describe('executeStepLoop', () => {
  it('cleanup hook receives updated outcome when onSuccess fails', async () => {
    const capturedOutcomes: Array<{ status: string; reason?: string }> = [];

    const steps = [makeStep('passing-step', async () => {})];

    const jobHooks: JobHooks = {
      onSuccess: async () => {
        throw new Error('onSuccess exploded');
      },
      cleanup: async (ctx: HookContext) => {
        capturedOutcomes.push({
          status: ctx.outcome.status,
          reason: ctx.outcome.reason,
        });
      },
    };

    const outputsMap: OutputsMap = new Map();
    const { sendIpc } = collectMessages();

    const result = await executeStepLoop({
      steps,
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap,
      event: {},
      env: {},
      jobHooks,
      startTime: Date.now(),
    });

    // Job should fail because onSuccess hook failed
    expect(result.status).toBe('failed');
    expect(result.failureReason).toContain('onSuccess failed');

    // The cleanup hook must see the updated outcome (failed, not success)
    expect(capturedOutcomes).toHaveLength(1);
    expect(capturedOutcomes[0].status).toBe('failed');
    expect(capturedOutcomes[0].reason).toContain('onSuccess failed');
  });

  it('cleanup hook sees success outcome when all steps and hooks pass', async () => {
    const capturedOutcomes: Array<{ status: string }> = [];

    const steps = [makeStep('step-1', async () => {})];

    const jobHooks: JobHooks = {
      onSuccess: async () => {},
      cleanup: async (ctx: HookContext) => {
        capturedOutcomes.push({ status: ctx.outcome.status });
      },
    };

    const outputsMap: OutputsMap = new Map();
    const { sendIpc } = collectMessages();

    const result = await executeStepLoop({
      steps,
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap,
      event: {},
      env: {},
      jobHooks,
      startTime: Date.now(),
    });

    expect(result.status).toBe('success');
    expect(capturedOutcomes).toHaveLength(1);
    expect(capturedOutcomes[0].status).toBe('success');
  });

  it('cleanup hook sees failed outcome when onFailure also fails', async () => {
    const capturedOutcomes: Array<{ status: string; reason?: string }> = [];

    const steps = [
      makeStep('failing-step', async () => {
        throw new Error('step failed');
      }),
    ];

    const jobHooks: JobHooks = {
      onFailure: async () => {
        throw new Error('onFailure also exploded');
      },
      cleanup: async (ctx: HookContext) => {
        capturedOutcomes.push({
          status: ctx.outcome.status,
          reason: ctx.outcome.reason,
        });
      },
    };

    const outputsMap: OutputsMap = new Map();
    const { sendIpc } = collectMessages();

    const result = await executeStepLoop({
      steps,
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap,
      event: {},
      env: {},
      jobHooks,
      startTime: Date.now(),
    });

    expect(result.status).toBe('failed');

    // Cleanup should see 'failed' status with the onFailure failure reason
    expect(capturedOutcomes).toHaveLength(1);
    expect(capturedOutcomes[0].status).toBe('failed');
    expect(capturedOutcomes[0].reason).toContain('onFailure failed');
  });

  it('skips completion hooks when aborted between steps', async () => {
    let onSuccessCalled = false;
    let cleanupCalled = false;
    let stepCount = 0;

    const steps = [
      makeStep('step-1', async () => {
        stepCount++;
      }),
      makeStep('step-2', async () => {
        stepCount++;
      }),
    ];

    const jobHooks: JobHooks = {
      onSuccess: async () => {
        onSuccessCalled = true;
      },
      cleanup: async () => {
        cleanupCalled = true;
      },
    };

    const outputsMap: OutputsMap = new Map();
    const { sendIpc } = collectMessages();

    // Abort after first step
    let callCount = 0;
    const result = await executeStepLoop({
      steps,
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap,
      event: {},
      env: {},
      jobHooks,
      isAborted: () => {
        callCount++;
        // First call is before step-1 (not aborted), second is before step-2 (aborted)
        return callCount >= 2;
      },
      startTime: Date.now(),
    });

    expect(result.status).toBe('aborted');
    expect(stepCount).toBe(1); // Only step-1 ran
    expect(onSuccessCalled).toBe(false); // Must NOT run
    expect(cleanupCalled).toBe(false); // Must NOT run (deferred to workflow-runner cancel-path)
  });

  it('skips onFailure and cleanup hooks when aborted after a failed step', async () => {
    let onFailureCalled = false;
    let cleanupCalled = false;

    const steps = [
      makeStep('failing-step', async () => {
        throw new Error('step failed');
      }),
    ];

    const jobHooks: JobHooks = {
      onFailure: async () => {
        onFailureCalled = true;
      },
      cleanup: async () => {
        cleanupCalled = true;
      },
    };

    const outputsMap: OutputsMap = new Map();
    const { sendIpc } = collectMessages();

    const result = await executeStepLoop({
      steps,
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap,
      event: {},
      env: {},
      jobHooks,
      isAborted: () => true, // Aborted from the start
      startTime: Date.now(),
    });

    expect(result.status).toBe('aborted');
    expect(onFailureCalled).toBe(false);
    expect(cleanupCalled).toBe(false);
  });

  // Hook capture invariant: workflow-runner wires `createStepContext` to
  // `createStepCtxWithCapture` which sets `captureStepIndex` to the passed
  // index. If the step loop ever calls `createStepContext` for a hook without
  // an index that makes capture active (>= 0), console.log inside that hook
  // will silently disappear. Lock this by asserting the step loop calls
  // `createStepContext` with the expected (stepIndex, stepName) for each
  // hook invocation — per-step hooks reuse the step's index, post-loop and
  // cancel-path hooks allocate fresh indices >= steps.length.
  it('calls createStepContext with non-negative stepIndex and correct stepName for each hook', async () => {
    const calls: Array<{ stepIndex: number; stepName: string }> = [];
    const captureFactory = (stepIndex: number, stepName: string): StepContext => {
      calls.push({ stepIndex, stepName });
      return stubStepContext();
    };

    const steps = [makeStep('s0', async () => {}), makeStep('s1', async () => {})];

    const jobHooks: JobHooks = {
      beforeStep: async () => {},
      afterStep: async () => {},
      onSuccess: async () => {},
      cleanup: async () => {},
    };

    const outputsMap: OutputsMap = new Map();
    const { sendIpc } = collectMessages();

    const result = await executeStepLoop({
      steps,
      createStepContext: captureFactory,
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap,
      event: {},
      env: {},
      jobHooks,
      startTime: Date.now(),
    });

    expect(result.status).toBe('success');

    // Per-step hooks reuse the step index (0 or 1), so beforeStep / step body
    // / afterStep for step N all share stepIndex=N and land in step N's log.
    const byName = (name: string) => calls.filter((c) => c.stepName === name);
    expect(byName('s0').every((c) => c.stepIndex === 0)).toBe(true);
    expect(byName('s0').length).toBeGreaterThanOrEqual(3); // beforeStep + body + afterStep
    expect(byName('s1').every((c) => c.stepIndex === 1)).toBe(true);
    expect(byName('s1').length).toBeGreaterThanOrEqual(3);

    // Post-loop hooks get their own stepIndex >= steps.length so they show up
    // as dedicated step rows in the dashboard.
    const onSuccessCalls = calls.filter((c) => c.stepName === 'onSuccess');
    expect(onSuccessCalls).toHaveLength(1);
    expect(onSuccessCalls[0].stepIndex).toBeGreaterThanOrEqual(steps.length);

    const cleanupCalls = calls.filter((c) => c.stepName === 'cleanup');
    expect(cleanupCalls).toHaveLength(1);
    expect(cleanupCalls[0].stepIndex).toBeGreaterThanOrEqual(steps.length);
    expect(cleanupCalls[0].stepIndex).not.toBe(onSuccessCalls[0].stepIndex);

    // Every hook call received a non-negative stepIndex so captureStepIndex
    // (>= 0 in workflow-runner) will be active during hook execution.
    expect(calls.every((c) => c.stepIndex >= 0)).toBe(true);
  });

  it('fires beforeStepEnvFiles then afterStepApplyEnvFiles around each step in order', async () => {
    const order: string[] = [];

    const steps = [
      makeStep('s1', async () => {
        order.push('run:s1');
      }),
      makeStep('s2', async () => {
        order.push('run:s2');
      }),
    ];

    const outputsMap: OutputsMap = new Map();
    const { sendIpc } = collectMessages();

    const result = await executeStepLoop({
      steps,
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap,
      event: {},
      env: {},
      startTime: Date.now(),
      beforeStepEnvFiles: async () => {
        order.push('before');
      },
      afterStepApplyEnvFiles: async () => {
        order.push('after');
      },
    });

    expect(result.status).toBe('success');
    expect(order).toEqual(['before', 'run:s1', 'after', 'before', 'run:s2', 'after']);
  });

  it('runs afterStepApplyEnvFiles even when the step throws', async () => {
    const order: string[] = [];

    const steps = [
      makeStep('s1', async () => {
        order.push('run');
        throw new Error('boom');
      }),
    ];

    const outputsMap: OutputsMap = new Map();
    const { sendIpc } = collectMessages();

    await executeStepLoop({
      steps,
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap,
      event: {},
      env: {},
      startTime: Date.now(),
      beforeStepEnvFiles: async () => {
        order.push('before');
      },
      afterStepApplyEnvFiles: async () => {
        order.push('after');
      },
    });

    expect(order).toEqual(['before', 'run', 'after']);
  });

  it('fires neither env-file hook for a rule-skipped step', async () => {
    const order: string[] = [];

    const skippedStep: Step = {
      ...makeStep('skipped', async () => {
        order.push('run');
      }),
      rules: [{ _tag: 'Rule', label: 'never', check: async () => false } as any],
    };

    const outputsMap: OutputsMap = new Map();
    const { sendIpc } = collectMessages();

    await executeStepLoop({
      steps: [skippedStep],
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap,
      event: {},
      env: {},
      startTime: Date.now(),
      beforeStepEnvFiles: async () => {
        order.push('before');
      },
      afterStepApplyEnvFiles: async () => {
        order.push('after');
      },
    });

    expect(order).toEqual([]);
  });

  it('invokes onFailure with stepIndex >= steps.length when a step fails', async () => {
    const calls: Array<{ stepIndex: number; stepName: string }> = [];
    const captureFactory = (stepIndex: number, stepName: string): StepContext => {
      calls.push({ stepIndex, stepName });
      return stubStepContext();
    };

    const steps = [
      makeStep('s0', async () => {
        throw new Error('boom');
      }),
    ];

    const jobHooks: JobHooks = {
      onFailure: async () => {},
    };

    const outputsMap: OutputsMap = new Map();
    const { sendIpc } = collectMessages();

    const result = await executeStepLoop({
      steps,
      createStepContext: captureFactory,
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap,
      event: {},
      env: {},
      jobHooks,
      startTime: Date.now(),
    });

    expect(result.status).toBe('failed');
    const onFailureCalls = calls.filter((c) => c.stepName === 'onFailure');
    expect(onFailureCalls).toHaveLength(1);
    expect(onFailureCalls[0].stepIndex).toBeGreaterThanOrEqual(steps.length);
  });

  it('jobDeadlineSignal interrupts a long-running in-flight step', async () => {
    // A single long step with no per-step timeout: only the job-deadline signal
    // can unwind it. Without the signal threaded into the step race, the step
    // would run to completion (the bug this guards against).
    let stepResolved = false;
    const steps = [
      makeStep('long-sleep', async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 60_000));
        stepResolved = true;
      }),
    ];

    const jobDeadline = new AbortController();
    // Fire the deadline shortly after the step starts.
    setTimeout(() => jobDeadline.abort(), 20);

    const outputsMap: OutputsMap = new Map();
    const { messages, sendIpc } = collectMessages();

    const result = await executeStepLoop({
      steps,
      createStepContext: () => stubStepContext(),
      sendIpc,
      // 30-min default would never bound the step within the test.
      defaultTimeoutMs: 30 * 60 * 1000,
      outputsMap,
      event: {},
      env: {},
      jobDeadlineSignal: jobDeadline.signal,
      startTime: Date.now(),
    });

    // The step was aborted by the deadline, not run to completion.
    expect(stepResolved).toBe(false);
    expect(result.status).toBe('failed');
    const stepComplete = messages.find((m) => m.type === 'step.complete');
    expect(stepComplete).toBeDefined();
    expect((stepComplete as { status: string }).status).toBe('failed');
  });

  it('restores a step-level cache before the step runs and saves it after success', async () => {
    const order: string[] = [];
    const restore = vi.fn(async () => {
      order.push('restore');
      return { hit: false };
    });
    const save = vi.fn(async () => {
      order.push('save');
    });
    const steps = [
      {
        ...makeStep('cached-step', async () => {
          order.push('run');
        }),
        cache: { key: 's-k', paths: ['dist'] },
      } as Step,
    ];

    const outputsMap: OutputsMap = new Map();
    const { messages, sendIpc } = collectMessages();

    const result = await executeStepLoop({
      steps,
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap,
      event: {},
      env: {},
      cachePhaseDeps: { cache: { restore, save }, sendIpc, nextStepIndex: () => 999 },
      startTime: Date.now(),
    });

    expect(result.status).toBe('success');
    // restore before run, save after run
    expect(order).toEqual(['restore', 'run', 'save']);
    // pseudo-steps surface as cache:restore / cache:save step.complete IPC
    const cacheCompletes = messages.filter(
      (m) => m.type === 'step.complete' && m.step_type?.startsWith('cache:'),
    );
    expect(cacheCompletes).toHaveLength(2);
  });

  it('does NOT save a step-level cache when the step fails', async () => {
    const save = vi.fn(async () => {});
    const steps = [
      {
        ...makeStep('cached-step', async () => {
          throw new Error('step boom');
        }),
        cache: { key: 's-k', paths: ['dist'] },
      } as Step,
    ];
    const outputsMap: OutputsMap = new Map();
    const { sendIpc } = collectMessages();
    const result = await executeStepLoop({
      steps,
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap,
      event: {},
      env: {},
      cachePhaseDeps: {
        cache: { restore: vi.fn(async () => ({ hit: false })), save },
        sendIpc,
        nextStepIndex: () => 999,
      },
      startTime: Date.now(),
    });
    expect(result.status).toBe('failed');
    expect(save).not.toHaveBeenCalled();
  });
});

describe('executeStepLoop parallel groups', () => {
  /** Wire per-step abort controllers so fail-fast can cancel a sibling. */
  function parallelOpts(extra: Partial<Parameters<typeof executeStepLoop>[0]> = {}) {
    const controllers = new Map<number, AbortController>();
    const { messages, sendIpc } = collectMessages();
    return {
      messages,
      opts: {
        steps: [] as Step[],
        sendIpc,
        defaultTimeoutMs: 30_000,
        outputsMap: new Map(),
        event: {},
        env: {},
        startTime: Date.now(),
        createStepContext: (stepIndex: number) => {
          const c = new AbortController();
          controllers.set(stepIndex, c);
          return stubStepContext({ signal: c.signal } as Partial<StepContext>);
        },
        abortStep: (stepIndex: number) => controllers.get(stepIndex)?.abort(),
        getStepAbortSignal: (stepIndex: number) => controllers.get(stepIndex)?.signal,
        ...extra,
      } as Parameters<typeof executeStepLoop>[0],
    };
  }

  it('runs a parallel group concurrently and stamps concurrencyKind/groupId', async () => {
    const order: string[] = [];
    const a = makeStep('a', async () => {
      await new Promise((r) => setTimeout(r, 25));
      order.push('a');
    });
    const b = makeStep('b', async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push('b');
    });
    const { messages, opts } = parallelOpts({
      steps: [a, b],
      stepNodes: [
        {
          kind: 'parallel',
          groupId: 'g0',
          name: 'g0',
          failFast: true,
          children: [
            { step: a, stepIndex: 0 },
            { step: b, stepIndex: 1 },
          ],
        },
      ],
    });
    const result = await executeStepLoop(opts);
    expect(result.status).toBe('success');
    expect(order).toEqual(['b', 'a']);
    const completes = messages.filter((m) => m.type === 'step.complete');
    expect(completes.every((m) => (m as { groupId?: string }).groupId === 'g0')).toBe(true);
    expect(
      completes.every(
        (m) => (m as { concurrencyKind?: string }).concurrencyKind === 'parallel-child',
      ),
    ).toBe(true);
  });

  it('fail-fast cancels the in-flight sibling and fails the job', async () => {
    const boom = makeStep('boom', async () => {
      await new Promise((r) => setTimeout(r, 2));
      throw new Error('boom failed');
    });
    const slow = makeStep('slow', async (ctx) => {
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener('abort', () => resolve());
        setTimeout(resolve, 1000);
      });
    });
    const { messages, opts } = parallelOpts({
      steps: [boom, slow],
      stepNodes: [
        {
          kind: 'parallel',
          groupId: 'g0',
          name: 'g0',
          failFast: true,
          children: [
            { step: boom, stepIndex: 0 },
            { step: slow, stepIndex: 1 },
          ],
        },
      ],
    });
    const result = await executeStepLoop(opts);
    expect(result.status).toBe('failed');
    const slowComplete = messages.find((m) => m.type === 'step.complete' && m.stepIndex === 1) as
      | { status?: string }
      | undefined;
    expect(slowComplete?.status).toBe('cancelled');
  });
});

describe('executeStepLoop step-approval gate', () => {
  function makeApprovalStep(name: string, ran: { value: boolean }): Step {
    return {
      _tag: 'Step',
      name,
      approval: [{ team: 'leads' }],
      run: async () => {
        ran.value = true;
      },
      result: {} as any,
    };
  }

  it('runs the step when the approval is approved', async () => {
    const ran = { value: false };
    const outputsMap: OutputsMap = new Map();
    const { sendIpc } = collectMessages();
    const awaitStepApproval = vi.fn().mockResolvedValue({ outcome: 'approved' as const });

    const result = await executeStepLoop({
      steps: [makeApprovalStep('deploy', ran)],
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap,
      event: {},
      env: {},
      startTime: Date.now(),
      awaitStepApproval,
    });

    expect(awaitStepApproval).toHaveBeenCalledOnce();
    expect(awaitStepApproval.mock.calls[0][0]).toMatchObject({
      stepIndex: 0,
      stepName: 'deploy',
      clauses: [{ team: 'leads' }],
    });
    expect(ran.value).toBe(true);
    expect(result.status).toBe('success');
  });

  it('fails the job and does not run the step when rejected', async () => {
    const ran = { value: false };
    const outputsMap: OutputsMap = new Map();
    const { sendIpc } = collectMessages();
    const awaitStepApproval = vi
      .fn()
      .mockResolvedValue({ outcome: 'rejected' as const, reason: 'nope' });

    const result = await executeStepLoop({
      steps: [makeApprovalStep('deploy', ran)],
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap,
      event: {},
      env: {},
      startTime: Date.now(),
      awaitStepApproval,
    });

    expect(ran.value).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.stepResults[0].error?.message).toContain('approval rejected');
  });

  it('fails the job when the approval expires', async () => {
    const ran = { value: false };
    const outputsMap: OutputsMap = new Map();
    const { sendIpc } = collectMessages();
    const awaitStepApproval = vi.fn().mockResolvedValue({ outcome: 'expired' as const });

    const result = await executeStepLoop({
      steps: [makeApprovalStep('deploy', ran)],
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap,
      event: {},
      env: {},
      startTime: Date.now(),
      awaitStepApproval,
    });

    expect(ran.value).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.stepResults[0].error?.message).toContain('approval expired');
  });

  it('runs the step unconditionally when awaitStepApproval is not wired', async () => {
    const ran = { value: false };
    const outputsMap: OutputsMap = new Map();
    const { sendIpc } = collectMessages();

    const result = await executeStepLoop({
      steps: [makeApprovalStep('deploy', ran)],
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap,
      event: {},
      env: {},
      startTime: Date.now(),
    });

    expect(ran.value).toBe(true);
    expect(result.status).toBe('success');
  });

  it('does not pre-step gate a when:drift step (the drift gate owns it)', async () => {
    const ran = { value: false };
    const outputsMap: OutputsMap = new Map();
    const { sendIpc } = collectMessages();
    const awaitStepApproval = vi.fn().mockResolvedValue({ outcome: 'approved' as const });

    const driftStep: Step = {
      _tag: 'Step',
      name: 'cfg',
      check: async () => null, // in sync ⇒ no drift ⇒ no gate, step skips
      summarize: () => 'x',
      approval: { when: 'drift' } as any,
      run: async () => {
        ran.value = true;
      },
      result: {} as any,
    } as Step;

    const result = await executeStepLoop({
      steps: [driftStep],
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap,
      event: {},
      env: {},
      checkMode: 'apply',
      startTime: Date.now(),
      awaitStepApproval,
    });

    // The pre-step gate must NOT fire for a when:drift step.
    expect(awaitStepApproval).not.toHaveBeenCalled();
    expect(result.status).toBe('success');
  });
});

describe('executeStepLoop drift-approval gate', () => {
  function makeDriftStep(opts: {
    name: string;
    drift: unknown | null;
    runSpy?: ReturnType<typeof vi.fn>;
  }): Step {
    return {
      _tag: 'Step',
      name: opts.name,
      check: async () => opts.drift,
      summarize: (d: any) => `would change: ${JSON.stringify(d)}`,
      approval: { when: 'drift', approvers: [{ team: 'ops' }], reason: 'prod patch' } as any,
      run: (opts.runSpy ?? vi.fn(async () => ({ applied: true }))) as any,
      result: {} as any,
    } as Step;
  }

  it('apply mode + drift => requests approval with payload; applies on approve', async () => {
    const runSpy = vi.fn(async () => ({ applied: true }));
    const { sendIpc } = collectMessages();
    const awaitStepApprovalWithPayload = vi
      .fn()
      .mockResolvedValue({ outcome: 'approved' as const });

    const result = await executeStepLoop({
      steps: [makeDriftStep({ name: 'cfg', drift: { want: 'x' }, runSpy })],
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      checkMode: 'apply',
      startTime: Date.now(),
      awaitStepApprovalWithPayload,
    });

    expect(awaitStepApprovalWithPayload).toHaveBeenCalledOnce();
    const req = awaitStepApprovalWithPayload.mock.calls[0][0];
    expect(req).toMatchObject({
      stepIndex: 0,
      stepName: 'cfg',
      clauses: [{ team: 'ops' }],
      reason: 'prod patch',
    });
    expect(req.payload.summaryMarkdown).toBe('would change: {"want":"x"}');
    expect(req.payload.drift).toEqual({ want: 'x' });
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0][1]).toEqual({ want: 'x' });
    expect(result.status).toBe('success');
  });

  it('apply mode + drift => fail-stop when rejected; run NOT called', async () => {
    const runSpy = vi.fn(async () => ({ applied: true }));
    const { sendIpc } = collectMessages();
    const awaitStepApprovalWithPayload = vi
      .fn()
      .mockResolvedValue({ outcome: 'rejected' as const, reason: 'nope' });

    const result = await executeStepLoop({
      steps: [makeDriftStep({ name: 'cfg', drift: { want: 'x' }, runSpy })],
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      checkMode: 'apply',
      startTime: Date.now(),
      awaitStepApprovalWithPayload,
    });

    expect(runSpy).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
  });

  it('in-sync (no drift) => no approval requested; step skips', async () => {
    const runSpy = vi.fn(async () => ({ applied: true }));
    const { sendIpc } = collectMessages();
    const awaitStepApprovalWithPayload = vi.fn();

    const result = await executeStepLoop({
      steps: [makeDriftStep({ name: 'cfg', drift: null, runSpy })],
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      checkMode: 'apply',
      startTime: Date.now(),
      awaitStepApprovalWithPayload,
    });

    expect(awaitStepApprovalWithPayload).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
    expect(result.status).toBe('success');
  });

  it('check mode never gates on drift (preview only)', async () => {
    const runSpy = vi.fn(async () => ({ applied: true }));
    const { sendIpc } = collectMessages();
    const awaitStepApprovalWithPayload = vi.fn();

    const result = await executeStepLoop({
      steps: [makeDriftStep({ name: 'cfg', drift: { want: 'x' }, runSpy })],
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      checkMode: 'check',
      startTime: Date.now(),
      awaitStepApprovalWithPayload,
    });

    expect(awaitStepApprovalWithPayload).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
    expect(result.status).toBe('success');
  });
});

describe('executeStepLoop check mode', () => {
  /** Build a checked (idempotent) step with spy-able check / run / whenInSync. */
  function makeCheckStep(opts: {
    name: string;
    drift: unknown | null;
    runSpy?: ReturnType<typeof vi.fn>;
    whenInSyncSpy?: ReturnType<typeof vi.fn>;
    checkThrows?: boolean;
    continueOnError?: boolean;
  }): Step {
    return {
      _tag: 'Step',
      name: opts.name,
      check: async () => {
        if (opts.checkThrows) throw new Error('check boom');
        return opts.drift;
      },
      summarize: (d: any) => `would change: ${JSON.stringify(d)}`,
      run: (opts.runSpy ?? vi.fn(async () => ({ applied: true }))) as any,
      ...(opts.whenInSyncSpy && { whenInSync: opts.whenInSyncSpy }),
      ...(opts.continueOnError !== undefined && { continueOnError: opts.continueOnError }),
      result: {} as any,
    } as Step;
  }

  function findStepComplete(
    messages: RunnerToAgentMessage[],
  ): Extract<RunnerToAgentMessage, { type: 'step.complete' }> {
    const m = messages.find((x) => x.type === 'step.complete');
    if (!m || m.type !== 'step.complete') throw new Error('no step.complete emitted');
    return m;
  }

  it('apply mode + drift => applied; run called with drift', async () => {
    const runSpy = vi.fn(async () => ({ applied: true }));
    const { messages, sendIpc } = collectMessages();
    const result = await executeStepLoop({
      steps: [makeCheckStep({ name: 'cfg', drift: { want: 'x' }, runSpy })],
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      checkMode: 'apply',
      startTime: Date.now(),
    });
    expect(result.status).toBe('success');
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0][1]).toEqual({ want: 'x' });
    const sc = findStepComplete(messages);
    expect(sc.status).toBe('success');
    expect(sc.checkOutcome).toBe('applied');
  });

  it('apply mode + null => skipped; whenInSync called, run NOT called', async () => {
    const runSpy = vi.fn(async () => ({ applied: true }));
    const whenInSyncSpy = vi.fn(async () => ({ applied: false }));
    const { messages, sendIpc } = collectMessages();
    const result = await executeStepLoop({
      steps: [makeCheckStep({ name: 'cfg', drift: null, runSpy, whenInSyncSpy })],
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      checkMode: 'apply',
      startTime: Date.now(),
    });
    expect(result.status).toBe('success');
    expect(runSpy).not.toHaveBeenCalled();
    expect(whenInSyncSpy).toHaveBeenCalledTimes(1);
    const sc = findStepComplete(messages);
    expect(sc.status).toBe('skipped');
    expect(sc.checkOutcome).toBe('skipped');
  });

  it('check mode + drift => dry-run; run NOT called', async () => {
    const runSpy = vi.fn(async () => ({ applied: true }));
    const { messages, sendIpc } = collectMessages();
    const result = await executeStepLoop({
      steps: [makeCheckStep({ name: 'cfg', drift: { want: 'x' }, runSpy })],
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      checkMode: 'check',
      startTime: Date.now(),
    });
    expect(result.status).toBe('success');
    expect(runSpy).not.toHaveBeenCalled();
    const sc = findStepComplete(messages);
    expect(sc.status).toBe('success');
    expect(sc.checkOutcome).toBe('dry-run');
    expect(sc.driftSummary).toContain('would change');
    expect(sc.drift).toEqual({ want: 'x' });
  });

  it('check mode + null => skipped; run NOT called', async () => {
    const runSpy = vi.fn(async () => ({ applied: true }));
    const { messages, sendIpc } = collectMessages();
    const result = await executeStepLoop({
      steps: [makeCheckStep({ name: 'cfg', drift: null, runSpy })],
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      checkMode: 'check',
      startTime: Date.now(),
    });
    expect(result.status).toBe('success');
    expect(runSpy).not.toHaveBeenCalled();
    const sc = findStepComplete(messages);
    expect(sc.status).toBe('skipped');
    expect(sc.checkOutcome).toBe('skipped');
  });

  it('check mode + plain step (no check fn) => no_check; run NOT called', async () => {
    const runSpy = vi.fn(async () => {});
    const { messages, sendIpc } = collectMessages();
    const result = await executeStepLoop({
      steps: [makeStep('plain', runSpy as any)],
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      checkMode: 'check',
      startTime: Date.now(),
    });
    expect(result.status).toBe('success');
    expect(runSpy).not.toHaveBeenCalled();
    const sc = findStepComplete(messages);
    expect(sc.status).toBe('skipped');
    expect(sc.checkOutcome).toBe('no_check');
  });

  it('apply mode + plain step (no check fn) => run called, no checkOutcome', async () => {
    const runSpy = vi.fn(async () => {});
    const { messages, sendIpc } = collectMessages();
    const result = await executeStepLoop({
      steps: [makeStep('plain', runSpy as any)],
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      checkMode: 'apply',
      startTime: Date.now(),
    });
    expect(result.status).toBe('success');
    expect(runSpy).toHaveBeenCalledTimes(1);
    const sc = findStepComplete(messages);
    expect(sc.status).toBe('success');
    expect(sc.checkOutcome).toBeUndefined();
  });

  it('check() throwing => failed', async () => {
    const { messages, sendIpc } = collectMessages();
    const result = await executeStepLoop({
      steps: [makeCheckStep({ name: 'cfg', drift: { want: 'x' }, checkThrows: true })],
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      checkMode: 'apply',
      startTime: Date.now(),
    });
    expect(result.status).toBe('failed');
    const sc = findStepComplete(messages);
    expect(sc.status).toBe('failed');
  });

  it('check() throwing with continueOnError => loop continues past the failed step', async () => {
    const secondRun = vi.fn(async () => {});
    const { sendIpc } = collectMessages();
    const result = await executeStepLoop({
      steps: [
        makeCheckStep({
          name: 'cfg',
          drift: { want: 'x' },
          checkThrows: true,
          continueOnError: true,
        }),
        makeStep('after', secondRun as any),
      ],
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      checkMode: 'apply',
      startTime: Date.now(),
    });
    // continueOnError lets the loop reach the next step; the failed step is still
    // recorded (the job-runner layer applies the "don't fail the job" semantic).
    expect(secondRun).toHaveBeenCalledTimes(1);
    expect(result.stepResults[0].status).toBe('failed');
    expect(result.stepResults[1].status).toBe('success');
  });
});

describe('step retry', () => {
  function makeRetryStep(
    name: string,
    run: (ctx: StepContext) => Promise<void>,
    retry: Step['retry'],
    extra: Partial<Step> = {},
  ): Step {
    return { _tag: 'Step', name, run, retry, result: {} as any, ...extra };
  }

  it('retries a thrown step then succeeds', async () => {
    let n = 0;
    const step = makeRetryStep(
      'flaky',
      async () => {
        if (++n < 3) throw new Error('boom');
      },
      { maxAttempts: 3, delayMs: 1, backoff: 'fixed', maxDelayMs: 1 },
    );
    const { sendIpc } = collectMessages();
    const result = await executeStepLoop({
      steps: [step],
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      startTime: Date.now(),
    });
    expect(n).toBe(3);
    expect(result.status).toBe('success');
    expect(result.stepResults[0].status).toBe('success');
  });

  it('fails after exhausting attempts', async () => {
    let n = 0;
    const step = makeRetryStep(
      'always',
      async () => {
        n++;
        throw new Error('boom');
      },
      { maxAttempts: 2, delayMs: 1, backoff: 'fixed', maxDelayMs: 1 },
    );
    const { sendIpc } = collectMessages();
    const result = await executeStepLoop({
      steps: [step],
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      startTime: Date.now(),
    });
    expect(n).toBe(2);
    expect(result.stepResults[0].status).toBe('failed');
  });

  it('retryIf=false fails immediately (one attempt)', async () => {
    let n = 0;
    const step = makeRetryStep(
      'nonretry',
      async () => {
        n++;
        throw new Error('nope');
      },
      { maxAttempts: 3, delayMs: 1, backoff: 'fixed', maxDelayMs: 1, retryIf: () => false },
    );
    const { sendIpc } = collectMessages();
    const result = await executeStepLoop({
      steps: [step],
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      startTime: Date.now(),
    });
    expect(n).toBe(1);
    expect(result.stepResults[0].status).toBe('failed');
  });

  it('retries exhaust before continueOnError softens the failure', async () => {
    let n = 0;
    const secondRun = vi.fn(async () => {});
    const flaky = makeRetryStep(
      'soft',
      async () => {
        n++;
        throw new Error('x');
      },
      { maxAttempts: 2, delayMs: 1, backoff: 'fixed', maxDelayMs: 1 },
      { continueOnError: true },
    );
    const after: Step = { _tag: 'Step', name: 'after', run: secondRun as any, result: {} as any };
    const { sendIpc } = collectMessages();
    const result = await executeStepLoop({
      steps: [flaky, after],
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      startTime: Date.now(),
    });
    // Retries exhaust first (2 attempts), then continueOnError lets the loop reach
    // the next step.
    expect(n).toBe(2);
    expect(secondRun).toHaveBeenCalledTimes(1);
    expect(result.stepResults[0].status).toBe('failed');
    expect(result.stepResults[1].status).toBe('success');
  });

  it('per-attempt timeout counts as one failed attempt and retries', async () => {
    let n = 0;
    const step = makeRetryStep(
      'slow-then-fast',
      async () => {
        n++;
        if (n === 1) await new Promise((r) => setTimeout(r, 200)); // exceeds the 50ms timeout
      },
      { maxAttempts: 2, delayMs: 1, backoff: 'fixed', maxDelayMs: 1 },
      { timeout: 50 },
    );
    const { sendIpc } = collectMessages();
    const result = await executeStepLoop({
      steps: [step],
      createStepContext: () => stubStepContext(),
      sendIpc,
      defaultTimeoutMs: 30_000,
      outputsMap: new Map(),
      event: {},
      env: {},
      startTime: Date.now(),
    });
    expect(n).toBe(2);
    expect(result.stepResults[0].status).toBe('success');
  });
});
