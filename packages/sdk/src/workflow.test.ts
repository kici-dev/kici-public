import { describe, it, expect } from 'vitest';
import { workflow } from './workflow.js';
import { job } from './job.js';
import { step } from './step.js';
import { pr, push } from './triggers/index.js';
import { rule } from './rules/index.js';
import { isDynamicJobFn } from './types.js';
import { dynamicJob, getDynamicJobGroup, DYNAMIC_JOB_GROUP_TAG } from './types.js';
import { dynamicGroup, isDynamicGroupRef, DYNAMIC_GROUP_TAG } from './dynamic-group.js';
import type { DynamicJobFn, Job } from './types.js';

describe('workflow()', () => {
  const checkoutStep = step('checkout', async () => {});

  const buildJob = job('build', {
    runsOn: 'linux',
    steps: [checkoutStep],
  });

  const testJob = job('test', {
    runsOn: 'linux',
    steps: [checkoutStep],
    needs: [buildJob],
  });

  describe('basic functionality (backward compatible)', () => {
    it('creates a workflow with name and jobs', () => {
      const ci = workflow('ci', {
        jobs: [buildJob, testJob],
      });

      expect(ci._tag).toBe('Workflow');
      expect(ci.name).toBe('ci');
      expect(ci.jobs).toHaveLength(2);
      expect(ci.jobs[0]).toBe(buildJob);
      expect(ci.jobs[1]).toBe(testJob);
    });

    it('preserves job order', () => {
      const ci = workflow('pipeline', {
        jobs: [testJob, buildJob],
      });

      expect(ci.jobs[0].name).toBe('test');
      expect(ci.jobs[1].name).toBe('build');
    });

    it('creates a workflow without triggers or rules (undefined)', () => {
      const ci = workflow('ci', {
        jobs: [buildJob],
      });

      expect(ci.on).toBeUndefined();
      expect(ci.rules).toBeUndefined();
      expect(ci.description).toBeUndefined();
    });
  });

  describe('trigger integration', () => {
    it('accepts a single trigger config', () => {
      const ci = workflow('ci', {
        on: pr({ target: 'main' }),
        jobs: [buildJob],
      });

      expect(ci.on).toHaveLength(1);
      const trigger = ci.on![0];
      expect(trigger._tag).toBe('PrTrigger');
      if (trigger._tag === 'PrTrigger') {
        expect(trigger.targetBranches).toHaveLength(1);
      }
    });

    it('accepts multiple trigger configs as array', () => {
      const ci = workflow('ci', {
        on: [pr({ target: 'main', paths: ['src/**'] }), push({ branches: 'main' })],
        jobs: [buildJob],
      });

      expect(ci.on).toHaveLength(2);
      expect(ci.on![0]._tag).toBe('PrTrigger');
      expect(ci.on![1]._tag).toBe('PushTrigger');
    });

    it('trigger configs are frozen TriggerConfig objects', () => {
      const ci = workflow('ci', {
        on: pr({ target: 'main', paths: ['src/**'] }),
        jobs: [buildJob],
      });

      const trigger = ci.on![0];
      expect(trigger).toHaveProperty('events');
      expect(trigger).toHaveProperty('paths');
      if (trigger._tag === 'PrTrigger') {
        expect(trigger).toHaveProperty('targetBranches');
      }
      // Should be frozen (immutable)
      expect(Object.isFrozen(trigger)).toBe(true);
    });
  });

  describe('rule integration', () => {
    it('accepts rules array', () => {
      const frontendRule = rule('frontend changes', () => true);
      const ci = workflow('ci', {
        jobs: [buildJob],
        rules: [frontendRule],
      });

      expect(ci.rules).toHaveLength(1);
      expect(ci.rules![0].label).toBe('frontend changes');
    });

    it('stores rules as-is (not built)', () => {
      const myRule = rule('my rule', async () => true);
      const ci = workflow('ci', {
        jobs: [buildJob],
        rules: [myRule],
      });

      // Rules should be stored directly, not transformed
      expect(ci.rules![0]).toBe(myRule);
      expect(ci.rules![0]._tag).toBe('Rule');
    });

    it('accepts multiple rules', () => {
      const rule1 = rule('rule 1');
      const rule2 = rule('rule 2', () => false);
      const ci = workflow('ci', {
        jobs: [buildJob],
        rules: [rule1, rule2],
      });

      expect(ci.rules).toHaveLength(2);
    });
  });

  describe('description support', () => {
    it('accepts optional description', () => {
      const ci = workflow('ci', {
        jobs: [buildJob],
        description: 'Main CI pipeline',
      });

      expect(ci.description).toBe('Main CI pipeline');
    });
  });

  describe('full workflow with all options', () => {
    it('combines triggers, rules, and description', () => {
      const srcRule = rule('has src changes', () => true);
      const ci = workflow('ci', {
        on: [pr({ target: 'main', paths: ['src/**'] }), push({ branches: 'main' })],
        jobs: [buildJob, testJob],
        rules: [srcRule],
        description: 'Main CI pipeline for src changes',
      });

      expect(ci.name).toBe('ci');
      expect(ci.jobs).toHaveLength(2);
      expect(ci.on).toHaveLength(2);
      expect(ci.rules).toHaveLength(1);
      expect(ci.description).toBe('Main CI pipeline for src changes');
    });
  });

  describe('hook and concurrency fields', () => {
    it('accepts concurrency config', () => {
      const ci = workflow('ci', {
        jobs: [],
        concurrency: {
          group: (ctx) => `main-${ctx.branch}`,
          cancelInProgress: true,
        },
      });

      expect(ci.concurrency).toBeDefined();
      expect(ci.concurrency!.cancelInProgress).toBe(true);
      expect(typeof ci.concurrency!.group).toBe('function');
    });

    it('accepts concurrency with max', () => {
      const ci = workflow('ci', {
        jobs: [],
        concurrency: {
          group: () => 'deploy',
          max: 3,
        },
      });

      expect(ci.concurrency!.max).toBe(3);
    });

    it('accepts all 4 workflow-level hook types', () => {
      const hookFn = async () => {};
      const ci = workflow('ci', {
        jobs: [],
        onCancel: hookFn,
        cleanup: hookFn,
        onSuccess: hookFn,
        onFailure: hookFn,
      });

      expect(ci.onCancel).toBe(hookFn);
      expect(ci.cleanup).toBe(hookFn);
      expect(ci.onSuccess).toBe(hookFn);
      expect(ci.onFailure).toBe(hookFn);
    });

    it('hook and concurrency fields are undefined when not provided', () => {
      const ci = workflow('ci', { jobs: [] });

      expect(ci.onCancel).toBeUndefined();
      expect(ci.cleanup).toBeUndefined();
      expect(ci.onSuccess).toBeUndefined();
      expect(ci.onFailure).toBeUndefined();
      expect(ci.concurrency).toBeUndefined();
    });

    it('threads timeout from WorkflowOptions onto the Workflow', () => {
      const w = workflow('ci', { jobs: [], timeout: 1_800_000 });
      expect(w.timeout).toBe(1_800_000);
    });

    it('leaves timeout undefined when not set', () => {
      const w = workflow('ci', { jobs: [] });
      expect(w.timeout).toBeUndefined();
    });
  });

  describe('dynamic job generation', () => {
    it('creates workflow with static jobs only (backward compatible)', () => {
      const w = workflow('ci', {
        jobs: [buildJob, testJob],
      });

      expect(w.jobs).toHaveLength(2);
      expect((w.jobs[0] as Job)._tag).toBe('Job');
      expect((w.jobs[1] as Job)._tag).toBe('Job');
    });

    it('creates workflow with dynamic job generator', () => {
      // Note: DynamicJobFn uses destructured {$, ctx, log, env}
      const dynamicJobs: DynamicJobFn = async ({ $, ctx, log, env }) => [
        job('test-a', { runsOn: 'linux', steps: [checkoutStep], needs: ['build'] }),
        job('test-b', { runsOn: 'linux', steps: [checkoutStep], needs: ['build'] }),
      ];

      const w = workflow('ci', {
        jobs: [buildJob, dynamicJobs],
      });

      expect(w.jobs).toHaveLength(2);
      expect((w.jobs[0] as Job)._tag).toBe('Job');
      expect(typeof w.jobs[1]).toBe('function');
    });

    it('creates workflow mixing static jobs and generators', () => {
      const deployJob = job('deploy', { runsOn: 'linux', steps: [checkoutStep], needs: ['build'] });
      const testGenerator: DynamicJobFn = async ({ $ }) => [
        job('test-unit', { runsOn: 'linux', steps: [checkoutStep] }),
        job('test-e2e', { runsOn: 'linux', steps: [checkoutStep] }),
      ];

      const w = workflow('ci', {
        jobs: [buildJob, testGenerator, deployJob],
      });

      expect(w.jobs).toHaveLength(3);
      expect((w.jobs[0] as Job).name).toBe('build');
      expect(typeof w.jobs[1]).toBe('function');
      expect((w.jobs[2] as Job).name).toBe('deploy');
    });

    it('isDynamicJobFn correctly identifies job generators', () => {
      const staticJob = job('build', { runsOn: 'linux', steps: [checkoutStep] });
      const dynamicJob: DynamicJobFn = async ({ $ }) => [];

      expect(isDynamicJobFn(staticJob)).toBe(false);
      expect(isDynamicJobFn(dynamicJob)).toBe(true);
    });

    it('dynamic jobs can reference other jobs by name', () => {
      const dynamicJobs: DynamicJobFn = async ({ ctx }) => [
        job('test', { runsOn: 'linux', steps: [checkoutStep], needs: ['build'] }),
        job('lint', { runsOn: 'linux', steps: [checkoutStep], needs: ['build'] }),
      ];

      const w = workflow('ci', {
        jobs: [buildJob, dynamicJobs],
      });

      // Verify workflow stores the configuration
      // Actual needs resolution happens at agent runtime
      expect(w.jobs).toHaveLength(2);
    });
  });

  describe('dynamicGroup() helper', () => {
    it('creates a DynamicGroupRef with group name', () => {
      const ref = dynamicGroup('test-shards');
      expect(ref.group).toBe('test-shards');
      expect(ref[DYNAMIC_GROUP_TAG]).toBe(true);
    });

    it('creates a DynamicGroupRef with when option', () => {
      const ref = dynamicGroup('test-shards', { when: 'always' });
      expect(ref.group).toBe('test-shards');
      expect(ref.when).toBe('always');
    });

    it('omits when when not specified', () => {
      const ref = dynamicGroup('test-shards');
      expect(ref.when).toBeUndefined();
    });

    it('isDynamicGroupRef identifies DynamicGroupRef objects', () => {
      const ref = dynamicGroup('test-shards');
      expect(isDynamicGroupRef(ref)).toBe(true);
    });

    it('isDynamicGroupRef rejects non-refs', () => {
      expect(isDynamicGroupRef('test-shards')).toBe(false);
      expect(isDynamicGroupRef(null)).toBe(false);
      expect(isDynamicGroupRef(undefined)).toBe(false);
      expect(isDynamicGroupRef({ group: 'test-shards' })).toBe(false);
      expect(isDynamicGroupRef(42)).toBe(false);
    });
  });

  describe('private registries', () => {
    it('accepts a registries: array with a scoped registry', () => {
      const w = workflow('ci', {
        jobs: [buildJob],
        registries: [
          {
            url: 'https://npm.pkg.github.com',
            scope: '@my-org',
            tokenSecret: 'production:GITHUB_PACKAGES_TOKEN',
          },
        ],
      });

      expect(w.registries).toHaveLength(1);
      expect(w.registries![0].url).toBe('https://npm.pkg.github.com');
      expect(w.registries![0].scope).toBe('@my-org');
      expect(w.registries![0].tokenSecret).toBe('production:GITHUB_PACKAGES_TOKEN');
    });

    it('accepts a default registry (no scope) and a scoped one together', () => {
      const w = workflow('ci', {
        jobs: [buildJob],
        registries: [
          { url: 'https://my-corp-mirror.example.com', tokenSecret: 'shared:NPM_MIRROR_TOKEN' },
          {
            url: 'https://npm.pkg.github.com',
            scope: '@my-org',
            tokenSecret: 'production:GITHUB_PACKAGES_TOKEN',
          },
        ],
      });

      expect(w.registries).toHaveLength(2);
    });

    it('rejects two registries that both omit scope (more than one default)', () => {
      expect(() =>
        workflow('ci', {
          jobs: [buildJob],
          registries: [
            { url: 'https://a.example.com', tokenSecret: 'shared:A_TOKEN' },
            { url: 'https://b.example.com', tokenSecret: 'shared:B_TOKEN' },
          ],
        }),
      ).toThrow(/at most one registries entry may omit `scope`/);
    });

    it('rejects two registries that declare the same scope', () => {
      expect(() =>
        workflow('ci', {
          jobs: [buildJob],
          registries: [
            { url: 'https://a.example.com', scope: '@my-org', tokenSecret: 'shared:A' },
            { url: 'https://b.example.com', scope: '@my-org', tokenSecret: 'shared:B' },
          ],
        }),
      ).toThrow(/declares scope @my-org more than once/);
    });

    it('rejects a malformed scope', () => {
      expect(() =>
        workflow('ci', {
          jobs: [buildJob],
          registries: [
            { url: 'https://a.example.com', scope: 'no-leading-at', tokenSecret: 'shared:A' },
          ],
        }),
      ).toThrow(/scope must match @<package-scope>/);
    });

    it('rejects a non-URL string in registries[].url', () => {
      expect(() =>
        workflow('ci', {
          jobs: [buildJob],
          registries: [{ url: 'not-a-url', tokenSecret: 'shared:A' }],
        }),
      ).toThrow(/registries\[0\]\.url is not a valid URL/);
    });

    it('rejects a tokenSecret without the qualified env:NAME syntax', () => {
      expect(() =>
        workflow('ci', {
          jobs: [buildJob],
          registries: [{ url: 'https://a.example.com', tokenSecret: 'BARE_TOKEN' }],
        }),
      ).toThrow(/must use qualified <environment>:<secret-name> syntax/);
    });

    it('rejects a tokenSecret with empty environment or secret-name halves', () => {
      expect(() =>
        workflow('ci', {
          jobs: [buildJob],
          registries: [{ url: 'https://a.example.com', tokenSecret: ':NAME_ONLY' }],
        }),
      ).toThrow(/qualified <environment>:<secret-name>/);
      expect(() =>
        workflow('ci', {
          jobs: [buildJob],
          registries: [{ url: 'https://a.example.com', tokenSecret: 'env:' }],
        }),
      ).toThrow(/qualified <environment>:<secret-name>/);
    });

    it('rejects a tokenSecret with more than one colon', () => {
      expect(() =>
        workflow('ci', {
          jobs: [buildJob],
          registries: [{ url: 'https://a.example.com', tokenSecret: 'env:NAME:EXTRA' }],
        }),
      ).toThrow(/qualified <environment>:<secret-name>/);
    });

    it('accepts an installEnv array of qualified secret refs', () => {
      const w = workflow('ci', {
        jobs: [buildJob],
        installEnv: ['production:NPM_TOKEN', 'shared:CA_BUNDLE'],
      });

      expect(w.installEnv).toEqual(['production:NPM_TOKEN', 'shared:CA_BUNDLE']);
    });

    it('rejects an installEnv entry without the qualified env:NAME syntax', () => {
      expect(() =>
        workflow('ci', {
          jobs: [buildJob],
          installEnv: ['BARE_NAME'],
        }),
      ).toThrow(/installEnv\[0\] must use qualified <environment>:<secret-name>/);
    });

    it('leaves registries and installEnv undefined by default', () => {
      const w = workflow('ci', { jobs: [buildJob] });
      expect(w.registries).toBeUndefined();
      expect(w.installEnv).toBeUndefined();
    });
  });

  describe('dynamicJob() factory', () => {
    it('tags a DynamicJobFn with a group name', () => {
      const fn: DynamicJobFn = async () => [];
      const tagged = dynamicJob('test-shards', fn);

      expect(getDynamicJobGroup(tagged)).toBe('test-shards');
      expect(tagged[DYNAMIC_JOB_GROUP_TAG]).toBe('test-shards');
    });

    it('isDynamicJobFn still works for tagged functions', () => {
      const fn: DynamicJobFn = async () => [];
      const tagged = dynamicJob('test-shards', fn);

      expect(isDynamicJobFn(tagged)).toBe(true);
    });

    it('getDynamicJobGroup returns undefined for untagged functions', () => {
      const fn: DynamicJobFn = async () => [];
      expect(getDynamicJobGroup(fn)).toBeUndefined();
    });

    it('tagged function still works as a DynamicJobFn', async () => {
      const fn: DynamicJobFn = async () => [
        job('shard-1', { runsOn: 'linux', steps: [step('run', async () => {})] }),
      ];
      const tagged = dynamicJob('test-shards', fn);
      const result = await tagged({
        $: {} as any,
        ctx: { workflow: { name: 'ci' } },
        log: {} as any,
        env: {},
        kici: {} as any,
      });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('shard-1');
    });
  });
});

describe('needs when field', () => {
  it('accepts a when keyword on a needs edge', () => {
    const b = job('b', {
      runsOn: 'linux',
      needs: [{ name: 'a', when: 'on-failure' }],
      run: async () => {},
    });
    expect(b.needs?.[0]).toEqual({ name: 'a', when: 'on-failure' });
  });

  it('accepts a raw status-set on a needs edge', () => {
    const b = job('b', {
      runsOn: 'linux',
      needs: [{ name: 'a', when: ['skipped', 'failed'] }],
      run: async () => {},
    });
    expect(b.needs?.[0]).toMatchObject({ name: 'a', when: ['skipped', 'failed'] });
  });

  it('accepts a when keyword on a group needs edge', () => {
    const b = job('b', {
      runsOn: 'linux',
      needs: [{ group: 'shards', when: 'on-skip' }],
      run: async () => {},
    });
    expect(b.needs?.[0]).toEqual({ group: 'shards', when: 'on-skip' });
  });
});
