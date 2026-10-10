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
      runsOn: [{ kind: 'exact', value: 'kici:os:linux' }],
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

describe('displayDryRun targeting lines', () => {
  const exact = (value: string) => ({ kind: 'exact' as const, value });
  const regex = (source: string, flags: string) => ({ kind: 'regex' as const, source, flags });
  const job = (name: string, targeting: Record<string, unknown>) => ({
    _type: 'static',
    name,
    needs: [],
    steps: [{ name: 'run' }],
    ...targeting,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prints every runs-on form readably', async () => {
    const { logger } = await import('@kici-dev/core');
    const wf = {
      name: 'ci',
      triggers: [{ _type: 'push' }],
      jobs: [
        job('one', { runsOn: [exact('linux')] }),
        job('many', {
          runsOn: [exact('linux'), regex('x64|arm64', '')],
          excludeLabels: [exact('slow')],
        }),
        job('fanout', {
          runsOnAll: {
            include: [[exact('role:web')], [exact('role:db')]],
            exclude: [exact('drain')],
          },
        }),
        job('any', {}),
      ],
    } as unknown as LockWorkflow;
    displayDryRun([wf], [decision], {});
    // Strip ANSI colour codes the gray() wrapper adds.
    const infos = (logger.info as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0]).replace(/\u001b\[[0-9;]*m/g, ''),
    );
    // fails-when: dry-run interpolates `job.runsOn` directly ("[object Object]")
    expect(infos.join('\n')).not.toContain('[object Object]');
    expect(infos).toContain('      runs-on: linux');
    expect(infos).toContain('      runs-on: linux, /x64|arm64/');
    expect(infos).toContain('      exclude-labels: slow');
    expect(infos).toContain('      runs-on-all: role:web | role:db (excluding drain)');
    // breaks-if-wrong: a job with no constraint still prints a runs-on line
    expect(infos).toContain('      runs-on: any agent');
  });
});
