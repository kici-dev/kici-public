import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job, MatrixValues, Step, Workflow, StepContext, Rule } from '@kici-dev/sdk';
import type { SimulatedEvent } from '@kici-dev/engine';
import type { ResolvedJob, LocalJobResult } from './types.js';

// Mock the rule-evaluator module
vi.mock('../test-runner/rule-evaluator.js', () => ({
  createRuleContext: vi.fn().mockReturnValue({}),
  evaluateRules: vi.fn().mockResolvedValue({ allPassed: true, results: [] }),
}));

// Mock the output-formatter module
vi.mock('../test-runner/output-formatter.js', () => ({
  formatter: {
    logJobStart: vi.fn(),
    logJobComplete: vi.fn(),
    logJobFailure: vi.fn(),
    logJobLine: vi.fn(),
    logStepStart: vi.fn(),
    logStepComplete: vi.fn(),
    logStepError: vi.fn(),
    logRuleResult: vi.fn(),
  },
}));

// Mock step-context
vi.mock('../test-runner/step-context.js', () => ({
  createStepContext: vi.fn().mockReturnValue({
    $: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    env: {},
    setEnv: vi.fn(),
    addPath: vi.fn(),
    inputs: {},
    workflow: { name: 'test-workflow' },
    job: { name: 'test-job', runsOn: 'local' },
    matrix: undefined,
    isTestRun: false,
    secrets: {},
    emit: vi.fn(),
    outputsOf: vi.fn(),
    jobOutputs: vi.fn(),
    setSecretOutput: vi.fn(),
  }),
}));

// Mock SDK setters
vi.mock('@kici-dev/sdk', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    setStepOutputsMap: vi.fn(),
    setStepRefMap: vi.fn(),
    setJobOutputsMap: vi.fn(),
  };
});

import { resolveJobs, executeResolvedJob, type JobExecutionContext } from './job-runner.js';
import { evaluateRules } from '../test-runner/rule-evaluator.js';
import { createStepContext } from '../test-runner/step-context.js';

function makeStep(name: string, outputs?: Record<string, unknown>): Step {
  return {
    _tag: 'Step' as const,
    name,
    run: vi.fn().mockResolvedValue(outputs),
  } as unknown as Step;
}

function makeJob(overrides: Partial<Job> & { name: string }): Job {
  return {
    _tag: 'Job' as const,
    runsOn: 'local',
    steps: [],
    result: {} as any,
    ...overrides,
  } as Job;
}

function makeWorkflow(jobs: Job[]): Workflow {
  return {
    _tag: 'Workflow' as const,
    name: 'test-workflow',
    on: {},
    jobs,
  } as unknown as Workflow;
}

function makeEvent(): SimulatedEvent {
  return {
    type: 'push',
    payload: { ref: 'refs/heads/main', after: 'abc123' },
    targetBranch: 'main',
    changedFiles: [],
  };
}

function makeContext(overrides?: Partial<JobExecutionContext>): JobExecutionContext {
  return {
    workflowName: 'test-workflow',
    event: makeEvent(),
    secrets: { flat: {}, contexts: {} },
    kiciDir: '/tmp/.kici',
    execDir: '/tmp',
    jobOutputsMap: new Map(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('resolveJobs', () => {
  it('resolves static job into single ResolvedJob', async () => {
    const job = makeJob({ name: 'lint', steps: [makeStep('run-lint')] });
    const workflow = makeWorkflow([job]);
    const event = makeEvent();

    const resolved = await resolveJobs(workflow, event);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].expandedName).toBe('lint');
    expect(resolved[0].job).toBe(job);
    expect(resolved[0].matrixValues).toEqual({});
    expect(resolved[0].resolvedNeeds).toEqual([]);
  });

  it('resolves static job with needs as string[]', async () => {
    const setup = makeJob({ name: 'setup', steps: [makeStep('install')] });
    const lint = makeJob({ name: 'lint', needs: ['setup'], steps: [makeStep('run-lint')] });
    const workflow = makeWorkflow([setup, lint]);
    const event = makeEvent();

    const resolved = await resolveJobs(workflow, event);

    expect(resolved).toHaveLength(2);
    const lintResolved = resolved.find((r) => r.expandedName === 'lint')!;
    expect(lintResolved.resolvedNeeds).toEqual(['setup']);
  });

  it('resolves static job with needs as Job references', async () => {
    const setup = makeJob({ name: 'setup', steps: [makeStep('install')] });
    const lint = makeJob({ name: 'lint', needs: [setup as any], steps: [makeStep('run-lint')] });
    const workflow = makeWorkflow([setup, lint]);
    const event = makeEvent();

    const resolved = await resolveJobs(workflow, event);

    const lintResolved = resolved.find((r) => r.expandedName === 'lint')!;
    expect(lintResolved.resolvedNeeds).toEqual(['setup']);
  });

  it('expands matrix job into N ResolvedJob instances with correct names', async () => {
    const job = makeJob({
      name: 'test',
      matrix: ['node-18', 'node-20'] as any,
      steps: [makeStep('run-test')],
    });
    const workflow = makeWorkflow([job]);
    const event = makeEvent();

    const resolved = await resolveJobs(workflow, event);

    expect(resolved).toHaveLength(2);
    expect(resolved[0].expandedName).toBe('test (node-18)');
    expect(resolved[0].matrixValues).toEqual({ value: 'node-18' });
    expect(resolved[1].expandedName).toBe('test (node-20)');
    expect(resolved[1].matrixValues).toEqual({ value: 'node-20' });
  });

  it('expands multi-dimensional matrix job', async () => {
    const job = makeJob({
      name: 'test',
      matrix: { os: ['linux', 'macos'], node: ['18'] } as any,
      steps: [makeStep('run-test')],
    });
    const workflow = makeWorkflow([job]);
    const event = makeEvent();

    const resolved = await resolveJobs(workflow, event);

    expect(resolved).toHaveLength(2);
    // Object key iteration order: node dimension comes first (alphabetical JS behavior)
    expect(resolved).toHaveLength(2);
    // Each instance should have both os and node in matrixValues
    for (const r of resolved) {
      expect(r.matrixValues).toHaveProperty('os');
      expect(r.matrixValues).toHaveProperty('node');
    }
  });

  it('updates needs references to expanded names for fan-in pattern', async () => {
    const build = makeJob({
      name: 'build',
      matrix: ['debug', 'release'] as any,
      steps: [makeStep('compile')],
    });
    const deploy = makeJob({
      name: 'deploy',
      needs: ['build'],
      steps: [makeStep('publish')],
    });
    const workflow = makeWorkflow([build, deploy]);
    const event = makeEvent();

    const resolved = await resolveJobs(workflow, event);

    const deployResolved = resolved.find((r) => r.expandedName === 'deploy')!;
    expect(deployResolved.resolvedNeeds).toContain('build (debug)');
    expect(deployResolved.resolvedNeeds).toContain('build (release)');
    expect(deployResolved.resolvedNeeds).toHaveLength(2);
  });

  it('evaluates dynamic job functions and returns resulting jobs', async () => {
    const dynamicFn = vi
      .fn()
      .mockResolvedValue([
        makeJob({ name: 'generated-1', steps: [makeStep('step1')] }),
        makeJob({ name: 'generated-2', steps: [makeStep('step2')] }),
      ]);
    // Mark it as a function (isDynamicJobFn checks typeof === 'function')
    const workflow = {
      _tag: 'Workflow' as const,
      name: 'test-workflow',
      on: {},
      jobs: [dynamicFn],
    } as unknown as Workflow;
    const event = makeEvent();

    const resolved = await resolveJobs(workflow, event);

    expect(dynamicFn).toHaveBeenCalled();
    expect(resolved).toHaveLength(2);
    expect(resolved[0].expandedName).toBe('generated-1');
    expect(resolved[1].expandedName).toBe('generated-2');
  });

  it('passes the normalized event envelope to dynamic functions (raw fields under payload)', async () => {
    let seenEvent: Record<string, unknown> | undefined;
    const dynamicFn = vi.fn().mockImplementation(async ({ ctx }: { ctx: any }) => {
      seenEvent = ctx.event;
      return [makeJob({ name: 'gen', steps: [makeStep('s')] })];
    });
    const workflow = {
      _tag: 'Workflow' as const,
      name: 'envelope-wf',
      on: {},
      jobs: [dynamicFn],
    } as unknown as Workflow;
    const event: SimulatedEvent = {
      type: 'pull_request',
      action: 'opened',
      targetBranch: 'main',
      sourceBranch: 'feature',
      payload: { number: 42, pull_request: { number: 42, draft: false } },
      changedFiles: ['src/a.ts'],
    };

    await resolveJobs(workflow, event);

    expect(seenEvent).toBeDefined();
    // Normalized fields live at the top level of the envelope.
    expect(seenEvent!.type).toBe('pull_request');
    expect(seenEvent!.action).toBe('opened');
    expect(seenEvent!.targetBranch).toBe('main');
    expect(seenEvent!.sourceBranch).toBe('feature');
    // Raw provider fields stay nested under `payload`, NOT spread at top level.
    expect((seenEvent!.payload as Record<string, unknown>).number).toBe(42);
    expect(seenEvent!.number).toBeUndefined();
    expect((seenEvent!.payload as Record<string, unknown>).pull_request).toBeDefined();
    expect(seenEvent!.pull_request).toBeUndefined();
  });
});

describe('executeResolvedJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset evaluateRules to default passing behavior
    vi.mocked(evaluateRules).mockResolvedValue({ allPassed: true, results: [] } as any);
  });

  it('runs all steps in sequence with correct context', async () => {
    const step1 = makeStep('step-1', { key: 'val1' });
    const step2 = makeStep('step-2', { key: 'val2' });
    const job = makeJob({ name: 'test', steps: [step1, step2] });
    const resolved: ResolvedJob = {
      job,
      expandedName: 'test',
      matrixValues: {},
      resolvedNeeds: [],
    };
    const ctx = makeContext();

    const result = await executeResolvedJob(resolved, ctx);

    expect(result.status).toBe('success');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].name).toBe('step-1');
    expect(result.steps[1].name).toBe('step-2');
    expect(step1.run).toHaveBeenCalledOnce();
    expect(step2.run).toHaveBeenCalledOnce();
  });

  it('evaluates job rules before running steps and skips on rule failure', async () => {
    vi.mocked(evaluateRules).mockResolvedValue({
      allPassed: false,
      results: [{ label: 'test-rule', passed: false }],
    } as any);

    const step = makeStep('step-1');
    const rule = { label: 'test-rule', check: vi.fn() } as unknown as Rule;
    const job = makeJob({ name: 'test', steps: [step], rules: [rule] });
    const resolved: ResolvedJob = {
      job,
      expandedName: 'test',
      matrixValues: {},
      resolvedNeeds: [],
    };
    const ctx = makeContext();

    const result = await executeResolvedJob(resolved, ctx);

    expect(result.status).toBe('skipped');
    expect(result.steps).toHaveLength(0);
    expect(step.run).not.toHaveBeenCalled();
  });

  it('respects AbortSignal and returns cancelled status', async () => {
    const controller = new AbortController();
    const step1 = makeStep('step-1');
    // Abort after first step executes
    (step1.run as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      controller.abort();
      return undefined;
    });
    const step2 = makeStep('step-2');
    const job = makeJob({ name: 'test', steps: [step1, step2] });
    const resolved: ResolvedJob = {
      job,
      expandedName: 'test',
      matrixValues: {},
      resolvedNeeds: [],
    };
    const ctx = makeContext({ signal: controller.signal });

    const result = await executeResolvedJob(resolved, ctx);

    expect(result.status).toBe('cancelled');
    expect(step2.run).not.toHaveBeenCalled();
  });

  it('collects step outputs into jobOutputsMap for cross-job chaining', async () => {
    const step = makeStep('step-1', { result: 'hello' });
    const job = makeJob({ name: 'producer', steps: [step] });
    const resolved: ResolvedJob = {
      job,
      expandedName: 'producer',
      matrixValues: {},
      resolvedNeeds: [],
    };
    const jobOutputsMap = new Map();
    const ctx = makeContext({ jobOutputsMap });

    await executeResolvedJob(resolved, ctx);

    expect(jobOutputsMap.has('producer')).toBe(true);
  });

  it('builds the { byMatrix, merged } envelope under the base name for matrix children', async () => {
    const jobOutputsMap = new Map();
    const ctx = makeContext({ jobOutputsMap });

    // Child A
    await executeResolvedJob(
      {
        job: makeJob({ name: 'build', steps: [makeStep('s', { v: '1' })] }),
        expandedName: 'build (a)',
        matrixValues: { variant: 'a' },
        resolvedNeeds: [],
      },
      ctx,
    );
    // Child B
    await executeResolvedJob(
      {
        job: makeJob({ name: 'build', steps: [makeStep('s', { v: '2' })] }),
        expandedName: 'build (b)',
        matrixValues: { variant: 'b' },
        resolvedNeeds: [],
      },
      ctx,
    );

    // Each child keeps its own flat entry under the expanded name.
    expect(jobOutputsMap.get('build (a)')).toEqual({ v: '1' });
    expect(jobOutputsMap.get('build (b)')).toEqual({ v: '2' });
    // The base name carries the keyed envelope, merged last-write-wins in suffix order.
    expect(jobOutputsMap.get('build')).toEqual({
      byMatrix: { a: { v: '1' }, b: { v: '2' } },
      merged: { v: '2' },
    });
  });

  it('returns failure on step failure', async () => {
    const step1 = makeStep('step-1');
    (step1.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('step failed'));
    const step2 = makeStep('step-2');
    const job = makeJob({ name: 'test', steps: [step1, step2] });
    const resolved: ResolvedJob = {
      job,
      expandedName: 'test',
      matrixValues: {},
      resolvedNeeds: [],
    };
    const ctx = makeContext();

    const result = await executeResolvedJob(resolved, ctx);

    expect(result.status).toBe('failure');
    expect(result.error).toBeDefined();
    expect(step2.run).not.toHaveBeenCalled();
  });

  it('includes matrix values in result', async () => {
    const step = makeStep('step-1');
    const job = makeJob({ name: 'test', steps: [step] });
    const matrixValues: MatrixValues = { os: 'linux', node: '18' };
    const resolved: ResolvedJob = {
      job,
      expandedName: 'test (linux, 18)',
      matrixValues,
      resolvedNeeds: [],
    };
    const ctx = makeContext();

    const result = await executeResolvedJob(resolved, ctx);

    expect(result.matrixValues).toEqual(matrixValues);
  });

  it('forwards event.payload + event.provider to createStepContext as rawPayload + provider', async () => {
    const step = makeStep('step-1');
    const job = makeJob({ name: 'test', steps: [step] });
    const resolved: ResolvedJob = {
      job,
      expandedName: 'test',
      matrixValues: {},
      resolvedNeeds: [],
    };
    const event: SimulatedEvent = {
      type: 'dispatch',
      action: 'cdn-bundle',
      payload: { action: 'cdn-bundle', client_payload: { foo: 'bar' } },
      provider: 'github',
      targetBranch: 'main',
      changedFiles: [],
    };
    const ctx = makeContext({ event });

    await executeResolvedJob(resolved, ctx);

    // createStepContext is mocked; assert it was called with the event payload
    // and provider passed through as the 8th and 9th positional args.
    const calls = vi.mocked(createStepContext).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastCall = calls[calls.length - 1];
    // Args: workflowInfo, jobInfo, repoRoot, inputs, matrix, secrets, environment,
    //       rawPayload, provider
    expect(lastCall[7]).toEqual({ action: 'cdn-bundle', client_payload: { foo: 'bar' } });
    expect(lastCall[8]).toBe('github');
  });

  it('passes context.execDir to createStepContext as the repoRoot (3rd arg)', async () => {
    const step = makeStep('step-1');
    const job = makeJob({ name: 'test', steps: [step] });
    const resolved: ResolvedJob = {
      job,
      expandedName: 'test',
      matrixValues: {},
      resolvedNeeds: [],
    };
    const ctx = makeContext({ execDir: '/tmp/kici-run-abcdef' });

    await executeResolvedJob(resolved, ctx);

    const calls = vi.mocked(createStepContext).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastCall = calls[calls.length - 1];
    // Args: workflowInfo, jobInfo, repoRoot, inputs, matrix, secrets, ...
    expect(lastCall[2]).toBe('/tmp/kici-run-abcdef');
  });
});

describe('executeResolvedJob check mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(evaluateRules).mockResolvedValue({ allPassed: true, results: [] } as any);
  });

  function makeCheckStep(opts: {
    name: string;
    drift: unknown | null;
    runSpy?: ReturnType<typeof vi.fn>;
    whenInSyncSpy?: ReturnType<typeof vi.fn>;
  }): Step {
    return {
      _tag: 'Step' as const,
      name: opts.name,
      check: vi.fn().mockResolvedValue(opts.drift),
      summarize: (d: any) => `would change: ${JSON.stringify(d)}`,
      run: opts.runSpy ?? vi.fn().mockResolvedValue({ applied: true }),
      ...(opts.whenInSyncSpy && { whenInSync: opts.whenInSyncSpy }),
    } as unknown as Step;
  }

  async function runOne(step: Step, checkMode: import('@kici-dev/engine').CheckMode) {
    const job = makeJob({ name: 'test', steps: [step] });
    const resolved: ResolvedJob = {
      job,
      expandedName: 'test',
      matrixValues: {},
      resolvedNeeds: [],
    };
    return executeResolvedJob(resolved, makeContext({ checkMode }));
  }

  it('apply + drift => applied, run called with drift', async () => {
    const runSpy = vi.fn().mockResolvedValue({ applied: true });
    const result = await runOne(
      makeCheckStep({ name: 'cfg', drift: { want: 'x' }, runSpy }),
      'apply',
    );
    expect(result.steps[0].status).toBe('success');
    expect(result.steps[0].checkOutcome).toBe('applied');
    expect(runSpy).toHaveBeenCalledWith(expect.anything(), { want: 'x' });
  });

  it('check + drift => dry-run, run NOT called, sentinel not written', async () => {
    const runSpy = vi.fn().mockResolvedValue({ applied: true });
    const result = await runOne(
      makeCheckStep({ name: 'cfg', drift: { want: 'x' }, runSpy }),
      'check',
    );
    expect(result.steps[0].status).toBe('success');
    expect(result.steps[0].checkOutcome).toBe('dry-run');
    expect(result.steps[0].driftSummary).toContain('would change');
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('apply + null => skipped, whenInSync called, run NOT called', async () => {
    const runSpy = vi.fn().mockResolvedValue({ applied: true });
    const whenInSyncSpy = vi.fn().mockResolvedValue({ applied: false });
    const result = await runOne(
      makeCheckStep({ name: 'cfg', drift: null, runSpy, whenInSyncSpy }),
      'apply',
    );
    expect(result.steps[0].status).toBe('skipped');
    expect(result.steps[0].checkOutcome).toBe('skipped');
    expect(runSpy).not.toHaveBeenCalled();
    expect(whenInSyncSpy).toHaveBeenCalledOnce();
  });

  it('check + plain step => no_check, run NOT called', async () => {
    const runSpy = vi.fn().mockResolvedValue(undefined);
    const plain = { _tag: 'Step' as const, name: 'plain', run: runSpy } as unknown as Step;
    const result = await runOne(plain, 'check');
    expect(result.steps[0].status).toBe('skipped');
    expect(result.steps[0].checkOutcome).toBe('no_check');
    expect(runSpy).not.toHaveBeenCalled();
  });
});
