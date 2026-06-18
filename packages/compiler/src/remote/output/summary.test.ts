import { describe, it, expect } from 'vitest';
import {
  formatSummary,
  formatErrorHighlight,
  formatMultiFixtureSummary,
  type RunResult,
} from './summary.js';
import { formatJsonResult } from './json.js';
import { formatJunitResult } from './junit.js';
// ── Summary table tests ──────────────────────────────────────────

describe('formatSummary', () => {
  it('renders table with pass/fail/skip statuses', () => {
    const result: RunResult = {
      fixtureId: 'push-main',
      runId: 'run-1',
      status: 'failed',
      totalDurationMs: 17500,
      jobs: [
        { name: 'build', status: 'success', durationMs: 12300 },
        { name: 'test', status: 'failed', durationMs: 5200 },
        { name: 'lint', status: 'skipped' },
      ],
    };

    const output = formatSummary(result);

    // Should contain box-drawing characters
    expect(output).toContain('\u250c'); // top-left corner
    expect(output).toContain('\u2518'); // bottom-right corner
    expect(output).toContain('\u2502'); // vertical border

    // Should contain job names
    expect(output).toContain('build');
    expect(output).toContain('test');
    expect(output).toContain('lint');

    // Should contain status indicators (the raw text, not ANSI)
    expect(output).toContain('pass');
    expect(output).toContain('fail');
    expect(output).toContain('skip');

    // Should contain durations
    expect(output).toContain('12.3s');
    expect(output).toContain('5.2s');
    expect(output).toContain('-'); // skipped has no duration

    // Should contain overall result
    expect(output).toContain('FAILED');
    expect(output).toContain('17.5s');
  });

  it('renders all-pass table', () => {
    const result: RunResult = {
      fixtureId: 'push-develop',
      runId: 'run-2',
      status: 'success',
      totalDurationMs: 8000,
      jobs: [{ name: 'build', status: 'success', durationMs: 8000 }],
    };

    const output = formatSummary(result);
    expect(output).toContain('PASSED');
    expect(output).toContain('8.0s');
  });

  it('contains headers', () => {
    const result: RunResult = {
      fixtureId: 'test-1',
      runId: 'run-3',
      status: 'success',
      totalDurationMs: 1000,
      jobs: [{ name: 'a', status: 'success', durationMs: 1000 }],
    };

    const output = formatSummary(result);
    expect(output).toContain('Job');
    expect(output).toContain('Status');
    expect(output).toContain('Duration');
  });
});

// ── Error highlight tests ────────────────────────────────────────

describe('formatErrorHighlight', () => {
  it('includes last lines of failed step', () => {
    const lines = [
      'FAIL src/app.test.ts',
      '  Test "should handle errors" failed:',
      '  Expected: 200',
      '  Received: 500',
    ];

    const output = formatErrorHighlight('test', lines);

    // Should contain the error header
    expect(output).toContain('Error: test');

    // Should contain all lines
    for (const line of lines) {
      expect(output).toContain(line);
    }
  });

  it('truncates to last 50 lines', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const output = formatErrorHighlight('build', lines);

    // Should NOT contain early lines
    expect(output).not.toContain('line 1\n');
    expect(output).not.toContain('line 50\n');

    // Should contain last 50 lines
    expect(output).toContain('line 51');
    expect(output).toContain('line 100');
  });
});

// ── Multi-fixture summary tests ─────────────────────────────────

describe('formatMultiFixtureSummary', () => {
  it('shows aggregate counts', () => {
    const results: RunResult[] = [
      {
        fixtureId: 'push-main',
        runId: 'r1',
        status: 'success',
        totalDurationMs: 1000,
        jobs: [],
      },
      {
        fixtureId: 'push-develop',
        runId: 'r2',
        status: 'success',
        totalDurationMs: 2000,
        jobs: [],
      },
      {
        fixtureId: 'pr-open',
        runId: 'r3',
        status: 'failed',
        totalDurationMs: 3000,
        jobs: [],
      },
      {
        fixtureId: 'tag-create',
        runId: 'r4',
        status: 'success',
        totalDurationMs: 500,
        jobs: [],
      },
    ];

    const output = formatMultiFixtureSummary(results);

    expect(output).toContain('Fixtures:');
    expect(output).toContain('3 passed');
    expect(output).toContain('1 failed');
    expect(output).toContain('4 total');
  });

  it('handles cancelled results', () => {
    const results: RunResult[] = [
      {
        fixtureId: 'a',
        runId: 'r1',
        status: 'success',
        totalDurationMs: 1000,
        jobs: [],
      },
      {
        fixtureId: 'b',
        runId: 'r2',
        status: 'cancelled',
        totalDurationMs: 500,
        jobs: [],
      },
    ];

    const output = formatMultiFixtureSummary(results);
    expect(output).toContain('1 passed');
    expect(output).toContain('1 cancelled');
    expect(output).toContain('2 total');
  });
});

// ── JSON output tests ────────────────────────────────────────────

describe('formatJsonResult', () => {
  it('produces valid JSON with correct structure', () => {
    const results: RunResult[] = [
      {
        fixtureId: 'push-main',
        runId: 'run-abc',
        status: 'success',
        totalDurationMs: 5000,
        jobs: [
          { name: 'build', status: 'success', durationMs: 3000 },
          { name: 'test', status: 'success', durationMs: 2000 },
        ],
      },
    ];

    const output = formatJsonResult(results);
    const parsed = JSON.parse(output);

    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].fixtureId).toBe('push-main');
    expect(parsed.results[0].runId).toBe('run-abc');
    expect(parsed.results[0].status).toBe('success');
    expect(parsed.results[0].totalDurationMs).toBe(5000);
    expect(parsed.results[0].jobs).toHaveLength(2);
    expect(parsed.results[0].jobs[0].name).toBe('build');

    expect(parsed.summary.passed).toBe(1);
    expect(parsed.summary.failed).toBe(0);
    expect(parsed.summary.cancelled).toBe(0);
    expect(parsed.summary.total).toBe(1);
  });

  it('counts summary correctly across multiple results', () => {
    const results: RunResult[] = [
      {
        fixtureId: 'a',
        runId: 'r1',
        status: 'success',
        totalDurationMs: 1000,
        jobs: [],
      },
      {
        fixtureId: 'b',
        runId: 'r2',
        status: 'failed',
        totalDurationMs: 2000,
        jobs: [],
      },
      {
        fixtureId: 'c',
        runId: 'r3',
        status: 'cancelled',
        totalDurationMs: 500,
        jobs: [],
      },
    ];

    const parsed = JSON.parse(formatJsonResult(results));
    expect(parsed.summary.passed).toBe(1);
    expect(parsed.summary.failed).toBe(1);
    expect(parsed.summary.cancelled).toBe(1);
    expect(parsed.summary.total).toBe(3);
  });

  it('omits durationMs when undefined', () => {
    const results: RunResult[] = [
      {
        fixtureId: 'a',
        runId: 'r1',
        status: 'success',
        totalDurationMs: 1000,
        jobs: [{ name: 'build', status: 'skipped' }],
      },
    ];

    const parsed = JSON.parse(formatJsonResult(results));
    expect(parsed.results[0].jobs[0]).not.toHaveProperty('durationMs');
  });
});

// ── JUnit XML output tests ───────────────────────────────────────

describe('formatJunitResult', () => {
  it('produces valid XML with correct structure', () => {
    const results: RunResult[] = [
      {
        fixtureId: 'push-main',
        runId: 'run-1',
        status: 'failed',
        totalDurationMs: 17500,
        jobs: [
          { name: 'build', status: 'success', durationMs: 12300 },
          { name: 'test', status: 'failed', durationMs: 5200 },
        ],
      },
    ];

    const output = formatJunitResult(results);

    // XML declaration
    expect(output).toContain('<?xml version="1.0" encoding="UTF-8"?>');

    // Root element with aggregates
    expect(output).toContain('<testsuites name="kici-test"');
    expect(output).toContain('tests="2"');
    expect(output).toContain('failures="1"');

    // Testsuite for fixture
    expect(output).toContain('<testsuite name="push-main"');

    // Passing testcase (self-closing)
    expect(output).toContain('<testcase name="build"');
    expect(output).toContain('classname="push-main"');
    expect(output).toContain('time="12.300"');

    // Failing testcase with failure element
    expect(output).toContain('<testcase name="test"');
    expect(output).toContain('<failure message="Step failed">');
    expect(output).toContain('</testcase>');

    // Closing tags
    expect(output).toContain('</testsuite>');
    expect(output).toContain('</testsuites>');
  });

  it('escapes XML entities in output text', () => {
    const results: RunResult[] = [
      {
        fixtureId: 'test-<special>&"chars',
        runId: 'run-1',
        status: 'failed',
        totalDurationMs: 1000,
        jobs: [{ name: 'build & test', status: 'failed', durationMs: 1000 }],
      },
    ];

    const failureMessages = new Map([
      ['test-<special>&"chars:build & test', 'Error: a < b && c > d "quoted"'],
    ]);

    const output = formatJunitResult(results, failureMessages);

    expect(output).toContain('&lt;special&gt;');
    expect(output).toContain('&amp;&quot;chars');
    expect(output).toContain('build &amp; test');
    expect(output).toContain('a &lt; b &amp;&amp; c &gt; d &quot;quoted&quot;');
  });

  it('handles skipped jobs', () => {
    const results: RunResult[] = [
      {
        fixtureId: 'test-1',
        runId: 'run-1',
        status: 'success',
        totalDurationMs: 1000,
        jobs: [
          { name: 'build', status: 'success', durationMs: 1000 },
          { name: 'deploy', status: 'skipped' },
        ],
      },
    ];

    const output = formatJunitResult(results);
    expect(output).toContain('<skipped />');
  });

  it('handles multiple fixtures as separate testsuites', () => {
    const results: RunResult[] = [
      {
        fixtureId: 'push-main',
        runId: 'r1',
        status: 'success',
        totalDurationMs: 5000,
        jobs: [{ name: 'build', status: 'success', durationMs: 5000 }],
      },
      {
        fixtureId: 'push-develop',
        runId: 'r2',
        status: 'success',
        totalDurationMs: 3000,
        jobs: [{ name: 'test', status: 'success', durationMs: 3000 }],
      },
    ];

    const output = formatJunitResult(results);
    expect(output).toContain('<testsuite name="push-main"');
    expect(output).toContain('<testsuite name="push-develop"');
    expect(output).toContain('tests="2"'); // aggregate in testsuites
    expect(output).toContain('failures="0"');
  });
});
