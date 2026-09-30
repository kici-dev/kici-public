/**
 * Which files an event changed, expressed as a git range.
 *
 * The one definition the orchestrator's changed-files fetchers and the agent's
 * clone diff share, so both layers reach the same answer from the same event.
 * Pure — no I/O and no `node:*` import — because the engine barrel is
 * browser-safe.
 */
import { z } from 'zod';

export const diffRangeKindSchema = z.enum(['two-dot', 'new-branch', 'deleted', 'pr', 'none']);
export type DiffRangeKind = z.infer<typeof diffRangeKindSchema>;

const Kind = diffRangeKindSchema.enum;

export type DiffRange =
  /** `git diff base..head` — a push to an existing branch. */
  | { kind: (typeof Kind)['two-dot']; base: string; head: string }
  /** Three-dot `defaultBranch...head` — the files a new branch adds. */
  | { kind: (typeof Kind)['new-branch']; defaultBranch: string; head: string }
  /** A deleted branch: no files changed. */
  | { kind: typeof Kind.deleted }
  /** Three-dot `base...HEAD` — a pull request. */
  | { kind: typeof Kind.pr; base: string }
  /** No range exists: nobody can compute a diff for this event. */
  | { kind: typeof Kind.none };

/** The event fields a range is read from; `SimulatedEvent` and the SDK `EventPayload` both fit. */
export interface DiffRangeEvent {
  type: string;
  targetBranch?: string;
  baseBranch?: string;
  defaultBranch?: string;
  payload?: Record<string, unknown>;
}

const ZERO_SHA_RE = /^0+$/;

/** Whether a SHA is git's all-zero placeholder (a created or deleted ref). */
export function isZeroSha(sha: string): boolean {
  return ZERO_SHA_RE.test(sha);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function defaultBranchOf(event: DiffRangeEvent): string | undefined {
  if (event.defaultBranch) return event.defaultBranch;
  const repository = event.payload?.repository;
  if (repository === null || typeof repository !== 'object') return undefined;
  return nonEmptyString((repository as Record<string, unknown>).default_branch);
}

/** The git range an event changed, or `none` when no diff exists anywhere. */
export function resolveDiffRange(event: DiffRangeEvent): DiffRange {
  if (event.type === 'pull_request') {
    const base = event.baseBranch ?? event.targetBranch;
    return base ? { kind: Kind.pr, base } : { kind: Kind.none };
  }
  if (event.type !== 'push') return { kind: Kind.none };

  const before = nonEmptyString(event.payload?.before);
  const after = nonEmptyString(event.payload?.after);
  if (!before || !after) return { kind: Kind.none };
  if (isZeroSha(after)) return { kind: Kind.deleted };
  if (!isZeroSha(before)) return { kind: Kind['two-dot'], base: before, head: after };

  const defaultBranch = defaultBranchOf(event);
  if (!defaultBranch || defaultBranch === event.targetBranch) return { kind: Kind.none };
  return { kind: Kind['new-branch'], defaultBranch, head: after };
}

/** Whether a range lets an agent compute the diff the orchestrator could not. */
export function isDeferrableRange(range: DiffRange): boolean {
  return (
    range.kind === Kind['two-dot'] || range.kind === Kind['new-branch'] || range.kind === Kind.pr
  );
}
