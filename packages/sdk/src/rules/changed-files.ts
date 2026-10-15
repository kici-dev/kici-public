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
 * `changedFiles` **throws** when the diff is unavailable rather than reading as
 * empty: a path gate that sees no changes suppresses work invisibly, and a
 * `filter` suppresses every job — leaving no run row on the organization-wide
 * path, or a `success` run with only `__init__*` jobs on the same-repo path.
 *
 * One shared getter, because a plain `{ changedFiles: [] }` satisfies both
 * context types and would still typecheck. Every builder of either context
 * calls this.
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
