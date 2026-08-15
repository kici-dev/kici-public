import { describe, it, expect, vi } from 'vitest';
import { evaluateDynamicFields, type FilterEvalInput } from './init-runner.js';
import type { Workflow, Job, RepoInfo } from '@kici-dev/sdk';

/**
 * Helper to create a minimal Workflow with one job for testing.
 */
function makeWorkflow(jobOverrides: Partial<Job> = {}): Workflow {
  const job: Job = {
    _tag: 'Job',
    name: 'deploy',
    runsOn: 'ubuntu',
    steps: [],
    ...jobOverrides,
  };
  return {
    _tag: 'Workflow',
    name: 'ci',
    jobs: [job],
  };
}

describe('evaluateDynamicFields', () => {
  it('resolves all three dynamic fields when all flags are true', async () => {
    const workflow = makeWorkflow({
      context: () => 'staging',
      env: () => ({ NODE_ENV: 'staging', DEBUG: '1' }),
      concurrencyGroup: () => 'deploy-staging',
    });

    const result = await evaluateDynamicFields(
      workflow,
      'deploy',
      { branch: 'main' },
      { dynamicContext: true, dynamicEnv: true, dynamicConcurrencyGroup: true },
    );

    expect(result.contextNames).toEqual(['staging']);
    expect(result.env).toEqual({ NODE_ENV: 'staging', DEBUG: '1' });
    expect(result.concurrencyGroup).toBe('deploy-staging');
  });

  it('resolves a dynamic matrix function to combination values', async () => {
    const workflow = makeWorkflow({
      matrix: () => ({ variant: ['a', 'b'] }),
    } as Partial<Job>);

    const result = await evaluateDynamicFields(
      workflow,
      'deploy',
      {},
      {
        dynamicContext: false,
        dynamicEnv: false,
        dynamicConcurrencyGroup: false,
        dynamicMatrix: true,
      },
    );

    expect(result.matrixValues).toEqual([{ variant: 'a' }, { variant: 'b' }]);
  });

  it('applies include/exclude to a resolved dynamic matrix', async () => {
    const workflow = makeWorkflow({
      matrix: () => ['a', 'b', 'c'],
      exclude: [{ value: 'b' }],
    } as Partial<Job>);

    const result = await evaluateDynamicFields(
      workflow,
      'deploy',
      {},
      {
        dynamicContext: false,
        dynamicEnv: false,
        dynamicConcurrencyGroup: false,
        dynamicMatrix: true,
      },
    );

    expect(result.matrixValues).toEqual([{ value: 'a' }, { value: 'c' }]);
  });

  it('leaves matrixValues undefined when dynamicMatrix flag is off', async () => {
    const workflow = makeWorkflow({ matrix: () => ['a'] } as Partial<Job>);
    const result = await evaluateDynamicFields(
      workflow,
      'deploy',
      {},
      { dynamicContext: false, dynamicEnv: false, dynamicConcurrencyGroup: false },
    );
    expect(result.matrixValues).toBeUndefined();
  });

  it('resolves only contextName when only dynamicContext is true', async () => {
    const workflow = makeWorkflow({
      context: () => 'production',
      env: () => ({ SHOULD_NOT: 'resolve' }),
      concurrencyGroup: () => 'should-not-resolve',
    });

    const result = await evaluateDynamicFields(
      workflow,
      'deploy',
      {},
      { dynamicContext: true, dynamicEnv: false, dynamicConcurrencyGroup: false },
    );

    expect(result.contextNames).toEqual(['production']);
    expect(result.env).toBeUndefined();
    expect(result.concurrencyGroup).toBeUndefined();
  });

  it('resolves dynamic env when dynamicEnv is true', async () => {
    const workflow = makeWorkflow({
      env: () => ({ NODE_ENV: 'staging' }),
    });

    const result = await evaluateDynamicFields(
      workflow,
      'deploy',
      {},
      { dynamicContext: false, dynamicEnv: true, dynamicConcurrencyGroup: false },
    );

    expect(result.env).toEqual({ NODE_ENV: 'staging' });
    expect(result.contextNames).toBeUndefined();
    expect(result.concurrencyGroup).toBeUndefined();
  });

  it('throws when dynamic function throws', async () => {
    const workflow = makeWorkflow({
      context: () => {
        throw new Error('External API down');
      },
    });

    await expect(
      evaluateDynamicFields(
        workflow,
        'deploy',
        {},
        { dynamicContext: true, dynamicEnv: false, dynamicConcurrencyGroup: false },
      ),
    ).rejects.toThrow('External API down');
  });

  it('leaves field undefined when dynamic function returns undefined', async () => {
    const workflow = makeWorkflow({
      context: () => undefined as unknown as string,
    });

    const result = await evaluateDynamicFields(
      workflow,
      'deploy',
      {},
      { dynamicContext: true, dynamicEnv: false, dynamicConcurrencyGroup: false },
    );

    expect(result.contextNames).toBeUndefined();
  });

  it('throws timeout error when dynamic function exceeds timeout', async () => {
    const workflow = makeWorkflow({
      context: () => new Promise((resolve) => setTimeout(() => resolve('late'), 500)),
    });

    await expect(
      evaluateDynamicFields(
        workflow,
        'deploy',
        {},
        { dynamicContext: true, dynamicEnv: false, dynamicConcurrencyGroup: false },
        50, // 50ms timeout, function takes 500ms
      ),
    ).rejects.toThrow(/Timeout after 50ms/);
  });

  it('awaits async dynamic functions correctly', async () => {
    const workflow = makeWorkflow({
      context: async () => {
        await new Promise((r) => setTimeout(r, 10));
        return 'async-env';
      },
      env: async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { ASYNC: 'true' };
      },
    });

    const result = await evaluateDynamicFields(
      workflow,
      'deploy',
      {},
      { dynamicContext: true, dynamicEnv: true, dynamicConcurrencyGroup: false },
    );

    expect(result.contextNames).toEqual(['async-env']);
    expect(result.env).toEqual({ ASYNC: 'true' });
  });

  it('passes event data as argument to dynamic functions', async () => {
    const workflow = makeWorkflow({
      context: (event: Record<string, unknown>) =>
        event.branch === 'main' ? 'production' : 'staging',
      env: (event: Record<string, unknown>) => ({
        DEPLOY_TARGET: event.branch as string,
      }),
      concurrencyGroup: (event: Record<string, unknown>) => `deploy-${event.branch as string}`,
    });

    const event = { branch: 'main', sha: 'abc123' };
    const result = await evaluateDynamicFields(workflow, 'deploy', event, {
      dynamicContext: true,
      dynamicEnv: true,
      dynamicConcurrencyGroup: true,
    });

    expect(result.contextNames).toEqual(['production']);
    expect(result.env).toEqual({ DEPLOY_TARGET: 'main' });
    expect(result.concurrencyGroup).toBe('deploy-main');
  });

  it('throws when job is not found in workflow', async () => {
    const workflow = makeWorkflow();

    await expect(
      evaluateDynamicFields(
        workflow,
        'nonexistent',
        {},
        { dynamicContext: true, dynamicEnv: false, dynamicConcurrencyGroup: false },
      ),
    ).rejects.toThrow("Job 'nonexistent' not found in workflow 'ci'");
  });

  it('resolves the full ordered env list including static elements when the list is dynamic', async () => {
    const workflow = makeWorkflow({
      context: 'static-env', // single static name, normalized to a one-element list
    });

    const result = await evaluateDynamicFields(
      workflow,
      'deploy',
      {},
      { dynamicContext: true, dynamicEnv: false, dynamicConcurrencyGroup: false },
    );

    // The agent returns the complete ordered name list (static names verbatim).
    expect(result.contextNames).toEqual(['static-env']);
  });

  it('resolves each element of a multi-environment list in order', async () => {
    const workflow = makeWorkflow({
      contexts: ['staging', (event: Record<string, unknown>) => `env-${event.branch as string}`],
    });

    const result = await evaluateDynamicFields(
      workflow,
      'deploy',
      { branch: 'main' },
      { dynamicContext: true, dynamicEnv: false, dynamicConcurrencyGroup: false },
    );

    expect(result.contextNames).toEqual(['staging', 'env-main']);
  });
});

describe('dynamic matrix input guards', () => {
  const matrixFlags = {
    dynamicContext: false,
    dynamicEnv: false,
    dynamicConcurrencyGroup: false,
    dynamicMatrix: true,
  };

  it('fails with an actionable error when the matrix function forgot its return', async () => {
    const workflow = makeWorkflow({ matrix: (() => undefined) as never });
    await expect(evaluateDynamicFields(workflow, 'deploy', {}, matrixFlags)).rejects.toThrow(
      /dynamicMatrix for job 'deploy'/,
    );
  });

  it('fails instead of reading a bare string as one dimension per character', async () => {
    const workflow = makeWorkflow({ matrix: (() => 'linux') as never });
    await expect(evaluateDynamicFields(workflow, 'deploy', {}, matrixFlags)).rejects.toThrow(
      /one dimension per character/,
    );
  });

  it('fails fast on an oversized matrix instead of exhausting memory', async () => {
    const big = Array.from({ length: 1000 }, (_, i) => `v${i}`);
    const workflow = makeWorkflow({ matrix: (() => ({ a: big, b: big, c: big })) as never });
    await expect(evaluateDynamicFields(workflow, 'deploy', {}, matrixFlags)).rejects.toThrow(
      /too large to expand/,
    );
  });

  it('still expands a valid dynamic matrix', async () => {
    const workflow = makeWorkflow({ matrix: (() => ['a', 'b']) as never });
    const result = await evaluateDynamicFields(workflow, 'deploy', {}, matrixFlags);
    expect(result.matrixValues).toEqual([{ value: 'a' }, { value: 'b' }]);
  });
});

describe('workflow-level filter', () => {
  const filterFlags = {
    dynamicContext: false,
    dynamicEnv: false,
    dynamicConcurrencyGroup: false,
    hasFilter: true,
  };

  /**
   * A filter input whose diff is available by default. `changedFilesStatus` is
   * overridable so a test can exercise the unavailable-diff contract.
   */
  function makeFilterInput(over: Partial<FilterEvalInput> = {}): FilterEvalInput {
    const repo: RepoInfo = {
      identifier: 'acme/app',
      path: '/tmp/kici-filter-test',
      ref: 'main',
      sha: 'deadbeef',
    };
    return {
      sourceRepo: repo,
      workflowRepo: repo,
      changedFiles: ['src/index.ts'],
      changedFilesStatus: 'fetched',
      env: { CI: 'true' },
      ...over,
    };
  }

  it('evaluates the workflow filter and reports the verdict', async () => {
    const workflow = makeWorkflow();
    workflow.filter = () => false;

    const result = await evaluateDynamicFields(
      workflow,
      'deploy',
      { type: 'push' },
      filterFlags,
      60_000,
      makeFilterInput(),
    );

    expect(result.filterPassed).toBe(false);
  });

  it('skips every dynamic field once the filter says the workflow does not apply', async () => {
    // Positive control for the assertion below: the same job's dynamic env IS
    // evaluated when the filter passes, so `env: undefined` proves suppression
    // rather than a job that never had a dynamic field to begin with.
    const envFn = vi.fn(() => ({ NODE_ENV: 'staging' }));
    const make = (verdict: boolean) => {
      const workflow = makeWorkflow({ env: envFn });
      workflow.filter = () => verdict;
      return workflow;
    };

    const suppressed = await evaluateDynamicFields(
      make(false),
      'deploy',
      {},
      { ...filterFlags, dynamicEnv: true },
      60_000,
      makeFilterInput(),
    );
    expect(suppressed.filterPassed).toBe(false);
    expect(suppressed.env).toBeUndefined();
    expect(envFn).not.toHaveBeenCalled();

    const passed = await evaluateDynamicFields(
      make(true),
      'deploy',
      {},
      { ...filterFlags, dynamicEnv: true },
      60_000,
      makeFilterInput(),
    );
    expect(passed.filterPassed).toBe(true);
    expect(passed.env).toEqual({ NODE_ENV: 'staging' });
    expect(envFn).toHaveBeenCalledTimes(1);
  });

  it('reports no verdict at all when the workflow declares no filter', async () => {
    const workflow = makeWorkflow({ env: () => ({ A: '1' }) });
    const result = await evaluateDynamicFields(
      workflow,
      'deploy',
      {},
      {
        dynamicContext: false,
        dynamicEnv: true,
        dynamicConcurrencyGroup: false,
      },
    );
    expect(result.filterPassed).toBeUndefined();
    expect(result.env).toEqual({ A: '1' });
  });

  it('throws rather than reading an unavailable diff as an empty list', async () => {
    // The context is built through createFilterContext, so `changedFiles` is a
    // throwing getter. A plain object literal would silently hand the filter
    // `[]` here and suppress the workflow with nothing to inspect.
    const workflow = makeWorkflow();
    workflow.filter = (ctx) => ctx.changedFiles.some((f) => f.startsWith('src/'));

    await expect(
      evaluateDynamicFields(
        workflow,
        'deploy',
        { type: 'schedule' },
        filterFlags,
        60_000,
        makeFilterInput({ changedFiles: [], changedFilesStatus: 'unavailable' }),
      ),
    ).rejects.toThrow(/changedFiles/);

    // Positive control: the same filter decides cleanly when the diff IS there.
    const ok = await evaluateDynamicFields(
      workflow,
      'deploy',
      { type: 'push' },
      filterFlags,
      60_000,
      makeFilterInput(),
    );
    expect(ok.filterPassed).toBe(true);
  });

  it('hands the filter the repo pair, the event, and the diff', async () => {
    const seen: Record<string, unknown> = {};
    const workflow = makeWorkflow();
    workflow.filter = (ctx) => {
      seen.source = ctx.sourceRepo.identifier;
      seen.workflow = ctx.workflowRepo.identifier;
      seen.path = ctx.sourceRepo.path;
      seen.event = ctx.event;
      seen.changed = ctx.changedFiles;
      seen.env = ctx.env.CI;
      return true;
    };

    await evaluateDynamicFields(
      workflow,
      'deploy',
      { type: 'push' },
      filterFlags,
      60_000,
      makeFilterInput(),
    );

    expect(seen).toEqual({
      source: 'acme/app',
      workflow: 'acme/app',
      path: '/tmp/kici-filter-test',
      event: { type: 'push' },
      changed: ['src/index.ts'],
      env: 'true',
    });
  });

  it('fails with an actionable error when the lock records a filter the module does not export', async () => {
    const workflow = makeWorkflow();
    await expect(
      evaluateDynamicFields(workflow, 'deploy', {}, filterFlags, 60_000, makeFilterInput()),
    ).rejects.toThrow(/lock file is out of date/);
  });

  it('fails rather than evaluating a filter with no source tree to read', async () => {
    const workflow = makeWorkflow();
    workflow.filter = () => true;
    await expect(evaluateDynamicFields(workflow, 'deploy', {}, filterFlags)).rejects.toThrow(
      /supplied no filter context/,
    );
  });

  it('propagates a throwing filter instead of reading the throw as "do not run"', async () => {
    const workflow = makeWorkflow();
    workflow.filter = () => {
      throw new Error('filter exploded');
    };
    await expect(
      evaluateDynamicFields(workflow, 'deploy', {}, filterFlags, 60_000, makeFilterInput()),
    ).rejects.toThrow(/filter exploded/);
  });

  it('bounds a hanging filter with the init timeout', async () => {
    const workflow = makeWorkflow();
    workflow.filter = () => new Promise<boolean>(() => {});
    await expect(
      evaluateDynamicFields(workflow, 'deploy', {}, filterFlags, 10, makeFilterInput()),
    ).rejects.toThrow(/Timeout after 10ms/);
  });
});
