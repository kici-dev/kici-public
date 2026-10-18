import { describe, expect, it } from 'vitest';
import { combineRunStatuses, errorBlocks } from './run-remote-follow.js';

type Watch = Parameters<typeof errorBlocks>[0][number];

function watch(overrides: Partial<Watch> & Pick<Watch, 'lastStatus'>): Watch {
  return {
    run: { runId: 'run-1', workflowName: 'wf' },
    jobTails: new Map(),
    runTail: [],
    attributed: true,
    ...overrides,
  };
}

describe('combineRunStatuses', () => {
  it('passes only when every run passed', () => {
    // breaks-if-wrong: all runs green is a pass
    expect(combineRunStatuses(['success', 'success'])).toBe('success');
    // fails-when: the combined status reads only the first run
    expect(combineRunStatuses(['success', 'failed'])).toBe('failed');
  });

  it('reports a cancel only when nothing failed', () => {
    expect(combineRunStatuses(['success', 'cancelled'])).toBe('cancelled');
    expect(combineRunStatuses(['failed', 'cancelled'])).toBe('failed');
  });

  it('never passes an empty set of runs', () => {
    expect(combineRunStatuses([])).toBe('failed');
  });
});

describe('errorBlocks', () => {
  it("gives each failed job its own block, holding only that job's lines", () => {
    const blocks = errorBlocks(
      [
        watch({
          lastStatus: {
            runId: 'run-1',
            status: 'failed',
            done: true,
            jobs: [
              { jobId: 'a', jobName: 'init-fails', status: 'failed' },
              { jobId: 'b', jobName: 'image-tools', status: 'success' },
              { jobId: 'c', jobName: 'step-fails', status: 'failed' },
            ],
          },
          jobTails: new Map([
            ['init-fails', ['mise 404']],
            ['image-tools', ['apt install tree']],
            ['step-fails', ['exit 3']],
          ]),
          runTail: ['mise 404', 'apt install tree', 'exit 3'],
        }),
      ],
      false,
    );
    // fails-when: one block carries the run's mixed tail, and the second failed job gets none
    expect(blocks).toEqual([
      { label: 'init-fails', lines: ['mise 404'] },
      { label: 'step-fails', lines: ['exit 3'] },
    ]);
  });

  it('labels each block <workflow> / <job> across workflows', () => {
    const failedRun = (runId: string, workflowName: string): Watch =>
      watch({
        run: { runId, workflowName },
        lastStatus: {
          runId,
          status: 'failed',
          done: true,
          jobs: [{ jobId: runId, jobName: 'build', status: 'failed' }],
        },
        jobTails: new Map([['build', [`${workflowName} output`]]]),
      });
    const blocks = errorBlocks([failedRun('r1', 'wf-a'), failedRun('r2', 'wf-b')], true);
    expect(blocks).toEqual([
      { label: 'wf-a / build', lines: ['wf-a output'] },
      { label: 'wf-b / build', lines: ['wf-b output'] },
    ]);
  });

  it("shows a run's failure reason when it failed with no failed job", () => {
    const blocks = errorBlocks(
      [
        watch({
          lastStatus: {
            runId: 'run-1',
            status: 'failed',
            done: true,
            jobs: [],
            failureReason: 'secret DB_PASSWORD not found',
          },
        }),
      ],
      false,
    );
    // fails-when: an init-failed run prints FAILED with no reason
    expect(blocks).toEqual([{ label: 'wf', lines: ['secret DB_PASSWORD not found'] }]);
  });

  it("keeps one block of the run's tail for a server that does not name each line's job", () => {
    const blocks = errorBlocks(
      [
        watch({
          attributed: false,
          lastStatus: {
            runId: 'run-1',
            status: 'failed',
            done: true,
            jobs: [{ jobId: 'a', jobName: 'test', status: 'failed' }],
          },
          runTail: ['a', 'b'],
        }),
      ],
      false,
    );
    // breaks-if-wrong: an older orchestrator still gets its error block
    expect(blocks).toEqual([{ label: 'test', lines: ['a', 'b'] }]);
  });

  it('prints nothing for a run that passed', () => {
    expect(
      errorBlocks(
        [
          watch({
            lastStatus: { runId: 'run-1', status: 'success', done: true, jobs: [] },
            runTail: ['ok'],
          }),
        ],
        false,
      ),
    ).toEqual([]);
  });
});
