import { describe, it, expect } from 'vitest';
import {
  ExecutionJobStatus,
  JobKind,
  RunDetailFallbackReason,
  RunDetailSource,
} from '@kici-dev/engine';
import { stepDetailNotes } from './detail-notes.js';

const job = (over: Record<string, unknown> = {}) => ({
  jobId: 'j1',
  jobName: 'build',
  status: ExecutionJobStatus.enum.failed,
  matrixValues: null,
  startedAt: 1_700_000_000_000,
  completedAt: 1_700_000_060_000,
  durationMs: 60_000,
  agentId: 'a1',
  errorMessage: null,
  steps: [],
  ...over,
});

describe('stepDetailNotes', () => {
  it('names the fallback reason when the Platform served its stored copy', () => {
    const notes = stepDetailNotes({
      detail: { jobs: [job()] },
      source: RunDetailSource.enum['platform-db'],
      fallbackReason: RunDetailFallbackReason.enum.orchestrator_unreachable,
    });
    // fails-when: a stored-copy read prints nothing, which is the silent empty output
    expect(notes).toEqual([
      'step detail unavailable: the Platform could not read it from the orchestrator that ran this run (no orchestrator that can serve this run is connected)',
    ]);
  });

  it('says so when the Platform names no reason', () => {
    expect(
      stepDetailNotes({
        detail: { jobs: [] },
        source: RunDetailSource.enum['platform-db'],
        fallbackReason: null,
      }),
    ).toEqual([
      'step detail unavailable: the Platform could not read it from the orchestrator that ran this run (the Platform did not name a reason)',
    ]);
  });

  it('notes a finished job that ran on an agent but reports no steps', () => {
    const notes = stepDetailNotes({
      detail: { jobs: [job()] },
      source: RunDetailSource.enum['orchestrator-proxy'],
      fallbackReason: null,
    });
    expect(notes).toEqual([
      'no step detail for job build: it ran on an agent, but the orchestrator reported no steps',
    ]);
  });

  it('prints nothing for a job that is still running, never started, or runs no steps on an agent', () => {
    // breaks-if-wrong: a healthy run with a just-started job, a queued job or a
    // gate job must print no note
    const notes = stepDetailNotes({
      detail: {
        jobs: [
          job({ status: ExecutionJobStatus.enum.running }),
          job({ startedAt: null }),
          job({ jobKind: JobKind.enum.gate }),
          job({
            steps: [
              {
                stepIndex: 0,
                stepName: 's',
                status: 'success',
                startedAt: 1,
                completedAt: 2,
                durationMs: 1,
                exitCode: 0,
                errorMessage: null,
              },
            ],
          }),
        ],
      } as never,
      source: RunDetailSource.enum['orchestrator-proxy'],
      fallbackReason: null,
    });
    expect(notes).toEqual([]);
  });
});
