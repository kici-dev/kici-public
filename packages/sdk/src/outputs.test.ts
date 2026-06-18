import { describe, it, expect, beforeEach } from 'vitest';
import {
  createStepOutputProxy,
  createJobOutputProxy,
  resolveStepOutputs,
  resolveJobOutputs,
  setStepOutputsMap,
  setJobOutputsMap,
  setStepRefMap,
  getStepOutputsMap,
  getJobOutputsMap,
  getStepRefMap,
} from './outputs.js';
import type { OutputsMap, StepRefMap } from './outputs.js';
import { step } from './step.js';
import { job } from './job.js';

describe('createStepOutputProxy', () => {
  let outputsMap: OutputsMap;

  beforeEach(() => {
    outputsMap = new Map();
    setStepOutputsMap(outputsMap);
  });

  it('resolves property access when outputs are populated', () => {
    outputsMap.set('build', { version: '1.0.0', artifact: 'dist/main.js' });
    const proxy = createStepOutputProxy<{ version: string; artifact: string }>('build');

    expect(proxy.version).toBe('1.0.0');
    expect(proxy.artifact).toBe('dist/main.js');
  });

  it('throws when step has not produced outputs yet', () => {
    const proxy = createStepOutputProxy<{ version: string }>('build');

    expect(() => proxy.version).toThrow("Step 'build' has not produced outputs yet");
  });

  it('resolves multiple fields correctly', () => {
    outputsMap.set('test', { a: 1, b: 'hello', c: true });
    const proxy = createStepOutputProxy<{ a: number; b: string; c: boolean }>('test');

    expect(proxy.a).toBe(1);
    expect(proxy.b).toBe('hello');
    expect(proxy.c).toBe(true);
  });

  it('well-known string props do not throw', () => {
    // These should not throw even when outputs map is empty
    const proxy = createStepOutputProxy<{ x: number }>('missing');

    // toString, valueOf, etc. should delegate to Reflect
    expect(() => proxy.toString).not.toThrow();
    expect(() => proxy.valueOf).not.toThrow();
  });

  it('symbol props delegate to Reflect', () => {
    const proxy = createStepOutputProxy<{ x: number }>('missing');

    // Symbol access should not throw
    expect(() => (proxy as any)[Symbol.toPrimitive]).not.toThrow();
    expect(() => (proxy as any)[Symbol.iterator]).not.toThrow();
  });

  it('JSON.stringify works when outputs are populated', () => {
    outputsMap.set('build', { version: '1.0.0' });
    const proxy = createStepOutputProxy<{ version: string }>('build');

    // Should not throw -- ownKeys and getOwnPropertyDescriptor support JSON.stringify
    const json = JSON.stringify(proxy);
    expect(JSON.parse(json)).toEqual({ version: '1.0.0' });
  });

  it('ownKeys returns correct keys', () => {
    outputsMap.set('build', { x: 1, y: 2 });
    const proxy = createStepOutputProxy<{ x: number; y: number }>('build');

    expect(Object.keys(proxy)).toEqual(['x', 'y']);
  });

  it('ownKeys returns empty when step has no outputs', () => {
    const proxy = createStepOutputProxy<{ x: number }>('missing');
    expect(Object.keys(proxy)).toEqual([]);
  });

  it('has trap works correctly', () => {
    outputsMap.set('build', { version: '1.0.0' });
    const proxy = createStepOutputProxy<{ version: string }>('build');

    expect('version' in proxy).toBe(true);
    expect('missing' in proxy).toBe(false);
  });
});

describe('Step.result integration', () => {
  let outputsMap: OutputsMap;

  beforeEach(() => {
    outputsMap = new Map();
    setStepOutputsMap(outputsMap);
  });

  it('step with return type has .result property at runtime', () => {
    const buildStep = step('build', {
      run: async () => ({ version: '1.0.0', artifact: 'dist/main.js' }),
    });

    // .result exists at runtime (it's a Proxy)
    expect(buildStep.result).toBeDefined();
    expect(typeof buildStep.result).toBe('object');
  });

  it('step .result resolves when outputs map is populated', () => {
    const buildStep = step('build', {
      run: async () => ({ version: '1.0.0' }),
    });

    outputsMap.set('build', { version: '1.0.0' });

    expect(buildStep.result.version).toBe('1.0.0');
  });

  it('void step has .result at runtime but typed as never', () => {
    const voidStep = step('checkout', async () => {});

    // At runtime, .result still exists (it's a Proxy), but TypeScript types it as `never`
    // This is a compile-time check -- at runtime the property exists
    expect((voidStep as any).result).toBeDefined();
  });

  it('step-to-step output chaining via .result', () => {
    const stepA = step('build', {
      run: async () => ({ version: '1.0.0' }),
    });

    // Simulate execution: stepA produces outputs
    outputsMap.set('build', { version: '1.0.0' });

    // stepB accesses stepA.result.version
    const version = stepA.result.version;
    expect(version).toBe('1.0.0');
  });
});

describe('createJobOutputProxy', () => {
  let jobOutputsMap: OutputsMap;

  beforeEach(() => {
    jobOutputsMap = new Map();
    setJobOutputsMap(jobOutputsMap);
  });

  it('multi-step job: job.result.stepName.field resolves correctly', () => {
    // For multi-step jobs, outputs are nested by step name
    jobOutputsMap.set('build', {
      compile: { artifact: 'dist/main.js' },
      test: { passed: true },
    });

    const proxy = createJobOutputProxy('build');
    expect((proxy as any).compile).toEqual({ artifact: 'dist/main.js' });
    expect((proxy as any).test).toEqual({ passed: true });
  });

  it('single-step (run shorthand) job: job.result.field resolves directly', () => {
    // For run shorthand jobs, outputs are flat (no step nesting)
    jobOutputsMap.set('deploy', { url: 'https://example.com', status: 'success' });

    const proxy = createJobOutputProxy('deploy');
    expect((proxy as any).url).toBe('https://example.com');
    expect((proxy as any).status).toBe('success');
  });

  it('throws when job has not produced outputs yet', () => {
    const proxy = createJobOutputProxy('missing');
    expect(() => (proxy as any).field).toThrow("Job 'missing' has not produced outputs yet");
  });
});

describe('Job.result integration', () => {
  let jobOutputsMap: OutputsMap;

  beforeEach(() => {
    jobOutputsMap = new Map();
    setJobOutputsMap(jobOutputsMap);
  });

  it('job has .result property at runtime', () => {
    const checkoutStep = step('checkout', async () => {});
    const buildJob = job('build', {
      runsOn: 'linux',
      steps: [checkoutStep],
    });

    expect(buildJob.result).toBeDefined();
    expect(typeof buildJob.result).toBe('object');
  });

  it('job .result resolves when job outputs map is populated', () => {
    const checkoutStep = step('checkout', async () => {});
    const buildJob = job('build', {
      runsOn: 'linux',
      steps: [checkoutStep],
    });

    jobOutputsMap.set('build', { compile: { version: '1.0.0' } });

    expect((buildJob.result as any).compile).toEqual({ version: '1.0.0' });
  });
});

describe('setOutputsMap / injection', () => {
  it('creates fresh maps that do not pollute each other', () => {
    const map1: OutputsMap = new Map();
    map1.set('build', { version: '1.0' });
    setStepOutputsMap(map1);

    const proxy = createStepOutputProxy<{ version: string }>('build');
    expect(proxy.version).toBe('1.0');

    // Inject a new map (simulating new execution)
    const map2: OutputsMap = new Map();
    map2.set('build', { version: '2.0' });
    setStepOutputsMap(map2);

    // Same proxy now resolves against new map
    expect(proxy.version).toBe('2.0');
  });

  it('old map does not affect new execution', () => {
    const map1: OutputsMap = new Map();
    map1.set('old-step', { data: 'old' });
    setStepOutputsMap(map1);

    // New execution with fresh map
    const map2: OutputsMap = new Map();
    setStepOutputsMap(map2);

    const proxy = createStepOutputProxy<{ data: string }>('old-step');
    expect(() => proxy.data).toThrow("Step 'old-step' has not produced outputs yet");
  });

  it('getStepOutputsMap returns the currently injected map', () => {
    const map: OutputsMap = new Map();
    setStepOutputsMap(map);
    expect(getStepOutputsMap()).toBe(map);
  });

  it('getJobOutputsMap returns the currently injected map', () => {
    const map: OutputsMap = new Map();
    setJobOutputsMap(map);
    expect(getJobOutputsMap()).toBe(map);
  });

  it('getStepRefMap returns the currently injected map', () => {
    const map: StepRefMap = new WeakMap();
    setStepRefMap(map);
    expect(getStepRefMap()).toBe(map);
  });
});

describe('resolveStepOutputs', () => {
  let outputsMap: OutputsMap;
  let refMap: StepRefMap;

  beforeEach(() => {
    outputsMap = new Map();
    refMap = new WeakMap();
    setStepOutputsMap(outputsMap);
    setStepRefMap(refMap);
  });

  it('resolves by Step reference (uses step.name)', () => {
    const buildStep = step('build', {
      run: async () => ({ version: '1.0.0' }),
    });

    outputsMap.set('build', { version: '1.0.0' });

    const outputs = resolveStepOutputs<{ version: string }>(buildStep);
    expect(outputs.version).toBe('1.0.0');
  });

  it('resolves by bare function reference (uses StepRefMap)', () => {
    const bareFn = async () => ({ status: 'ready' });
    refMap.set(bareFn, 'step-1');
    outputsMap.set('step-1', { status: 'ready' });

    const outputs = resolveStepOutputs<{ status: string }>(bareFn);
    expect(outputs.status).toBe('ready');
  });

  it('throws on unregistered bare function reference', () => {
    const unknownFn = async () => {};

    expect(() => resolveStepOutputs(unknownFn)).toThrow(
      'Cannot resolve outputs for bare function: function not registered in step ref map',
    );
  });

  it('throws when step has not produced outputs', () => {
    const buildStep = step('build', async () => {});

    expect(() => resolveStepOutputs(buildStep)).toThrow(
      "Step 'build' has not produced outputs yet",
    );
  });

  it('throws on invalid reference type', () => {
    expect(() => resolveStepOutputs(42 as any)).toThrow(
      'Invalid step reference: expected Step object or bare function',
    );
  });

  it('accepts custom outputsMap and refMap parameters', () => {
    const customMap: OutputsMap = new Map();
    customMap.set('custom', { value: 42 });

    const customRefMap: StepRefMap = new WeakMap();
    const fn = async () => {};
    customRefMap.set(fn, 'custom');

    const outputs = resolveStepOutputs<{ value: number }>(fn, customMap, customRefMap);
    expect(outputs.value).toBe(42);
  });
});

describe('resolveJobOutputs', () => {
  let jobOutputsMap: OutputsMap;

  beforeEach(() => {
    jobOutputsMap = new Map();
    setJobOutputsMap(jobOutputsMap);
  });

  it('resolves job outputs by reference', () => {
    const checkoutStep = step('checkout', async () => {});
    const buildJob = job('build', {
      runsOn: 'linux',
      steps: [checkoutStep],
    });

    jobOutputsMap.set('build', { compile: { version: '1.0.0' } });

    const outputs = resolveJobOutputs(buildJob);
    expect(outputs).toEqual({ compile: { version: '1.0.0' } });
  });

  it('throws when job has not produced outputs', () => {
    const checkoutStep = step('checkout', async () => {});
    const buildJob = job('build', {
      runsOn: 'linux',
      steps: [checkoutStep],
    });

    expect(() => resolveJobOutputs(buildJob)).toThrow("Job 'build' has not produced outputs yet");
  });

  it('accepts custom outputsMap parameter', () => {
    const customMap: OutputsMap = new Map();
    customMap.set('deploy', { url: 'https://example.com' });

    const outputs = resolveJobOutputs({ name: 'deploy' }, customMap);
    expect(outputs).toEqual({ url: 'https://example.com' });
  });
});
