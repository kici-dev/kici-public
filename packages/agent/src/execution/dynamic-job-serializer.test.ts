import { describe, it, expect } from 'vitest';
import {
  serializeJobsToLock,
  MatrixExpansionError,
  MAX_DYNAMIC_JOBS,
  type SerializerContext,
} from './dynamic-job-serializer.js';
import { job, step } from '@kici-dev/sdk';

const mockCtx = (event: Record<string, unknown> = {}): SerializerContext => ({
  event,
  // The serializer only forwards $ to dynamic matrix fns; tests that exercise
  // matrix fns receive the same opaque value back via DynamicMatrixContext.
  $: (() => {}) as unknown as SerializerContext['$'],
  log: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
  env: process.env as Record<string, string | undefined>,
  workflowName: 'test-wf',
});

describe('serializeJobsToLock', () => {
  it('serializes a simple job with string runsOn', async () => {
    const jobs = [
      job('test-job', {
        runsOn: 'linux',
        steps: [
          step('hello', async ({ $ }) => {
            await $`echo hi`;
          }),
        ],
      }),
    ];

    const result = await serializeJobsToLock(jobs, mockCtx());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      _type: 'static',
      name: 'test-job',
      runsOn: [{ kind: 'exact', value: 'linux' }],
      needs: [],
      steps: [{ name: 'hello', hasOutputs: false }],
    });
  });

  it('serializes a job with array runsOn', async () => {
    const jobs = [
      job('multi-label', {
        runsOn: ['linux', 'docker'],
        steps: [step('s1', async () => {})],
      }),
    ];

    const result = await serializeJobsToLock(jobs, mockCtx());
    expect(result[0].runsOn).toEqual([
      { kind: 'exact', value: 'linux' },
      { kind: 'exact', value: 'docker' },
    ]);
  });

  it('serializes a job with RunsOnSelector (labels + exclude)', async () => {
    const jobs = [
      job('selector', {
        runsOn: { labels: ['linux', 'gpu'], exclude: ['arm64'] },
        steps: [step('s1', async () => {})],
      }),
    ];

    const result = await serializeJobsToLock(jobs, mockCtx());
    expect(result[0].runsOn).toEqual([
      { kind: 'exact', value: 'linux' },
      { kind: 'exact', value: 'gpu' },
    ]);
    expect(result[0].excludeLabels).toEqual([{ kind: 'exact', value: 'arm64' }]);
  });

  it('serializes job with string needs', async () => {
    const j1 = job('build', {
      runsOn: 'linux',
      steps: [step('s1', async () => {})],
    });
    const j2 = job('test', {
      runsOn: 'linux',
      needs: ['build'],
      steps: [step('s1', async () => {})],
    });

    const result = await serializeJobsToLock([j1, j2], mockCtx());
    expect(result[1].needs).toEqual(['build']);
  });

  it('serializes job with Job object needs', async () => {
    const j1 = job('build', {
      runsOn: 'linux',
      steps: [step('s1', async () => {})],
    });
    const j2 = job('test', {
      runsOn: 'linux',
      needs: [j1],
      steps: [step('s1', async () => {})],
    });

    const result = await serializeJobsToLock([j1, j2], mockCtx());
    expect(result[1].needs).toEqual(['build']);
  });

  it('serializes step metadata (continueOnError, timeout, outputs)', async () => {
    const { z } = await import('@kici-dev/sdk');
    const jobs = [
      job('meta-job', {
        runsOn: 'linux',
        steps: [
          step('with-meta', {
            outputs: { url: z.string() },
            continueOnError: true,
            timeout: 5000,
            run: async () => ({ url: 'http://example.com' }),
          }),
        ],
      }),
    ];

    const result = await serializeJobsToLock(jobs, mockCtx());
    expect(result[0].steps[0]).toMatchObject({
      name: 'with-meta',
      hasOutputs: true,
      continueOnError: true,
      timeout: 5000,
    });
  });

  it('round-trips the step retry data subset without retryIf', async () => {
    const jobs = [
      job('retry-job', {
        runsOn: 'linux',
        steps: [
          step('flaky', {
            retry: { maxAttempts: 3, retryIf: () => true },
            run: async () => {},
          }),
        ],
      }),
    ];

    const result = await serializeJobsToLock(jobs, mockCtx());
    expect(result[0].steps[0].retry).toEqual({
      maxAttempts: 3,
      delayMs: 1000,
      backoff: 'exponential',
      maxDelayMs: 30000,
    });
    expect(result[0].steps[0].retry).not.toHaveProperty('retryIf');
  });

  it('serializes static array matrix', async () => {
    const jobs = [
      job('matrix-job', {
        runsOn: 'linux',
        matrix: ['a', 'b', 'c'],
        steps: [step('s1', async () => {})],
      }),
    ];

    const result = await serializeJobsToLock(jobs, mockCtx());
    expect(result[0].matrix).toEqual({
      _type: 'static',
      values: ['a', 'b', 'c'],
    });
  });

  it('serializes static object matrix', async () => {
    const jobs = [
      job('matrix-obj', {
        runsOn: 'linux',
        matrix: { os: ['linux', 'macos'], node: ['18', '20'] },
        steps: [step('s1', async () => {})],
      }),
    ];

    const result = await serializeJobsToLock(jobs, mockCtx());
    expect(result[0].matrix).toEqual({
      _type: 'static',
      values: { os: ['linux', 'macos'], node: ['18', '20'] },
    });
  });

  it('serializes environment and env (static)', async () => {
    const jobs = [
      job('env-job', {
        runsOn: 'linux',
        environment: 'production',
        env: { NODE_ENV: 'production' },
        steps: [step('s1', async () => {})],
      }),
    ];

    const result = await serializeJobsToLock(jobs, mockCtx());
    expect(result[0].environment).toBe('production');
    expect(result[0].env).toEqual({ NODE_ENV: 'production' });
  });

  it('serializes description and concurrencyGroup', async () => {
    const jobs = [
      job('desc-job', {
        runsOn: 'linux',
        description: 'my job',
        concurrencyGroup: 'deploy-group',
        steps: [step('s1', async () => {})],
      }),
    ];

    const result = await serializeJobsToLock(jobs, mockCtx());
    expect(result[0].description).toBe('my job');
    expect(result[0].concurrencyGroup).toBe('deploy-group');
  });

  // Dynamic field resolution

  it('resolves dynamic environment function against the eval event', async () => {
    const jobs = [
      job('dyn-env', {
        runsOn: 'linux',
        environment: (event) => `env-${(event as { branch: string }).branch}`,
        steps: [step('s1', async () => {})],
      }),
    ];

    const result = await serializeJobsToLock(jobs, mockCtx({ branch: 'staging' }));
    expect(result[0].environment).toBe('env-staging');
  });

  it('resolves dynamic env function against the eval event', async () => {
    const jobs = [
      job('dyn-env-map', {
        runsOn: 'linux',
        env: (event) => ({ BRANCH: (event as { branch: string }).branch }),
        steps: [step('s1', async () => {})],
      }),
    ];

    const result = await serializeJobsToLock(jobs, mockCtx({ branch: 'staging' }));
    expect(result[0].env).toEqual({ BRANCH: 'staging' });
  });

  it('resolves async dynamic env function', async () => {
    const jobs = [
      job('dyn-env-async', {
        runsOn: 'linux',
        env: async (event) => ({ BRANCH: (event as { branch: string }).branch }),
        steps: [step('s1', async () => {})],
      }),
    ];

    const result = await serializeJobsToLock(jobs, mockCtx({ branch: 'staging' }));
    expect(result[0].env).toEqual({ BRANCH: 'staging' });
  });

  it('resolves dynamic concurrencyGroup function against the eval event', async () => {
    const jobs = [
      job('dyn-cg', {
        runsOn: 'linux',
        concurrencyGroup: (event) => `group-${(event as { branch: string }).branch}`,
        steps: [step('s1', async () => {})],
      }),
    ];

    const result = await serializeJobsToLock(jobs, mockCtx({ branch: 'staging' }));
    expect(result[0].concurrencyGroup).toBe('group-staging');
  });

  it('resolves async dynamic matrix function (array form)', async () => {
    const jobs = [
      job('dyn-matrix-arr', {
        runsOn: 'linux',
        matrix: async () => ['alpha', 'beta'],
        steps: [step('s1', async () => {})],
      }),
    ];

    const result = await serializeJobsToLock(jobs, mockCtx());
    expect(result[0].matrix).toEqual({
      _type: 'static',
      values: ['alpha', 'beta'],
    });
  });

  it('resolves async dynamic matrix function (object form)', async () => {
    const jobs = [
      job('dyn-matrix-obj', {
        runsOn: 'linux',
        matrix: async () => ({ os: ['linux', 'macos'] }),
        steps: [step('s1', async () => {})],
      }),
    ];

    const result = await serializeJobsToLock(jobs, mockCtx());
    expect(result[0].matrix).toEqual({
      _type: 'static',
      values: { os: ['linux', 'macos'] },
    });
  });

  it('passes workflow + job context to dynamic matrix function', async () => {
    let captured: { workflow?: string; jobName?: string; runsOn?: unknown } = {};
    const jobs = [
      job('matrix-ctx', {
        runsOn: ['linux', 'docker'],
        matrix: async ({ ctx }) => {
          captured = {
            workflow: ctx.workflow.name,
            jobName: ctx.job.name,
            runsOn: ctx.job.runsOn,
          };
          return ['x'];
        },
        steps: [step('s1', async () => {})],
      }),
    ];

    await serializeJobsToLock(jobs, mockCtx());
    expect(captured.workflow).toBe('test-wf');
    expect(captured.jobName).toBe('matrix-ctx');
    expect(captured.runsOn).toEqual(['linux', 'docker']);
  });

  it('propagates errors thrown by dynamic env functions', async () => {
    const jobs = [
      job('throwing', {
        runsOn: 'linux',
        env: () => {
          throw new Error('boom');
        },
        steps: [step('s1', async () => {})],
      }),
    ];

    await expect(serializeJobsToLock(jobs, mockCtx())).rejects.toThrow('boom');
  });

  it('leaves env unset when dynamic env function returns undefined', async () => {
    const jobs = [
      job('undef-env', {
        runsOn: 'linux',
        env: () => undefined as unknown as Record<string, string>,
        steps: [step('s1', async () => {})],
      }),
    ];

    const result = await serializeJobsToLock(jobs, mockCtx());
    expect(result[0].env).toBeUndefined();
  });

  it('throws when dynamic matrix function returns an unsupported value', async () => {
    const jobs = [
      job('bad-matrix', {
        runsOn: 'linux',
        matrix: async () => 42 as unknown as string[],
        steps: [step('s1', async () => {})],
      }),
    ];

    await expect(serializeJobsToLock(jobs, mockCtx())).rejects.toThrow('unsupported value');
  });

  it('throws MatrixExpansionError when a dynamic matrix function throws', async () => {
    const jobs = [
      job('build', {
        runsOn: 'linux',
        matrix: async () => {
          throw new Error('boom');
        },
        steps: [step('s1', async () => {})],
      }),
    ];

    const err = await serializeJobsToLock(jobs, mockCtx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MatrixExpansionError);
    expect((err as MatrixExpansionError).jobName).toBe('build');
    expect((err as MatrixExpansionError).message).toContain('boom');
  });

  it('throws MatrixExpansionError when a dynamic matrix returns an unsupported value', async () => {
    const jobs = [
      job('shard', {
        runsOn: 'linux',
        matrix: async () => 42 as unknown as string[],
        steps: [step('s1', async () => {})],
      }),
    ];

    const err = await serializeJobsToLock(jobs, mockCtx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MatrixExpansionError);
    expect((err as MatrixExpansionError).jobName).toBe('shard');
  });

  // Error cases

  it('throws on duplicate job names', async () => {
    const jobs = [
      job('dup', { runsOn: 'linux', steps: [step('s1', async () => {})] }),
      job('dup', { runsOn: 'linux', steps: [step('s1', async () => {})] }),
    ];

    await expect(serializeJobsToLock(jobs, mockCtx())).rejects.toThrow("Duplicate job name 'dup'");
  });

  it('throws when exceeding max job limit', async () => {
    const jobs = Array.from({ length: MAX_DYNAMIC_JOBS + 1 }, (_, i) =>
      job(`job-${i}`, { runsOn: 'linux', steps: [step('s1', async () => {})] }),
    );

    await expect(serializeJobsToLock(jobs, mockCtx())).rejects.toThrow(
      `exceeding the limit of ${MAX_DYNAMIC_JOBS}`,
    );
  });

  it('throws when needs reference unknown job', async () => {
    const jobs = [
      job('test', {
        runsOn: 'linux',
        needs: ['nonexistent'],
        steps: [step('s1', async () => {})],
      }),
    ];

    await expect(serializeJobsToLock(jobs, mockCtx())).rejects.toThrow(
      "Job dependency 'nonexistent' not found in workflow jobs",
    );
  });

  it('handles empty jobs array', async () => {
    const result = await serializeJobsToLock([], mockCtx());
    expect(result).toEqual([]);
  });

  // Cross-domain needs tests

  it('resolves needs with a static job name in staticNames', async () => {
    const jobs = [
      job('test', {
        runsOn: 'linux',
        needs: ['lint'],
        steps: [step('s1', async () => {})],
      }),
    ];

    const staticNames = new Set(['lint', 'build']);
    const result = await serializeJobsToLock(jobs, mockCtx(), staticNames);
    expect(result[0].needs).toEqual(['lint']);
  });

  it('resolves needs with a DynamicGroupRef in allowedGroups', async () => {
    const { dynamicGroup } = await import('@kici-dev/sdk');
    const jobs = [
      job('deploy', {
        runsOn: 'linux',
        needs: [dynamicGroup('test-shards')],
        steps: [step('s1', async () => {})],
      }),
    ];

    const allowedGroups = new Set(['test-shards']);
    const result = await serializeJobsToLock(jobs, mockCtx(), new Set(), allowedGroups);
    expect(result[0].needs).toEqual([{ group: 'test-shards', runOn: ['success'] }]);
    expect(result[0].dependsOnGroups).toEqual(['test-shards']);
  });

  it('throws when needs reference unknown static name', async () => {
    const jobs = [
      job('test', {
        runsOn: 'linux',
        needs: ['unknown-static'],
        steps: [step('s1', async () => {})],
      }),
    ];

    await expect(
      serializeJobsToLock(jobs, mockCtx(), new Set(['lint']), new Set()),
    ).rejects.toThrow("Job dependency 'unknown-static' not found in workflow jobs");
  });

  it('throws when needs reference unknown group name', async () => {
    const { dynamicGroup } = await import('@kici-dev/sdk');
    const jobs = [
      job('deploy', {
        runsOn: 'linux',
        needs: [dynamicGroup('nonexistent-group')],
        steps: [step('s1', async () => {})],
      }),
    ];

    await expect(
      serializeJobsToLock(jobs, mockCtx(), new Set(), new Set(['other-group'])),
    ).rejects.toThrow("Dynamic group 'nonexistent-group' not found in workflow");
  });

  it('resolves { name, when } needs entry to NeedsEntry', async () => {
    const jobs = [
      job('notify', {
        runsOn: 'linux',
        needs: [{ name: 'build', when: 'always' as const }],
        steps: [step('s1', async () => {})],
      }),
    ];

    const staticNames = new Set(['build']);
    const result = await serializeJobsToLock(jobs, mockCtx(), staticNames);
    expect(result[0].needs).toEqual([
      {
        name: 'build',
        runOn: ['success', 'failed', 'cancelled', 'skipped', 'timed_out_stale', 'drift_dropped'],
      },
    ]);
  });

  it('produces valid lock output with cross-domain needs', async () => {
    const { dynamicGroup } = await import('@kici-dev/sdk');
    const j1 = job('lint', {
      runsOn: 'linux',
      steps: [step('s1', async () => {})],
    });
    const j2 = job('deploy', {
      runsOn: 'linux',
      needs: [j1, dynamicGroup('test-shards', { when: 'always' })],
      steps: [step('s1', async () => {})],
    });

    const allowedGroups = new Set(['test-shards']);
    const result = await serializeJobsToLock([j1, j2], mockCtx(), new Set(), allowedGroups);
    expect(result).toHaveLength(2);
    expect(result[1].needs).toEqual([
      'lint',
      {
        group: 'test-shards',
        runOn: ['success', 'failed', 'cancelled', 'skipped', 'timed_out_stale', 'drift_dropped'],
      },
    ]);
    expect(result[1].dependsOnGroups).toEqual(['test-shards']);
  });
});
