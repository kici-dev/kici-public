/**
 * Trigger matching engine for evaluating workflow triggers against webhook
 * events; the one implementation the compiler and the orchestrator share.
 */
import { getCompiledRegex, getGlobMatcher, getRepoGlobMatcher } from './compiled-matchers.js';
import { isDeferrableRange, resolveDiffRange } from './diff-range.js';
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
  LockWorkflowsFailedBatchTrigger,
  LockJobCompleteTrigger,
  LockGenericWebhookTrigger,
  LockScheduleTrigger,
  LockLifecycleTrigger,
  LockWorkflow,
  LockBranchPattern,
  LockTextMatch,
  SimulatedEvent,
  ChangedFilesStatus,
} from './types.js';
import {
  createCommitMessageTraceEntry,
  createTraceEntry,
  createWorkflowDecision,
  TraceCheck,
  type TraceEntry,
  type WorkflowDecision,
} from './decision-trace.js';
import { matchJsonPath, matchJsonPathNot } from './jsonpath-matcher.js';
import { evaluateTextMatch } from './text-match.js';

/** Patterns split into include/exclude by their `!` prefix (stripped on exclude). */
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

export function matchBranchPattern(pattern: LockBranchPattern, branch: string): boolean {
  if (pattern.type === 'glob') {
    return getGlobMatcher(pattern.pattern)(branch);
  } else {
    return getCompiledRegex(pattern.pattern, pattern.flags, 'branch/tag/repo pattern').test(branch);
  }
}

/**
 * Like {@link matchBranchPattern}, but globs compile through
 * {@link getRepoGlobMatcher} so `**` matches a dot-prefixed identifier
 * (`.hidden/repo`): repo identifiers are org/name pairs with no dotfile
 * convention, and `repos: ['**']` means every repo. Regex patterns are
 * unaffected (`dot` is glob-only).
 */
function matchRepoPattern(pattern: LockBranchPattern, repo: string): boolean {
  if (pattern.type === 'glob') {
    return getRepoGlobMatcher(pattern.pattern)(repo);
  }
  return getCompiledRegex(pattern.pattern, pattern.flags, 'branch/tag/repo pattern').test(repo);
}

/** An empty pattern list matches every branch. */
function matchAnyBranch(patterns: readonly LockBranchPattern[], branch: string): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((p) => matchBranchPattern(p, branch));
}

/**
 * Match path patterns against changed files. `!`-prefixed patterns are
 * exclusions; an all-negation array matches every non-excluded file.
 */
export function matchPathPatterns(
  paths: readonly string[],
  changedFiles: string[],
  status?: ChangedFilesStatus,
): boolean {
  if (paths.length === 0) return true;

  // Diff unavailable (a provider gap such as universal-git PR events, or
  // upstream degradation): match conservatively, since a spurious run beats a
  // silently dropped one. Only an explicit `unavailable` status triggers it, so a
  // genuine empty diff (`fetched` + []) still no-matches below.
  if (status === 'unavailable') return true;

  if (changedFiles.length === 0) return false;

  const { include, exclude } = splitStringPatterns(paths);

  let relevantFiles = changedFiles;
  if (exclude.length > 0) {
    relevantFiles = changedFiles.filter(
      (file) => !exclude.some((pattern) => getGlobMatcher(pattern)(file)),
    );
    if (relevantFiles.length === 0) return false;
  }

  // An all-negation array matches the remaining files implicitly.
  if (include.length === 0) return true;

  return relevantFiles.some((file) => include.some((pattern) => getGlobMatcher(pattern)(file)));
}

/**
 * Match repo patterns against a source repository identifier. `!`-prefixed
 * patterns are exclusions; an all-negation array matches every non-excluded
 * repo, and an empty array matches all repos.
 */
export function matchRepoPatterns(
  repos: readonly LockBranchPattern[],
  sourceRepo: string,
): boolean {
  if (repos.length === 0) return true;

  const { include, exclude } = splitBranchPatterns(repos);

  if (exclude.length > 0) {
    if (exclude.some((p) => matchRepoPattern(p, sourceRepo))) return false;
  }

  // An all-negation array matches a non-excluded repo implicitly.
  if (include.length === 0) return true;

  return include.some((p) => matchRepoPattern(p, sourceRepo));
}

/** True when the repo filter matches or is absent; records a trace entry. */
function evaluateRepoFilter(
  trigger: { repos?: readonly LockBranchPattern[] },
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  if (trigger.repos?.length) {
    if (!event.sourceRepo) {
      traces.push(createTraceEntry(TraceCheck.RepoFilter, 'required', '(missing)', false));
      return false;
    }
    const { include, exclude } = splitBranchPatterns(trigger.repos);
    const repoMatch = matchRepoPatterns(trigger.repos, event.sourceRepo);
    traces.push(
      createTraceEntry(
        TraceCheck.RepoFilter,
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
 * Evaluate a trigger's `commitMessage` filter; true when the trigger declares
 * none. An event with no message is INDETERMINATE, not a clean exclusion:
 * like the Tier-1 `requires` gate, a workflow whose declared gate was never
 * evaluated does not run.
 */
function evaluateCommitMessageFilter(
  trigger: { readonly commitMessage?: LockTextMatch },
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  const match = trigger.commitMessage;
  if (!match) return true;

  if (event.commitMessage === undefined) {
    traces.push(
      createCommitMessageTraceEntry({
        match,
        text: undefined,
        passed: false,
        indeterminate: true,
        reason: 'no commit message in payload (provider carries none for this event)',
      }),
    );
    return false;
  }

  const result = evaluateTextMatch(event.commitMessage, match);
  traces.push(
    createCommitMessageTraceEntry({
      match,
      text: event.commitMessage,
      passed: result.pass,
      indeterminate: result.indeterminate !== undefined,
      ...(result.indeterminate !== undefined && { reason: result.indeterminate }),
    }),
  );
  return result.pass;
}

/** Trace value of a `paths` check that read an unavailable diff. */
export const UnavailablePathsTrace = {
  /** A git range exists: the agent decides from its clone. */
  DecidedOnAgent: '[unavailable — decided on agent]',
  /** No range the agent can diff: the workflow runs conservatively. */
  Conservative: '[unavailable — matched conservatively]',
} as const;

/** Appended to a matched decision's summary when its paths are left to the agent. */
export const DEFERRED_PATHS_SUMMARY_SUFFIX = ' — paths decided on the agent';

export interface TriggerMatchNotes {
  /**
   * Set by a push/pr trigger whose `paths` check passed only because the diff
   * was unavailable while a git range exists.
   */
  conservativePaths?: readonly string[];
}

/**
 * Evaluate a push/pr trigger's `paths` list and trace it. An `unavailable`
 * diff matches; with a git range, `notes` records it so the agent's clone
 * decides the paths.
 */
function checkTriggerPaths(
  paths: readonly string[],
  event: SimulatedEvent,
  traces: TraceEntry[],
  notes: TriggerMatchNotes | undefined,
): boolean {
  if (paths.length === 0) return true;
  const changedFiles = event.changedFiles ?? [];
  const { include, exclude } = splitStringPatterns(paths);
  const unavailable = event.changedFilesStatus === 'unavailable';
  const deferrable = unavailable && isDeferrableRange(resolveDiffRange(event));
  const matches = matchPathPatterns(paths, changedFiles, event.changedFilesStatus);
  const value = !unavailable
    ? `[${changedFiles.join(', ')}]`
    : deferrable
      ? UnavailablePathsTrace.DecidedOnAgent
      : UnavailablePathsTrace.Conservative;
  traces.push(
    createTraceEntry(
      'paths',
      `include: [${include.join(', ')}] exclude: [${exclude.join(', ')}]`,
      value,
      matches,
    ),
  );
  if (deferrable && notes) notes.conservativePaths = paths;
  return matches;
}

function matchPrTrigger(
  trigger: LockPrTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
  notes?: TriggerMatchNotes,
): boolean {
  if (event.type !== 'pull_request') {
    traces.push(createTraceEntry('event type', 'pull_request', event.type, false));
    return false;
  }
  traces.push(createTraceEntry('event type', 'pull_request', event.type, true));

  if (trigger.events.length > 0) {
    const action = event.action ?? '';
    const actionMatches = trigger.events.includes(action);
    traces.push(createTraceEntry('action', trigger.events.join('|'), action, actionMatches));
    if (!actionMatches) return false;
  }

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

  if (!checkTriggerPaths(trigger.paths, event, traces, notes)) return false;

  if (!evaluateCommitMessageFilter(trigger, event, traces)) return false;

  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

function matchPushTrigger(
  trigger: LockPushTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
  notes?: TriggerMatchNotes,
): boolean {
  if (event.type !== 'push') {
    traces.push(createTraceEntry('event type', 'push', event.type, false));
    return false;
  }
  traces.push(createTraceEntry('event type', 'push', event.type, true));

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

  if (!checkTriggerPaths(trigger.paths, event, traces, notes)) return false;

  if (!evaluateCommitMessageFilter(trigger, event, traces)) return false;

  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/** Tag name is expected in event.targetBranch (normalizer sets it there). */
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

  if (!evaluateCommitMessageFilter(trigger, event, traces)) return false;

  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/** Supports action filter, source filter (issue vs PR), and bodyMatch (glob/regex). */
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

  if (trigger.actions.length > 0) {
    const action = event.action ?? '';
    const matches = trigger.actions.includes(action);
    traces.push(createTraceEntry('action', trigger.actions.join('|'), action, matches));
    if (!matches) return false;
  }

  if (trigger.source) {
    const issue = event.payload.issue as Record<string, unknown> | undefined;
    const hasPullRequest = issue && 'pull_request' in issue;
    const isFromPr = !!hasPullRequest;

    if (trigger.source === 'issue') {
      const matches = !isFromPr;
      traces.push(createTraceEntry('source', 'issue', isFromPr ? 'pr' : 'issue', matches));
      if (!matches) return false;
    } else {
      const matches = isFromPr;
      traces.push(createTraceEntry('source', 'pr', isFromPr ? 'pr' : 'issue', matches));
      if (!matches) return false;
    }
  }

  if (trigger.bodyMatch) {
    const comment = event.payload.comment as Record<string, unknown> | undefined;
    const body = (comment?.body as string) ?? '';

    if (trigger.bodyMatch.type === 'glob') {
      const matches = getGlobMatcher(trigger.bodyMatch.pattern)(body);
      traces.push(createTraceEntry('bodyMatch (glob)', trigger.bodyMatch.pattern, body, matches));
      if (!matches) return false;
    } else {
      const regex = getCompiledRegex(
        trigger.bodyMatch.pattern,
        trigger.bodyMatch.flags,
        'comment bodyMatch',
      );
      const matches = regex.test(body);
      traces.push(createTraceEntry('bodyMatch (regex)', trigger.bodyMatch.pattern, body, matches));
      if (!matches) return false;
    }
  }

  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/** Supports action and review state filters. */
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

  if (trigger.actions.length > 0) {
    const action = event.action ?? '';
    const matches = trigger.actions.includes(action);
    traces.push(createTraceEntry('action', trigger.actions.join('|'), action, matches));
    if (!matches) return false;
  }

  if (trigger.states.length > 0) {
    const review = event.payload.review as Record<string, unknown> | undefined;
    const state = (review?.state as string) ?? '';
    const matches = trigger.states.includes(state);
    traces.push(createTraceEntry('state', trigger.states.join('|'), state, matches));
    if (!matches) return false;
  }

  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/** Supports action filter. */
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

  if (trigger.actions.length > 0) {
    const action = event.action ?? '';
    const matches = trigger.actions.includes(action);
    traces.push(createTraceEntry('action', trigger.actions.join('|'), action, matches));
    if (!matches) return false;
  }

  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/** Supports action filter (published, created, etc.). */
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

  if (trigger.actions.length > 0) {
    const action = event.action ?? '';
    const matches = trigger.actions.includes(action);
    traces.push(createTraceEntry('action', trigger.actions.join('|'), action, matches));
    if (!matches) return false;
  }

  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/** GitHub sends event_type as action for repository_dispatch. */
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

  if (trigger.types.length > 0) {
    const action = event.action ?? '';
    const matches = trigger.types.includes(action);
    traces.push(createTraceEntry('dispatch type', trigger.types.join('|'), action, matches));
    if (!matches) return false;
  }

  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/** Checks refType and ref pattern against payload fields. */
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

  if (trigger.refTypes.length > 0) {
    const refType = event.payload.ref_type as string;
    const matches = trigger.refTypes.includes(refType as 'branch' | 'tag');
    traces.push(createTraceEntry('ref type', trigger.refTypes.join('|'), refType, matches));
    if (!matches) return false;
  }

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

  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/** Same structure as create trigger. */
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

  if (trigger.refTypes.length > 0) {
    const refType = event.payload.ref_type as string;
    const matches = trigger.refTypes.includes(refType as 'branch' | 'tag');
    traces.push(createTraceEntry('ref type', trigger.refTypes.join('|'), refType, matches));
    if (!matches) return false;
  }

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

  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/** Checks context via glob matching and state filter. */
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

  if (trigger.contexts.length > 0) {
    const context = (event.payload.context as string) ?? '';
    const matches = trigger.contexts.some((pattern) => getGlobMatcher(pattern)(context));
    traces.push(createTraceEntry('context', trigger.contexts.join('|'), context, matches));
    if (!matches) return false;
  }

  if (trigger.states.length > 0) {
    const state = (event.payload.state as string) ?? '';
    const matches = trigger.states.includes(state);
    traces.push(createTraceEntry('state', trigger.states.join('|'), state, matches));
    if (!matches) return false;
  }

  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/** Checks action, workflow name, and conclusion filters. */
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

  if (trigger.actions.length > 0) {
    const action = event.action ?? '';
    const matches = trigger.actions.includes(action);
    traces.push(createTraceEntry('action', trigger.actions.join('|'), action, matches));
    if (!matches) return false;
  }

  const workflowRun = event.payload.workflow_run as Record<string, unknown> | undefined;

  if (trigger.workflows.length > 0) {
    const name = (workflowRun?.name as string) ?? '';
    const matches = trigger.workflows.includes(name);
    traces.push(createTraceEntry('workflow name', trigger.workflows.join('|'), name, matches));
    if (!matches) return false;
  }

  if (trigger.conclusions.length > 0) {
    const conclusion = (workflowRun?.conclusion as string) ?? '';
    const matches = trigger.conclusions.includes(conclusion);
    traces.push(createTraceEntry('conclusion', trigger.conclusions.join('|'), conclusion, matches));
    if (!matches) return false;
  }

  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/** Fork triggers filter only by repo. */
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

  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/** Supports action filter (created, deleted). */
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

  if (trigger.actions.length > 0) {
    const action = event.action ?? '';
    const matches = trigger.actions.includes(action);
    traces.push(createTraceEntry('action', trigger.actions.join('|'), action, matches));
    if (!matches) return false;
  }

  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/** Supports action filter (started). */
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

  if (trigger.actions.length > 0) {
    const action = event.action ?? '';
    const matches = trigger.actions.includes(action);
    traces.push(createTraceEntry('action', trigger.actions.join('|'), action, matches));
    if (!matches) return false;
  }

  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/** Matches event type against the events array, then optionally filters by action. */
function matchWebhookTrigger(
  trigger: LockWebhookTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  const eventMatches = trigger.events.includes(event.type);
  traces.push(createTraceEntry('event type', trigger.events.join('|'), event.type, eventMatches));
  if (!eventMatches) return false;

  if (trigger.actions.length > 0) {
    const action = event.action ?? '';
    const matches = trigger.actions.includes(action);
    traces.push(createTraceEntry('action', trigger.actions.join('|'), action, matches));
    if (!matches) return false;
  }

  if (!evaluateRepoFilter(trigger, event, traces)) return false;

  return true;
}

/** Checks event name, optional JSONPath match/not, and source filter. */
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

  const eventName = (event.payload.eventName as string) ?? '';
  const nameMatches = eventName === trigger.eventName;
  traces.push(createTraceEntry('event name', trigger.eventName, eventName, nameMatches));
  if (!nameMatches) return false;

  if (trigger.match && Object.keys(trigger.match).length > 0) {
    const eventPayload = (event.payload.payload as Record<string, unknown>) ?? {};
    const matches = matchJsonPath(eventPayload, trigger.match);
    traces.push(
      createTraceEntry('jsonpath match', JSON.stringify(trigger.match), '(payload)', matches),
    );
    if (!matches) return false;
  }

  if (trigger.not && Object.keys(trigger.not).length > 0) {
    const eventPayload = (event.payload.payload as Record<string, unknown>) ?? {};
    const passes = matchJsonPathNot(eventPayload, trigger.not);
    traces.push(createTraceEntry('jsonpath not', JSON.stringify(trigger.not), '(payload)', passes));
    if (!passes) return false;
  }

  if (trigger.source) {
    const sourceRepo = (event.payload.sourceRepo as string) ?? '';
    const matches = sourceRepo === trigger.source;
    traces.push(createTraceEntry('source', trigger.source, sourceRepo, matches));
    if (!matches) return false;
  }

  return true;
}

/** Checks workflow name, status array, and source filter. */
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

  if (trigger.name) {
    const workflowName = (event.payload.workflowName as string) ?? '';
    const matches = workflowName === trigger.name;
    traces.push(createTraceEntry('workflow name', trigger.name, workflowName, matches));
    if (!matches) return false;
  }

  if (trigger.status && trigger.status.length > 0) {
    const status = (event.payload.status as string) ?? '';
    const matches = trigger.status.includes(status);
    traces.push(createTraceEntry('status', trigger.status.join('|'), status, matches));
    if (!matches) return false;
  }

  if (trigger.source) {
    const sourceRepo = (event.payload.sourceRepo as string) ?? '';
    const matches = sourceRepo === trigger.source;
    traces.push(createTraceEntry('source', trigger.source, sourceRepo, matches));
    if (!matches) return false;
  }

  return true;
}

/**
 * A workflows_failed_batch trigger matches in two phases:
 *  - A failed `workflow_complete` event (subject to the name/source filters) is
 *    an accumulation input: the orchestrator buffers the run into the batch
 *    window instead of dispatching now.
 *  - A synthetic `workflows_failed_batch` event, emitted once per window,
 *    dispatches the subscribing workflow a single time.
 */
function matchWorkflowsFailedBatchTrigger(
  trigger: LockWorkflowsFailedBatchTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
): boolean {
  if (event.type === 'workflow_complete') {
    // Accumulation input: only failed completions feed the batch.
    const status = (event.payload.status as string) ?? '';
    const isFailed = status === 'failed';
    traces.push(createTraceEntry('status', 'failed', status, isFailed));
    if (!isFailed) return false;
  } else if (event.type !== 'workflows_failed_batch') {
    traces.push(
      createTraceEntry('event type', 'workflow_complete|workflows_failed_batch', event.type, false),
    );
    return false;
  }
  traces.push(createTraceEntry('event type', 'workflows_failed_batch', event.type, true));

  if (trigger.name) {
    const workflowName = (event.payload.workflowName as string) ?? '';
    const matches = workflowName === trigger.name;
    traces.push(createTraceEntry('workflow name', trigger.name, workflowName, matches));
    if (!matches) return false;
  }

  if (trigger.source) {
    const sourceRepo = (event.payload.sourceRepo as string) ?? '';
    const matches = sourceRepo === trigger.source;
    traces.push(createTraceEntry('source', trigger.source, sourceRepo, matches));
    if (!matches) return false;
  }

  return true;
}

/** Checks workflow name, job name, status array, and source filter. */
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

  if (trigger.workflow) {
    const workflowName = (event.payload.workflowName as string) ?? '';
    const matches = workflowName === trigger.workflow;
    traces.push(createTraceEntry('workflow name', trigger.workflow, workflowName, matches));
    if (!matches) return false;
  }

  if (trigger.job) {
    const jobName = (event.payload.jobName as string) ?? '';
    const matches = jobName === trigger.job;
    traces.push(createTraceEntry('job name', trigger.job, jobName, matches));
    if (!matches) return false;
  }

  if (trigger.status && trigger.status.length > 0) {
    const status = (event.payload.status as string) ?? '';
    const matches = trigger.status.includes(status);
    traces.push(createTraceEntry('status', trigger.status.join('|'), status, matches));
    if (!matches) return false;
  }

  if (trigger.source) {
    const sourceRepo = (event.payload.sourceRepo as string) ?? '';
    const matches = sourceRepo === trigger.source;
    traces.push(createTraceEntry('source', trigger.source, sourceRepo, matches));
    if (!matches) return false;
  }

  return true;
}

/** Checks source ID, optional events array, and JSONPath match/not. */
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

  const eventSource = (event.payload.source as string) ?? '';
  const sourceMatches = eventSource === trigger.source;
  traces.push(createTraceEntry('source', trigger.source, eventSource, sourceMatches));
  if (!sourceMatches) return false;

  // Matched against payload.eventType, falling back to the event action.
  if (trigger.events && trigger.events.length > 0) {
    const eventType = (event.payload.eventType as string) ?? event.action ?? '';
    const matches = trigger.events.includes(eventType);
    traces.push(
      createTraceEntry('event type filter', trigger.events.join('|'), eventType, matches),
    );
    if (!matches) return false;
  }

  if (trigger.match && Object.keys(trigger.match).length > 0) {
    const matches = matchJsonPath(event.payload, trigger.match);
    traces.push(
      createTraceEntry('jsonpath match', JSON.stringify(trigger.match), '(payload)', matches),
    );
    if (!matches) return false;
  }

  if (trigger.not && Object.keys(trigger.not).length > 0) {
    const passes = matchJsonPathNot(event.payload, trigger.not);
    traces.push(createTraceEntry('jsonpath not', JSON.stringify(trigger.not), '(payload)', passes));
    if (!passes) return false;
  }

  return true;
}

/** Schedule triggers match when the event type is 'schedule' and the cron expression matches. */
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

  const cronExpression = (event.payload.cronExpression as string) ?? '';
  const matches = cronExpression === trigger.cronExpression;
  traces.push(createTraceEntry('cron expression', trigger.cronExpression, cronExpression, matches));
  if (!matches) return false;

  return true;
}

/**
 * Lifecycle triggers match when event type is 'lifecycle', the lifecycle event
 * is in the trigger's events array, and optionally the source repo matches.
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

  const lifecycleEvent = (event.payload.lifecycleEvent as string) ?? '';
  const eventMatches = trigger.events.includes(lifecycleEvent);
  traces.push(
    createTraceEntry('lifecycle event', trigger.events.join('|'), lifecycleEvent, eventMatches),
  );
  if (!eventMatches) return false;

  if (trigger.sources && trigger.sources.length > 0) {
    const sourceRepo = (event.payload.sourceRepo as string) ?? '';
    const sourceMatches = trigger.sources.includes(sourceRepo);
    traces.push(createTraceEntry('source', trigger.sources.join('|'), sourceRepo, sourceMatches));
    if (!sourceMatches) return false;
  }

  return true;
}

export function matchTrigger(
  trigger: LockTrigger,
  event: SimulatedEvent,
  traces: TraceEntry[],
  notes?: TriggerMatchNotes,
): boolean {
  switch (trigger._type) {
    case 'pr':
      return matchPrTrigger(trigger, event, traces, notes);
    case 'push':
      return matchPushTrigger(trigger, event, traces, notes);
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
    case 'workflows_failed_batch':
      return matchWorkflowsFailedBatchTrigger(trigger, event, traces);
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

/** Match all of a workflow's triggers against an event, with the full trace. */
export function matchWorkflowTriggers(
  workflow: LockWorkflow,
  event: SimulatedEvent,
): WorkflowDecision {
  const allTraces: TraceEntry[] = [];

  if (workflow.triggers.length === 0) {
    return createWorkflowDecision(workflow.name, false, [], undefined, 'No triggers defined');
  }

  let firstDeferred: { index: number; traces: TraceEntry[]; type: string } | undefined;
  const deferredPaths: string[][] = [];

  // The first outright match wins.
  for (let i = 0; i < workflow.triggers.length; i++) {
    const trigger = workflow.triggers[i];
    if (trigger == null) continue;
    const triggerTraces: TraceEntry[] = [];
    const notes: TriggerMatchNotes = {};

    if (matchTrigger(trigger, event, triggerTraces, notes)) {
      if (notes.conservativePaths === undefined) {
        return createWorkflowDecision(
          workflow.name,
          true,
          triggerTraces,
          i,
          `Matched trigger ${i + 1} (${trigger._type})`,
        );
      }
      // Keep scanning: a later trigger matching outright makes the workflow
      // run whatever the agent would decide for this one.
      deferredPaths.push([...notes.conservativePaths]);
      firstDeferred ??= { index: i, traces: triggerTraces, type: trigger._type };
      continue;
    }

    allTraces.push(...triggerTraces);
  }

  if (firstDeferred) {
    return {
      ...createWorkflowDecision(
        workflow.name,
        true,
        firstDeferred.traces,
        firstDeferred.index,
        `Matched trigger ${firstDeferred.index + 1} (${firstDeferred.type})${DEFERRED_PATHS_SUMMARY_SUFFIX}`,
      ),
      deferredPaths,
    };
  }

  return createWorkflowDecision(workflow.name, false, allTraces, undefined, 'No triggers matched');
}

export function matchAllWorkflows(
  workflows: readonly LockWorkflow[],
  event: SimulatedEvent,
): WorkflowDecision[] {
  return workflows.map((w) => matchWorkflowTriggers(w, event));
}
