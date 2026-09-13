/**
 * Tests for the orchestrator's ID-token claim set.
 *
 * The property under test is the one a cloud trust policy depends on: a fork
 * pull request and a trusted push to the same base branch must not mint the
 * same identity. Before the `sub` split they did, byte for byte, and no other
 * claim carried enough shape to pin instead.
 */
import { describe, expect, it } from 'vitest';
import { buildIdTokenClaims, type JobClaimSource, type RunClaimSource } from './id-token-claims.js';

const BASE: RunClaimSource = {
  run_id: 'run-1',
  org_id: 'org-1',
  repo_identifier: 'acme/app',
  ref: 'main',
  sha: 'deadbeef',
  workflow_name: 'deploy',
  provider: 'github',
  local_working_tree: false,
};

const JOB: JobClaimSource = {
  run_id: 'run-1',
  job_id: 'job-1',
  orchestrator_id: 'orch-9',
  status: 'running',
};

const OPTS = {
  issuer: 'https://orch.example',
  audience: 'sts.amazonaws.com',
  nowSeconds: 1_000,
  ttlSeconds: 600,
};

/** A trusted push to `main` in the base repository. */
const push: RunClaimSource = {
  ...BASE,
  trigger_event: 'push',
  head_ref: null,
  head_repository: null,
  is_fork: false,
  trust_tier: 'trusted',
  trigger_actor_username: 'maintainer',
};

/**
 * A fork pull request targeting `main`, running the same workflow. Note `ref`
 * is `main` on BOTH — the run row records the branch a run PRESENTS, which for
 * a pull request is the base branch.
 */
const forkPr: RunClaimSource = {
  ...BASE,
  trigger_event: 'pull_request:opened',
  head_ref: 'patch-1',
  head_repository: 'attacker/app',
  is_fork: true,
  trust_tier: 'unknown',
  trigger_actor_username: 'drive-by',
};

describe('buildIdTokenClaims — subject', () => {
  it('gives a fork pull request a different sub from a push to the same base branch', () => {
    const pushSub = buildIdTokenClaims(push, JOB, OPTS).sub;
    const prSub = buildIdTokenClaims(forkPr, JOB, OPTS).sub;

    // Positive control: the two runs agree on every field the OLD subject was
    // built from, so a subject derived from those alone is necessarily equal.
    expect(forkPr.repo_identifier).toBe(push.repo_identifier);
    expect(forkPr.ref).toBe(push.ref);
    expect(forkPr.workflow_name).toBe(push.workflow_name);

    expect(pushSub).not.toBe(prSub);
  });

  it('leaves the push subject byte-identical to the pre-split form', () => {
    expect(buildIdTokenClaims(push, JOB, OPTS).sub).toBe('repo:acme/app:ref:main:workflow:deploy');
  });

  it("uses GitHub's ref-less pull_request shape for every PR-family event", () => {
    for (const triggerEvent of ['pull_request:opened', 'review:submitted', 'review_comment']) {
      expect(buildIdTokenClaims({ ...forkPr, trigger_event: triggerEvent }, JOB, OPTS).sub).toBe(
        'repo:acme/app:pull_request',
      );
    }
  });

  it('keeps the branch subject for every non-PR event', () => {
    for (const triggerEvent of ['push', 'tag', 'schedule', 'workflow_run', undefined]) {
      expect(buildIdTokenClaims({ ...push, trigger_event: triggerEvent }, JOB, OPTS).sub).toBe(
        'repo:acme/app:ref:main:workflow:deploy',
      );
    }
  });

  /**
   * A re-run records `trigger_event: 'rerun'`, which is not pull-request
   * family. Without the inherited event, re-running the fork pull request
   * above mints the identity the trusted push mints — the collision the
   * subject split exists to break, re-opened one re-run later.
   */
  const rerunOfForkPr: RunClaimSource = {
    ...forkPr,
    trigger_event: 'rerun',
    subject_trigger_event: 'pull_request:opened',
  };

  const rerunOfPush: RunClaimSource = {
    ...push,
    trigger_event: 'rerun',
    subject_trigger_event: 'push',
  };

  it('gives a re-run of a fork pull request the pull-request subject', () => {
    expect(buildIdTokenClaims(rerunOfForkPr, JOB, OPTS).sub).toBe('repo:acme/app:pull_request');
  });

  it('gives a re-run of a fork pull request a different sub from a re-run of a push', () => {
    // Positive control: the two rows agree on every field the branch-shaped
    // subject is built from, including `trigger_event` itself.
    expect(rerunOfForkPr.trigger_event).toBe(rerunOfPush.trigger_event);
    expect(rerunOfForkPr.ref).toBe(rerunOfPush.ref);
    expect(rerunOfForkPr.workflow_name).toBe(rerunOfPush.workflow_name);

    expect(buildIdTokenClaims(rerunOfForkPr, JOB, OPTS).sub).not.toBe(
      buildIdTokenClaims(rerunOfPush, JOB, OPTS).sub,
    );
    expect(buildIdTokenClaims(rerunOfPush, JOB, OPTS).sub).toBe(
      'repo:acme/app:ref:main:workflow:deploy',
    );
  });

  it('keeps the branch subject for a legacy re-run row that inherited nothing', () => {
    // Every row written before the column existed. NULL means "use
    // `trigger_event`", so the subject it mints today does not move.
    expect(
      buildIdTokenClaims(
        { ...forkPr, trigger_event: 'rerun', subject_trigger_event: null },
        JOB,
        OPTS,
      ).sub,
    ).toBe('repo:acme/app:ref:main:workflow:deploy');
  });

  it('reports event_name as rerun while the subject says pull_request', () => {
    const claims = buildIdTokenClaims(rerunOfForkPr, JOB, OPTS);
    expect(claims.event_name).toBe('rerun');
    expect(claims.sub).toBe('repo:acme/app:pull_request');
  });

  it('restores the colliding subject under the legacy escape hatch', () => {
    const legacy = { ...OPTS, legacyPullRequestSubject: true };
    expect(buildIdTokenClaims(forkPr, JOB, legacy).sub).toBe(
      buildIdTokenClaims(push, JOB, legacy).sub,
    );
    expect(buildIdTokenClaims(forkPr, JOB, legacy).sub).toBe(
      'repo:acme/app:ref:main:workflow:deploy',
    );
  });
});

describe('buildIdTokenClaims — event-context claims', () => {
  it('carries the fork context a trust policy needs', () => {
    const claims = buildIdTokenClaims(forkPr, JOB, OPTS);
    expect(claims.event_name).toBe('pull_request:opened');
    expect(claims.base_ref).toBe('main');
    expect(claims.head_ref).toBe('patch-1');
    expect(claims.head_repository).toBe('attacker/app');
    expect(claims.is_fork).toBe('true');
    expect(claims.trust_tier).toBe('unknown');
    expect(claims.actor).toBe('drive-by');
  });

  it('marks an unknown-tier mint rather than refusing it', () => {
    // Degrade, not refuse: the customer's IAM policy makes the call, and an
    // honest attestation of an untrusted build is still worth recording.
    const claims = buildIdTokenClaims({ ...forkPr, trust_tier: 'unknown' }, JOB, OPTS);
    expect(claims.trust_tier).toBe('unknown');
    expect(claims.sub).toBe('repo:acme/app:pull_request');
  });

  it('renders every unresolved column as a fail-closed sentinel, never a plausible default', () => {
    const unresolved = buildIdTokenClaims(BASE, JOB, OPTS);
    expect(unresolved.event_name).toBe('unknown');
    expect(unresolved.head_ref).toBe('');
    expect(unresolved.is_fork).toBe('unresolved');
    expect(unresolved.trust_tier).toBe('unresolved');
    expect(unresolved.actor).toBe('');

    // The two that would fail OPEN if they guessed.
    expect(unresolved.head_repository).toBe('');
    expect(unresolved.head_repository).not.toBe(BASE.repo_identifier);
    expect(unresolved.is_fork).not.toBe('false');
  });

  it('emits every event claim as a present string, so a StringEquals never silently drops', () => {
    for (const source of [push, forkPr, BASE]) {
      const claims = buildIdTokenClaims(source, JOB, OPTS) as unknown as Record<string, unknown>;
      for (const key of [
        'event_name',
        'base_ref',
        'head_ref',
        'head_repository',
        'is_fork',
        'trust_tier',
        'actor',
      ]) {
        expect(typeof claims[key], `${key} on ${source.trigger_event}`).toBe('string');
      }
    }
  });

  it('mirrors ref into base_ref so a policy can pin either name', () => {
    expect(buildIdTokenClaims(forkPr, JOB, OPTS).base_ref).toBe(forkPr.ref);
    expect(buildIdTokenClaims(push, JOB, OPTS).base_ref).toBe(push.ref);
  });
});
