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

    expect(result.environmentName).toBe('staging');
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

    expect(result.environmentName).toBe('production');
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
    expect(result.environmentName).toBeUndefined();
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

    expect(result.environmentName).toBeUndefined();
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

    expect(result.environmentName).toBe('async-env');
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

    expect(result.environmentName).toBe('production');
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

  it('leaves field undefined when flag is true but property is not a function', async () => {
    const workflow = makeWorkflow({
      environment: 'static-env', // string, not function
    });

    const result = await evaluateDynamicFields(
      workflow,
      'deploy',
      {},
      { dynamicEnvironment: true, dynamicEnv: false, dynamicConcurrencyGroup: false },
    );

    // Static value is not evaluated -- the flag says dynamic but property is static
    expect(result.environmentName).toBeUndefined();
  });
});
