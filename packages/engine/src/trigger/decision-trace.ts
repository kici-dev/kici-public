/** Decision trace: every check performed during trigger evaluation, for debugging. */

import { describeTextMatch } from './text-match.js';
import type { LockTextMatch } from './types.js';

export interface TraceEntry {
  /** What was checked (e.g., "branch pattern", "path filter", "event type") */
  check: string;
  /** The pattern/condition that was evaluated */
  pattern: string;
  /** The value being tested against */
  value: string;
  passed: boolean;
  reason?: string;
}

/** Decision trace for a workflow's trigger evaluation. */
export interface WorkflowDecision {
  workflowName: string;
  matched: boolean;
  /** Index of the trigger that matched, if any */
  matchedTrigger?: number;
  checks: TraceEntry[];
  summary: string;
  /**
   * The `paths` lists of triggers that matched only because the changed files
   * were unavailable while a git range existed. Set only when no trigger
   * matched outright; the agent decides these from its clone.
   */
  deferredPaths?: string[][];
}

/**
 * Max characters of any free-text field a trace entry carries.
 *
 * The downstream entry-count cap alone bounds nothing: one `paths` entry names
 * every changed file in the push and one `bodyMatch` entry quotes an outsider's
 * comment body, so fifty entries can still be megabytes. The trace rides one
 * WebSocket frame to the Platform, and a frame past the server's payload ceiling
 * closes the connection, stalling every delivery for that organization until it
 * reconnects. Bounding each field where it is minted makes the downstream size
 * guards a backstop rather than the only limit.
 */
export const TRACE_TEXT_MAX = 200;

/** Clamp one free-text trace field, marking a clamped value with an ellipsis. */
export function truncateTraceText(text: string): string {
  return text.length > TRACE_TEXT_MAX ? `${text.slice(0, TRACE_TEXT_MAX)}…` : text;
}

/**
 * Create a new trace entry. Free-text fields are clamped here, not per call
 * site: they carry event content of unbounded size, and one unclamped call site
 * would reintroduce an unbounded frame.
 */
export function createTraceEntry(
  check: string,
  pattern: string,
  value: string,
  passed: boolean,
  reason?: string,
): TraceEntry {
  return {
    check,
    pattern: truncateTraceText(pattern),
    value: truncateTraceText(value),
    passed,
    reason: reason === undefined ? undefined : truncateTraceText(reason),
  };
}

/**
 * Stable `check` labels for the gates an organization-wide global workflow
 * passes on its way to dispatch.
 *
 * Other trigger checks use free-text labels naming the field they read. These
 * are constants because one package records them and another reads them back
 * (by code, and by whoever asks "why did nothing run?"), so a typo on either
 * side would silently produce a trace nobody can search for.
 */
export const TraceCheck = {
  /** `repos` glob/regex filter, deciding whether a workflow applies to the event's repo. */
  RepoFilter: 'repo',
  /** Tier-1 declarative `requires` content filter, interpreted by the orchestrator. */
  ContentRequirements: 'requires',
  /** Tier-2 `filter` predicate, run by an agent in the global eval round. */
  GlobalFilter: 'filter',
  /** Tier-0 declarative `commitMessage` filter, read from the normalized event. */
  CommitMessage: 'commitMessage',
  /** Materialization of a matched workflow's jobs, on the way to dispatch. */
  Dispatch: 'dispatch',
} as const;
export type TraceCheck = (typeof TraceCheck)[keyof typeof TraceCheck];

/**
 * Verdict vocabulary shared by the gate trace entries.
 *
 * `Indeterminate` is deliberately distinct from `Excluded`: a gate that could
 * not be evaluated decided nothing, and an exclusion would tell the author their
 * filter said no when nothing ever ran it.
 */
export const TraceVerdict = {
  Matched: 'matched',
  Excluded: 'excluded',
  Indeterminate: 'indeterminate',
} as const;
export type TraceVerdict = (typeof TraceVerdict)[keyof typeof TraceVerdict];

function verdictFor(passed: boolean, indeterminate: boolean): TraceVerdict {
  if (indeterminate) return TraceVerdict.Indeterminate;
  return passed ? TraceVerdict.Matched : TraceVerdict.Excluded;
}

/**
 * Record the Tier-1 `requires` content filter's verdict for one workflow.
 * `files` (the repo-relative paths the list reads) names what was inspected.
 */
export function createContentRequirementsTraceEntry(args: {
  files: readonly string[];
  passed: boolean;
  /** Set when the requirement list could not be evaluated (unreadable file, bad parse). */
  indeterminate?: boolean;
  reason?: string;
}): TraceEntry {
  return createTraceEntry(
    TraceCheck.ContentRequirements,
    args.files.length > 0 ? args.files.join(', ') : '(no files)',
    verdictFor(args.passed, args.indeterminate === true),
    args.passed,
    args.reason,
  );
}

/**
 * Record the Tier-2 `filter` predicate's verdict for one workflow.
 *
 * Without it a `filter` exclusion is invisible: the predicate returns `false` on
 * an agent and the workflow never appears, leaving its author nothing to inspect.
 */
export function createGlobalFilterTraceEntry(args: {
  /** The round's verdict for this candidate: `true` means the filter admitted it. */
  run: boolean;
  /** True when the round could not decide (a failed round, a budget breach). */
  indeterminate?: boolean;
  reason?: string;
}): TraceEntry {
  return createTraceEntry(
    TraceCheck.GlobalFilter,
    'filter(context) === true',
    verdictFor(args.run, args.indeterminate === true),
    args.run,
    args.reason,
  );
}

/**
 * Record that a matched workflow could not be materialized into jobs.
 *
 * A workflow whose triggers matched and whose build then threw has no run row
 * and no queued job; without this entry its author could not tell it apart from
 * a workflow that was never registered.
 */
export function createDispatchFailureTraceEntry(reason: string): TraceEntry {
  return createTraceEntry(
    TraceCheck.Dispatch,
    'jobs materialize',
    TraceVerdict.Excluded,
    false,
    reason,
  );
}

/**
 * Return a copy of `decision` with `entries` appended to its checks.
 *
 * Never mutated in place: the caller that recorded the decision still reads it,
 * and appending would retroactively rewrite what that reader saw.
 *
 * A failing appended entry demotes `matched` and replaces `summary`: a workflow
 * whose triggers matched but whose content filter excluded it did NOT match
 * overall.
 */
export function appendChecks(
  decision: WorkflowDecision,
  entries: readonly TraceEntry[],
): WorkflowDecision {
  const failed = entries.find((entry) => !entry.passed);
  return {
    ...decision,
    matched: decision.matched && failed === undefined,
    checks: [...decision.checks, ...entries],
    summary: failed ? (failed.reason ?? `Excluded by the ${failed.check} check`) : decision.summary,
  };
}

/**
 * Record the Tier-0 `commitMessage` filter's verdict for one trigger.
 *
 * `text: undefined` means the event carried no message; the caller marks that
 * indeterminate, not excluded (see {@link TraceVerdict}).
 */
export function createCommitMessageTraceEntry(args: {
  match: LockTextMatch;
  text: string | undefined;
  passed: boolean;
  indeterminate?: boolean;
  reason?: string;
}): TraceEntry {
  const shown =
    args.text === undefined
      ? '(absent)'
      : args.text.length > TRACE_TEXT_MAX
        ? `${args.text.slice(0, TRACE_TEXT_MAX)}…`
        : args.text;
  return createTraceEntry(
    TraceCheck.CommitMessage,
    describeTextMatch(args.match),
    verdictFor(args.passed, args.indeterminate === true),
    args.passed,
    args.reason ?? `message: ${JSON.stringify(shown)}`,
  );
}

/**
 * What a withheld trace field is replaced with when the reader does not hold
 * `event_log:read_payload`.
 *
 * Shared because the Platform writes it, the dashboard renders it and tests
 * assert the permission boundary against it; a literal repeated at each site
 * would drift.
 */
export const REDACTED_TRACE_FIELD = '[redacted — requires event_log:read_payload]';

/**
 * Workflow name the truncation marker carries.
 *
 * A reserved sentinel, written by one package and read back by two others, so
 * it lives in one place.
 */
export const TRACE_TRUNCATION_WORKFLOW_NAME = '(trace truncated)';

/**
 * Build the marker that stands in for the decisions a size budget dropped.
 *
 * Truncated rather than discarded, so a reader can tell "matching never ran"
 * from "the trace was too large to keep".
 */
export function createTraceTruncationMarker(omitted: number): Record<string, unknown> {
  return {
    workflowName: TRACE_TRUNCATION_WORKFLOW_NAME,
    matched: false,
    traceTruncated: true,
    decisionsOmitted: omitted,
    checks: [],
    checksCount: 0,
    summary:
      (omitted === 1
        ? '1 further workflow decision was dropped: '
        : `${omitted} further workflow decisions were dropped: `) +
      'the trace exceeded the size budget for this delivery.',
  };
}

/**
 * UTF-8 byte length of `text`. Never `String.length`, which counts UTF-16 code
 * units: a CJK-heavy body measures at roughly a third of its bytes
 * on the wire and in the stored row.
 */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Drop trailing decisions until the serialized array fits `maxBytes`, appending
 * a marker naming how many were dropped.
 *
 * Shared by the orchestrator (wire budget) and the Platform (storage budget),
 * so both agree on what a truncated trace looks like.
 */
export function truncateDecisionsToByteBudget<T>(
  decisions: readonly T[],
  maxBytes: number,
): { decisions: Array<T | Record<string, unknown>>; omitted: number } {
  if (utf8ByteLength(JSON.stringify(decisions)) <= maxBytes) {
    return { decisions: [...decisions], omitted: 0 };
  }

  // The marker's size depends on its count, so reserve the worst case (every
  // decision dropped) up front.
  const reserved = utf8ByteLength(JSON.stringify(createTraceTruncationMarker(decisions.length)));
  // `[` + `]`, plus the comma joining the marker to whatever precedes it.
  let used = 3 + reserved;

  const kept: T[] = [];
  for (const decision of decisions) {
    const cost = utf8ByteLength(JSON.stringify(decision)) + 1;
    if (used + cost > maxBytes) break;
    used += cost;
    kept.push(decision);
  }

  const omitted = decisions.length - kept.length;
  return { decisions: [...kept, createTraceTruncationMarker(omitted)], omitted };
}

export function createWorkflowDecision(
  workflowName: string,
  matched: boolean,
  checks: TraceEntry[],
  matchedTrigger?: number,
  summary?: string,
): WorkflowDecision {
  return {
    workflowName,
    matched,
    matchedTrigger,
    checks,
    summary: summary ?? (matched ? 'Trigger conditions met' : 'No matching trigger'),
  };
}
