import { describe, it, expect } from 'vitest';
import {
  upstreamBaseNamesFromNeeds,
  buildMatrixOutputsEnvelope,
  buildHostOutputsEnvelope,
  buildUpstreamOutputsByBase,
  buildUpstreamStatusesByBase,
  buildInternalJobConfigForWorkflow,
  internalJobRunsOnSelectors,
} from './orchestrator-core.js';

describe('internalJobRunsOnSelectors', () => {
  it('partitions a lock job runsOn LabelMatcher[] into exact label strings + regex patterns (never raw matcher objects)', () => {
    // Regression: internal-event (cron / ctx.emit) dispatch used to pass the
    // raw LabelMatcher objects as runsOnLabels, which crashed peer-registry's
    // `requiredLabels.map((l) => l.toLowerCase())` ("l.toLowerCase is not a
    // function") in coordinator routing and matched no agent in direct dispatch.
    expect(
      internalJobRunsOnSelectors({
        runsOn: [
          { kind: 'exact', value: 'role:web' },
          { kind: 'regex', source: '^kici:host:box-', flags: '' },
        ],
        excludeLabels: [{ kind: 'regex', source: '-canary$', flags: '' }],
      }),
    ).toEqual({
      runsOnLabels: ['role:web'],
      runsOnPatterns: [{ kind: 'regex', source: '^kici:host:box-', flags: '' }],
      excludeLabels: [],
      excludePatterns: [{ kind: 'regex', source: '-canary$', flags: '' }],
    });
  });

  it('returns empty selectors for a job with no runsOn (matches any agent)', () => {
    expect(internalJobRunsOnSelectors({})).toEqual({
      runsOnLabels: [],
      runsOnPatterns: [],
      excludeLabels: [],
      excludePatterns: [],
    });
  });
});

describe('upstreamBaseNamesFromNeeds', () => {
  it('returns [] for undefined / non-array', () => {
    expect(upstreamBaseNamesFromNeeds(undefined)).toEqual([]);
    expect(upstreamBaseNamesFromNeeds(null)).toEqual([]);
    expect(upstreamBaseNamesFromNeeds('test')).toEqual([]);
  });

  it('passes through string needs', () => {
    expect(upstreamBaseNamesFromNeeds(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('extracts the name from NeedsEntry objects (fixes the string-assumption bug)', () => {
    expect(upstreamBaseNamesFromNeeds([{ name: 'test', runOn: ['failed'] }])).toEqual(['test']);
  });

  it('skips NeedsGroupEntry objects (resolved by the scheduler)', () => {
    expect(upstreamBaseNamesFromNeeds([{ group: 'deploys', runOn: ['success'] }])).toEqual([]);
  });

  it('handles a mix of strings and objects', () => {
    expect(
      upstreamBaseNamesFromNeeds(['lint', { name: 'test', runOn: ['failed'] }, { group: 'g' }]),
    ).toEqual(['lint', 'test']);
  });
});

describe('buildMatrixOutputsEnvelope', () => {
  it('keys byMatrix by the suffix and merges last-write-wins in name order', () => {
    const env = buildMatrixOutputsEnvelope('test', [
      { job_name: 'test (b)', parsed: { v: '2', only_b: 'yes' } },
      { job_name: 'test (a)', parsed: { v: '1' } },
    ]);
    expect(env.byMatrix).toEqual({ a: { v: '1' }, b: { v: '2', only_b: 'yes' } });
    // name order is a, b -> b wins on `v`.
    expect(env.merged).toEqual({ v: '2', only_b: 'yes' });
  });
});

describe('buildHostOutputsEnvelope', () => {
  it('keys byHost, records succeeded/failed hosts, and arrays outputs across hosts', () => {
    const env = buildHostOutputsEnvelope([
      { host: 'web-02', status: 'failed', parsed: { v: '2' } },
      { host: 'web-01', status: 'success', parsed: { v: '1' } },
    ]);
    expect(env.byHost).toEqual({ 'web-01': { v: '1' }, 'web-02': { v: '2' } });
    expect(env.summary.succeededHosts).toEqual(['web-01']);
    expect(env.summary.failedHosts).toEqual(['web-02']);
    // host order (web-01, web-02) -> array view, never a collapsing scalar.
    expect(env.summary.outputs).toEqual({ v: ['1', '2'] });
  });
});

describe('buildUpstreamOutputsByBase', () => {
  it('builds the byHost envelope for a runsOnAll upstream', () => {
    const out = buildUpstreamOutputsByBase(
      ['patch'],
      [
        {
          job_name: 'patch (web-01)',
          outputs: JSON.stringify({ v: '1' }),
          matrix_values: null,
          variant_kind: 'host',
          variant_label: 'web-01',
          status: 'success',
        },
        {
          job_name: 'patch (web-02)',
          outputs: JSON.stringify({ v: '2' }),
          matrix_values: null,
          variant_kind: 'host',
          variant_label: 'web-02',
          status: 'failed',
        },
      ],
    );
    expect(out).toEqual({
      patch: {
        byHost: { 'web-01': { v: '1' }, 'web-02': { v: '2' } },
        summary: {
          succeededHosts: ['web-01'],
          failedHosts: ['web-02'],
          outputs: { v: ['1', '2'] },
        },
      },
    });
  });

  it('builds the byMatrix/merged envelope for a fanned upstream', () => {
    const out = buildUpstreamOutputsByBase(
      ['test'],
      [
        {
          job_name: 'test (a)',
          outputs: JSON.stringify({ v: '1' }),
          matrix_values: '{"variant":"a"}',
        },
        {
          job_name: 'test (b)',
          outputs: JSON.stringify({ v: '2' }),
          matrix_values: '{"variant":"b"}',
        },
      ],
    );
    expect(out).toEqual({
      test: { byMatrix: { a: { v: '1' }, b: { v: '2' } }, merged: { v: '2' } },
    });
  });

  it('keeps the flat shape for a non-fanned upstream', () => {
    const out = buildUpstreamOutputsByBase('build'.length ? ['build'] : [], [
      { job_name: 'build', outputs: JSON.stringify({ artifact: 'x' }), matrix_values: null },
    ]);
    expect(out).toEqual({ build: { artifact: 'x' } });
  });

  it('returns undefined when no upstream produced outputs', () => {
    const out = buildUpstreamOutputsByBase(
      ['test'],
      [{ job_name: 'test', outputs: null, matrix_values: null }],
    );
    expect(out).toBeUndefined();
  });

  it('does not over-match a different base via prefix', () => {
    const out = buildUpstreamOutputsByBase(
      ['test'],
      [
        { job_name: 'test (a)', outputs: JSON.stringify({ v: '1' }), matrix_values: '{"x":"a"}' },
        { job_name: 'tests (a)', outputs: JSON.stringify({ v: 'X' }), matrix_values: '{"x":"a"}' },
      ],
    );
    expect(out).toEqual({ test: { byMatrix: { a: { v: '1' } }, merged: { v: '1' } } });
  });
});

describe('buildUpstreamStatusesByBase', () => {
  it('keys each upstream row by job_name', () => {
    const out = buildUpstreamStatusesByBase([
      { job_name: 'build', status: 'success' },
      { job_name: 'probe', status: 'failed' },
    ]);
    expect(out).toEqual({ build: 'success', probe: 'failed' });
  });

  it('records per-child statuses for a fanned-out upstream', () => {
    const out = buildUpstreamStatusesByBase([
      { job_name: 'test (a)', status: 'success' },
      { job_name: 'test (b)', status: 'skipped' },
    ]);
    expect(out).toEqual({ 'test (a)': 'success', 'test (b)': 'skipped' });
  });

  it('skips rows with no status and returns undefined when none have one', () => {
    expect(buildUpstreamStatusesByBase([{ job_name: 'x', status: null }])).toBeUndefined();
  });
});

describe('buildInternalJobConfigForWorkflow dispatchInputs', () => {
  const job = { id: 'j', name: 'j', steps: [], needs: [] };

  it('stamps defaults-only schedule inputs for a cron fire', () => {
    const wf = {
      name: 'sched-wf',
      source: 'test/repo',
      triggers: [
        {
          _type: 'schedule',
          cronExpression: '0 0 * * *',
          timezone: 'UTC',
          inputs: { mode: { type: 'enum', values: ['full', 'quick'], default: 'full' } },
        },
      ],
    };
    const cfg = buildInternalJobConfigForWorkflow(wf, job);
    expect(cfg.dispatchInputs).toEqual({ mode: 'full' });
  });

  it('omits dispatchInputs for a non-schedule internal event workflow', () => {
    const wf = {
      name: 'wc-wf',
      source: 'test/repo',
      triggers: [{ _type: 'workflow_complete', status: ['success'] }],
    };
    const cfg = buildInternalJobConfigForWorkflow(wf, job);
    expect('dispatchInputs' in cfg).toBe(false);
  });
});
