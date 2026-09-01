/**
 * Phase G (workflow-modification detection) unit tests for
 * `applyWorkflowModificationsAndSecurityHold`.
 *
 * Guards the two behavioral contracts of the phase: the neutral "workflow
 * changes" check is posted on its OWN dedicated poster method, and the phase
 * posts no pending "Held for approval" check (that belongs to the dispatch
 * gate, which creates a real resolvable hold).
 *
 * Detection and legibility only: it reports whether workflow files changed, and
 * that report feeds no dispatch decision — the org trust policy is the fork
 * switch, evaluated from the fork signal and the tier alone
 * (`trust-policy-gate.test.ts`).
 */
import { describe, it, expect, vi } from 'vitest';
import type { LockFile, LockWorkflow } from '@kici-dev/engine';
import { applyWorkflowModificationsAndSecurityHold } from './process-webhook.js';

function makeWorkflow(name: string): LockWorkflow {
  return {
    name,
    contentHash: 'abc123',
    compileSchemaVersion: 1,
    triggers: [{ _type: 'push', branches: [{ type: 'glob', pattern: 'main' }], paths: [] }],
    jobs: [
      {
        _type: 'static',
        name: 'build',
        runsOn: 'default',
        needs: [],
        steps: [{ name: 'install', hasOutputs: false }],
      },
    ],
  } as unknown as LockWorkflow;
}

function makeLockFile(workflows: LockWorkflow[]): LockFile {
  return {
    schemaVersion: 9,
    source: { file: '.kici/workflows/ci.ts', export: '#default' },
    contentHash: 'deadbeef',
    workflows,
  } as unknown as LockFile;
}

function callHelper(
  postCheckStatus: ReturnType<typeof vi.fn>,
  postWorkflowModificationCheck: ReturnType<typeof vi.fn>,
  tier: 'unknown' | 'known' | 'trusted',
  opts: { identical?: boolean } = {},
) {
  const bundle = {
    normalizer: { provider: 'github' },
    checkStatusPoster: { provider: 'github', postCheckStatus, postWorkflowModificationCheck },
  };
  const args = {
    info: { deliveryId: 'd1' },
    bundle,
    event: { type: 'pull_request', action: 'opened', senderUsername: 'octocat' },
    // base lock has only `ci`; head adds `deploy` → one detected modification.
    fullLockFile: makeLockFile([makeWorkflow('ci')]),
    headLockFileForDiff: opts.identical
      ? makeLockFile([makeWorkflow('ci')])
      : makeLockFile([makeWorkflow('ci'), makeWorkflow('deploy')]),
    isPREvent: true,
    lockFileSource: 'base' as const,
    trustResolution: { tier, contributorUsername: 'octocat' },
    repoIdentifier: 'owner/repo',
    ref: 'headsha',
    credentials: {},
  };
  return applyWorkflowModificationsAndSecurityHold(
    args as unknown as Parameters<typeof applyWorkflowModificationsAndSecurityHold>[0],
  );
}

describe('applyWorkflowModificationsAndSecurityHold (phase G)', () => {
  it('posts the neutral check on its dedicated method and NO pending hold check', () => {
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const postWorkflowModificationCheck = vi.fn().mockResolvedValue(undefined);

    const state = callHelper(postCheckStatus, postWorkflowModificationCheck, 'unknown');

    // Neutral informational check posted via the dedicated method (own check name).
    expect(postWorkflowModificationCheck).toHaveBeenCalledTimes(1);
    // Phase G no longer posts the pending "Held for approval" check — the dispatch
    // gate does, alongside the real held_runs row.
    expect(postCheckStatus.mock.calls.some((c) => c[3] === 'Held for approval')).toBe(false);
    // Phase G reports the signal; the trust-policy gate decides the outcome.
    expect(state.hasWorkflowModifications).toBe(true);
    expect(state.workflowModifications).toHaveLength(1);
  });

  it('reports the signal regardless of tier — the decision is not made here', () => {
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    const postWorkflowModificationCheck = vi.fn().mockResolvedValue(undefined);

    const state = callHelper(postCheckStatus, postWorkflowModificationCheck, 'trusted');

    // The neutral check is still informational for a trusted author...
    expect(postWorkflowModificationCheck).toHaveBeenCalledTimes(1);
    // ...and the signal is still reported. Whether a trusted author is gated is
    // the evaluator's call (see trust-policy-gate.test.ts), not phase G's.
    expect(state.hasWorkflowModifications).toBe(true);
    expect(state).not.toHaveProperty('workflowModificationHold');
  });

  it('reports no modifications when base and head lock files match', () => {
    const state = callHelper(
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue(undefined),
      'unknown',
      { identical: true },
    );
    expect(state.hasWorkflowModifications).toBe(false);
    expect(state.workflowModifications).toHaveLength(0);
  });
});
