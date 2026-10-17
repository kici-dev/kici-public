/**
 * The event `kici run remote <fixture>` sends. A fixture's trigger filters never
 * set the event branch: it is the fixture's `branch`, else the checked-out one.
 */

import type { FixtureOptions } from '@kici-dev/sdk';
import { eventLabelForTag } from './describe-event.js';

/** The checked-out branch (none on a detached `HEAD`) and the `HEAD` commit. */
export interface GitHead {
  branch?: string;
  sha?: string;
}

/** A `SimulatedEvent`-compatible event, as the test trigger route takes it. */
export interface FixtureEvent {
  type: string;
  action?: string;
  targetBranch: string;
  sourceBranch?: string;
  payload: Record<string, unknown>;
}

/** The branch when neither the fixture nor a detached `HEAD` names one, as in `kici init`. */
export const FALLBACK_BRANCH = 'main';

const FALLBACK_PR_SOURCE_BRANCH = 'feature/test';

const FALLBACK_TAG = 'v0.0.0';

const PR_EVENT_FAMILY = new Set(['pull_request', 'review', 'review_comment']);

/** The engine event type and action a trigger config simulates; an unknown tag is a push. */
export function fixtureEventKind(event: unknown): { type: string; action?: string } {
  const e = (event ?? {}) as Record<string, unknown>;
  const label = eventLabelForTag(e._tag) ?? 'push';
  const type = label === 'pr' ? 'pull_request' : label;
  const actions = e._tag === 'PrTrigger' ? e.events : e.actions;
  const first = Array.isArray(actions) && actions.length > 0 ? String(actions[0]) : undefined;
  // `pr()` with no events defaults to every PR event; `opened` is the first.
  const action = type === 'pull_request' ? (first ?? 'opened') : first;
  return { type, ...(action !== undefined && { action }) };
}

/** The branch a fixture uses on a detached `HEAD`, or undefined when it does not follow the checkout. */
export function currentBranchFallback(opts: FixtureOptions): string | undefined {
  const { type } = fixtureEventKind(opts.event);
  if (PR_EVENT_FAMILY.has(type)) return FALLBACK_PR_SOURCE_BRANCH;
  if (type === 'tag' || opts.branch !== undefined) return undefined;
  return FALLBACK_BRANCH;
}

/** Build the event a fixture simulates, defaulting its branch and SHA to `head`. */
export function buildFixtureEvent(opts: FixtureOptions, head: GitHead): FixtureEvent {
  const { type, action } = fixtureEventKind(opts.event);
  const sha = opts.sha ?? head.sha;
  const repository = { full_name: opts.repo ?? 'owner/repo' };

  if (PR_EVENT_FAMILY.has(type)) {
    // `branch` is the base, as with `kici preview --branch`; the checkout is the head.
    const targetBranch = opts.branch ?? FALLBACK_BRANCH;
    const sourceBranch = head.branch ?? FALLBACK_PR_SOURCE_BRANCH;
    return {
      type,
      ...(action !== undefined && { action }),
      targetBranch,
      sourceBranch,
      payload: {
        ...(action !== undefined && { action }),
        ...(opts.pr !== undefined && { number: opts.pr }),
        pull_request: {
          ...(opts.pr !== undefined && { number: opts.pr }),
          head: { ref: sourceBranch, ...(sha && { sha }) },
          base: { ref: targetBranch },
        },
        repository,
      },
    };
  }

  if (type === 'tag') {
    const tagName = opts.branch ?? FALLBACK_TAG;
    return {
      type,
      ...(action !== undefined && { action }),
      targetBranch: tagName,
      payload: { ref: `refs/tags/${tagName}`, repository, ...(sha && { after: sha }) },
    };
  }

  const targetBranch = opts.branch ?? head.branch ?? FALLBACK_BRANCH;
  return {
    type,
    ...(action !== undefined && { action }),
    targetBranch,
    payload: {
      ref: `refs/heads/${targetBranch}`,
      repository,
      ...(sha && { after: sha }),
      ...(opts.pr !== undefined && { number: opts.pr }),
    },
  };
}
