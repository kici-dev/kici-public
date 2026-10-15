import type { StepContext, WorkflowInfo, JobInfo, MatrixValues, Logger } from '@kici-dev/sdk';
import { createTestStepContext } from '@kici-dev/sdk/testing';
import { formatter } from './output-formatter.js';

/** Prefixes output with the job name. */
function createTestLogger(jobName: string): Logger {
  return {
    info: (message: string, ...args: unknown[]) => {
      const formatted = args.length > 0 ? `${message} ${args.join(' ')}` : message;
      formatter.logJobLine(jobName, formatted);
    },
    warn: (message: string, ...args: unknown[]) => {
      const formatted = args.length > 0 ? `${message} ${args.join(' ')}` : message;
      formatter.logJobLine(jobName, `⚠ ${formatted}`);
    },
    error: (message: string, ...args: unknown[]) => {
      const formatted = args.length > 0 ? `${message} ${args.join(' ')}` : message;
      formatter.logJobLine(jobName, `✗ ${formatted}`);
    },
    debug: (message: string, ...args: unknown[]) => {
      // --debug sets KICI_DEBUG.
      if (process.env.KICI_DEBUG === 'true') {
        const formatted = args.length > 0 ? `${message} ${args.join(' ')}` : message;
        formatter.logJobLine(jobName, `[debug] ${formatted}`);
      }
    },
  };
}

export interface LocalStepContext {
  /** Threaded into every step of the job. */
  ctx: StepContext;
  /**
   * Drains the job's temp scope and secrets state. Call once at job end —
   * success, failure or throw — to reclaim every `ctx.mktemp`/`ctx.mktempFile`.
   */
  dispose: () => Promise<void>;
}

/**
 * A thin adapter over the shared `@kici-dev/sdk/testing` builder, the single
 * source of truth for test step contexts, supplying the formatter-backed logger.
 *
 * `repoRoot` pins `ctx.$` to the repository root, as on the agent path
 * (`packages/agent/src/execution/sandbox/workflow-runner.ts`); otherwise it
 * inherits wherever the user invoked `kici`, which breaks relative paths. The
 * returned `dispose` lets `executeJob` reclaim temp dirs at job end, not only
 * via the exit backstop.
 */
export function createStepContext(
  workflowInfo: WorkflowInfo,
  jobInfo: JobInfo,
  repoRoot: string,
  inputs: Record<string, unknown> = {},
  matrix?: MatrixValues,
  testSecrets?: { flat: Record<string, string>; contexts: Record<string, Record<string, string>> },
  context?: string,
  rawPayload?: Record<string, unknown>,
  provider?: string,
  dispatchInputs: Readonly<Record<string, string | number | boolean | null>> = {},
  signal: AbortSignal = new AbortController().signal,
): LocalStepContext {
  const { ctx, dispose } = createTestStepContext({
    workflow: workflowInfo,
    job: jobInfo,
    repoRoot,
    inputs,
    dispatchInputs,
    signal,
    log: createTestLogger(jobInfo.name),
    secrets: testSecrets,
    ...(matrix !== undefined && { matrix }),
    ...(context !== undefined && { context }),
    ...(rawPayload !== undefined && { rawPayload }),
    ...(provider !== undefined && { provider }),
  });
  return { ctx, dispose };
}
