import { $ } from 'zx';
import type { ChangedFilesStatus } from '@kici-dev/engine';
import type { EventPayload } from '../events/event-payloads.js';
import type { FanoutPosition } from '../fanout-context.js';
import type { RuleContext } from './types.js';

/**
 * Thrown when a rule reads `ctx.changedFiles` but the diff is not available
 * (`changedFilesStatus !== 'fetched'`). `evaluateRules` re-throws this rather
 * than folding it into a `passed=false` skip, so the job fails loudly instead
 * of silently mis-evaluating a path-based gate.
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

/** Input for {@link createRuleContext}. */
export interface CreateRuleContextInput {
  event: EventPayload | Record<string, unknown>;
  changedFiles?: string[];
  /** Defaults to `'fetched'` — a caller that passes a real list needs no status. */
  changedFilesStatus?: ChangedFilesStatus;
  env?: Record<string, string | undefined>;
  dispatchInputs?: Readonly<Record<string, string | number | boolean | null>>;
  fanout?: FanoutPosition;
}

/**
 * Build a RuleContext. `changedFiles` is exposed as a getter: it returns the
 * list when `changedFilesStatus === 'fetched'`, otherwise it throws
 * `ChangedFilesUnavailableError`. This is the single construction site for a
 * rule context across the agent, the compiler test-runner, and tests.
 */
export function createRuleContext(input: CreateRuleContextInput): RuleContext {
  const status: ChangedFilesStatus = input.changedFilesStatus ?? 'fetched';
  const files = input.changedFiles ?? [];
  const eventType =
    typeof (input.event as { type?: unknown }).type === 'string'
      ? (input.event as { type: string }).type
      : undefined;

  const base: Omit<RuleContext, 'changedFiles'> = {
    event: input.event as EventPayload,
    changedFilesStatus: status,
    env: input.env ?? {},
    dispatchInputs: input.dispatchInputs ?? {},
    ...(input.fanout && { fanout: input.fanout }),
    $,
  };

  Object.defineProperty(base, 'changedFiles', {
    enumerable: true,
    configurable: true,
    get(): string[] {
      if (status !== 'fetched') throw new ChangedFilesUnavailableError(status, eventType);
      return files;
    },
  });

  return base as RuleContext;
}
