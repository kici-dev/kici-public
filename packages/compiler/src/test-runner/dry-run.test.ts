import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowDecision } from '@kici-dev/engine';
import type { LockWorkflow } from '../types.js';
import { DynamicValueField, type JobPurityWarning } from '../lockfile/index.js';
import { displayDryRun } from './dry-run.js';

vi.mock('@kici-dev/core', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const lockWorkflow: LockWorkflow = {
  name: 'ci',
  triggers: [{ _type: 'push' }],
  jobs: [
    {
      _type: 'static',
      name: 'build',
      runsOn: 'kici:os:linux',
      needs: [],
      steps: [{ name: 'run' }],
    },
  ],
} as unknown as LockWorkflow;

const decision: WorkflowDecision = {
  workflowName: 'ci',
  matched: true,
  matchedTrigger: 0,
  checks: [],
  summary: 'matched',
};

describe('displayDryRun purity warnings', () => {
  let loggerInfo: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { logger } = await import('@kici-dev/core');
    loggerInfo = logger.info as ReturnType<typeof vi.fn>;
  });

  it('shows the injected __init__ job for an impure dynamic value', () => {
    const warnings: JobPurityWarning[] = [
      {
        workflowName: 'ci',
        jobName: 'build',
        field: DynamicValueField.Context,
        reason: 'async functions cannot be inlined',
      },
    ];
    displayDryRun([lockWorkflow], [decision], {}, warnings);
    const out = loggerInfo.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('__init__ job required');
    expect(out).toContain('~5-10s');
    expect(out).toContain('context is not pure');
    // Summary line counts distinct (workflow, job) pairs.
    expect(out).toContain('1 __init__ job(s) will be injected');
  });

  it('emits no init-job lines when there are no warnings', () => {
    displayDryRun([lockWorkflow], [decision], {}, []);
    const out = loggerInfo.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).not.toContain('__init__ job required');
    expect(out).not.toContain('will be injected');
  });

  it('does not count a warning for a job that is filtered out of the display', () => {
    // Warning references a job the --job filter hides: the summary must stay
    // consistent with the (absent) per-job detail lines and count zero.
    const warnings: JobPurityWarning[] = [
      {
        workflowName: 'ci',
        jobName: 'build',
        field: DynamicValueField.Context,
        reason: 'async functions cannot be inlined',
      },
    ];
    displayDryRun([lockWorkflow], [decision], { job: 'other' }, warnings);
    const out = loggerInfo.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).not.toContain('__init__ job required');
    expect(out).not.toContain('will be injected');
  });
});
