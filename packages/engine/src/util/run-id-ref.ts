/**
 * A run id as a person types it: a full UUID, or the leading characters of one (the
 * short form shown in issue reports and dashboards, like a git short SHA).
 */

/** Fewest hex characters a run id prefix may have, as for a git short SHA. */
export const RUN_ID_PREFIX_MIN_LENGTH = 4;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]+$/;
const UUID_HEX_LENGTH = 32;

export type RunIdRef =
  /** A full run id, lowercased. */
  | { kind: 'uuid'; runId: string }
  /** The leading hex digits of a run id, lowercased, hyphens removed. */
  | { kind: 'prefix'; hex: string }
  /** Neither; `reason` says why, for the error the caller prints. */
  | { kind: 'invalid'; reason: string };

/** True for a full run id (a UUID). */
export function isRunId(value: string): boolean {
  return UUID_RE.test(value);
}

/** Classify what a person typed as a run id. */
export function parseRunIdRef(input: string): RunIdRef {
  const ref = input.trim();
  if (UUID_RE.test(ref)) return { kind: 'uuid', runId: ref.toLowerCase() };
  const hex = ref.toLowerCase().replaceAll('-', '');
  if (hex.length === 0 || !HEX_RE.test(hex) || hex.length > UUID_HEX_LENGTH) {
    return { kind: 'invalid', reason: 'a run id is a UUID, or its first characters' };
  }
  if (hex.length < RUN_ID_PREFIX_MIN_LENGTH) {
    return {
      kind: 'invalid',
      reason: `a run id prefix needs at least ${RUN_ID_PREFIX_MIN_LENGTH} characters`,
    };
  }
  return { kind: 'prefix', hex };
}

function formatUuid(hex32: string): string {
  return [
    hex32.slice(0, 8),
    hex32.slice(8, 12),
    hex32.slice(12, 16),
    hex32.slice(16, 20),
    hex32.slice(20),
  ].join('-');
}

/**
 * The inclusive UUID range of every run id that starts with `hex`. A UUID column
 * compares byte by byte, so `run_id BETWEEN low AND high` reads the primary-key
 * index instead of casting every row to text.
 */
export function runIdPrefixRange(hex: string): { low: string; high: string } {
  return {
    low: formatUuid(hex.padEnd(UUID_HEX_LENGTH, '0')),
    high: formatUuid(hex.padEnd(UUID_HEX_LENGTH, 'f')),
  };
}

/** True when `runId` starts with the hex digits of a prefix ref. */
export function runIdHasPrefix(runId: string, hex: string): boolean {
  return runId.toLowerCase().replaceAll('-', '').startsWith(hex);
}

/** The error for text that cannot be a run id; `findHint` names where full ids are. */
export function invalidRunIdMessage(ref: string, reason: string, findHint: string): string {
  return (
    `Invalid run id '${ref}': ${reason}. Pass a full run id, or its first ` +
    `${RUN_ID_PREFIX_MIN_LENGTH} or more characters (${findHint}).`
  );
}

/**
 * The one run id among `matches` (the run ids that start with `ref`), or an error
 * naming the matches when there are several, or saying none matched. `unseen` counts
 * matches the caller knows of but did not fetch.
 */
export function pickRunIdMatch(args: {
  ref: string;
  matches: readonly string[];
  unseen: number;
  findHint: string;
}): string {
  const { ref, matches, unseen, findHint } = args;
  if (matches.length === 1 && unseen === 0) return matches[0]!;
  if (matches.length === 0) throw new Error(`No run id starts with '${ref}' (${findHint}).`);
  const more = unseen > 0 ? `, and ${unseen} more` : '';
  throw new Error(
    `Run id prefix '${ref}' is ambiguous: it matches ${matches.join(', ')}${more}. ` +
      'Type more characters of the run id.',
  );
}
