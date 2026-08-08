import { describe, it, expect } from 'vitest';
import {
  materializeFanout,
  materializeResolvedMatrix,
  materializeResolvedHosts,
  hostEnvelopeFields,
  matrixEnvelopeFields,
  FanoutError,
  FanoutCause,
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

  it('expands a single-dim static matrix (array form) with deterministic naming', () => {
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

  it('defaults FanoutError cause to error and accepts a narrowed-empty cause', () => {
    const err = new FanoutError('fan', 'msg');
    expect(err.cause).toBe(FanoutCause.error);
    const narrowed = new FanoutError('fan', 'msg', FanoutCause.narrowedEmpty);
    expect(narrowed.cause).toBe(FanoutCause.narrowedEmpty);
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

describe('matrix input guards (static path)', () => {
  it('rejects an oversized product before materializing it', () => {
    const big = Array.from({ length: 1000 }, (_, i) => `v${i}`);
    const lockJob = base({ matrix: { _type: 'static', values: { a: big, b: big, c: big } } });
    // If the guard were missing this would allocate 1e9 tuples, not throw.
    expect(() => materializeFanout([lockJob])).toThrow(FanoutError);
    expect(() => materializeFanout([lockJob])).toThrow(/too large to expand/);
  });

  it('still allows a product above the fan-out cap that excludes back under it', () => {
    // 300 raw combinations, excluded down to 200 — succeeds today and must keep
    // succeeding. This is the regression guard for the two-threshold split.
    const twenty = Array.from({ length: 20 }, (_, i) => `a${i}`);
    const fifteen = Array.from({ length: 15 }, (_, i) => `b${i}`);
    const lockJob = base({
      matrix: { _type: 'static', values: { a: twenty, b: fifteen } },
      exclude: fifteen.slice(0, 5).map((b) => ({ b })),
    });
    const result = materializeFanout([lockJob]);
    expect(result.jobs).toHaveLength(200);
  });

  it('rewraps a malformed matrix as a FanoutError naming the job', () => {
    const lockJob = base({ matrix: { _type: 'static', values: 'linux' as never } });
    expect(() => materializeFanout([lockJob])).toThrow(FanoutError);
    expect(() => materializeFanout([lockJob])).toThrow(/one dimension per character/);
    expect(() => materializeFanout([lockJob])).toThrow(/job 'test'/);
  });

  it('rejects a duplicate combination', () => {
    const lockJob = base({ matrix: { _type: 'static', values: ['a', 'a'] } });
    expect(() => materializeFanout([lockJob])).toThrow(FanoutError);
    expect(() => materializeFanout([lockJob])).toThrow(/duplicate combination/);
    expect(() => materializeFanout([lockJob])).toThrow(/test \(a\)/);
  });
});

describe('matrix input guards (resolved dynamic path)', () => {
  it('rejects duplicate resolved combinations', () => {
    const lockJob = base({});
    expect(() =>
      materializeResolvedMatrix(lockJob, [{ value: 'linux' }, { value: 'linux' }]),
    ).toThrow(/duplicate combination/);
  });

  it('accepts distinct resolved combinations', () => {
    const lockJob = base({});
    const result = materializeResolvedMatrix(lockJob, [{ value: 'a' }, { value: 'b' }]);
    expect(result.jobs).toHaveLength(2);
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

  it('assigns fanoutIndex/Total over an agentId-sorted host fan-out', () => {
    const unsorted: ResolvedHostAgent[] = [
      { agentId: 'b', host: 'host-b', labels: [] },
      { agentId: 'a', host: 'host-a', labels: [] },
      { agentId: 'c', host: 'host-c', labels: [] },
    ];
    const { jobs } = materializeResolvedHosts(hostBase({}), unsorted, 1024);
    const byAgent = Object.fromEntries(jobs.map((j) => [j.pinnedAgentId, j]));
    expect(byAgent.a.fanoutIndex).toBe(0);
    expect(byAgent.a.fanoutTotal).toBe(3);
    expect(byAgent.b.fanoutIndex).toBe(1);
    expect(byAgent.c.fanoutIndex).toBe(2);
    expect(byAgent.c.fanoutTotal).toBe(3);
    // Emission order is the input order; the index is the agentId-sorted rank,
    // which the orchestrator wave dispatch keys on (dispatch order == index).
    expect(jobs.map((j) => j.pinnedAgentId)).toEqual(['b', 'a', 'c']);
  });
});

describe('fanout position assignment', () => {
  const matrixBase = (over: Partial<LockJob>): LockJob =>
    ({ _type: 'static', name: 'm', runsOn: 'ubuntu', needs: [], steps: [], ...over }) as LockJob;

  it('assigns fanoutIndex/Total over matrix children by variant label', () => {
    const { jobs } = materializeFanout([
      matrixBase({ matrix: { _type: 'static', values: ['a', 'b', 'c'] } }),
    ]);
    expect(jobs).toHaveLength(3);
    jobs.forEach((j, i) => {
      expect(j.fanoutIndex).toBe(i);
      expect(j.fanoutTotal).toBe(3);
    });
  });

  it('omits fanout fields on a non-fan-out (single-child) job', () => {
    const { jobs } = materializeFanout([matrixBase({})]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].fanoutIndex).toBeUndefined();
    expect(jobs[0].fanoutTotal).toBeUndefined();
  });

  it('carries fanout position through the envelope builders', () => {
    const { jobs } = materializeFanout([
      matrixBase({ matrix: { _type: 'static', values: ['a', 'b'] } }),
    ]);
    const env = matrixEnvelopeFields(jobs[0]);
    expect(env.fanoutIndex).toBe(jobs[0].fanoutIndex);
    expect(env.fanoutTotal).toBe(2);
  });

  it('host envelope carries fanout position; single-child envelope omits it', () => {
    const agents: ResolvedHostAgent[] = [
      { agentId: 'a', host: 'h-a', labels: [] },
      { agentId: 'b', host: 'h-b', labels: [] },
    ];
    const fanned = materializeResolvedHosts(matrixBase({}), agents, 1024).jobs;
    expect(hostEnvelopeFields(fanned[0]).fanoutTotal).toBe(2);
    const single = materializeResolvedHosts(matrixBase({}), [agents[0]], 1024).jobs;
    expect(hostEnvelopeFields(single[0]).fanoutIndex).toBeUndefined();
    expect(hostEnvelopeFields(single[0]).fanoutTotal).toBeUndefined();
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
