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
 * Create a new trace entry.
 */
export function createTraceEntry(
  check: string,
  pattern: string,
  value: string,
  passed: boolean,
  reason?: string,
): TraceEntry {
  return { check, pattern, value, passed, reason };
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

/** Max characters of the message recorded in a trace, so an essay-length body stays bounded. */
const TRACE_TEXT_MAX = 200;

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
