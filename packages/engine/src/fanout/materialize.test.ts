import { describe, it, expect } from 'vitest';
import {
  materializeFanout,
  materializeResolvedHosts,
  hostEnvelopeFields,
  FanoutError,
  MAX_FANOUT_JOBS,
  VariantKind,
  type ResolvedHostAgent,
} from './materialize.js';
import type { LockJob } from '../trigger/types.js';

const base = (over: Partial<LockJob>): LockJob =>
  ({ _type: 'static', name: 'test', runsOn: 'ubuntu', needs: [], steps: [], ...over }) as LockJob;

describe('materializeFanout', () => {
  it('passes non-matrix jobs through 1:1', () => {
    const { jobs, expansionMap } = materializeFanout([base({})]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ baseName: 'test', expandedName: 'test' });
    expect(jobs[0].variantValues).toBeUndefined();
    expect(jobs[0].variantKind).toBeUndefined();
    expect(expansionMap.get('test')).toEqual(['test']);
  });

  it('expands a single-dim static matrix (array form) with local-executor naming', () => {
    const { jobs, expansionMap } = materializeFanout([
      base({ matrix: { _type: 'static', values: ['a', 'b'] } }),
    ]);
    expect(jobs.map((j) => j.expandedName)).toEqual(['test (a)', 'test (b)']);
    expect(jobs[0].variantValues).toEqual({ value: 'a' });
    expect(jobs[1].variantValues).toEqual({ value: 'b' });
    expect(jobs.every((j) => j.variantKind === 'matrix')).toBe(true);
    expect(expansionMap.get('test')).toEqual(['test (a)', 'test (b)']);
  });

  it('expands a single-dim static matrix (object form)', () => {
    const { jobs } = materializeFanout([
      base({ matrix: { _type: 'static', values: { variant: ['a', 'b'] } } }),
    ]);
    expect(jobs.map((j) => j.expandedName)).toEqual(['test (a)', 'test (b)']);
    expect(jobs[0].variantValues).toEqual({ variant: 'a' });
    expect(jobs[1].variantValues).toEqual({ variant: 'b' });
  });

  it('applies include/exclude', () => {
    const { jobs } = materializeFanout([
      base({
        matrix: { _type: 'static', values: { os: ['linux', 'macos'], arch: ['x64'] } },
        exclude: [{ os: 'macos', arch: 'x64' }],
        include: [{ os: 'windows', arch: 'arm64' }],
      }),
    ]);
    expect(jobs.map((j) => j.variantValues)).toEqual([
      { arch: 'x64', os: 'linux' },
      { os: 'windows', arch: 'arm64' },
    ]);
  });

  it('throws FanoutError on zero combinations after exclude', () => {
    expect(() =>
      materializeFanout([
        base({
          matrix: { _type: 'static', values: { os: ['linux'] } },
          exclude: [{ os: 'linux' }],
        }),
      ]),
    ).toThrow(FanoutError);
  });

  it('throws FanoutError above the cap', () => {
    const values = {
      a: Array.from({ length: 20 }, (_, i) => `${i}`),
      b: Array.from({ length: 20 }, (_, i) => `${i}`),
    }; // 400 > 256
    expect(() => materializeFanout([base({ matrix: { _type: 'static', values } })])).toThrow(/256/);
    expect(MAX_FANOUT_JOBS).toBe(256);
  });

  it('leaves dynamic matrices unexpanded with a passthrough marker', () => {
    const { jobs, expansionMap } = materializeFanout([
      base({
        matrix: { _type: 'dynamic', source: { file: 'wf.ts', jobName: 'test' } },
      }),
    ]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].pendingDynamicMatrix).toBe(true);
    expect(jobs[0].expandedName).toBe('test');
    expect(jobs[0].variantValues).toBeUndefined();
    expect(expansionMap.get('test')).toEqual(['test']);
  });

  it('produces distinct expanded names when a dimension is named "value"', () => {
    // Regression: a multi-dim matrix with a `value` dimension must not collapse
    // sibling combinations onto the same expanded name (silent job loss).
    const { jobs, expansionMap } = materializeFanout([
      base({
        matrix: { _type: 'static', values: { value: ['x86', 'arm'], os: ['linux', 'macos'] } },
      }),
    ]);
    const names = jobs.map((j) => j.expandedName);
    expect(new Set(names).size).toBe(names.length); // no duplicates
    // Dimension names are sorted (os before value), so the suffix is "os, value".
    expect(names).toEqual(
      expect.arrayContaining([
        'test (linux, x86)',
        'test (linux, arm)',
        'test (macos, x86)',
        'test (macos, arm)',
      ]),
    );
    expect(expansionMap.get('test')).toHaveLength(4);
  });

  it('carries the original lockJob through on every materialized child', () => {
    const job = base({ matrix: { _type: 'static', values: ['a', 'b'] } });
    const { jobs } = materializeFanout([job]);
    expect(jobs[0].lockJob).toBe(job);
    expect(jobs[1].lockJob).toBe(job);
  });
});

describe('materializeResolvedHosts', () => {
  const hostBase = (over: Partial<LockJob>): LockJob =>
    ({ _type: 'static', name: 'patch', needs: [], steps: [], ...over }) as LockJob;
  const agents: ResolvedHostAgent[] = [
    { agentId: 'a1', host: 'web-01', labels: ['role:web'], connectedInstanceId: 'i1' },
    { agentId: 'a2', host: 'web-02', labels: ['role:web'], connectedInstanceId: 'i1' },
  ];

  it('emits one pinned child per agent', () => {
    const { jobs, expansionMap } = materializeResolvedHosts(hostBase({}), agents, 1024);
    expect(jobs.map((j) => j.expandedName)).toEqual(['patch (web-01)', 'patch (web-02)']);
    expect(jobs.map((j) => j.variantKind)).toEqual([VariantKind.host, VariantKind.host]);
    expect(jobs.map((j) => j.pinnedAgentId)).toEqual(['a1', 'a2']);
    expect(jobs.map((j) => j.host)).toEqual(['web-01', 'web-02']);
    expect(jobs.map((j) => j.connectedInstanceId)).toEqual(['i1', 'i1']);
    expect(expansionMap.get('patch')).toEqual(['patch (web-01)', 'patch (web-02)']);
  });

  it('threads the resolved agent facts onto each child', () => {
    const { jobs } = materializeResolvedHosts(hostBase({}), agents, 1024);
    expect(jobs[0].agent).toEqual(agents[0]);
  });

  it('throws FanoutError on zero matched agents', () => {
    expect(() => materializeResolvedHosts(hostBase({}), [], 1024)).toThrow(/zero matching hosts/);
  });

  it('throws FanoutError when matched hosts exceed maxHosts', () => {
    expect(() => materializeResolvedHosts(hostBase({}), agents, 1)).toThrow(/max 1/);
  });
});

describe('hostEnvelopeFields', () => {
  it('extracts name/baseJobName/pinnedAgentId/host/agent/connectedInstanceId', () => {
    const agent: ResolvedHostAgent = { agentId: 'a1', host: 'web-01', labels: ['role:web'] };
    const fields = hostEnvelopeFields({
      lockJob: { _type: 'static', name: 'patch', needs: [], steps: [] } as LockJob,
      baseName: 'patch',
      expandedName: 'patch (web-01)',
      variantKind: VariantKind.host,
      pinnedAgentId: 'a1',
      host: 'web-01',
      agent,
      connectedInstanceId: 'i1',
    });
    expect(fields).toEqual({
      name: 'patch (web-01)',
      baseJobName: 'patch',
      pinnedAgentId: 'a1',
      host: 'web-01',
      agent,
      connectedInstanceId: 'i1',
    });
  });
});
