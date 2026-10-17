import { describe, it, expect } from 'vitest';
import { push, pr, tag, comment, release, schedule } from '@kici-dev/sdk';
import { buildFixtureEvent, currentBranchFallback, fixtureEventKind } from './event.js';

const HEAD = { branch: 'ci/kici', sha: '0123456789abcdef0123456789abcdef01234567' };

describe('buildFixtureEvent', () => {
  it('defaults a push to the current branch and HEAD SHA, not the filter branches', () => {
    const event = buildFixtureEvent({ event: push({ branches: ['main'] }) }, HEAD);
    // fails-when: the event ref comes from a hardcoded 'main' or from push({ branches }) (#470)
    expect(event.targetBranch).toBe('ci/kici');
    expect(event.payload.ref).toBe('refs/heads/ci/kici');
    // fails-when: the HEAD SHA is not carried, so the run records no commit
    expect(event.payload.after).toBe(HEAD.sha);
    expect(event.type).toBe('push');
  });

  it('lets an explicit fixture branch and sha win over the repository', () => {
    const event = buildFixtureEvent({ event: push(), branch: 'release/1', sha: 'feedface' }, HEAD);
    // breaks-if-wrong: a fixture that pins its branch must keep it on any checkout
    expect(event.targetBranch).toBe('release/1');
    expect(event.payload.ref).toBe('refs/heads/release/1');
    expect(event.payload.after).toBe('feedface');
  });

  it("falls back to 'main' on a detached HEAD", () => {
    const event = buildFixtureEvent({ event: push() }, { sha: HEAD.sha });
    expect(event.payload.ref).toBe('refs/heads/main');
    expect(event.payload.after).toBe(HEAD.sha);
  });

  it('simulates a pr() fixture as a pull_request with the current branch as head', () => {
    const event = buildFixtureEvent(
      { event: pr({ target: 'main', events: ['synchronize'] }), pr: 7 },
      HEAD,
    );
    // fails-when: the trigger tag is ignored and every fixture is sent as a push
    expect(event.type).toBe('pull_request');
    expect(event.action).toBe('synchronize');
    expect(event.targetBranch).toBe('main');
    expect(event.sourceBranch).toBe('ci/kici');
    expect(event.payload).toMatchObject({
      number: 7,
      pull_request: { number: 7, head: { ref: 'ci/kici', sha: HEAD.sha }, base: { ref: 'main' } },
    });
  });

  it('uses the fixture branch as the PR base', () => {
    const event = buildFixtureEvent({ event: pr(), branch: 'develop' }, HEAD);
    expect(event.action).toBe('opened');
    expect(event.targetBranch).toBe('develop');
    expect(event.sourceBranch).toBe('ci/kici');
  });

  it('simulates a tag() fixture as a tag push, never on the current branch', () => {
    const event = buildFixtureEvent({ event: tag({ patterns: ['v*'] }), branch: 'v1.2.3' }, HEAD);
    expect(event.type).toBe('tag');
    expect(event.payload.ref).toBe('refs/tags/v1.2.3');
    expect(event.targetBranch).toBe('v1.2.3');
  });
});

describe('fixtureEventKind', () => {
  it('maps SDK trigger tags to engine event types', () => {
    expect(fixtureEventKind(push())).toEqual({ type: 'push' });
    expect(fixtureEventKind(pr())).toEqual({ type: 'pull_request', action: 'opened' });
    expect(fixtureEventKind(comment({ actions: ['edited'] }))).toEqual({
      type: 'comment',
      action: 'edited',
    });
    expect(fixtureEventKind(release({ actions: ['created'] }))).toEqual({
      type: 'release',
      action: 'created',
    });
    expect(fixtureEventKind(schedule({ cron: '0 0 * * *' })).type).toBe('schedule');
    // breaks-if-wrong: an unrecognized event still simulates a push, as before
    expect(fixtureEventKind({ _tag: 'NotATrigger' })).toEqual({ type: 'push' });
  });
});

describe('currentBranchFallback', () => {
  it('names the fallback only for fixtures that default to the current branch', () => {
    expect(currentBranchFallback({ event: push() })).toBe('main');
    expect(currentBranchFallback({ event: push(), branch: 'x' })).toBeUndefined();
    expect(currentBranchFallback({ event: pr() })).toBe('feature/test');
    expect(currentBranchFallback({ event: tag() })).toBeUndefined();
  });
});
