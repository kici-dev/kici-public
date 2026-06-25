import type {
  Step,
  StepOptions,
  StepOptionsPlain,
  StepOptionsWithCheck,
  StepRunFn,
  SourceLocation,
  RetryConfig,
  NormalizedRetry,
} from './types.js';
import { createStepOutputProxy } from './outputs.js';
import { normalizeApproval } from './approval.js';

/**
 * Fill retry defaults and expand the `retry: N` shorthand into a
 * {@link NormalizedRetry}. `retryIf` is carried through unchanged (it is
 * execution-only and never serialized).
 */
function normalizeRetry(retry: number | RetryConfig | undefined): NormalizedRetry | undefined {
  if (retry === undefined) return undefined;
  const cfg = typeof retry === 'number' ? { maxAttempts: retry } : retry;
  return {
    maxAttempts: cfg.maxAttempts,
    delayMs: cfg.delayMs ?? 1000,
    backoff: cfg.backoff ?? 'exponential',
    maxDelayMs: cfg.maxDelayMs ?? 30000,
    ...(cfg.retryIf && { retryIf: cfg.retryIf }),
  };
}

/**
 * Capture the call-site source location of step() using the V8 stack trace API.
 * Uses Error.captureStackTrace with the `step` function as the constructor argument
 * so the stack starts from step()'s caller.
 *
 * @returns SourceLocation or undefined if parsing fails
 */
function captureCallSite(): SourceLocation | undefined {
  const originalLimit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = 4;
    const err: { stack?: string } = {};
    // Use captureCallSite as the constructor function so the stack starts at step() (its caller).
    // Frame 0 = step(), Frame 1 = step()'s caller (the actual call site we want).
    Error.captureStackTrace(err, captureCallSite);
    const stack = err.stack;
    if (!stack) return undefined;

    // Stack: "Error\n    at step (...)\n    at callSite (...)\n..."
    // Skip lines[0] ("Error") and lines[1] (step() frame), parse lines[2] (call site).
    const lines = stack.split('\n');
    // Start at index 2 to skip "Error" header and the step() frame
    for (let i = 2; i < lines.length; i++) {
      const line = lines[i].trim();
      const match = line.match(/\((.+):(\d+):(\d+)\)$/) || line.match(/^at (.+):(\d+):(\d+)$/);
      if (match) {
        let file = match[1];
        if (file.startsWith('file://')) {
          file = file.slice(7);
        }
        return {
          file,
          line: parseInt(match[2], 10),
          column: parseInt(match[3], 10),
        };
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    Error.stackTraceLimit = originalLimit;
  }
}

/**
 * Create an id-less step with just a run function.
 * The compiler assigns a counter-based ID (step-1, step-2, etc.) at lock file generation.
 *
 * @example
 * const s = step(async (ctx) => {
 *   await ctx.$`echo hello`;
 * });
 */
export function step<TResult = void>(
  run: (ctx: import('./context.js').StepContext) => Promise<TResult>,
): Step<TResult>;

/**
 * Create an id-less step with full options.
 * The compiler assigns a counter-based ID at lock file generation.
 *
 * @example
 * const s = step({
 *   run: async (ctx) => {
 *     return { version: '1.0.0' };
 *   },
 *   timeout: 60000,
 * });
 */
export function step<TResult = void>(options: StepOptions<TResult>): Step<TResult>;

/**
 * Create a named step with just a run function (no outputs).
 *
 * @example
 * const checkout = step('checkout', async (ctx) => {
 *   await ctx.$`git checkout`;
 * });
 */
export function step(name: string, run: StepRunFn): Step<void>;

/**
 * Create a named step with full options and generic return type.
 *
 * @example
 * const build = step('build', {
 *   outputs: {
 *     version: z.string(),
 *     artifacts: z.array(z.string()),
 *   },
 *   run: async (ctx) => {
 *     await ctx.$`pnpm build`;
 *     return { version: '1.0.0', artifacts: ['dist/main.js'] };
 *   }
 * });
 */
export function step<TResult = void>(name: string, options: StepOptions<TResult>): Step<TResult>;

/**
 * Create a named idempotent step with a check facet.
 *
 * `check` returns a drift value (or null when in sync); `run` becomes the apply
 * function and receives that drift; `summarize` renders the drift for logs and
 * the dashboard. `whenInSync` optionally produces the outputs when already in sync.
 *
 * @example
 * const nginx = step('configure-nginx', {
 *   check: async (ctx) => (await inSync(ctx)) ? null : { want: DESIRED },
 *   summarize: (drift) => `would rewrite nginx.conf (${drift.want.length} bytes)`,
 *   run: async (ctx, drift) => { await writeConfig(drift.want); return { reloaded: true }; },
 *   whenInSync: async () => ({ reloaded: false }),
 * });
 */
export function step<TResult = void, TDrift = unknown>(
  name: string,
  options: StepOptionsWithCheck<TResult, TDrift>,
): Step<TResult>;

/**
 * Create an id-less idempotent step with a check facet.
 */
export function step<TResult = void, TDrift = unknown>(
  options: StepOptionsWithCheck<TResult, TDrift>,
): Step<TResult>;

/**
 * Implementation of step() factory.
 * Discriminates overloads by first arg type:
 * - string => named variant (existing)
 * - function => id-less simple (wrap as { run: fn }, name = '')
 * - object => id-less full options (name = '')
 */
export function step<TResult = void, TDrift = unknown>(
  nameOrRunOrOptions:
    | string
    | ((ctx: import('./context.js').StepContext) => Promise<TResult>)
    | StepOptions<TResult, TDrift>,
  runOrOptions?: StepRunFn | StepOptions<TResult, TDrift>,
): Step<TResult> {
  // Capture call-site before any other work
  const _sourceLocation = captureCallSite();

  let name: string;
  let options: StepOptions<TResult, TDrift>;

  if (typeof nameOrRunOrOptions === 'string') {
    // Named variant: step(name, run) or step(name, options)
    name = nameOrRunOrOptions;
    options =
      typeof runOrOptions === 'function'
        ? ({ run: runOrOptions as StepOptionsPlain<TResult>['run'] } as StepOptions<
            TResult,
            TDrift
          >)
        : runOrOptions!;
  } else if (typeof nameOrRunOrOptions === 'function') {
    // Id-less simple: step(run)
    name = '';
    options = {
      run: nameOrRunOrOptions as StepOptionsPlain<TResult>['run'],
    } as StepOptions<TResult, TDrift>;
  } else {
    // Id-less full options: step(options)
    name = '';
    options = nameOrRunOrOptions;
  }

  // Idempotent invariant: summarize is mandatory whenever a check facet is declared.
  if (options.check && !options.summarize) {
    throw new Error('summarize is required when check is set');
  }

  // Drift gate invariant: `approval: { when: 'drift' }` fires between a step's
  // check and run, so it only makes sense on a step that has a check facet.
  if (
    options.approval !== undefined &&
    normalizeApproval(options.approval).when === 'drift' &&
    !options.check
  ) {
    throw new Error('approval.when "drift" requires a check facet');
  }

  const retry = normalizeRetry(options.retry);

  return {
    _tag: 'Step' as const,
    name,
    outputs: options.outputs,
    run: options.run,
    ...(options.check !== undefined && { check: options.check }),
    ...(options.summarize !== undefined && { summarize: options.summarize }),
    ...(options.drift !== undefined && { drift: options.drift }),
    ...(options.whenInSync !== undefined && { whenInSync: options.whenInSync }),
    continueOnError: options.continueOnError,
    timeout: options.timeout,
    ...(retry !== undefined && { retry }),
    ...(options.cache !== undefined && { cache: options.cache }),
    rules: options.rules,
    onCancel: options.onCancel,
    cleanup: options.cleanup,
    ...(options.approval !== undefined && { approval: options.approval }),
    _sourceLocation,
    result: createStepOutputProxy(name),
  } as Step<TResult>;
}
