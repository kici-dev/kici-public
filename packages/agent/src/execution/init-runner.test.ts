import { describe, it, expect } from 'vitest';
import { evaluateDynamicFields } from './init-runner.js';
import type { Workflow, Job } from '@kici-dev/sdk';

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
      environment: () => 'staging',
      env: () => ({ NODE_ENV: 'staging', DEBUG: '1' }),
      concurrencyGroup: () => 'deploy-staging',
    });

    const result = await evaluateDynamicFields(
      workflow,
      'deploy',
      { branch: 'main' },
      { dynamicEnvironment: true, dynamicEnv: true, dynamicConcurrencyGroup: true },
    );

    expect(result.environmentNames).toEqual(['staging']);
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
        dynamicEnvironment: false,
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
        dynamicEnvironment: false,
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
      { dynamicEnvironment: false, dynamicEnv: false, dynamicConcurrencyGroup: false },
    );
    expect(result.matrixValues).toBeUndefined();
  });

  it('resolves only environmentName when only dynamicEnvironment is true', async () => {
    const workflow = makeWorkflow({
      environment: () => 'production',
      env: () => ({ SHOULD_NOT: 'resolve' }),
      concurrencyGroup: () => 'should-not-resolve',
    });

    const result = await evaluateDynamicFields(
      workflow,
      'deploy',
      {},
      { dynamicEnvironment: true, dynamicEnv: false, dynamicConcurrencyGroup: false },
    );

    expect(result.environmentNames).toEqual(['production']);
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
      { dynamicEnvironment: false, dynamicEnv: true, dynamicConcurrencyGroup: false },
    );

    expect(result.env).toEqual({ NODE_ENV: 'staging' });
    expect(result.environmentNames).toBeUndefined();
    expect(result.concurrencyGroup).toBeUndefined();
  });

  it('throws when dynamic function throws', async () => {
    const workflow = makeWorkflow({
      environment: () => {
        throw new Error('External API down');
      },
    });

    await expect(
      evaluateDynamicFields(
        workflow,
        'deploy',
        {},
        { dynamicEnvironment: true, dynamicEnv: false, dynamicConcurrencyGroup: false },
      ),
    ).rejects.toThrow('External API down');
  });

  it('leaves field undefined when dynamic function returns undefined', async () => {
    const workflow = makeWorkflow({
      environment: () => undefined as unknown as string,
    });

    const result = await evaluateDynamicFields(
      workflow,
      'deploy',
      {},
      { dynamicEnvironment: true, dynamicEnv: false, dynamicConcurrencyGroup: false },
    );

    expect(result.environmentNames).toBeUndefined();
  });

  it('throws timeout error when dynamic function exceeds timeout', async () => {
    const workflow = makeWorkflow({
      environment: () => new Promise((resolve) => setTimeout(() => resolve('late'), 500)),
    });

    await expect(
      evaluateDynamicFields(
        workflow,
        'deploy',
        {},
        { dynamicEnvironment: true, dynamicEnv: false, dynamicConcurrencyGroup: false },
        50, // 50ms timeout, function takes 500ms
      ),
    ).rejects.toThrow(/Timeout after 50ms/);
  });

  it('awaits async dynamic functions correctly', async () => {
    const workflow = makeWorkflow({
      environment: async () => {
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
      { dynamicEnvironment: true, dynamicEnv: true, dynamicConcurrencyGroup: false },
    );

    expect(result.environmentNames).toEqual(['async-env']);
    expect(result.env).toEqual({ ASYNC: 'true' });
  });

  it('passes event data as argument to dynamic functions', async () => {
    const workflow = makeWorkflow({
      environment: (event: Record<string, unknown>) =>
        event.branch === 'main' ? 'production' : 'staging',
      env: (event: Record<string, unknown>) => ({
        DEPLOY_TARGET: event.branch as string,
      }),
      concurrencyGroup: (event: Record<string, unknown>) => `deploy-${event.branch as string}`,
    });

    const event = { branch: 'main', sha: 'abc123' };
    const result = await evaluateDynamicFields(workflow, 'deploy', event, {
      dynamicEnvironment: true,
      dynamicEnv: true,
      dynamicConcurrencyGroup: true,
    });

    expect(result.environmentNames).toEqual(['production']);
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
        { dynamicEnvironment: true, dynamicEnv: false, dynamicConcurrencyGroup: false },
      ),
    ).rejects.toThrow("Job 'nonexistent' not found in workflow 'ci'");
  });

  it('resolves the full ordered env list including static elements when the list is dynamic', async () => {
    const workflow = makeWorkflow({
      environment: 'static-env', // single static name, normalized to a one-element list
    });

    const result = await evaluateDynamicFields(
      workflow,
      'deploy',
      {},
      { dynamicEnvironment: true, dynamicEnv: false, dynamicConcurrencyGroup: false },
    );

    // The agent returns the complete ordered name list (static names verbatim).
    expect(result.environmentNames).toEqual(['static-env']);
  });

  it('resolves each element of a multi-environment list in order', async () => {
    const workflow = makeWorkflow({
      environments: [
        'staging',
        (event: Record<string, unknown>) => `env-${event.branch as string}`,
      ],
    });

    const result = await evaluateDynamicFields(
      workflow,
      'deploy',
      { branch: 'main' },
      { dynamicEnvironment: true, dynamicEnv: false, dynamicConcurrencyGroup: false },
    );

    expect(result.environmentNames).toEqual(['staging', 'env-main']);
  });
});
