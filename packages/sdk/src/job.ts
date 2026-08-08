import { randomUUID } from 'node:crypto';
import { isKnownCapability } from '@kici-dev/engine';
import type {
  GenericInitConfig,
  InitItem,
  Job,
  JobOptions,
  StepInput,
  InferJobOutputsFromSteps,
  StepContextWithNeeds,
} from './types.js';
import type { StepContext } from './context.js';
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
 * Validate a job's `sandbox` escape-hatch request. An unknown capability name
 * is a typo that would never match the operator allow-list, so it is rejected
 * at author time (security is still enforced deny-by-default at dispatch — this
 * is a correctness/UX guard). Capability form is normalized by the dispatch
 * resolver, so both `NET_ADMIN` and `CAP_NET_ADMIN` are accepted here.
 */
function validateSandbox(sandbox: JobOptions['sandbox'], jobName: string): void {
  if (sandbox === undefined) return;
  for (const cap of sandbox.capabilities ?? []) {
    if (!isKnownCapability(cap)) {
      throw new Error(
        `job('${jobName}'): unknown Linux capability '${cap}' in sandbox.capabilities`,
      );
    }
  }
}

/**
 * Create a job with an explicit name; run shorthand with typed `ctx.needs`.
 *
 * When the job declares `needs: [jobRef, …]`, the `run:` function's `ctx.needs`
 * is typed from the tuple — job references thread their inferred outputs, so
 * `ctx.needs.<job>.result.<field>` is checked (string / `{ name }` entries stay
 * loose). Outputs are inferred flat from the run function's return type.
 */
export function job<
  TName extends string,
  const TNeeds extends readonly unknown[],
  TRun extends (ctx: StepContextWithNeeds<TNeeds>) => Promise<any>,
>(
  name: TName,
  options: Omit<JobOptions, 'needs' | 'run' | 'steps'> & {
    needs: TNeeds;
    run: TRun;
    steps?: undefined;
  },
): Job<Awaited<ReturnType<TRun>>, TName>;

/**
 * Create a job with an explicit name; outputs inferred from the run shorthand.
 *
 * The `run:` shorthand infers a **flat** output shape from the run function's
 * return type (`job.result.<field>`), matching the runtime's single-step
 * flattening.
 */
export function job<TName extends string, TRun extends (ctx: StepContext) => Promise<any>>(
  name: TName,
  options: JobOptions & { run: TRun; steps?: undefined },
): Job<Awaited<ReturnType<TRun>>, TName>;

/**
 * Create a job with an explicit name; outputs inferred from the steps tuple.
 *
 * A `steps:` job infers a **nested** output shape keyed by step name
 * (`job.result.<step>.<field>`) via {@link InferJobOutputsFromSteps} — name
 * your steps to get typed cross-job reads (id-less steps contribute nothing).
 *
 * @example
 * const build = job('build', {
 *   runsOn: 'kici:os:linux',
 *   steps: [checkout, install, compile],
 * });
 */
export function job<TName extends string, const TSteps extends readonly StepInput[]>(
  name: TName,
  options: JobOptions & { steps: TSteps; run?: undefined },
): Job<InferJobOutputsFromSteps<TSteps>, TName>;

/**
 * Create a job with an explicit name and an explicit output-type override.
 *
 * Pass the output shape as a type argument (`job<MyOutputs>('name', {...})`) for
 * dynamically-shaped jobs the inference can't reproduce. With no type argument
 * (and no `run` / `steps` to infer from) it defaults to the loose
 * `Record<string, unknown>`, so a bare job keeps compiling.
 *
 * @example
 * const build = job('build', {
 *   runsOn: 'kici:os:linux',
 *   steps: [checkout, install, compile],
 *   rules: [rule('env: CI')],
 *   description: 'Build the project',
 * });
 */
export function job<TOutputs = Record<string, unknown>, TName extends string = string>(
  name: TName,
  options: JobOptions,
): Job<TOutputs, TName>;

/**
 * Create a job with auto-generated ID; run shorthand with typed `ctx.needs`.
 */
export function job<
  const TNeeds extends readonly unknown[],
  TRun extends (ctx: StepContextWithNeeds<TNeeds>) => Promise<any>,
>(
  options: Omit<JobOptions, 'needs' | 'run' | 'steps'> & {
    needs: TNeeds;
    run: TRun;
    steps?: undefined;
  },
): Job<Awaited<ReturnType<TRun>>>;

/**
 * Create a job with auto-generated ID; outputs inferred from the run shorthand.
 */
export function job<TRun extends (ctx: StepContext) => Promise<any>>(
  options: JobOptions & { run: TRun; steps?: undefined },
): Job<Awaited<ReturnType<TRun>>>;

/**
 * Create a job with auto-generated ID; outputs inferred from the steps tuple.
 *
 * @example
 * const build = job({
 *   runsOn: 'kici:os:linux',
 *   steps: [checkout, install],
 * });
 */
export function job<const TSteps extends readonly StepInput[]>(
  options: JobOptions & { steps: TSteps; run?: undefined },
): Job<InferJobOutputsFromSteps<TSteps>>;

/**
 * Create a job with auto-generated ID and an explicit output-type override.
 */
export function job<TOutputs = Record<string, unknown>>(options: JobOptions): Job<TOutputs>;

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
  validateSandbox(options.sandbox, name);

  // When a job binds multiple contexts and no explicit concurrency group is
  // set, default the concurrency group to the first (primary) bound context's
  // name. A dynamic first element (function) falls through to dispatch-time
  // resolution, matching the single-context behaviour.
  const firstContext = options.contexts?.[0];
  const concurrencyGroup =
    options.concurrencyGroup ?? (typeof firstContext === 'string' ? firstContext : undefined);

  if (options.context !== undefined && options.contexts !== undefined) {
    throw new Error(`job('${name}'): context and contexts are mutually exclusive — use one`);
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
    ...(options.sandbox !== undefined && { sandbox: options.sandbox }),
    context: options.context,
    contexts: options.contexts,
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
