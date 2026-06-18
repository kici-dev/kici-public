/**
 * SDK wait-for helpers for workflow authors.
 *
 * Workflows often need to pause until an external condition becomes
 * true — a resource finishes provisioning, a file appears on disk, an
 * HTTP endpoint returns a healthy response, an external job reaches a
 * terminal state. The helpers in this file express that pattern with
 * the same shape as `idempotent` / `idempotentStep`:
 *
 * - `check()` returns the resolved value when the condition is met, or
 *   `null` to keep polling.
 * - Optional `onSuccess(value)` runs once after the wait succeeds; its
 *   return value becomes the step result.
 * - Optional `onTimeout({ elapsedMs, attempts })` runs if the deadline
 *   is exceeded; its return value becomes the step result. If absent,
 *   the helper throws a typed `WaitForTimeoutError` so the step fails.
 * - Errors thrown by `check()` are swallowed by default (matching the
 *   "poll-until-healthy" pattern). Opt out via `swallowErrors: false`.
 *
 * Cancellation: the helper has no `AbortSignal` plumbing. A `check()`
 * that takes longer than `intervalMs` is not aborted mid-flight; the
 * loop only inspects the deadline at the top of each iteration. The
 * step's own `timeout` field is the hard kill.
 *
 * Two entry points:
 *
 * - `waitFor(options)` — generic helper callable from any step, hook,
 *   or bare async function. Resolves to the discriminated result.
 * - `waitForStep(name, options)` — factory returning an SDK `Step`
 *   whose run function executes `waitFor(...)` and propagates status
 *   lines into `ctx.log.info`.
 */

import { step } from './step.js';
import type { Step } from './types.js';
import type { StepContext } from './context.js';

export interface WaitForOptions<TValue, TSuccess = void, TTimeout = void> {
  /** Optional name surfaced in status lines and the timeout error. */
  name?: string;
  /** Polled inspection. Return the resolved value when the condition
   *  is met, or `null` to keep polling. */
  check: () => Promise<TValue | null>;
  /** Time between successive `check()` invocations, in milliseconds.
   *  Defaults to 2000. */
  intervalMs?: number;
  /** Total time budget for the wait, in milliseconds. Defaults to
   *  60000. The deadline is inspected at the top of each iteration. */
  timeoutMs?: number;
  /** Time to wait before the first `check()` invocation, in
   *  milliseconds. Defaults to 0. */
  initialDelayMs?: number;
  /** Optional success action. Runs once after `check()` returns a
   *  non-null value. Its return value is surfaced as `result` on the
   *  'succeeded' outcome. */
  onSuccess?: (value: TValue) => Promise<TSuccess>;
  /** Optional timeout action. Runs when the deadline is exceeded. Its
   *  return value is surfaced as `result` on the 'timed-out' outcome.
   *  When omitted, the helper throws a `WaitForTimeoutError` instead. */
  onTimeout?: (info: { elapsedMs: number; attempts: number }) => Promise<TTimeout>;
  /** When `true` (default), errors thrown by `check()` are logged and
   *  swallowed so polling continues. When `false`, the first error
   *  propagates out of the helper. */
  swallowErrors?: boolean;
  /** Sink for status lines. Defaults to console.log. */
  log?: (line: string) => void;
}

/**
 * The discriminated result of a `waitFor` invocation. Narrow on
 * `outcome` to read the correct branch.
 */
export type WaitForResult<TValue, TSuccess = void, TTimeout = void> =
  | {
      outcome: 'succeeded';
      value: TValue;
      elapsedMs: number;
      attempts: number;
      result: TSuccess;
    }
  | {
      outcome: 'timed-out';
      elapsedMs: number;
      attempts: number;
      result: TTimeout;
    };

/**
 * Thrown by `waitFor` when the deadline is exceeded and no
 * `onTimeout` callback was supplied. The instance fields expose the
 * wait stats so callers can branch on them in a catch block.
 */
export class WaitForTimeoutError extends Error {
  /** The step name supplied via `WaitForOptions.name` (or 'waitFor'). */
  readonly stepName: string;
  /** Wall-clock duration of the wait, in milliseconds. */
  readonly elapsedMs: number;
  /** Number of `check()` invocations that ran before the timeout. */
  readonly attempts: number;

  constructor(stepName: string, elapsedMs: number, attempts: number) {
    super(`${stepName}: timed out after ${elapsedMs}ms (attempts=${attempts})`);
    this.name = 'WaitForTimeoutError';
    this.stepName = stepName;
    this.elapsedMs = elapsedMs;
    this.attempts = attempts;
  }
}

const DEFAULT_NAME = 'waitFor';
const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 60000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCheckOnce<TValue>(
  check: () => Promise<TValue | null>,
  swallowErrors: boolean,
  log: (line: string) => void,
  name: string,
  attempt: number,
): Promise<{ value: TValue | null }> {
  try {
    const value = await check();
    return { value };
  } catch (err) {
    if (!swallowErrors) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    log(`! ${name} — attempt ${attempt} error swallowed: ${msg}`);
    return { value: null };
  }
}

/**
 * Generic wait-for helper for use inside any step, hook, or bare
 * async function. Polls `check()` on a fixed interval until it returns
 * a non-null value or the deadline is exceeded.
 */
export async function waitFor<TValue, TSuccess = void, TTimeout = void>(
  opts: WaitForOptions<TValue, TSuccess, TTimeout>,
): Promise<WaitForResult<TValue, TSuccess, TTimeout>> {
  const name = opts.name ?? DEFAULT_NAME;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const initialDelayMs = opts.initialDelayMs ?? 0;
  const swallowErrors = opts.swallowErrors ?? true;
  const log = opts.log ?? ((line: string) => console.log(line));

  log(`→ ${name} — waiting (timeout=${timeoutMs}ms, interval=${intervalMs}ms)`);

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  if (initialDelayMs > 0) {
    await sleep(initialDelayMs);
  }

  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    const { value } = await runCheckOnce<TValue>(opts.check, swallowErrors, log, name, attempts);

    if (value !== null) {
      const elapsedMs = Date.now() - startedAt;
      log(`✓ ${name} — succeeded after ${elapsedMs}ms (attempts=${attempts})`);
      const result = opts.onSuccess ? await opts.onSuccess(value) : (undefined as TSuccess);
      return { outcome: 'succeeded', value, elapsedMs, attempts, result };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }

  const elapsedMs = Date.now() - startedAt;
  log(`✗ ${name} — timed out after ${elapsedMs}ms (attempts=${attempts})`);

  if (opts.onTimeout) {
    const result = await opts.onTimeout({ elapsedMs, attempts });
    return { outcome: 'timed-out', elapsedMs, attempts, result };
  }

  throw new WaitForTimeoutError(name, elapsedMs, attempts);
}

/**
 * Factory returning an SDK Step whose run function executes
 * `waitFor(...)`. Status lines are routed through `ctx.log.info`.
 * The step's typed return value is the WaitForResult union.
 */
export function waitForStep<TValue, TSuccess = void, TTimeout = void>(
  name: string,
  opts: Omit<WaitForOptions<TValue, TSuccess, TTimeout>, 'name' | 'log'>,
): Step<WaitForResult<TValue, TSuccess, TTimeout>> {
  return step<WaitForResult<TValue, TSuccess, TTimeout>>(name, {
    run: async (ctx: StepContext) =>
      waitFor<TValue, TSuccess, TTimeout>({
        name,
        check: opts.check,
        intervalMs: opts.intervalMs,
        timeoutMs: opts.timeoutMs,
        initialDelayMs: opts.initialDelayMs,
        onSuccess: opts.onSuccess,
        onTimeout: opts.onTimeout,
        swallowErrors: opts.swallowErrors,
        log: (line) => ctx.log.info(line),
      }),
  });
}
