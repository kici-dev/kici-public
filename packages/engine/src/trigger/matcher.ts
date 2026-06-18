/**
 * Trigger matching engine for evaluating workflow triggers against webhook events.
 * Single source of truth -- replaces duplicate logic in compiler and orchestrator.
 */
import picomatch from 'picomatch';
import type {
  LockTrigger,
  LockPrTrigger,
  LockPushTrigger,
  LockTagTrigger,
  LockCommentTrigger,
  LockReviewTrigger,
  LockReviewCommentTrigger,
  LockReleaseTrigger,
  LockDispatchTrigger,
  LockCreateTrigger,
  LockDeleteTrigger,
  LockStatusTrigger,
  LockWorkflowRunTrigger,
  LockForkTrigger,
  LockStarTrigger,
  LockWatchTrigger,
  LockWebhookTrigger,
  LockKiciEventTrigger,
  LockWorkflowCompleteTrigger,
  LockJobCompleteTrigger,
  LockGenericWebhookTrigger,
  LockScheduleTrigger,
  LockLifecycleTrigger,
  LockWorkflow,
  LockBranchPattern,
  SimulatedEvent,
} from './types.js';
import {
  createTraceEntry,
  createWorkflowDecision,
  type TraceEntry,
  type WorkflowDecision,
} from './decision-trace.js';
import { matchJsonPath, matchJsonPathNot } from './jsonpath-matcher.js';

/**
 * Split a list of string patterns into include/exclude based on ! prefix.
 */
interface SplitPatterns<T> {
  include: T[];
  exclude: T[];
}

function splitStringPatterns(patterns: readonly string[]): SplitPatterns<string> {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const p of patterns) {
    if (p.startsWith('!')) {
      exclude.push(p.slice(1));
    } else {
      include.push(p);
    }
  }
  return { include, exclude };
}

function splitBranchPatterns(
  patterns: readonly LockBranchPattern[],
): SplitPatterns<LockBranchPattern> {
  const include: LockBranchPattern[] = [];
  const exclude: LockBranchPattern[] = [];
  for (const p of patterns) {
    if (p.pattern.startsWith('!')) {
      exclude.push({ ...p, pattern: p.pattern.slice(1) });
    } else {
      include.push(p);
    }
  }
  return { include, exclude };
}

/**
 * Match a branch pattern against a branch name.
 */
export function matchBranchPattern(pattern: LockBranchPattern, branch: string): boolean {
  if (pattern.type === 'glob') {
    return picomatch.isMatch(branch, pattern.pattern);
  } else {
    const regex = new RegExp(pattern.pattern, pattern.flags);
    return regex.test(branch);
  }
}

/**
 * Match any of the branch patterns.
 * Returns true if patterns array is empty (no filter = match all).
 */
function matchAnyBranch(patterns: readonly LockBranchPattern[], branch: string): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((p) => matchBranchPattern(p, branch));
}

/**
 * Match path patterns against changed files.
 * Patterns prefixed with ! are exclusions. Remaining patterns are inclusions.
 * An all-negation array has implicit match-all semantics for non-excluded files.
 */
export function matchPathPatterns(paths: readonly string[], changedFiles: string[]): boolean {
  // No path filters = match
  if (paths.length === 0) return true;

  // If no changed files provided, can't filter by path
  if (changedFiles.length === 0) return false;

  const { include, exclude } = splitStringPatterns(paths);

  // Filter out files matching exclusion patterns first
  let relevantFiles = changedFiles;
  if (exclude.length > 0) {
    relevantFiles = changedFiles.filter(
      (file) => !exclude.some((pattern) => picomatch.isMatch(file, pattern)),
    );
    // If all files are excluded, no match
    if (relevantFiles.length === 0) return false;
  }

  // If no include patterns (all-negation array), remaining files match implicitly
  if (include.length === 0) return true;

  // Check include patterns against remaining files
  return relevantFiles.some((file) => include.some((pattern) => picomatch.isMatch(file, pattern)));
}

/**
 * Match repo patterns against a source repository identifier.
 * Patterns with ! prefix in the pattern string are exclusions.
 * An all-negation array has implicit match-all semantics for non-excluded repos.
 * Empty array = no filtering (matches all repos).
 */
export function matchRepoPatterns(
  repos: readonly LockBranchPattern[],
  sourceRepo: string,
): boolean {
  if (repos.length === 0) return true;

  const { include, exclude } = splitBranchPatterns(repos);

  // Check exclusions first
  if (exclude.length > 0) {
    if (exclude.some((p) => matchBranchPattern(p, sourceRepo))) return false;
  }

  // If no include patterns (all-negation array), non-excluded repo matches implicitly
  if (include.length === 0) return true;

  return include.some((p) => matchBranchPattern(p, sourceRepo));
}

/**
 * Evaluate repo pattern filter for a trigger against an event.
 * Returns true if matched (or no filter), false if filtered out.
 * Adds trace entries for debugging.
 */
function evaluateRepoFilter(
  trigger: { repos?: readonly LockBranchPattern[] },
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  if (trigger.repos?.length) {
    if (!event.sourceRepo) {
      traces.push(createTraceEntry('repo', 'required', '(missing)', false));
      return false;
    }
    const { include, exclude } = splitBranchPatterns(trigger.repos);
    const repoMatch = matchRepoPatterns(trigger.repos, event.sourceRepo);
    traces.push(
      createTraceEntry(
        'repo',
        `include:[${include.map((p) => p.pattern).join(',')}] exclude:[${exclude.map((p) => p.pattern).join(',')}]`,
        event.sourceRepo,
        repoMatch,
      ),
    );
    if (!repoMatch) return false;
  }
  return true;
}

/**
 * Match a PR trigger against a simulated event.
 */
function matchPrTrigger(
  trigger: LockPrTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  // Must be pull_request event
  if (event.type !== 'pull_request') {
    traces.push(createTraceEntry('event type', 'pull_request', event.type, false));
    return false;
  }
  traces.push(createTraceEntry('event type', 'pull_request', event.type, true));

  // Check action
  if (trigger.events.length > 0) {
    const action = event.action ?? '';
    const actionMatches = trigger.events.includes(action);
    traces.push(createTraceEntry('action', trigger.events.join('|'), action, actionMatches));
    if (!actionMatches) return false;
  }

  // Check target branch
  if (trigger.targetBranches.length > 0) {
    const matches = matchAnyBranch(trigger.targetBranches, event.targetBranch);
    traces.push(
      createTraceEntry(
        'target branch',
        trigger.targetBranches.map((p) => p.pattern).join('|'),
        event.targetBranch,
        matches,
      ),
    );
    if (!matches) return false;
  }

  // Check source branch
  if (trigger.sourceBranches.length > 0) {
    if (!event.sourceBranch) {
      traces.push(
        createTraceEntry(
          'source branch',
          trigger.sourceBranches.map((p) => p.pattern).join('|'),
          '(missing)',
          false,
          'Event has no sourceBranch but trigger requires source branch filtering',
        ),
      );
      return false;
    }
    const matches = matchAnyBranch(trigger.sourceBranches, event.sourceBranch);
    traces.push(
      createTraceEntry(
        'source branch',
        trigger.sourceBranches.map((p) => p.pattern).join('|'),
        event.sourceBranch,
        matches,
      ),
    );
    if (!matches) return false;
  }

  // Check paths
  if (trigger.paths.length > 0) {
    const changedFiles = event.changedFiles ?? [];
    const { include, exclude } = splitStringPatterns(trigger.paths);
    const matches = matchPathPatterns(trigger.paths, changedFiles);
    traces.push(
      createTraceEntry(
        'paths',
        `include: [${include.join(', ')}] exclude: [${exclude.join(', ')}]`,
        `[${changedFiles.join(', ')}]`,
        matches,
      ),
    );
    if (!matches) return false;
  }

  // Check repo patterns
  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/**
 * Match a push trigger against a simulated event.
 */
function matchPushTrigger(
  trigger: LockPushTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  // Must be push event
  if (event.type !== 'push') {
    traces.push(createTraceEntry('event type', 'push', event.type, false));
    return false;
  }
  traces.push(createTraceEntry('event type', 'push', event.type, true));

  // Check branch
  if (trigger.branches.length > 0) {
    const matches = matchAnyBranch(trigger.branches, event.targetBranch);
    traces.push(
      createTraceEntry(
        'branch',
        trigger.branches.map((p) => p.pattern).join('|'),
        event.targetBranch,
        matches,
      ),
    );
    if (!matches) return false;
  }

  // Check paths
  if (trigger.paths.length > 0) {
    const changedFiles = event.changedFiles ?? [];
    const { include, exclude } = splitStringPatterns(trigger.paths);
    const matches = matchPathPatterns(trigger.paths, changedFiles);
    traces.push(
      createTraceEntry(
        'paths',
        `include: [${include.join(', ')}] exclude: [${exclude.join(', ')}]`,
        `[${changedFiles.join(', ')}]`,
        matches,
      ),
    );
    if (!matches) return false;
  }

  // Check repo patterns
  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/**
 * Match a tag trigger against a simulated event.
 * Tag name is expected in event.targetBranch (normalizer sets it there).
 */
function matchTagTrigger(
  trigger: LockTagTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  if (event.type !== 'tag') {
    traces.push(createTraceEntry('event type', 'tag', event.type, false));
    return false;
  }
  traces.push(createTraceEntry('event type', 'tag', event.type, true));

  // Check tag name patterns against targetBranch (which holds the tag name)
  if (trigger.patterns.length > 0) {
    const matches = matchAnyBranch(trigger.patterns, event.targetBranch);
    traces.push(
      createTraceEntry(
        'tag pattern',
        trigger.patterns.map((p) => p.pattern).join('|'),
        event.targetBranch,
        matches,
      ),
    );
    if (!matches) return false;
  }

  // Check repo patterns
  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/**
 * Match a comment trigger against a simulated event.
 * Supports action filter, source filter (issue vs PR), and bodyMatch (glob/regex).
 */
function matchCommentTrigger(
  trigger: LockCommentTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  if (event.type !== 'comment') {
    traces.push(createTraceEntry('event type', 'comment', event.type, false));
    return false;
  }
  traces.push(createTraceEntry('event type', 'comment', event.type, true));

  // Check action filter
  if (trigger.actions.length > 0) {
    const action = event.action ?? '';
    const matches = trigger.actions.includes(action);
    traces.push(createTraceEntry('action', trigger.actions.join('|'), action, matches));
    if (!matches) return false;
  }

  // Check source filter (issue vs PR)
  if (trigger.source) {
    const issue = event.payload.issue as Record<string, unknown> | undefined;
    const hasPullRequest = issue && 'pull_request' in issue;
    const isFromPr = !!hasPullRequest;

    if (trigger.source === 'issue') {
      const matches = !isFromPr;
      traces.push(createTraceEntry('source', 'issue', isFromPr ? 'pr' : 'issue', matches));
      if (!matches) return false;
    } else {
      // source === 'pr'
      const matches = isFromPr;
      traces.push(createTraceEntry('source', 'pr', isFromPr ? 'pr' : 'issue', matches));
      if (!matches) return false;
    }
  }

  // Check bodyMatch
  if (trigger.bodyMatch) {
    const comment = event.payload.comment as Record<string, unknown> | undefined;
    const body = (comment?.body as string) ?? '';

    if (trigger.bodyMatch.type === 'glob') {
      const matches = picomatch.isMatch(body, trigger.bodyMatch.pattern);
      traces.push(createTraceEntry('bodyMatch (glob)', trigger.bodyMatch.pattern, body, matches));
      if (!matches) return false;
    } else {
      const regex = new RegExp(trigger.bodyMatch.pattern, trigger.bodyMatch.flags);
      const matches = regex.test(body);
      traces.push(createTraceEntry('bodyMatch (regex)', trigger.bodyMatch.pattern, body, matches));
      if (!matches) return false;
    }
  }

  // Check repo patterns
  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/**
 * Match a review trigger against a simulated event.
 * Supports action and review state filters.
 */
function matchReviewTrigger(
  trigger: LockReviewTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  if (event.type !== 'review') {
    traces.push(createTraceEntry('event type', 'review', event.type, false));
    return false;
  }
  traces.push(createTraceEntry('event type', 'review', event.type, true));

  // Check action filter
  if (trigger.actions.length > 0) {
    const action = event.action ?? '';
    const matches = trigger.actions.includes(action);
    traces.push(createTraceEntry('action', trigger.actions.join('|'), action, matches));
    if (!matches) return false;
  }

  // Check state filter
  if (trigger.states.length > 0) {
    const review = event.payload.review as Record<string, unknown> | undefined;
    const state = (review?.state as string) ?? '';
    const matches = trigger.states.includes(state);
    traces.push(createTraceEntry('state', trigger.states.join('|'), state, matches));
    if (!matches) return false;
  }

  // Check repo patterns
  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/**
 * Match a review comment trigger against a simulated event.
 * Supports action filter.
 */
function matchReviewCommentTrigger(
  trigger: LockReviewCommentTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  if (event.type !== 'review_comment') {
    traces.push(createTraceEntry('event type', 'review_comment', event.type, false));
    return false;
  }
  traces.push(createTraceEntry('event type', 'review_comment', event.type, true));

  // Check action filter
  if (trigger.actions.length > 0) {
    const action = event.action ?? '';
    const matches = trigger.actions.includes(action);
    traces.push(createTraceEntry('action', trigger.actions.join('|'), action, matches));
    if (!matches) return false;
  }

  // Check repo patterns
  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/**
 * Match a release trigger against a simulated event.
 * Supports action filter (published, created, etc.).
 */
function matchReleaseTrigger(
  trigger: LockReleaseTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  if (event.type !== 'release') {
    traces.push(createTraceEntry('event type', 'release', event.type, false));
    return false;
  }
  traces.push(createTraceEntry('event type', 'release', event.type, true));

  // Filter by actions if specified
  if (trigger.actions.length > 0) {
    const action = event.action ?? '';
    const matches = trigger.actions.includes(action);
    traces.push(createTraceEntry('action', trigger.actions.join('|'), action, matches));
    if (!matches) return false;
  }

  // Check repo patterns
  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/**
 * Match a dispatch trigger against a simulated event.
 * GitHub sends event_type as action for repository_dispatch.
 */
function matchDispatchTrigger(
  trigger: LockDispatchTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  if (event.type !== 'dispatch') {
    traces.push(createTraceEntry('event type', 'dispatch', event.type, false));
    return false;
  }
  traces.push(createTraceEntry('event type', 'dispatch', event.type, true));

  // Filter by types (matches against event.action)
  if (trigger.types.length > 0) {
    const action = event.action ?? '';
    const matches = trigger.types.includes(action);
    traces.push(createTraceEntry('dispatch type', trigger.types.join('|'), action, matches));
    if (!matches) return false;
  }

  // Check repo patterns
  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/**
 * Match a create trigger against a simulated event.
 * Checks refType and ref pattern against payload fields.
 */
function matchCreateTrigger(
  trigger: LockCreateTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  if (event.type !== 'create') {
    traces.push(createTraceEntry('event type', 'create', event.type, false));
    return false;
  }
  traces.push(createTraceEntry('event type', 'create', event.type, true));

  // Check refType filter
  if (trigger.refTypes.length > 0) {
    const refType = event.payload.ref_type as string;
    const matches = trigger.refTypes.includes(refType as 'branch' | 'tag');
    traces.push(createTraceEntry('ref type', trigger.refTypes.join('|'), refType, matches));
    if (!matches) return false;
  }

  // Check ref patterns against payload.ref
  if (trigger.patterns.length > 0) {
    const ref = event.payload.ref as string;
    const matches = matchAnyBranch(trigger.patterns, ref);
    traces.push(
      createTraceEntry(
        'ref pattern',
        trigger.patterns.map((p) => p.pattern).join('|'),
        ref,
        matches,
      ),
    );
    if (!matches) return false;
  }

  // Check repo patterns
  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/**
 * Match a delete trigger against a simulated event.
 * Same structure as create trigger.
 */
function matchDeleteTrigger(
  trigger: LockDeleteTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  if (event.type !== 'delete') {
    traces.push(createTraceEntry('event type', 'delete', event.type, false));
    return false;
  }
  traces.push(createTraceEntry('event type', 'delete', event.type, true));

  // Check refType filter
  if (trigger.refTypes.length > 0) {
    const refType = event.payload.ref_type as string;
    const matches = trigger.refTypes.includes(refType as 'branch' | 'tag');
    traces.push(createTraceEntry('ref type', trigger.refTypes.join('|'), refType, matches));
    if (!matches) return false;
  }

  // Check ref patterns against payload.ref
  if (trigger.patterns.length > 0) {
    const ref = event.payload.ref as string;
    const matches = matchAnyBranch(trigger.patterns, ref);
    traces.push(
      createTraceEntry(
        'ref pattern',
        trigger.patterns.map((p) => p.pattern).join('|'),
        ref,
        matches,
      ),
    );
    if (!matches) return false;
  }

  // Check repo patterns
  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/**
 * Match a status trigger against a simulated event.
 * Checks context via picomatch and state filter.
 */
function matchStatusTrigger(
  trigger: LockStatusTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  if (event.type !== 'status') {
    traces.push(createTraceEntry('event type', 'status', event.type, false));
    return false;
  }
  traces.push(createTraceEntry('event type', 'status', event.type, true));

  // Check context patterns via picomatch
  if (trigger.contexts.length > 0) {
    const context = (event.payload.context as string) ?? '';
    const matches = trigger.contexts.some((pattern) => picomatch.isMatch(context, pattern));
    traces.push(createTraceEntry('context', trigger.contexts.join('|'), context, matches));
    if (!matches) return false;
  }

  // Check state filter
  if (trigger.states.length > 0) {
    const state = (event.payload.state as string) ?? '';
    const matches = trigger.states.includes(state);
    traces.push(createTraceEntry('state', trigger.states.join('|'), state, matches));
    if (!matches) return false;
  }

  // Check repo patterns
  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/**
 * Match a workflow_run trigger against a simulated event.
 * Checks action, workflow name, and conclusion filters.
 */
function matchWorkflowRunTrigger(
  trigger: LockWorkflowRunTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  if (event.type !== 'workflow_run') {
    traces.push(createTraceEntry('event type', 'workflow_run', event.type, false));
    return false;
  }
  traces.push(createTraceEntry('event type', 'workflow_run', event.type, true));

  // Check action filter
  if (trigger.actions.length > 0) {
    const action = event.action ?? '';
    const matches = trigger.actions.includes(action);
    traces.push(createTraceEntry('action', trigger.actions.join('|'), action, matches));
    if (!matches) return false;
  }

  const workflowRun = event.payload.workflow_run as Record<string, unknown> | undefined;

  // Check workflow name filter
  if (trigger.workflows.length > 0) {
    const name = (workflowRun?.name as string) ?? '';
    const matches = trigger.workflows.includes(name);
    traces.push(createTraceEntry('workflow name', trigger.workflows.join('|'), name, matches));
    if (!matches) return false;
  }

  // Check conclusion filter
  if (trigger.conclusions.length > 0) {
    const conclusion = (workflowRun?.conclusion as string) ?? '';
    const matches = trigger.conclusions.includes(conclusion);
    traces.push(createTraceEntry('conclusion', trigger.conclusions.join('|'), conclusion, matches));
    if (!matches) return false;
  }

  // Check repo patterns
  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/**
 * Match a fork trigger against a simulated event.
 * Fork triggers match unconditionally (no filter fields).
 */
function matchForkTrigger(
  trigger: LockForkTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  if (event.type !== 'fork') {
    traces.push(createTraceEntry('event type', 'fork', event.type, false));
    return false;
  }
  traces.push(createTraceEntry('event type', 'fork', event.type, true));

  // Check repo patterns
  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/**
 * Match a star trigger against a simulated event.
 * Supports action filter (created, deleted).
 */
function matchStarTrigger(
  trigger: LockStarTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  if (event.type !== 'star') {
    traces.push(createTraceEntry('event type', 'star', event.type, false));
    return false;
  }
  traces.push(createTraceEntry('event type', 'star', event.type, true));

  // Check action filter
  if (trigger.actions.length > 0) {
    const action = event.action ?? '';
    const matches = trigger.actions.includes(action);
    traces.push(createTraceEntry('action', trigger.actions.join('|'), action, matches));
    if (!matches) return false;
  }

  // Check repo patterns
  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/**
 * Match a watch trigger against a simulated event.
 * Supports action filter (started).
 */
function matchWatchTrigger(
  trigger: LockWatchTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  if (event.type !== 'watch') {
    traces.push(createTraceEntry('event type', 'watch', event.type, false));
    return false;
  }
  traces.push(createTraceEntry('event type', 'watch', event.type, true));

  // Check action filter
  if (trigger.actions.length > 0) {
    const action = event.action ?? '';
    const matches = trigger.actions.includes(action);
    traces.push(createTraceEntry('action', trigger.actions.join('|'), action, matches));
    if (!matches) return false;
  }

  // Check repo patterns
  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/**
 * Match a generic webhook trigger against a simulated event.
 * Matches event type against the events array, then optionally filters by action.
 */
function matchWebhookTrigger(
  trigger: LockWebhookTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  // Check event type against trigger's events array
  const eventMatches = trigger.events.includes(event.type);
  traces.push(createTraceEntry('event type', trigger.events.join('|'), event.type, eventMatches));
  if (!eventMatches) return false;

  // Check action filter
  if (trigger.actions.length > 0) {
    const action = event.action ?? '';
    const matches = trigger.actions.includes(action);
    traces.push(createTraceEntry('action', trigger.actions.join('|'), action, matches));
    if (!matches) return false;
  }

  // Check repo patterns
  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/**
 * Match a kici_event trigger against a simulated event.
 * Checks event name, optional JSONPath match/not, and source filter.
 */
function matchKiciEventTrigger(
  trigger: LockKiciEventTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  if (event.type !== 'kici_event') {
    traces.push(createTraceEntry('event type', 'kici_event', event.type, false));
    return false;
  }
  traces.push(createTraceEntry('event type', 'kici_event', event.type, true));

  // Check event name from payload
  const eventName = (event.payload.eventName as string) ?? '';
  const nameMatches = eventName === trigger.eventName;
  traces.push(createTraceEntry('event name', trigger.eventName, eventName, nameMatches));
  if (!nameMatches) return false;

  // Apply JSONPath match filter
  if (trigger.match && Object.keys(trigger.match).length > 0) {
    const eventPayload = (event.payload.payload as Record<string, unknown>) ?? {};
    const matches = matchJsonPath(eventPayload, trigger.match);
    traces.push(
      createTraceEntry('jsonpath match', JSON.stringify(trigger.match), '(payload)', matches),
    );
    if (!matches) return false;
  }

  // Apply JSONPath not filter
  if (trigger.not && Object.keys(trigger.not).length > 0) {
    const eventPayload = (event.payload.payload as Record<string, unknown>) ?? {};
    const passes = matchJsonPathNot(eventPayload, trigger.not);
    traces.push(createTraceEntry('jsonpath not', JSON.stringify(trigger.not), '(payload)', passes));
    if (!passes) return false;
  }

  // Check source filter
  if (trigger.source) {
    const sourceRepo = (event.payload.sourceRepo as string) ?? '';
    const matches = sourceRepo === trigger.source;
    traces.push(createTraceEntry('source', trigger.source, sourceRepo, matches));
    if (!matches) return false;
  }

  return true;
}

/**
 * Match a workflow_complete trigger against a simulated event.
 * Checks workflow name, status array, and source filter.
 */
function matchWorkflowCompleteTrigger(
  trigger: LockWorkflowCompleteTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  if (event.type !== 'workflow_complete') {
    traces.push(createTraceEntry('event type', 'workflow_complete', event.type, false));
    return false;
  }
  traces.push(createTraceEntry('event type', 'workflow_complete', event.type, true));

  // Check workflow name if specified
  if (trigger.name) {
    const workflowName = (event.payload.workflowName as string) ?? '';
    const matches = workflowName === trigger.name;
    traces.push(createTraceEntry('workflow name', trigger.name, workflowName, matches));
    if (!matches) return false;
  }

  // Check status filter
  if (trigger.status && trigger.status.length > 0) {
    const status = (event.payload.status as string) ?? '';
    const matches = trigger.status.includes(status);
    traces.push(createTraceEntry('status', trigger.status.join('|'), status, matches));
    if (!matches) return false;
  }

  // Check source filter
  if (trigger.source) {
    const sourceRepo = (event.payload.sourceRepo as string) ?? '';
    const matches = sourceRepo === trigger.source;
    traces.push(createTraceEntry('source', trigger.source, sourceRepo, matches));
    if (!matches) return false;
  }

  return true;
}

/**
 * Match a job_complete trigger against a simulated event.
 * Checks workflow name, job name, status array, and source filter.
 */
function matchJobCompleteTrigger(
  trigger: LockJobCompleteTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  if (event.type !== 'job_complete') {
    traces.push(createTraceEntry('event type', 'job_complete', event.type, false));
    return false;
  }
  traces.push(createTraceEntry('event type', 'job_complete', event.type, true));

  // Check workflow name if specified
  if (trigger.workflow) {
    const workflowName = (event.payload.workflowName as string) ?? '';
    const matches = workflowName === trigger.workflow;
    traces.push(createTraceEntry('workflow name', trigger.workflow, workflowName, matches));
    if (!matches) return false;
  }

  // Check job name if specified
  if (trigger.job) {
    const jobName = (event.payload.jobName as string) ?? '';
    const matches = jobName === trigger.job;
    traces.push(createTraceEntry('job name', trigger.job, jobName, matches));
    if (!matches) return false;
  }

  // Check status filter
  if (trigger.status && trigger.status.length > 0) {
    const status = (event.payload.status as string) ?? '';
    const matches = trigger.status.includes(status);
    traces.push(createTraceEntry('status', trigger.status.join('|'), status, matches));
    if (!matches) return false;
  }

  // Check source filter
  if (trigger.source) {
    const sourceRepo = (event.payload.sourceRepo as string) ?? '';
    const matches = sourceRepo === trigger.source;
    traces.push(createTraceEntry('source', trigger.source, sourceRepo, matches));
    if (!matches) return false;
  }

  return true;
}

/**
 * Match a generic_webhook trigger against a simulated event.
 * Checks source ID, optional events array, and JSONPath match/not.
 */
function matchGenericWebhookTrigger(
  trigger: LockGenericWebhookTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  if (event.type !== 'generic_webhook') {
    traces.push(createTraceEntry('event type', 'generic_webhook', event.type, false));
    return false;
  }
  traces.push(createTraceEntry('event type', 'generic_webhook', event.type, true));

  // Check source ID -- must match exactly
  const eventSource = (event.payload.source as string) ?? '';
  const sourceMatches = eventSource === trigger.source;
  traces.push(createTraceEntry('source', trigger.source, eventSource, sourceMatches));
  if (!sourceMatches) return false;

  // Check events filter (optional -- if specified, event action must be in the list)
  if (trigger.events && trigger.events.length > 0) {
    const eventType = (event.payload.eventType as string) ?? event.action ?? '';
    const matches = trigger.events.includes(eventType);
    traces.push(
      createTraceEntry('event type filter', trigger.events.join('|'), eventType, matches),
    );
    if (!matches) return false;
  }

  // Apply JSONPath match filter
  if (trigger.match && Object.keys(trigger.match).length > 0) {
    const matches = matchJsonPath(event.payload, trigger.match);
    traces.push(
      createTraceEntry('jsonpath match', JSON.stringify(trigger.match), '(payload)', matches),
    );
    if (!matches) return false;
  }

  // Apply JSONPath not filter
  if (trigger.not && Object.keys(trigger.not).length > 0) {
    const passes = matchJsonPathNot(event.payload, trigger.not);
    traces.push(createTraceEntry('jsonpath not', JSON.stringify(trigger.not), '(payload)', passes));
    if (!passes) return false;
  }

  return true;
}

/**
 * Match a schedule trigger against a simulated event.
 * Schedule triggers match when the event type is 'schedule' and the cron expression matches.
 */
function matchScheduleTrigger(
  trigger: LockScheduleTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  if (event.type !== 'schedule') {
    traces.push(createTraceEntry('event type', 'schedule', event.type, false));
    return false;
  }
  traces.push(createTraceEntry('event type', 'schedule', event.type, true));

  // Check cron expression from payload
  const cronExpression = (event.payload.cronExpression as string) ?? '';
  const matches = cronExpression === trigger.cronExpression;
  traces.push(createTraceEntry('cron expression', trigger.cronExpression, cronExpression, matches));
  if (!matches) return false;

  return true;
}

/**
 * Match a lifecycle trigger against a simulated event.
 * Lifecycle triggers match when event type is 'lifecycle', the lifecycle event is in the trigger's
 * events array, and optionally the source repo matches.
 */
function matchLifecycleTrigger(
  trigger: LockLifecycleTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  if (event.type !== 'lifecycle') {
    traces.push(createTraceEntry('event type', 'lifecycle', event.type, false));
    return false;
  }
  traces.push(createTraceEntry('event type', 'lifecycle', event.type, true));

  // Check lifecycle event type from payload
  const lifecycleEvent = (event.payload.lifecycleEvent as string) ?? '';
  const eventMatches = trigger.events.includes(lifecycleEvent);
  traces.push(
    createTraceEntry('lifecycle event', trigger.events.join('|'), lifecycleEvent, eventMatches),
  );
  if (!eventMatches) return false;

  // Check source filter (optional)
  if (trigger.sources && trigger.sources.length > 0) {
    const sourceRepo = (event.payload.sourceRepo as string) ?? '';
    const sourceMatches = trigger.sources.includes(sourceRepo);
    traces.push(createTraceEntry('source', trigger.sources.join('|'), sourceRepo, sourceMatches));
    if (!sourceMatches) return false;
  }

  return true;
}

/**
 * Match a trigger against a simulated event.
 */
function matchTrigger(trigger: LockTrigger, event: SimulatedEvent, traces: TraceEntry[]): boolean {
  switch (trigger._type) {
    case 'pr':
      return matchPrTrigger(trigger, event, traces);
    case 'push':
      return matchPushTrigger(trigger, event, traces);
    case 'tag':
      return matchTagTrigger(trigger, event, traces);
    case 'comment':
      return matchCommentTrigger(trigger, event, traces);
    case 'review':
      return matchReviewTrigger(trigger, event, traces);
    case 'review_comment':
      return matchReviewCommentTrigger(trigger, event, traces);
    case 'release':
      return matchReleaseTrigger(trigger, event, traces);
    case 'dispatch':
      return matchDispatchTrigger(trigger, event, traces);
    case 'create':
      return matchCreateTrigger(trigger, event, traces);
    case 'delete':
      return matchDeleteTrigger(trigger, event, traces);
    case 'status':
      return matchStatusTrigger(trigger, event, traces);
    case 'workflow_run':
      return matchWorkflowRunTrigger(trigger, event, traces);
    case 'fork':
      return matchForkTrigger(trigger, event, traces);
    case 'star':
      return matchStarTrigger(trigger, event, traces);
    case 'watch':
      return matchWatchTrigger(trigger, event, traces);
    case 'webhook':
      return matchWebhookTrigger(trigger, event, traces);
    case 'kici_event':
      return matchKiciEventTrigger(trigger, event, traces);
    case 'workflow_complete':
      return matchWorkflowCompleteTrigger(trigger, event, traces);
    case 'job_complete':
      return matchJobCompleteTrigger(trigger, event, traces);
    case 'generic_webhook':
      return matchGenericWebhookTrigger(trigger, event, traces);
    case 'schedule':
      return matchScheduleTrigger(trigger, event, traces);
    case 'lifecycle':
      return matchLifecycleTrigger(trigger, event, traces);
    default:
      return false;
  }
}

/**
 * Match all triggers for a workflow against an event.
 * Returns WorkflowDecision with full trace.
 */
export function matchWorkflowTriggers(
  workflow: LockWorkflow,
  event: SimulatedEvent,
): WorkflowDecision {
  const allTraces: TraceEntry[] = [];

  // No triggers = never match
  if (workflow.triggers.length === 0) {
    return createWorkflowDecision(workflow.name, false, [], undefined, 'No triggers defined');
  }

  // Try each trigger - first match wins
  for (let i = 0; i < workflow.triggers.length; i++) {
    const trigger = workflow.triggers[i];
    if (trigger == null) continue; // skip null triggers
    const triggerTraces: TraceEntry[] = [];

    if (matchTrigger(trigger, event, triggerTraces)) {
      return createWorkflowDecision(
        workflow.name,
        true,
        triggerTraces,
        i,
        `Matched trigger ${i + 1} (${trigger._type})`,
      );
    }

    allTraces.push(...triggerTraces);
  }

  return createWorkflowDecision(workflow.name, false, allTraces, undefined, 'No triggers matched');
}

/**
 * Match all workflows against an event.
 */
export function matchAllWorkflows(
  workflows: readonly LockWorkflow[],
  event: SimulatedEvent,
): WorkflowDecision[] {
  return workflows.map((w) => matchWorkflowTriggers(w, event));
}
