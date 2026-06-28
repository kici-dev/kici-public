import { randomUUID } from 'node:crypto';
import type { GenericInitConfig, InitItem, Job, JobOptions } from './types.js';
import { createJobOutputProxy } from './outputs.js';

/** A typed preset is a `'mise'` string or a `{ mise }` object — neither carries `run`. */
function isPreset(item: InitItem): boolean {
  return item === 'mise' || (typeof item === 'object' && item !== null && 'mise' in item);
}

/**
 * Validate a job's `init` config. `undefined` / `false` / `'auto'` are no-ops;
 * typed presets (`'mise'` / `{ mise }`) carry no `run`, so they need no check.
 * Every remaining generic spec (one, or each element of an array) must carry a
 * non-empty `run` command. Throws with the offending index when validation fails.
 */
function validateInit(init: JobOptions['init'], jobName: string): void {
  if (init === undefined || init === false || init === 'auto') return;
  const items = Array.isArray(init) ? init : [init];
  items.forEach((item, i) => {
    if (isPreset(item)) return;
    const spec = item as GenericInitConfig;
    if (typeof spec.run !== 'string' || spec.run.trim().length === 0) {
      throw new Error(`job('${jobName}'): init[${i}].run must be a non-empty command`);
    }
  });
}

/**
 * Create a job with an explicit name.
 *
 * @example
 * const build = job('build', {
 *   runsOn: 'linux',
 *   steps: [checkout, install, compile],
 * });
 *
 * @example
 * // With rules and description
 * const build = job('build', {
 *   runsOn: 'linux',
 *   steps: [checkout, install, compile],
 *   rules: [rule('env: CI')],
 *   description: 'Build the project',
 * });
 */
export function job(name: string, options: JobOptions): Job;

/**
 * Create a job with auto-generated ID.
 *
 * @example
 * const build = job({
 *   runsOn: 'linux',
 *   steps: [checkout, install],
 * });
 */
export function job(options: JobOptions): Job;

/**
 * Implementation of job() factory.
 */
export function job(nameOrOptions: string | JobOptions, maybeOptions?: JobOptions): Job {
  const name = typeof nameOrOptions === 'string' ? nameOrOptions : randomUUID();
  const options = typeof nameOrOptions === 'string' ? maybeOptions! : nameOrOptions;

  // Normalize steps: if `run` shorthand is used, convert to single-step array
  let steps = options.steps ?? [];
  if (options.run) {
    if (options.steps && options.steps.length > 0) {
      throw new Error('job() cannot have both "run" and "steps" -- use one or the other');
    }
    steps = [options.run];
  }

  validateInit(options.init, name);

  // When a job binds multiple environments and no explicit concurrency group is
  // set, default the concurrency group to the first (primary) bound environment's
  // name. A dynamic first element (function) falls through to dispatch-time
  // resolution, matching the single-environment behaviour.
  const firstEnv = options.environments?.[0];
  const concurrencyGroup =
    options.concurrencyGroup ?? (typeof firstEnv === 'string' ? firstEnv : undefined);

  if (options.environment !== undefined && options.environments !== undefined) {
    throw new Error(
      `job('${name}'): environment and environments are mutually exclusive — use one`,
    );
  }

  if (options.runsOn !== undefined && options.runsOnAll !== undefined) {
    throw new Error(`job('${name}'): runsOn and runsOnAll are mutually exclusive`);
  }
  if (options.runsOn === undefined && options.runsOnAll === undefined) {
    throw new Error(`job('${name}'): one of runsOn or runsOnAll is required`);
  }
  if (options.onUnreachable !== undefined && options.runsOnAll === undefined) {
    console.warn(`[kici] job('${name}'): onUnreachable is ignored without runsOnAll`);
  }
  if (options.includeUninitialized !== undefined && options.runsOnAll === undefined) {
    console.warn(`[kici] job('${name}'): includeUninitialized is ignored without runsOnAll`);
  }

  return {
    _tag: 'Job' as const,
    name,
    ...(options.runsOn !== undefined && { runsOn: options.runsOn }),
    ...(options.runsOnAll !== undefined && { runsOnAll: options.runsOnAll }),
    ...(options.onUnreachable !== undefined && { onUnreachable: options.onUnreachable }),
    ...(options.includeUninitialized !== undefined && {
      includeUninitialized: options.includeUninitialized,
    }),
    ...(options.maxParallel !== undefined && { maxParallel: options.maxParallel }),
    ...(options.failFast !== undefined && { failFast: options.failFast }),
    steps,
    needs: options.needs,
    rules: options.rules,
    description: options.description,
    matrix: options.matrix,
    include: options.include,
    exclude: options.exclude,
    checkout: options.checkout,
    container: options.container,
    environment: options.environment,
    environments: options.environments,
    env: options.env,
    concurrencyGroup,
    onCancel: options.onCancel,
    cleanup: options.cleanup,
    onSuccess: options.onSuccess,
    onFailure: options.onFailure,
    beforeStep: options.beforeStep,
    afterStep: options.afterStep,
    gracePeriod: options.gracePeriod,
    timeout: options.timeout,
    resources: options.resources,
    init: options.init,
    ...(options.cache !== undefined && { cache: options.cache }),
    ...(options.approval !== undefined && { approval: options.approval }),
    result: createJobOutputProxy(name),
  };
}
