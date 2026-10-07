import { describe, expect, it } from 'vitest';
import { runSummaryFields, type RunSummarySource } from './run-summary-fields.js';

const run: RunSummarySource & { localWorkingTree?: boolean } = {
  workflowName: 'ci',
  statusEpoch: 2,
  provider: 'github',
  repoIdentifier: 'acme/app',
  workflowRepoIdentifier: 'acme/workflows',
  sha: 'abc123',
  installationId: 42,
  requestId: 'req-1',
  routingKey: 'rk-1',
  ref: 'main',
  triggerEvent: 'push',
  commitMessage: 'fix: thing',
  parentRunId: 'run-parent',
  originalRunId: 'run-original',
  triggeredBy: 'user-1',
  triggeredByAgentLabel: 'agent-label',
  triggerActorUsername: 'octocat',
  triggerActorUserId: '1001',
  localWorkingTree: true,
};

describe('runSummaryFields', () => {
  // fails-when: a field is dropped from, or added to, the shared context
  // (toStrictEqual, so an added key whose value is undefined still fails)
  it('copies exactly the summary fields of a run', () => {
    const { localWorkingTree: _omitted, ...expected } = run;
    expect(runSummaryFields(run)).toStrictEqual(expected);
  });

  // fails-when: localWorkingTree is forwarded from every status transition
  it('leaves localWorkingTree to the caller', () => {
    expect(runSummaryFields(run)).not.toHaveProperty('localWorkingTree');
  });

  // fails-when: an unset workflowRepoIdentifier or a zero statusEpoch is emitted as a key
  it('omits an unset workflowRepoIdentifier and a zero statusEpoch', () => {
    const s = runSummaryFields({ ...run, workflowRepoIdentifier: undefined, statusEpoch: 0 });
    expect(s).not.toHaveProperty('workflowRepoIdentifier');
    expect(s).not.toHaveProperty('statusEpoch');
    expect(s).toMatchObject({ workflowName: 'ci', sha: 'abc123', triggerActorUserId: '1001' });
  });
});
