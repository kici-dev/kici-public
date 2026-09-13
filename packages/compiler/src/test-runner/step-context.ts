import type { StepContext, WorkflowInfo, JobInfo, MatrixValues, Logger } from '@kici-dev/sdk';
import { createTestStepContext } from '@kici-dev/sdk/testing';
import { formatter } from './output-formatter.js';

/**
 * Create a logger that prefixes output with the job name.
 */
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
      // Only log debug if --debug flag is set (checked via KICI_DEBUG env var)
      if (process.env.KICI_DEBUG === 'true') {
        const formatted = args.length > 0 ? `${message} ${args.join(' ')}` : message;
        formatter.logJobLine(jobName, `[debug] ${formatted}`);
      }
    },
  };
}

/** Handle returned by {@link createStepContext}. */
export interface LocalStepContext {
  /** The built step context, threaded into every step of the job. */
  ctx: StepContext;
  /**
   * Drain the job's temp scope (and secrets state). Call once at job end —
   * success, failure, or throw — to reclaim every `ctx.mktemp`/`ctx.mktempFile`
   * allocation the job made. Delegates to the shared builder's `dispose`.
   */
  dispose: () => Promise<void>;
}

/**
 * Create a step context for local test execution.
 *
 * `repoRoot` pins `ctx.$` to the workflow's repository root so steps running via
 * local-dispatch behave the same as on the agent path (see
 * `packages/agent/src/execution/sandbox/workflow-runner.ts`). Without this,
 * `ctx.$` would inherit `process.cwd()` — i.e. wherever the user invoked `kici`
 * — which silently breaks any step that uses relative paths.
 *
 * This is a thin adapter over the shared `@kici-dev/sdk/testing` builder — the
 * single source of truth for constructing a test step context — supplying the
 * local runner's formatter-backed logger. The shared builder owns the
 * job-scoped temp allocator backing `ctx.mktemp`/`ctx.mktempFile`; the returned
 * `dispose` surfaces its drain so the caller (`executeJob`) can reclaim the
 * job's temp dirs at job end rather than only via the exit backstop.
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
