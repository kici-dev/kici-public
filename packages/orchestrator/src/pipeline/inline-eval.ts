/**
 * Inline expression evaluator for pure dynamic functions.
 *
 * Evaluates serialized arrow functions from the lockfile (LockInlineValue)
 * in a sandboxed VM context at dispatch time, eliminating the init-job
 * round-trip for pure functions.
 */

import vm from 'node:vm';
import { isLockInlineValue } from '@kici-dev/engine';
import type { LockJob } from '@kici-dev/engine';

/** 100ms timeout for inline evaluation */
const INLINE_TIMEOUT_MS = 100;

/**
 * Evaluate an inline expression that returns a string.
 *
 * @param expression - Serialized arrow function, e.g. '(event) => event.ref.split("/").pop()'
 * @param event - Normalized event envelope (SimulatedEvent shape; raw provider payload at event.payload)
 * @returns The string result
 * @throws TypeError if result is not a string
 * @throws Error on timeout or sandbox violation
 */
export function evaluateInlineString(expression: string, event: object): string {
  const sandbox = Object.create(null);
  sandbox.event = event;
  const code = `(${expression})(event)`;
  const result = vm.runInNewContext(code, sandbox, {
    timeout: INLINE_TIMEOUT_MS,
    filename: 'inline-eval',
  });
  if (typeof result !== 'string') {
    throw new TypeError(
      `Inline expression must return a string, got ${typeof result}: ${expression}`,
    );
  }
  return result;
}

/**
 * Evaluate an inline expression that returns a Record<string, string>.
 *
 * @param expression - Serialized arrow function, e.g. '(event) => ({ NODE_ENV: event.env })'
 * @param event - Normalized event envelope (SimulatedEvent shape; raw provider payload at event.payload)
 * @returns The record result
 * @throws TypeError if result is not a plain object
 * @throws Error on timeout or sandbox violation
 */
export function evaluateInlineRecord(expression: string, event: object): Record<string, string> {
  const sandbox = Object.create(null);
  sandbox.event = event;
  const code = `(${expression})(event)`;
  const result = vm.runInNewContext(code, sandbox, {
    timeout: INLINE_TIMEOUT_MS,
    filename: 'inline-eval',
  });
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new TypeError(
      `Inline expression must return an object, got ${result === null ? 'null' : typeof result}: ${expression}`,
    );
  }
  return result as Record<string, string>;
}

/**
 * Evaluate a lock job's inline (pure-function) dynamic fields against the
 * normalized event envelope (SimulatedEvent shape: { type, action,
 * targetBranch, sourceBranch, payload, … }). The raw provider webhook body is
 * nested at `event.payload` — the same shape rules and step contexts see.
 *
 * Throws a job-attributed Error when any expression throws; inline evaluation
 * failures are immediate dispatch failures (no init-job fallback).
 */
export function evaluateInlineFields(
  lockJob: LockJob,
  event: object,
): {
  inlineEnvironmentName: string | undefined;
  inlineEnv: Record<string, string> | undefined;
  inlineConcurrencyGroup: string | undefined;
} {
  let inlineEnvironmentName: string | undefined;
  let inlineEnv: Record<string, string> | undefined;
  let inlineConcurrencyGroup: string | undefined;

  if (isLockInlineValue(lockJob.environment)) {
    try {
      inlineEnvironmentName = evaluateInlineString(lockJob.environment.expression, event);
    } catch (err) {
      throw new Error(
        `Inline environment evaluation failed for job '${lockJob.name}': ${(err as Error).message}`,
      );
    }
  }
  if (isLockInlineValue(lockJob.env)) {
    try {
      inlineEnv = evaluateInlineRecord(lockJob.env.expression, event);
    } catch (err) {
      throw new Error(
        `Inline env evaluation failed for job '${lockJob.name}': ${(err as Error).message}`,
      );
    }
  }
  if (isLockInlineValue(lockJob.concurrencyGroup)) {
    try {
      inlineConcurrencyGroup = evaluateInlineString(lockJob.concurrencyGroup.expression, event);
    } catch (err) {
      throw new Error(
        `Inline concurrencyGroup evaluation failed for job '${lockJob.name}': ${(err as Error).message}`,
      );
    }
  }
  return { inlineEnvironmentName, inlineEnv, inlineConcurrencyGroup };
}
