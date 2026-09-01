/**
 * Decision trace recording for debugging trigger matching.
 * Records every check performed during trigger evaluation.
 */

import { describeTextMatch } from './text-match.js';
import type { LockTextMatch } from './types.js';

/**
 * Individual trace entry for a single check.
 */
export interface TraceEntry {
  /** What was checked (e.g., "branch pattern", "path filter", "event type") */
  check: string;
  /** The pattern/condition that was evaluated */
  pattern: string;
  /** The value being tested against */
  value: string;
  /** Whether the check passed */
  passed: boolean;
  /** Optional explanation */
  reason?: string;
}

/**
 * Decision trace for a workflow's trigger evaluation.
 */
export interface WorkflowDecision {
  workflowName: string;
  matched: boolean;
  /** Which trigger matched (if any) */
  matchedTrigger?: number;
  /** All checks performed */
  checks: TraceEntry[];
  /** Summary reason */
  summary: string;
}

/**
 * Max characters of any free-text field a trace entry carries, so an
 * essay-length input stays bounded.
 *
 * The entry count is capped separately, downstream, but a count bound alone
 * bounds nothing: a single `paths` entry names every changed file in the push
 * and a single `bodyMatch` entry quotes a comment body an outsider authored, so
 * fifty entries can still be megabytes. The forwarded trace rides one WebSocket
 * frame to the Platform, and a frame past the server's payload ceiling closes
 * the connection — stalling every delivery for that organization until it
 * reconnects. Bounding at the point each field is minted is what makes the
 * downstream size guards a backstop rather than the only limit.
 */
export const TRACE_TEXT_MAX = 200;

/** Clamp one free-text trace field, marking a clamped value with an ellipsis. */
export function truncateTraceText(text: string): string {
  return text.length > TRACE_TEXT_MAX ? `${text.slice(0, TRACE_TEXT_MAX)}…` : text;
}

/**
 * Create a new trace entry.
 *
 * Every free-text field is clamped here rather than at each call site: the
 * fields are fed from event content of unbounded size, and one unclamped call
 * site is enough to reintroduce an unbounded frame.
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
 * The other trigger checks are minted with free-text labels because each one
 * names the trigger field it read. These are named constants instead: they are
 * recorded in one package and read back in another — by code, and by whoever is
 * asking "why did nothing run?" — so a typo on either side would silently
 * produce a trace nobody can search for.
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
 * Verdict vocabulary shared by both gates.
 *
 * `Indeterminate` is deliberately distinct from `Excluded`: a gate that could
 * not be evaluated did not decide anything, and reporting it as an exclusion
 * would tell a workflow author their filter said no when nothing ever ran it.
 */
export const TraceVerdict = {
  Matched: 'matched',
  Excluded: 'excluded',
  Indeterminate: 'indeterminate',
} as const;
export type TraceVerdict = (typeof TraceVerdict)[keyof typeof TraceVerdict];

/** Pick the verdict for a gate from its pass flag and whether it could decide. */
function verdictFor(passed: boolean, indeterminate: boolean): TraceVerdict {
  if (indeterminate) return TraceVerdict.Indeterminate;
  return passed ? TraceVerdict.Matched : TraceVerdict.Excluded;
}

/**
 * Record the Tier-1 `requires` content filter's verdict for one workflow.
 *
 * `files` is the set of repo-relative paths the requirement list reads, so the
 * entry names what was inspected as well as what it concluded.
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
 * Without this entry a `filter` exclusion is invisible: the predicate runs on an
 * agent, returns `false`, and the workflow simply never appears — leaving its
 * author nothing to inspect. The entry is the answer to "why did nothing run?".
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
 * A workflow whose triggers matched and whose build then threw is absent from
 * every other record: no run row is created and no job is queued. Omitting it
 * from the trace as well leaves its author unable to tell it apart from a
 * workflow that was never registered — the exact indistinguishability the trace
 * exists to remove.
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
 * A decision is treated as a value, never mutated in place: the same object is
 * read by the caller that recorded it, and a gate appending to it would
 * retroactively rewrite what an earlier reader saw.
 *
 * A failing appended entry demotes `matched` and replaces `summary`, because a
 * workflow whose triggers matched but whose content filter excluded it did NOT
 * match overall — reporting it as matched is precisely the invisible outcome
 * these entries exist to explain.
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
 * `text: undefined` means the event carried no message — an INDETERMINATE
 * verdict, deliberately distinct from an exclusion: reporting it as "excluded"
 * would tell an author their filter said no when nothing ever read it.
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
 * Lives here rather than beside the Platform's redactor because three packages
 * read it: the Platform writes it, the dashboard renders it, and the E2E suite
 * asserts the permission boundary against it. A literal repeated at each site
 * would drift into a marker one of them no longer recognizes.
 */
export const REDACTED_TRACE_FIELD = '[redacted — requires event_log:read_payload]';

/**
 * Workflow name the truncation marker carries.
 *
 * A reserved sentinel rather than a real workflow: it is written by one package
 * and read back by two others, so a literal repeated at each site would drift
 * into a marker nobody recognizes.
 */
export const TRACE_TRUNCATION_WORKFLOW_NAME = '(trace truncated)';

/**
 * Build the marker that stands in for the decisions a size budget dropped.
 *
 * The trace is truncated rather than discarded: a reader who is told nothing
 * cannot tell "matching never ran" from "the trace was too large to keep", and
 * those two have opposite answers to "why did my workflow not fire".
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
 * UTF-8 byte length of `text`.
 *
 * Byte length, never `String.length`: the latter counts UTF-16 code units, so a
 * CJK-heavy comment body measures at roughly a third of the bytes it actually
 * costs on the wire and in the stored row.
 */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Drop trailing decisions until the serialized array fits `maxBytes`, appending
 * a marker naming how many were dropped.
 *
 * Shared by the orchestrator, which bounds what it puts on the wire, and the
 * Platform, which bounds what it stores. Two independent budgets over one
 * shape: keeping one implementation is what stops them from disagreeing about
 * what a truncated trace looks like.
 */
export function truncateDecisionsToByteBudget<T>(
  decisions: readonly T[],
  maxBytes: number,
): { decisions: Array<T | Record<string, unknown>>; omitted: number } {
  if (utf8ByteLength(JSON.stringify(decisions)) <= maxBytes) {
    return { decisions: [...decisions], omitted: 0 };
  }

  // The marker's own size depends on the count it reports, so reserve the
  // worst case (every decision dropped) rather than discovering a one-entry
  // overrun after the fact.
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

/**
 * Create a workflow decision record.
 */
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
