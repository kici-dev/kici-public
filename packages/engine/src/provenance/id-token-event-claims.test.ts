/**
 * Tests for the shared subject + event-claim derivation.
 *
 * The property under test is the one a cloud trust policy depends on: a
 * pull-request run and a trusted push to the same base branch must not mint
 * the same subject — and re-running that pull request must not undo the split.
 * A re-run records `trigger_event: 'rerun'`, so the subject is derived from
 * `subject_trigger_event ?? trigger_event`.
 *
 * The matrix below is deliberately two-sided. Asserting only the new behaviour
 * would pass with the fallback broken, which is the case every row written
 * before the column existed takes.
 */
import { describe, expect, it } from 'vitest';
import {
  buildEventClaims,
  buildIdTokenSubject,
  type EventClaimSource,
} from './id-token-event-claims.js';

const BASE: EventClaimSource = {
  repo_identifier: 'acme/app',
  ref: 'main',
  workflow_name: 'deploy',
};

const BRANCH_SUBJECT = 'repo:acme/app:ref:main:workflow:deploy';
const PR_SUBJECT = 'repo:acme/app:pull_request';

describe('buildIdTokenSubject — subject_trigger_event', () => {
  const cases: ReadonlyArray<
    readonly [label: string, run: Partial<EventClaimSource>, expected: string]
  > = [
    [
      'a first-run pull request keeps the pull-request shape',
      { trigger_event: 'pull_request:opened' },
      PR_SUBJECT,
    ],
    [
      'a re-run of a pull request presents the pull-request shape',
      { trigger_event: 'rerun', subject_trigger_event: 'pull_request:opened' },
      PR_SUBJECT,
    ],
    [
      'a legacy re-run row, with no inherited event, keeps the branch shape',
      { trigger_event: 'rerun', subject_trigger_event: null },
      BRANCH_SUBJECT,
    ],
    [
      'a re-run of a push keeps the branch shape',
      { trigger_event: 'rerun', subject_trigger_event: 'push' },
      BRANCH_SUBJECT,
    ],
    [
      'the inherited event is authoritative when set',
      { trigger_event: 'push', subject_trigger_event: 'pull_request:opened' },
      PR_SUBJECT,
    ],
    ['a plain push keeps the branch shape', { trigger_event: 'push' }, BRANCH_SUBJECT],
  ];

  it.each(cases)('%s', (_label, run, expected) => {
    expect(buildIdTokenSubject({ ...BASE, ...run })).toBe(expected);
  });

  it('has no legacy pull-request subject escape hatch', () => {
    // fails-when: the removed `legacyPullRequestSubject` option is accepted
    // again and restores the colliding branch-shaped subject for a PR.
    const run = { ...BASE, trigger_event: 'pull_request:opened' };
    expect(
      // @ts-expect-error — the option no longer exists.
      buildIdTokenSubject(run, { legacyPullRequestSubject: true }),
    ).toBe(PR_SUBJECT);
  });

  it('gives a re-run of a pull request a different subject from a re-run of a push', () => {
    const rerunOfPr = {
      ...BASE,
      trigger_event: 'rerun',
      subject_trigger_event: 'pull_request:opened',
    };
    const rerunOfPush = { ...BASE, trigger_event: 'rerun', subject_trigger_event: 'push' };

    // Positive control: the two rows agree on every field the branch-shaped
    // subject is built from, so a subject derived from those alone is
    // necessarily equal — which is exactly the collision under test.
    expect(rerunOfPr.repo_identifier).toBe(rerunOfPush.repo_identifier);
    expect(rerunOfPr.ref).toBe(rerunOfPush.ref);
    expect(rerunOfPr.workflow_name).toBe(rerunOfPush.workflow_name);
    expect(rerunOfPr.trigger_event).toBe(rerunOfPush.trigger_event);

    expect(buildIdTokenSubject(rerunOfPr)).not.toBe(buildIdTokenSubject(rerunOfPush));
  });

  it('covers every pull-request-family event through the inherited column', () => {
    for (const event of ['pull_request:opened', 'review:submitted', 'review_comment']) {
      expect(
        buildIdTokenSubject({ ...BASE, trigger_event: 'rerun', subject_trigger_event: event }),
      ).toBe(PR_SUBJECT);
    }
  });
});

describe('buildEventClaims — the inherited event does not leak', () => {
  it('reports event_name as rerun even when the subject is derived from a pull request', () => {
    const claims = buildEventClaims({
      ...BASE,
      trigger_event: 'rerun',
      subject_trigger_event: 'pull_request:opened',
    });
    expect(claims.event_name).toBe('rerun');
    // The claim and the subject deliberately disagree: `event_name` says what
    // started THIS run, the subject says which identity it presents.
    expect(
      buildIdTokenSubject({
        ...BASE,
        trigger_event: 'rerun',
        subject_trigger_event: 'pull_request:opened',
      }),
    ).toBe(PR_SUBJECT);
  });
});
