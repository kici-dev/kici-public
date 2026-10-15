/**
 * SDK wait-for helpers: pause a workflow until an external condition holds
 * (a resource provisioned, a file present, an endpoint healthy, a job
 * terminal), with the same shape as `idempotent` / `idempotentStep`. Errors
 * from `check()` are swallowed by default, matching the poll-until-healthy
 * pattern.
 *
 * Cancellation: there is no `AbortSignal` plumbing. A `check()` slower than
 * `intervalMs` is not aborted; the deadline is inspected only at the top of
 * each iteration. The step's own `timeout` field is the hard kill.
 */

import { step } from './step.js';
import type { Step } from './types.js';
import type { StepContext } from './context.js';
import { sleep } from '@kici-dev/engine';

export interface WaitForOptions<TValue, TSuccess = void, TTimeout = void> {
  /** Optional name surfaced in status lines and the timeout error. */
  name?: string;
  /** Return the resolved value when the condition is met, or `null` to keep polling. */
  check: () => Promise<TValue | null>;
  /** Milliseconds between `check()` calls. Defaults to 2000. */
  intervalMs?: number;
  /** Total budget in milliseconds. Defaults to 60000. The deadline is
   *  inspected at the top of each iteration. */
  timeoutMs?: number;
  /** Milliseconds before the first `check()`. Defaults to 0. */
  initialDelayMs?: number;
  /** Runs once after `check()` returns non-null; its return value is
   *  `result` on the 'succeeded' outcome. */
  onSuccess?: (value: TValue) => Promise<TSuccess>;
  /** Runs when the deadline is exceeded; its return value is `result` on
   *  the 'timed-out' outcome. When omitted, a `WaitForTimeoutError` is
   *  thrown instead. */
  onTimeout?: (info: { elapsedMs: number; attempts: number }) => Promise<TTimeout>;
  /** When `true` (default), `check()` errors are logged and polling
   *  continues. When `false`, the first error propagates. */
  swallowErrors?: boolean;
  /** Sink for status lines. Defaults to console.log. */
  log?: (line: string) => void;
}

/** The result of `waitFor`; narrow on `outcome`. */
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

/** Thrown by `waitFor` when the deadline passes and no `onTimeout` was supplied. */
export class WaitForTimeoutError extends Error {
  /** `WaitForOptions.name`, or 'waitFor'. */
  readonly stepName: string;
  /** Wall-clock milliseconds. */
  readonly elapsedMs: number;
  /** `check()` calls that ran before the timeout. */
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
 * Poll `check()` on a fixed interval until it returns non-null or the deadline
 * passes. Callable from any step, hook, or bare async function.
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

/** An SDK Step that runs `waitFor(...)`, logging status lines via `ctx.log.info`. */
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
