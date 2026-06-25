import { describe, it, expect, vi } from 'vitest';
import { job } from './job.js';
import { step } from './step.js';
import { rule } from './rules/index.js';
import type { HookInput } from './hooks/types.js';
import type { GenericInitConfig } from './types.js';
import type { EventPayload } from './events/event-payloads.js';

describe('dynamic function event fields', () => {
  it('stores environment/env/concurrencyGroup dynamic functions on the job', () => {
    // Runtime contract: dynamic environment / env / concurrencyGroup functions
    // are stored verbatim on the job. The compile-time guarantee that these
    // functions receive the narrowable EventPayload union lives in
    // events/event-payloads.test-d.ts (run through Vitest's typecheck runner).
    const j = job('typed-dynamic', {
      runsOn: 'default',
      environment: (event: EventPayload) =>
        event.type === 'pull_request'
          ? `preview-${event.payload.pull_request.number}`
          : 'production',
      env: (event: EventPayload) => ({
        BRANCH: event.targetBranch ?? 'unknown',
      }),
      concurrencyGroup: (event: EventPayload) => `cg-${event.targetBranch ?? 'none'}`,
      steps: [step('noop', async () => {})],
    });
    expect(j.name).toBe('typed-dynamic');
    expect(typeof j.environment).toBe('function');
    expect(typeof j.env).toBe('function');
    expect(typeof j.concurrencyGroup).toBe('function');
  });
});

describe('job()', () => {
  const checkoutStep = step('checkout', async () => {});
  const buildStep = step('build', async () => {});

  describe('basic functionality (backward compatible)', () => {
    it('creates a job with explicit name', () => {
      const build = job('build', {
        runsOn: 'linux',
        steps: [checkoutStep, buildStep],
      });

      expect(build._tag).toBe('Job');
      expect(build.name).toBe('build');
      expect(build.runsOn).toBe('linux');
      expect(build.steps).toHaveLength(2);
      expect(build.needs).toBeUndefined();
    });

    it('creates a job with auto-generated ID', () => {
      const build = job({
        runsOn: 'linux',
        steps: [checkoutStep],
      });

      expect(build._tag).toBe('Job');
      expect(build.name).toMatch(/^[0-9a-f-]{36}$/); // UUID format
      expect(build.runsOn).toBe('linux');
    });

    it('accepts needs as Job references', () => {
      const buildJob = job('build', {
        runsOn: 'linux',
        steps: [buildStep],
      });

      const testJob = job('test', {
        runsOn: 'linux',
        steps: [checkoutStep],
        needs: [buildJob],
      });

      expect(testJob.needs).toHaveLength(1);
      expect(testJob.needs?.[0]).toBe(buildJob);
    });

    it('accepts needs as string IDs', () => {
      const testJob = job('test', {
        runsOn: 'linux',
        steps: [checkoutStep],
        needs: ['build', 'lint'],
      });

      expect(testJob.needs).toEqual(['build', 'lint']);
    });

    it('accepts mixed needs (Job refs and strings)', () => {
      const buildJob = job('build', {
        runsOn: 'linux',
        steps: [buildStep],
      });

      const testJob = job('test', {
        runsOn: 'linux',
        steps: [checkoutStep],
        needs: [buildJob, 'lint'],
      });

      expect(testJob.needs).toHaveLength(2);
    });

    it('creates a job without rules or description (undefined)', () => {
      const build = job('build', {
        runsOn: 'linux',
        steps: [checkoutStep],
      });

      expect(build.rules).toBeUndefined();
      expect(build.description).toBeUndefined();
    });
  });

  describe('runsOnAll host fan-out', () => {
    it('creates a job with runsOnAll and no runsOn', () => {
      const patch = job('patch', {
        runsOnAll: 'role:web',
        steps: [checkoutStep],
      });
      expect(patch.runsOnAll).toBe('role:web');
      expect(patch.runsOn).toBeUndefined();
    });

    it('threads onUnreachable alongside runsOnAll', () => {
      const patch = job('patch', {
        runsOnAll: ['role:web', '!kici:host:web-01'],
        onUnreachable: 'fail',
        steps: [checkoutStep],
      });
      expect(patch.runsOnAll).toEqual(['role:web', '!kici:host:web-01']);
      expect(patch.onUnreachable).toBe('fail');
    });

    it('threads includeUninitialized alongside runsOnAll', () => {
      const converge = job('converge', {
        runsOnAll: 'kici:role:test',
        includeUninitialized: true,
        steps: [checkoutStep],
      });
      expect(converge.runsOnAll).toBe('kici:role:test');
      expect(converge.includeUninitialized).toBe(true);
    });

    it('leaves includeUninitialized undefined when omitted', () => {
      const patch = job('patch', { runsOnAll: 'role:web', steps: [checkoutStep] });
      expect(patch.includeUninitialized).toBeUndefined();
    });

    it('warns when includeUninitialized is set without runsOnAll', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      job('bad', { runsOn: 'linux', includeUninitialized: true, steps: [checkoutStep] });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('includeUninitialized is ignored without runsOnAll'),
      );
      warn.mockRestore();
    });

    it('throws when both runsOn and runsOnAll are set', () => {
      expect(() =>
        job('bad', { runsOn: 'linux', runsOnAll: 'role:web', steps: [checkoutStep] }),
      ).toThrow(/mutually exclusive/i);
    });

    it('throws when neither runsOn nor runsOnAll is set', () => {
      expect(() => job('bad', { steps: [checkoutStep] } as never)).toThrow(
        /one of runsOn or runsOnAll is required/i,
      );
    });
  });

  describe('rule integration', () => {
    it('accepts rules array', () => {
      const envRule = rule('env: CI');
      const build = job('build', {
        runsOn: 'linux',
        steps: [checkoutStep],
        rules: [envRule],
      });

      expect(build.rules).toHaveLength(1);
      expect(build.rules![0].label).toBe('env: CI');
    });

    it('stores rules as-is (not transformed)', () => {
      const myRule = rule('my rule', async () => true);
      const build = job('build', {
        runsOn: 'linux',
        steps: [checkoutStep],
        rules: [myRule],
      });

      expect(build.rules![0]).toBe(myRule);
      expect(build.rules![0]._tag).toBe('Rule');
    });

    it('accepts multiple rules', () => {
      const rule1 = rule('rule 1');
      const rule2 = rule('rule 2', () => false);
      const build = job('build', {
        runsOn: 'linux',
        steps: [checkoutStep],
        rules: [rule1, rule2],
      });

      expect(build.rules).toHaveLength(2);
    });
  });

  describe('description support', () => {
    it('accepts optional description', () => {
      const build = job('build', {
        runsOn: 'linux',
        steps: [checkoutStep],
        description: 'Build the project',
      });

      expect(build.description).toBe('Build the project');
    });
  });

  describe('full job with all options', () => {
    it('combines needs, rules, and description', () => {
      const setupJob = job('setup', {
        runsOn: 'linux',
        steps: [checkoutStep],
      });

      const envRule = rule('env: CI');
      const buildJob = job('build', {
        runsOn: 'linux',
        steps: [checkoutStep, buildStep],
        needs: [setupJob],
        rules: [envRule],
        description: 'Build all packages',
      });

      expect(buildJob.name).toBe('build');
      expect(buildJob.needs).toHaveLength(1);
      expect(buildJob.rules).toHaveLength(1);
      expect(buildJob.description).toBe('Build all packages');
    });

    it('works with anonymous job and all options', () => {
      const envRule = rule('env: CI');
      const anonJob = job({
        runsOn: 'linux',
        steps: [checkoutStep],
        rules: [envRule],
        description: 'Anonymous job',
      });

      expect(anonJob.name).toMatch(/^[0-9a-f-]{36}$/);
      expect(anonJob.rules).toHaveLength(1);
      expect(anonJob.description).toBe('Anonymous job');
    });
  });

  describe('cache field', () => {
    it('round-trips a declarative cache spec onto the job', () => {
      const cachedJob = job('build', {
        runsOn: 'linux',
        steps: [buildStep],
        cache: { key: 'k', paths: ['dist'] },
      });

      expect(cachedJob.cache).toEqual({ key: 'k', paths: ['dist'] });
    });

    it('leaves cache undefined when not provided', () => {
      const plainJob = job('build', { runsOn: 'linux', steps: [buildStep] });
      expect(plainJob.cache).toBeUndefined();
    });
  });

  describe('agent execution options', () => {
    it('creates a job with checkout: false', () => {
      const deployJob = job('deploy', {
        runsOn: 'linux',
        steps: [checkoutStep],
        checkout: false,
      });

      expect(deployJob.checkout).toBe(false);
    });

    it('creates a job with container string', () => {
      const containerJob = job('build', {
        runsOn: 'linux',
        steps: [buildStep],
        container: 'node:20',
      });

      expect(containerJob.container).toBe('node:20');
    });

    it('creates a job with container config object', () => {
      const containerJob = job('build', {
        runsOn: 'linux',
        steps: [buildStep],
        container: {
          image: 'node:20-alpine',
          env: { NODE_ENV: 'test' },
        },
      });

      expect(containerJob.container).toEqual({
        image: 'node:20-alpine',
        env: { NODE_ENV: 'test' },
      });
    });

    it('checkout and container are undefined when not provided', () => {
      const basicJob = job('basic', {
        runsOn: 'linux',
        steps: [checkoutStep],
      });

      expect(basicJob.checkout).toBeUndefined();
      expect(basicJob.container).toBeUndefined();
    });
  });

  describe('run shorthand', () => {
    it('creates a named job with run shorthand', () => {
      const deploy = job('deploy', {
        runsOn: 'default',
        run: async (ctx) => {},
      });

      expect(deploy._tag).toBe('Job');
      expect(deploy.name).toBe('deploy');
      expect(deploy.steps).toHaveLength(1);
      // The run function is stored as a bare function in the steps array
      expect(typeof deploy.steps[0]).toBe('function');
    });

    it('creates an unnamed job with run shorthand', () => {
      const j = job({
        runsOn: 'default',
        run: async (ctx) => {},
      });

      expect(j._tag).toBe('Job');
      expect(j.name).toMatch(/^[0-9a-f-]{36}$/); // UUID
      expect(j.steps).toHaveLength(1);
    });

    it('throws when both run and steps are provided', () => {
      expect(() =>
        job('x', {
          runsOn: 'default',
          run: async () => {},
          steps: [step('s', async () => {})],
        }),
      ).toThrow('job() cannot have both "run" and "steps"');
    });

    it('allows run with empty steps array (treated as run-only)', () => {
      // Empty steps array is falsy for .length > 0 check
      const j = job('x', {
        runsOn: 'default',
        run: async () => {},
        steps: [],
      });

      expect(j.steps).toHaveLength(1);
      expect(typeof j.steps[0]).toBe('function');
    });
  });

  describe('bare functions in steps array', () => {
    it('accepts bare async functions in steps array', () => {
      const bareFn = async (ctx: any) => {};
      const j = job('x', {
        runsOn: 'default',
        steps: [bareFn],
      });

      expect(j.steps).toHaveLength(1);
      expect(typeof j.steps[0]).toBe('function');
    });

    it('accepts mixed Step objects and bare functions in steps', () => {
      const bareFn = async (ctx: any) => {};
      const namedStep = step('named', async () => {});
      const j = job('x', {
        runsOn: 'default',
        steps: [namedStep, bareFn, step(async () => {})],
      });

      expect(j.steps).toHaveLength(3);
      // First is a Step object
      expect((j.steps[0] as any)._tag).toBe('Step');
      // Second is a bare function
      expect(typeof j.steps[1]).toBe('function');
      // Third is a Step object (id-less step)
      expect((j.steps[2] as any)._tag).toBe('Step');
    });
  });

  describe('matrix support', () => {
    it('creates job with static array matrix', () => {
      const testJob = job('test', {
        runsOn: 'linux',
        steps: [],
        matrix: ['18', '20', '22'],
      });

      expect(testJob.matrix).toEqual(['18', '20', '22']);
    });

    it('creates job with static object matrix', () => {
      const testJob = job('test', {
        runsOn: 'linux',
        steps: [],
        matrix: { os: ['linux', 'mac'], node: ['18', '20'] },
      });

      expect(testJob.matrix).toEqual({ os: ['linux', 'mac'], node: ['18', '20'] });
    });

    it('creates job with dynamic matrix function', () => {
      const dynamicMatrix = async () => ['a', 'b', 'c'];
      const testJob = job('test', {
        runsOn: 'linux',
        steps: [],
        matrix: dynamicMatrix,
      });

      expect(typeof testJob.matrix).toBe('function');
    });

    it('creates job with include and exclude', () => {
      const testJob = job('test', {
        runsOn: 'linux',
        steps: [],
        matrix: { os: ['linux', 'mac'], node: ['18', '20'] },
        exclude: [{ os: 'mac', node: '18' }],
        include: [{ os: 'windows', node: '22' }],
      });

      expect(testJob.exclude).toEqual([{ os: 'mac', node: '18' }]);
      expect(testJob.include).toEqual([{ os: 'windows', node: '22' }]);
    });

    it('matrix/include/exclude are undefined when not provided', () => {
      const testJob = job('test', {
        runsOn: 'linux',
        steps: [],
      });

      expect(testJob.matrix).toBeUndefined();
      expect(testJob.include).toBeUndefined();
      expect(testJob.exclude).toBeUndefined();
    });
  });

  describe('resources field', () => {
    it('passes through requests-only resources', () => {
      const j = job('build', {
        runsOn: 'linux',
        steps: [],
        resources: { requests: { cpus: 1, memory: '512m' } },
      });

      expect(j.resources).toEqual({ requests: { cpus: 1, memory: '512m' } });
    });

    it('passes through limits-only resources', () => {
      const j = job('build', {
        runsOn: 'linux',
        steps: [],
        resources: { limits: { cpus: 2, memory: '2g' } },
      });

      expect(j.resources).toEqual({ limits: { cpus: 2, memory: '2g' } });
    });

    it('passes through both requests and limits', () => {
      const j = job('build', {
        runsOn: 'linux',
        steps: [],
        resources: {
          requests: { cpus: 1, memory: '1g' },
          limits: { cpus: 2, memory: '4g' },
        },
      });

      expect(j.resources).toEqual({
        requests: { cpus: 1, memory: '1g' },
        limits: { cpus: 2, memory: '4g' },
      });
    });

    it('resources is undefined when not provided', () => {
      const j = job('build', { runsOn: 'linux', steps: [] });
      expect(j.resources).toBeUndefined();
    });
  });

  describe('hook fields', () => {
    it('accepts onCancel hook', () => {
      const j = job('deploy', {
        runsOn: 'linux',
        steps: [],
        onCancel: async () => {},
      });

      expect(j.onCancel).toBeDefined();
      expect(typeof j.onCancel).toBe('function');
    });

    it('accepts cleanup and gracePeriod', () => {
      const j = job('deploy', {
        runsOn: 'linux',
        steps: [],
        cleanup: async () => {},
        gracePeriod: 60,
      });

      expect(j.cleanup).toBeDefined();
      expect(j.gracePeriod).toBe(60);
    });

    it('threads timeout from JobOptions onto the Job', () => {
      const j = job('build', { runsOn: 'linux', steps: [], timeout: 600_000 });
      expect(j.timeout).toBe(600_000);
    });

    it('leaves timeout undefined when not set', () => {
      const j = job('build', { runsOn: 'linux', steps: [] });
      expect(j.timeout).toBeUndefined();
    });

    it('accepts all 6 hook types', () => {
      const hookFn: HookInput = async () => {};
      const j = job('deploy', {
        runsOn: 'linux',
        steps: [],
        onCancel: hookFn,
        cleanup: hookFn,
        onSuccess: hookFn,
        onFailure: hookFn,
        beforeStep: hookFn,
        afterStep: hookFn,
      });

      expect(j.onCancel).toBe(hookFn);
      expect(j.cleanup).toBe(hookFn);
      expect(j.onSuccess).toBe(hookFn);
      expect(j.onFailure).toBe(hookFn);
      expect(j.beforeStep).toBe(hookFn);
      expect(j.afterStep).toBe(hookFn);
    });

    it('accepts hook with timeout config', () => {
      const hookConfig = { run: async () => {}, timeout: 30000 };
      const j = job('deploy', {
        runsOn: 'linux',
        steps: [],
        onCancel: hookConfig,
      });

      expect(j.onCancel).toBe(hookConfig);
    });

    it('hook fields are undefined when not provided', () => {
      const j = job('build', {
        runsOn: 'linux',
        steps: [],
      });

      expect(j.onCancel).toBeUndefined();
      expect(j.cleanup).toBeUndefined();
      expect(j.onSuccess).toBeUndefined();
      expect(j.onFailure).toBeUndefined();
      expect(j.beforeStep).toBeUndefined();
      expect(j.afterStep).toBeUndefined();
      expect(j.gracePeriod).toBeUndefined();
    });
  });

  describe('init field', () => {
    it('threads a single GenericInitConfig through the factory', () => {
      const init: GenericInitConfig = { run: 'echo hi' };
      const j = job('build', { runsOn: 'linux', steps: [], init });
      expect(j.init).toEqual(init);
    });

    it('threads an array of init configs in order', () => {
      const init: GenericInitConfig[] = [{ run: 'a' }, { run: 'b' }];
      const j = job('build', { runsOn: 'linux', steps: [], init });
      expect(j.init).toEqual(init);
    });

    it('threads init: false (explicit opt-out)', () => {
      const j = job('build', { runsOn: 'linux', steps: [], init: false });
      expect(j.init).toBe(false);
    });

    it('leaves init undefined when not provided', () => {
      const j = job('build', { runsOn: 'linux', steps: [] });
      expect(j.init).toBeUndefined();
    });

    it('accepts a full init config (shell, cache, timeout, env)', () => {
      const init: GenericInitConfig = {
        run: 'mise install',
        shell: 'bash',
        cache: { key: 'mise-x', paths: ['~/.local/share/mise'] },
        timeout: 600_000,
        env: { MISE_QUIET: '1' },
      };
      const j = job('build', { runsOn: 'linux', steps: [], init });
      expect(j.init).toEqual(init);
    });

    it('rejects an init config with an empty run command', () => {
      expect(() => job('build', { runsOn: 'linux', steps: [], init: { run: '' } })).toThrow(
        /init\[0\]\.run must be a non-empty command/,
      );
    });

    it('rejects a whitespace-only run command', () => {
      expect(() => job('build', { runsOn: 'linux', steps: [], init: { run: '   \n' } })).toThrow(
        /init\[0\]\.run must be a non-empty command/,
      );
    });

    it('reports the offending index for an array init', () => {
      expect(() =>
        job('build', { runsOn: 'linux', steps: [], init: [{ run: 'ok' }, { run: '' }] }),
      ).toThrow(/init\[1\]\.run must be a non-empty command/);
    });

    it('does not validate when init is false', () => {
      expect(() => job('build', { runsOn: 'linux', steps: [], init: false })).not.toThrow();
    });
  });
});

describe('runsOn accepts RegExp and glob strings', () => {
  it('accepts a RegExp and a glob string in runsOn (type + runtime passthrough)', () => {
    const j = job('build', { runsOn: /kici:host:box-0[1-3]/, run: async () => {} });
    expect(j.runsOn).toBeInstanceOf(RegExp);
    const j2 = job('build2', { runsOn: 'kici:host:box-*', run: async () => {} });
    expect(j2.runsOn).toBe('kici:host:box-*');
  });
});
