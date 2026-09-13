import type { HookConfig, HookFn, HookInput } from './types.js';

/**
 * Normalize HookInput to extract run function and optional timeout.
 */
function normalizeInput(input: HookInput): { run: HookFn; timeout?: number } {
  if (typeof input === 'function') {
    return { run: input };
  }
  return { run: input.run, timeout: input.timeout };
}

/**
 * Create an onCancel hook config.
 * Runs when the job/step is cancelled.
 */
export function onCancel(input: HookInput): HookConfig {
  const { run, timeout } = normalizeInput(input);
  return { name: 'onCancel', type: 'onCancel', run, timeout };
}

/**
 * Create a cleanup hook config.
 * Always runs after job/step completion (success, failure, or cancel).
 */
export function cleanup(input: HookInput): HookConfig {
  const { run, timeout } = normalizeInput(input);
  return { name: 'cleanup', type: 'cleanup', run, timeout };
}

/**
 * Create an onSuccess hook config.
 * Runs when the job/workflow succeeds.
 */
export function onSuccess(input: HookInput): HookConfig {
  const { run, timeout } = normalizeInput(input);
  return { name: 'onSuccess', type: 'onSuccess', run, timeout };
}

/**
 * Create an onFailure hook config.
 * Runs when the job/workflow fails.
 */
export function onFailure(input: HookInput): HookConfig {
  const { run, timeout } = normalizeInput(input);
  return { name: 'onFailure', type: 'onFailure', run, timeout };
}

/**
 * Create a beforeStep hook config.
 * Runs before each step in the job.
 */
export function beforeStep(input: HookInput): HookConfig {
  const { run, timeout } = normalizeInput(input);
  return { name: 'beforeStep', type: 'beforeStep', run, timeout };
}

/**
 * Create an afterStep hook config.
 * Runs after each step in the job.
 */
export function afterStep(input: HookInput): HookConfig {
  const { run, timeout } = normalizeInput(input);
  return { name: 'afterStep', type: 'afterStep', run, timeout };
}

// Re-export types
export type { HookConfig, HookFn, HookInput, HookContext, OutcomeMetadata } from './types.js';
