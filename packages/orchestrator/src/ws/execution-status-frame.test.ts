import { describe, expect, it } from 'vitest';
import { ExecutionRunStatus, STATUS_FREE_TEXT_MAX, executionStatusSchema } from '@kici-dev/engine';
import type { ExecutionContext } from '../reporting/execution-tracker.js';
import { buildExecutionStatusFrame } from './execution-status-frame.js';

const SOURCE_REPO = 'owner/source-repo';
const WORKFLOW_REPO = 'owner/org-workflows';

function context(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    workflowName: 'ci',
    provider: 'github',
    repoIdentifier: SOURCE_REPO,
    sha: 'abc123',
    routingKey: 'github:1',
    ...overrides,
  };
}

function frame(ctx: ExecutionContext) {
  return buildExecutionStatusFrame({
    messageId: 'msg-1',
    runId: 'run-1',
    status: ExecutionRunStatus.enum.running,
    context: ctx,
    jobCount: 2,
    startedAt: 1_700_000_000_000,
    timestamp: 1_700_000_060_000,
  });
}

describe('buildExecutionStatusFrame', () => {
  it('carries the workflow repo when the context has one', () => {
    const built = frame(context({ workflowRepoIdentifier: WORKFLOW_REPO }));
    expect(built.workflowRepoIdentifier).toBe(WORKFLOW_REPO);
    // The source repo is untouched — a global run belongs to both.
    expect(built.repoIdentifier).toBe(SOURCE_REPO);
  });

  it('omits the workflow repo entirely when the context has none', () => {
    // Not "sends undefined" — the key must be absent, so a Platform-side
    // `!== undefined` guard reads it as "no value supplied" and leaves any
    // recorded value alone.
    const built = frame(context());
    expect('workflowRepoIdentifier' in built).toBe(false);
  });

  it('never substitutes the source repo for a missing workflow repo', () => {
    // The failure this guards is the one that would destroy the marker: echoing
    // `repoIdentifier` here makes every per-repository run look cross-repository.
    const built = frame(context());
    expect(built.workflowRepoIdentifier).toBeUndefined();
    expect(built.repoIdentifier).toBe(SOURCE_REPO);
  });

  it('marks an evaluation round so the Platform can admit its re-run', () => {
    const built = frame(context({ isGlobalEvalRound: true }));
    expect(built.isGlobalEvalRound).toBe(true);
  });

  it('omits the round marker entirely for an ordinary run', () => {
    // Same absent-means-absent contract as the workflow repo: the Platform
    // upsert leaves a recorded value alone when the key is missing.
    const built = frame(context());
    expect('isGlobalEvalRound' in built).toBe(false);
  });

  it('keeps every other optional field conditional on the context', () => {
    // A minimal context must not manufacture keys; the same absent-means-absent
    // contract the workflow repo relies on holds for its neighbours.
    const built = frame(context({ routingKey: undefined, provider: '' }));
    for (const key of ['routingKey', 'repoProvider', 'ref', 'triggerEvent', 'commitMessage']) {
      expect(key in built).toBe(false);
    }
    expect(built.workflowName).toBe('ci');
    expect(built.status).toBe(ExecutionRunStatus.enum.running);
    expect(built.jobCount).toBe(2);
  });
});

describe('buildExecutionStatusFrame statusEpoch', () => {
  it('carries the run status generation from the context', () => {
    expect(frame(context({ statusEpoch: 2 })).statusEpoch).toBe(2);
  });

  it('always sends statusEpoch, as 0 when the context has none', () => {
    // fails-when: the field is omitted at 0 — the Platform reads the frame as an
    // older orchestrator's and applies it unguarded, so a late frame reopens a
    // finished run.
    const built = frame(context());
    expect('statusEpoch' in built).toBe(true);
    expect(built.statusEpoch).toBe(0);
  });
});

describe('buildExecutionStatusFrame free text', () => {
  it('clamps a long failure reason, commit message and init-failure message', () => {
    const built = buildExecutionStatusFrame({
      messageId: 'msg-1',
      runId: 'run-1',
      status: ExecutionRunStatus.enum.failed,
      context: context({ commitMessage: 'c'.repeat(5_000) }),
      jobCount: 1,
      startedAt: 1,
      timestamp: 2,
      failureReason: `Failed jobs: ${'job-x, '.repeat(800)}`,
      initFailure: { scope: 'run', category: 'secret_resolution', message: 'm'.repeat(5_000) },
    });
    // fails-when: a long matrix's "Failed jobs: …" reason leaves the orchestrator unbounded
    expect(built.failureReason).toHaveLength(STATUS_FREE_TEXT_MAX);
    expect(built.commitMessage).toHaveLength(STATUS_FREE_TEXT_MAX);
    expect(built.initFailure!.message).toHaveLength(STATUS_FREE_TEXT_MAX);
    expect(executionStatusSchema.parse(built)).toEqual(built);
  });
});
