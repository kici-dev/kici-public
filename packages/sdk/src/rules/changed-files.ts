import type { ChangedFilesStatus } from '@kici-dev/engine';

/**
 * Thrown when a rule or a workflow `filter` reads `ctx.changedFiles` but the
 * diff is not available (`changedFilesStatus !== 'fetched'`). `evaluateRules`
 * re-throws this rather than folding it into a `passed=false` skip, so the job
 * fails loudly instead of silently mis-evaluating a path-based gate; the global
 * eval round reports the candidate indeterminate for the same reason.
 */
export class ChangedFilesUnavailableError extends Error {
  readonly changedFilesStatus: ChangedFilesStatus;
  readonly eventType?: string;

  constructor(status: ChangedFilesStatus, eventType?: string) {
    super(
      `ctx.changedFiles is not available (status: ${status}` +
        (eventType ? `, event: ${eventType}` : '') +
        `). Changed files are only defined for push / pull_request events with a ` +
        `computable diff. Guard with ctx.changedFilesStatus before accessing, e.g. ` +
        `\`if (ctx.changedFilesStatus !== 'fetched') return true\`.`,
    );
    this.name = 'ChangedFilesUnavailableError';
    this.changedFilesStatus = status;
    this.eventType = eventType;
  }
}

/** Read an event's `type` discriminant, when it carries a string one. */
export function eventTypeOf(event: unknown): string | undefined {
  const type = (event as { type?: unknown } | null | undefined)?.type;
  return typeof type === 'string' ? type : undefined;
}

/**
 * Install the throwing `changedFiles` accessor shared by `RuleContext` and
 * `FilterContext`.
 *
 * Both contexts contract `changedFiles` to **throw** when the diff is
 * unavailable rather than read as an empty list: a path-based gate that
 * silently sees no changes suppresses work invisibly, and for a `filter` it
 * suppresses every job the workflow declares. On the organization-wide path
 * that leaves no run row at all; on the same-repo path it leaves a `success`
 * run carrying only the workflow's `__init__*` evaluation jobs.
 *
 * The behaviour lives here, in one `Object.defineProperty`, precisely because a
 * plain `{ changedFiles: [] }` property satisfies both context types with no
 * error anywhere: a second construction site could violate the contract and
 * still typecheck. Every builder of either context calls this.
 */
export function defineChangedFilesGetter(
  target: object,
  input: { files: string[]; status: ChangedFilesStatus; eventType?: string },
): void {
  Object.defineProperty(target, 'changedFiles', {
    enumerable: true,
    configurable: true,
    get(): string[] {
      if (input.status !== 'fetched') {
        throw new ChangedFilesUnavailableError(input.status, input.eventType);
      }
      return input.files;
    },
  });
}
