import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowDecision } from '@kici-dev/engine';
import type { LockWorkflow } from '../types.js';
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

describe('displayDryRun', () => {
  let loggerInfo: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { logger } = await import('@kici-dev/core');
    loggerInfo = logger.info as ReturnType<typeof vi.fn>;
  });

  it('renders the matched workflow, its jobs and steps', () => {
    displayDryRun([lockWorkflow], [decision], {});
    const out = loggerInfo.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('DRY RUN');
    expect(out).toContain('Workflow: ci');
    expect(out).toContain('build');
    expect(out).toContain('run');
    expect(out).toContain('Dry run complete');
  });

  it('never renders init-job lines (dynamic values resolve in the agent init round)', () => {
    displayDryRun([lockWorkflow], [decision], {});
    const out = loggerInfo.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).not.toContain('__init__ job required');
    expect(out).not.toContain('will be injected');
  });

  it('reports no matched workflows when the event does not match', () => {
    const skipped: WorkflowDecision = { ...decision, matched: false };
    displayDryRun([lockWorkflow], [skipped], {});
    const out = loggerInfo.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('No workflows matched the event.');
  });
});
