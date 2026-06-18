import type { Step, StepOptions, StepRunFn, SourceLocation } from './types.js';
import { createStepOutputProxy } from './outputs.js';

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
 * Implementation of step() factory.
 * Discriminates overloads by first arg type:
 * - string => named variant (existing)
 * - function => id-less simple (wrap as { run: fn }, name = '')
 * - object => id-less full options (name = '')
 */
export function step<TResult = void>(
  nameOrRunOrOptions:
    | string
    | ((ctx: import('./context.js').StepContext) => Promise<TResult>)
    | StepOptions<TResult>,
  runOrOptions?: StepRunFn | StepOptions<TResult>,
): Step<TResult> {
  // Capture call-site before any other work
  const _sourceLocation = captureCallSite();

  let name: string;
  let options: StepOptions<TResult>;

  if (typeof nameOrRunOrOptions === 'string') {
    // Named variant: step(name, run) or step(name, options)
    name = nameOrRunOrOptions;
    options =
      typeof runOrOptions === 'function'
        ? { run: runOrOptions as unknown as StepOptions<TResult>['run'] }
        : runOrOptions!;
  } else if (typeof nameOrRunOrOptions === 'function') {
    // Id-less simple: step(run)
    name = '';
    options = { run: nameOrRunOrOptions as unknown as StepOptions<TResult>['run'] };
  } else {
    // Id-less full options: step(options)
    name = '';
    options = nameOrRunOrOptions;
  }

  return {
    _tag: 'Step' as const,
    name,
    outputs: options.outputs,
    run: options.run,
    continueOnError: options.continueOnError,
    timeout: options.timeout,
    ...(options.cache !== undefined && { cache: options.cache }),
    rules: options.rules,
    onCancel: options.onCancel,
    cleanup: options.cleanup,
    ...(options.requireApproval !== undefined && { requireApproval: options.requireApproval }),
    _sourceLocation,
    result: createStepOutputProxy(name),
  } as Step<TResult>;
}
