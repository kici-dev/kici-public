import type { z } from 'zod';
import type { $ as Shell } from 'zx';
import type { ResourceRequest, RunsOnAllInput, OnUnreachableMode } from '@kici-dev/engine';
import type { StepContext, Logger } from './context.js';
import type { TriggerConfig } from './triggers/types.js';
import type { Rule } from './rules/types.js';
import type { Matrix, MatrixInclude, MatrixExclude } from './matrix/types.js';
import type { HookInput } from './hooks/types.js';
import type { KiciApi } from './api-types.js';
import type { DynamicGroupRef } from './dynamic-group.js';
import type { EventPayload } from './events/event-payloads.js';
import type { RequireApproval } from './approval.js';

export type {
  ResourceRequest,
  ResourceSpec,
  RunsOnAllInput,
  OnUnreachableMode,
} from '@kici-dev/engine';

/** Source location captured at a step() call site. */
export interface SourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/**
 * OutputProxy<T> represents a lazy proxy over step/job outputs.
 * At the type level it mirrors T's shape for type-safe property access.
 * At runtime it's a Proxy that defers property access to an OutputsMap.
 */
export type OutputProxy<T> = {
  readonly [K in keyof T]: T[K];
};

/** Output schema type - record of Zod types */
export type OutputSchema = Record<string, z.ZodTypeAny>;

/** Infer the output type from an output schema */
export type InferOutputs<T extends OutputSchema> = z.infer<z.ZodObject<T>>;

/**
 * Step definition returned by step() factory.
 *
 * TResult is the inferred return type of the run function (defaults to void for backward compat).
 * The optional `outputs` field holds a Zod schema for runtime validation but does NOT drive the generic.
 */
export interface Step<TResult = void> {
  readonly _tag: 'Step';
  /** Step name. Empty string for id-less steps (compiler assigns counter IDs). */
  readonly name: string;
  /** Optional Zod schema for runtime output validation. */
  readonly outputs?: OutputSchema;
  readonly run: (ctx: StepContext, drift?: any) => Promise<TResult>;
  /**
   * Read-only inspection for an idempotent step. Returns a drift value when run()
   * would change state, or null when the system is already in the desired state.
   */
  readonly check?: (ctx: StepContext) => Promise<unknown | null>;
  /** Required when check is set: human-readable, serializable summary of the drift. */
  readonly summarize?: (drift: any) => string;
  /** Optional Zod schema validating the drift value. */
  readonly drift?: z.ZodTypeAny;
  /** Optional: produces the step's outputs when check() returns null (already in sync). */
  readonly whenInSync?: (ctx: StepContext) => Promise<TResult>;
  /** When true, job proceeds even if this step fails (recorded as failed but not fatal). */
  readonly continueOnError?: boolean;
  /** Step-level timeout in milliseconds. Overrides the agent's default (30 minutes). */
  readonly timeout?: number;
  /** Declarative cache: restored before this step, saved after on key miss. */
  readonly cache?: import('./cache-types.js').CacheInput;
  /** Step-level conditional rules (evaluated agent-side). */
  readonly rules?: Rule[];
  /** Runs on cancellation. */
  readonly onCancel?: HookInput;
  /** Always runs after step (success, failure, or cancel). */
  readonly cleanup?: HookInput;
  /** Pause for a manual human approval before this step runs. */
  readonly requireApproval?: RequireApproval;
  /** Internal: source location captured at step() call site. Not part of public API. */
  readonly _sourceLocation?: SourceLocation;
  /**
   * Type-safe proxy for accessing this step's outputs.
   * Only meaningful when TResult is non-void. Accessing .result on a void step is a compile-time error.
   * At runtime, resolves against the shared outputs map populated by the workflow runner.
   */
  readonly result: TResult extends void ? never : OutputProxy<TResult>;
}

/**
 * Bare async function accepted directly in the steps array.
 * Counter-named at compile time, return-type-inferred, no Zod validation.
 */
export type BareStepFn<TResult = void> = (ctx: StepContext) => Promise<TResult>;

/**
 * Union type for items accepted in a job's steps array.
 * Accepts both Step objects and bare async functions.
 */
export type StepInput = Step<any> | BareStepFn<any>;

/** Options for step() factory - simple form (just async function) */
export type StepRunFn = (ctx: StepContext) => Promise<void>;

/**
 * Facets shared by both the plain and the check variant of {@link StepOptions}.
 * These compose unchanged whether or not a step declares a `check` facet.
 */
export interface StepOptionsBase {
  /** Optional Zod schema for runtime output validation. */
  outputs?: OutputSchema;
  /** When true, job proceeds even if this step fails (recorded as failed but not fatal). */
  continueOnError?: boolean;
  /** Step-level timeout in milliseconds. Overrides the agent's default (30 minutes). */
  timeout?: number;
  /** Declarative cache: restored before this step, saved after on key miss. */
  cache?: import('./cache-types.js').CacheInput;
  /** Step-level conditional rules (evaluated agent-side). */
  rules?: Rule[];
  /** Runs on cancellation. */
  onCancel?: HookInput;
  /** Always runs after step (success, failure, or cancel). */
  cleanup?: HookInput;
  /** Pause for a manual human approval before this step runs. */
  requireApproval?: RequireApproval;
}

/**
 * Plain step options: `run` takes only the context — the existing, fully
 * backward-compatible shape. No `check` facet.
 */
export interface StepOptionsPlain<TResult = void> extends StepOptionsBase {
  run: (ctx: StepContext) => Promise<TResult>;
  check?: undefined;
  summarize?: undefined;
  drift?: undefined;
  whenInSync?: undefined;
}

/**
 * Idempotent-step options: `check` declares read-only inspection, `run` becomes
 * the *apply* function and receives the drift value `check` returned. `summarize`
 * is required. `whenInSync` optionally produces the outputs when already in sync.
 *
 * `TDrift` is independent of `TResult` — one output shape per step (whichever of
 * `run` / `whenInSync` executes), and a separate drift shape that `check` returns.
 */
export interface StepOptionsWithCheck<TResult = void, TDrift = unknown> extends StepOptionsBase {
  /** Read-only inspection. Returns drift when run() would change state, or null when in sync. */
  check: (ctx: StepContext) => Promise<TDrift | null>;
  /** Required when check is set: human-readable, serializable summary of the drift. */
  summarize: (drift: TDrift) => string;
  /** Optional Zod schema validating the drift value. */
  drift?: z.ZodTypeAny;
  /** Apply: runs only when check returned drift (apply mode); receives that drift. */
  run: (ctx: StepContext, drift: TDrift) => Promise<TResult>;
  /** Optional: produces the step's outputs when check returned null (already in sync). */
  whenInSync?: (ctx: StepContext) => Promise<TResult>;
}

/**
 * Options for step() factory - full form with outputs and generic return type.
 * Either the plain shape (`run(ctx)`) or the idempotent shape (`check` + `run(ctx, drift)`).
 */
export type StepOptions<TResult = void, TDrift = unknown> =
  | StepOptionsPlain<TResult>
  | StepOptionsWithCheck<TResult, TDrift>;

/** Trigger type (config objects returned by pr()/push() factory functions) */
export type Trigger = TriggerConfig;

/**
 * Context passed to dynamic job generator functions.
 * Uses destructured form: async ({$, ctx, log, env}) => jobs
 *
 * **Determinism requirement:** the executing agent re-evaluates the DynamicJobFn
 * to extract step closures (functions can't be serialized). For a given job name,
 * the re-evaluation must produce a job with the same name and the same steps.
 *
 * - `ctx.event` is deterministic — frozen from the original webhook payload.
 * - `ctx.needs` is deterministic — a snapshot of upstream outputs frozen at first
 *   eval and replayed unchanged on re-eval, like `ctx.event`. Present only on
 *   result-aware generators created via `dynamicJob(group, { needs, generate })`.
 * - `$`, `env`, and `kici` can return different results between eval and re-eval
 *   (different agent, different time, different infrastructure state).
 *
 * **Guidance:** derive job names and structure from `ctx.event` / `ctx.needs`
 * data whenever possible. If you use `kici.infrastructure.list()` or shell
 * commands to determine job names, be aware that changes between eval and re-eval
 * will cause a non-determinism warning (or failure if a job disappears).
 */
export interface DynamicJobContext {
  /** zx shell executor for running commands */
  $: typeof Shell;
  /** Event context and workflow metadata */
  ctx: {
    workflow: { name: string };
    /** Normalized event envelope that triggered this run. */
    event?: EventPayload;
    /**
     * Frozen outputs of declared upstream needs (result-aware generators only).
     * Single-job needs expose `ctx.needs.<job>.result.<field>`; group needs
     * expose an ordered array of `{ name, result }`.
     */
    needs?: import('./needs-context.js').NeedsContext;
  };
  /** Structured logger */
  log: Logger;
  /** Environment variables */
  env: Record<string, string | undefined>;
  /** Typed KiCI API — orchestrator queries over WS (e.g., kici.infrastructure.list()) */
  kici: KiciApi;
}

/**
 * Async function that generates jobs dynamically at runtime.
 * Signature: async ({$, ctx, log, env}) => Job[]
 *
 * **Determinism contract:** this function is called twice — once during the eval
 * phase (to discover which jobs to create) and once during execution (to extract
 * step closures for the specific job being run). The second call must produce a
 * job with the same name and equivalent steps as the first call.
 *
 * A mismatch in sibling job names triggers a warning; a missing target job
 * causes a hard failure with a clear determinism error.
 *
 * See `docs/architecture/dynamic-jobs.md` for the full re-evaluation flow.
 */
export type DynamicJobFn = (context: DynamicJobContext) => Promise<Job[]>;

/**
 * A job definition or an async function that generates jobs.
 * Used in workflow jobs array for mixing static and dynamic jobs.
 */
export type JobOrFactory = Job | DynamicJobFn;

/**
 * Type guard to check if a JobOrFactory is a dynamic job generator.
 */
export function isDynamicJobFn(item: JobOrFactory): item is DynamicJobFn {
  return typeof item === 'function';
}

// --- Dynamic job group tagging ---

const DYNAMIC_JOB_GROUP_TAG = Symbol.for('kici:dynamicJobGroup');

/** A DynamicJobFn tagged with a group name via dynamicJob(). */
export interface TaggedDynamicJobFn extends DynamicJobFn {
  readonly [DYNAMIC_JOB_GROUP_TAG]: string;
}

/**
 * Tag a DynamicJobFn with a group name for cross-domain needs.
 * Static jobs can then depend on this group via `needs: [dynamicGroup('name')]`.
 *
 * Two forms:
 * - **Function form** (event-only): `dynamicJob('shards', async ({ ctx }) => [...])`.
 *   Dispatched at webhook time; deterministic from `ctx.event` alone.
 * - **Options form** (result-aware): `dynamicJob('reports', { needs, generate })`.
 *   Deferred until every job/group in `needs` completes, then `generate` is
 *   evaluated with the upstreams' frozen outputs available as `ctx.needs`.
 *
 * @param groupName - The group name (must match what static jobs reference)
 * @param fnOrConfig - The generator function, or a result-aware `{ needs, generate }` config
 */
export function dynamicJob(
  groupName: string,
  fnOrConfig: DynamicJobFn | ResultAwareDynamicJobConfig,
): TaggedDynamicJobFn {
  const isConfig = typeof fnOrConfig !== 'function';
  const fn = (isConfig ? fnOrConfig.generate : fnOrConfig) as DynamicJobFn;
  const tagged = fn as TaggedDynamicJobFn & {
    [DYNAMIC_JOB_GROUP_TAG]: string;
    [DYNAMIC_JOB_NEEDS_TAG]?: ReadonlyArray<DynamicJobNeed>;
  };
  Object.defineProperty(tagged, DYNAMIC_JOB_GROUP_TAG, {
    value: groupName,
    enumerable: false,
  });
  if (isConfig) {
    Object.defineProperty(tagged, DYNAMIC_JOB_NEEDS_TAG, {
      value: fnOrConfig.needs,
      enumerable: false,
    });
  }
  return tagged as TaggedDynamicJobFn;
}

/**
 * Get the group name from a DynamicJobFn, if it was tagged with dynamicJob().
 * Returns undefined for untagged functions.
 */
export function getDynamicJobGroup(fn: DynamicJobFn): string | undefined {
  return (fn as TaggedDynamicJobFn)[DYNAMIC_JOB_GROUP_TAG];
}

export { DYNAMIC_JOB_GROUP_TAG };

// --- Result-aware dynamic job generation ---

const DYNAMIC_JOB_NEEDS_TAG = Symbol.for('kici:dynamicJobNeeds');

/**
 * One declared upstream edge for a result-aware generator.
 * Same shape as the elements of {@link JobOptions.needs}.
 */
export type DynamicJobNeed =
  | Job
  | string
  | DynamicGroupRef
  | { name: string; ifFailed?: 'skip' | 'run' }
  | { group: string; ifFailed?: 'skip' | 'run' };

/**
 * Options-object form of {@link dynamicJob}: a result-aware generator that is
 * deferred until its declared `needs` complete, then evaluated with their frozen
 * outputs available as `ctx.needs`.
 */
export interface ResultAwareDynamicJobConfig {
  /** Upstream jobs/groups whose outputs the generator reads via `ctx.needs`. */
  needs: ReadonlyArray<DynamicJobNeed>;
  /** The generator. Receives `ctx.needs` resolved from the frozen upstream snapshot. */
  generate: DynamicJobFn;
}

/** A {@link DynamicJobFn} tagged with declared needs (result-aware). */
export interface ResultAwareDynamicJobFn extends TaggedDynamicJobFn {
  readonly [DYNAMIC_JOB_NEEDS_TAG]: ReadonlyArray<DynamicJobNeed>;
}

/**
 * Read the declared needs from a result-aware generator.
 * Returns undefined for event-only generators (the function form of dynamicJob).
 */
export function getDynamicJobNeeds(fn: DynamicJobFn): ReadonlyArray<DynamicJobNeed> | undefined {
  return (fn as ResultAwareDynamicJobFn)[DYNAMIC_JOB_NEEDS_TAG];
}

export { DYNAMIC_JOB_NEEDS_TAG };

/**
 * Container configuration for job execution.
 * When set, all steps run inside the specified container.
 */
export interface ContainerConfig {
  /** Docker image name (e.g., 'node:20-alpine') */
  image: string;
  /** Additional environment variables for the container */
  env?: Record<string, string>;
}

/**
 * Generic per-job initialization config. Runs a hand-written command after the
 * repo is cloned and before the job's steps execute, so a repo-declared
 * toolchain (mise, a custom setup script, …) is provisioned and put on the
 * step environment's PATH.
 *
 * The command writes env it wants visible to later steps to the file at
 * `$KICI_ENV` (one `KEY=value` line each) and PATH additions to `$KICI_PATH`
 * (one directory per line) — the agent reads both after the command and applies
 * the delta to every subsequent step.
 */
export interface GenericInitConfig {
  /** Command run after clone, before steps. Runs in the job's sandbox at the clone root. */
  run: string;
  /** Shell used to run `run`. Defaults to 'bash'. */
  shell?: string;
  /** Cache spec for binaries the command fetches/installs (restored before, saved after on key miss). */
  cache?: import('./cache-types.js').CacheSpec;
  /** Max wall-clock for this init command in ms. Reuses the step/job timeout semantics. */
  timeout?: number;
  /** Static environment variables available to the command. */
  env?: Record<string, string>;
}

/**
 * Overrides for the `mise` init preset. The preset supplies the `run` command;
 * these tune the same fields a hand-written {@link GenericInitConfig} exposes,
 * minus `run`.
 */
export interface MiseInitConfig {
  /** Cache spec for mise's data dir. Omit -> content-derived default; `false` -> no cache. */
  cache?: import('./cache-types.js').CacheSpec | false;
  /** Max wall-clock for the mise init command in ms. Defaults to 600000. */
  timeout?: number;
  /** Static environment variables available to the mise command. */
  env?: Record<string, string>;
  /** Shell used to run the mise command. Defaults to the OS template's shell. */
  shell?: string;
}

/** A typed toolchain preset: zero-config string or an object with overrides. */
export type InitPreset = 'mise' | { mise: MiseInitConfig };

/** One init directive: a hand-written generic config or a typed preset. */
export type InitItem = GenericInitConfig | InitPreset;

/**
 * Per-job init configuration:
 * - a single {@link InitItem} (generic config or preset),
 * - an ordered array of items (run in order),
 * - `'auto'` — detect the toolchain from committed files (mise.toml / .tool-versions),
 * - `false` — explicit opt-out.
 *
 * An unset `init` is also "no init". `'auto'` is a scalar only — never an array element.
 */
export type InitConfig = InitItem | InitItem[] | 'auto' | false;

/**
 * Structured runsOn selector with required and excluded labels.
 * Used when jobs need to target specific agents while excluding others.
 *
 * **Targeting `kici:` labels:** `runsOn` may target any agent label, including the
 * `kici:`-namespaced auto-labels (e.g. `kici:os:linux`, `kici:arch:arm64`,
 * `kici:host:<name>`). Targeting is a requirement on candidate agents, never a grant.
 * Note that `kici:scaler:<name>` / `kici:agent:<backend>` are deployment-specific names,
 * so targeting them couples a workflow to one orchestrator's configuration. Users still
 * cannot *set* `kici:` labels on agents — that namespace is reserved for the scaler and
 * the agent's self-reported platform facts.
 */
export interface RunsOnSelector {
  labels: string | RegExp | (string | RegExp)[];
  exclude?: string | RegExp | (string | RegExp)[];
}

/**
 * Polymorphic runsOn type: string shorthand, array shorthand, or full selector object.
 * - `'kici:os:linux'` — single label shorthand (targets any linux agent)
 * - `['kici:os:linux', 'gpu']` — multi-label shorthand (all must match)
 * - `{ labels: ['kici:os:linux'], exclude: ['kici:host:box-01'] }` — full selector
 *
 * A plain string is matched exactly; a string containing glob metachars (`*?[]{}`) is a
 * glob; a `RegExp` is a regex. Patterns are validated for ReDoS at compile time.
 *
 * **Targeting `kici:` labels:** `runsOn` may target any agent label, including the
 * `kici:`-namespaced auto-labels (`kici:os:`, `kici:arch:`, `kici:host:`, `kici:agent:`,
 * `kici:scaler:`, `kici:role:`). Targeting is a requirement on candidate agents, never a
 * grant. `kici:scaler:` / `kici:agent:` are deployment-specific, so prefer custom labels
 * for portable pool targeting. Users still cannot *set* `kici:` labels on agents.
 */
export type RunsOn = string | RegExp | (string | RegExp)[] | RunsOnSelector;

/** Job definition returned by job() factory */
export interface Job {
  readonly _tag: 'Job';
  readonly name: string;
  /** Single-agent targeting. Mutually exclusive with `runsOnAll`. */
  readonly runsOn?: RunsOn;
  /**
   * Host fan-out: run one pinned execution per roster host matching the predicate.
   * Mutually exclusive with `runsOn`.
   */
  readonly runsOnAll?: RunsOnAllInput;
  /** Failure policy for unreachable durable hosts when using `runsOnAll`. */
  readonly onUnreachable?: OnUnreachableMode;
  /** Fan-out concurrency width (sliding window; `1` = serial). Applies to matrix and `runsOnAll`. */
  readonly maxParallel?: number;
  /** Halt the fan-out on first child failure, skipping the remainder. Default `false`. */
  readonly failFast?: boolean;
  readonly steps: readonly StepInput[];
  readonly needs?: ReadonlyArray<
    | Job
    | string
    | DynamicGroupRef
    | { name: string; ifFailed: 'skip' | 'run' }
    | { group: string; ifFailed: 'skip' | 'run' }
  >;
  /** Rules for conditional execution */
  readonly rules?: Rule[];
  /** Optional description */
  readonly description?: string;
  /** Matrix configuration (unexpanded) */
  readonly matrix?: Matrix;
  /** Include combinations */
  readonly include?: MatrixInclude[];
  /** Exclude combinations */
  readonly exclude?: MatrixExclude[];
  /** When false, agent skips git clone (default: true). Useful for deploy/notify jobs. */
  readonly checkout?: boolean;
  /** Docker image for job execution. All steps run inside the container. */
  readonly container?: string | ContainerConfig;
  /** Deployment environment for this job. String for static, or a function of the normalized event envelope for dynamic (resolved at orchestrator two-phase eval). */
  readonly environment?: string | ((event: EventPayload) => string | Promise<string>);
  /** Environment variables. Static object or a function of the normalized event envelope (resolved at orchestrator two-phase eval). */
  readonly env?:
    | Record<string, string>
    | ((event: EventPayload) => Record<string, string> | Promise<Record<string, string>>);
  /** Concurrency group name. Defaults to environment name if not set. String or a function of the normalized event envelope. */
  readonly concurrencyGroup?: string | ((event: EventPayload) => string | Promise<string>);
  /** Runs on cancellation. */
  readonly onCancel?: HookInput;
  /** Always runs after job (success, failure, or cancel). */
  readonly cleanup?: HookInput;
  /** Runs on job success. */
  readonly onSuccess?: HookInput;
  /** Runs on job failure. */
  readonly onFailure?: HookInput;
  /** Runs before each step in this job. */
  readonly beforeStep?: HookInput;
  /** Runs after each step in this job. */
  readonly afterStep?: HookInput;
  /** Seconds before SIGKILL after SIGTERM during cancellation. */
  readonly gracePeriod?: number;
  /** Total job wall-clock timeout in milliseconds (init + all steps + hooks). On breach the job is aborted and reported timed out. Agent-enforced. Independent of step-level timeout. */
  readonly timeout?: number;
  /**
   * Resource request and limit for this job. Used by the scaler to enforce
   * per-scaler / per-orchestrator / per-machine caps and the kernel-side limits
   * on the spawned agent.
   *
   * `requests` drive scheduler accounting (cap aggregation).
   * `limits` drive kernel enforcement (Docker memory + nanoCpus, FC memSizeMib + vcpuCount,
   * optional bare-metal systemd-run scope).
   *
   * If only one side is set, the other inherits its values. If neither is set,
   * the scaler default applies; if neither is set anywhere, the job counts only
   * toward the agent-count cap.
   */
  readonly resources?: ResourceRequest;
  /**
   * Per-job initialization. Runs after clone, before steps.
   * - A `GenericInitConfig` or typed preset (`'mise'` / `{ mise }`), single or
   *   in an ordered array, provisions a toolchain.
   * - `'auto'` detects the toolchain from committed files (mise.toml / .tool-versions).
   * - `false` is an explicit opt-out (an unset `init` is also "no init").
   */
  readonly init?: InitConfig;
  /** Declarative cache: restored before steps, saved after the job on key miss. */
  readonly cache?: import('./cache-types.js').CacheInput;
  /** Pause for a manual human approval before this job dispatches. */
  readonly requireApproval?: RequireApproval;
  /**
   * Type-safe proxy for accessing this job's outputs.
   * For multi-step jobs: jobRef.result.stepName.field
   * For single-step (run shorthand) jobs: jobRef.result.field
   * At runtime, resolves against the shared job outputs map populated by the workflow runner.
   */
  readonly result: OutputProxy<any>;
}

/** Options for job() factory */
export interface JobOptions {
  /** Single-agent targeting. Mutually exclusive with `runsOnAll`. */
  runsOn?: RunsOn;
  /**
   * Host fan-out: run one pinned execution per roster host matching the predicate.
   * The author writes a label string (`'role:web'`), an array with `!`-prefixed
   * excludes (`['kici:os:linux', 'role:db', '!kici:host:db-01']`), or the
   * structured `{ include: [{ all: [...] }], exclude?: [...] }` form.
   * Mutually exclusive with `runsOn`.
   */
  runsOnAll?: RunsOnAllInput;
  /**
   * Failure policy for unreachable durable hosts when using `runsOnAll`:
   * `'skip'` omits them, `'fail'` fails the run, `'hold'` (default) queues a
   * pinned child and waits. Only meaningful alongside `runsOnAll`.
   */
  onUnreachable?: OnUnreachableMode;
  /**
   * Fan-out concurrency width: the maximum number of fan-out children (matrix
   * combinations or `runsOnAll` hosts) that run at once. A sliding window —
   * each child that reaches a terminal state releases the next held sibling.
   * `1` = strictly serial (rolling). Applies to both matrix and `runsOnAll`
   * fan-out; ignored on a non-fan-out job. Must be `>= 1`.
   */
  maxParallel?: number;
  /**
   * Halt the fan-out on the first child failure: stop releasing new children
   * and skip the ones still held. Default `false` (every child runs regardless
   * of sibling outcomes). Applies to both matrix and `runsOnAll` fan-out.
   */
  failFast?: boolean;
  /**
   * Steps to execute in this job. Accepts Step objects and bare async functions.
   * Mutually exclusive with `run`.
   */
  steps?: StepInput[];
  /**
   * Single-step shorthand: an async function that becomes the job's only step.
   * Mutually exclusive with `steps`.
   */
  run?: (ctx: StepContext) => Promise<any>;
  needs?: Array<
    | Job
    | string
    | DynamicGroupRef
    | { name: string; ifFailed: 'skip' | 'run' }
    | { group: string; ifFailed: 'skip' | 'run' }
  >;
  /** Rules that must pass for job to execute */
  rules?: Rule[];
  /** Optional description for documentation */
  description?: string;
  /**
   * Matrix configuration for job expansion.
   * - Single dimension: string[] like ['linux', 'mac', 'windows']
   * - Multi-dimensional: Record like {os: ['linux', 'mac'], node: ['18', '20']}
   * - Dynamic: async function returning either form
   */
  matrix?: Matrix;
  /**
   * Additional matrix combinations to include.
   * Applied after expansion, can add combinations not in original matrix.
   */
  include?: MatrixInclude[];
  /**
   * Matrix combinations to exclude.
   * Applied before include, removes matching combinations.
   */
  exclude?: MatrixExclude[];
  /** When false, agent skips git clone (default: true). Useful for deploy/notify jobs. */
  checkout?: boolean;
  /**
   * Docker image for job execution.
   * Simple string form for image name, object form for additional config.
   * When set, all steps run inside the container.
   */
  container?: string | ContainerConfig;
  /** Deployment environment for this job. String for static, or a function of the normalized event envelope for dynamic (resolved at orchestrator two-phase eval). */
  environment?: string | ((event: EventPayload) => string | Promise<string>);
  /** Environment variables. Static object or a function of the normalized event envelope (resolved at orchestrator two-phase eval). */
  env?:
    | Record<string, string>
    | ((event: EventPayload) => Record<string, string> | Promise<Record<string, string>>);
  /** Concurrency group name. Defaults to environment name if not set. String or a function of the normalized event envelope. */
  concurrencyGroup?: string | ((event: EventPayload) => string | Promise<string>);
  /** Runs on cancellation. */
  onCancel?: HookInput;
  /** Always runs after job (success, failure, or cancel). */
  cleanup?: HookInput;
  /** Runs on job success. */
  onSuccess?: HookInput;
  /** Runs on job failure. */
  onFailure?: HookInput;
  /** Runs before each step in this job. */
  beforeStep?: HookInput;
  /** Runs after each step in this job. */
  afterStep?: HookInput;
  /** Seconds before SIGKILL after SIGTERM during cancellation. */
  gracePeriod?: number;
  /** Total job wall-clock timeout in milliseconds (init + all steps + hooks). On breach the job is aborted and reported timed out. Agent-enforced. Independent of step-level timeout. */
  timeout?: number;
  /**
   * Resource request and limit for this job. Used by the scaler to enforce
   * per-scaler / per-orchestrator / per-machine caps and the kernel-side limits
   * on the spawned agent.
   *
   * `requests` drive scheduler accounting (cap aggregation).
   * `limits` drive kernel enforcement (Docker memory + nanoCpus, FC memSizeMib + vcpuCount,
   * optional bare-metal systemd-run scope).
   *
   * If only one side is set, the other inherits its values. If neither is set,
   * the scaler default applies; if neither is set anywhere, the job counts only
   * toward the agent-count cap.
   */
  resources?: ResourceRequest;
  /**
   * Per-job initialization. Runs after clone, before steps.
   * - A `GenericInitConfig` or typed preset (`'mise'` / `{ mise }`), single or
   *   in an ordered array, provisions a toolchain.
   * - `'auto'` detects the toolchain from committed files (mise.toml / .tool-versions).
   * - `false` is an explicit opt-out (an unset `init` is also "no init").
   */
  init?: InitConfig;
  /** Declarative cache: restored before steps, saved after the job on key miss. */
  cache?: import('./cache-types.js').CacheInput;
  /** Pause for a manual human approval before this job dispatches. */
  requireApproval?: RequireApproval;
}

/**
 * Private npm registry declaration. Tells the agent to authenticate against
 * a private package registry before running `npm install`.
 *
 * `tokenSecret` uses qualified `<environment>:<secret-name>` syntax — the
 * orchestrator resolves the secret from the named environment's scoped secret
 * store at dispatch time. Example: `tokenSecret: 'production:NPM_TOKEN'`.
 */
export interface Registry {
  /** Registry URL (e.g. `https://npm.pkg.github.com`). */
  readonly url: string;
  /**
   * Optional npm package scope this registry serves (e.g. `@my-org`).
   * If omitted, the registry becomes the default (only one default per workflow).
   */
  readonly scope?: string;
  /**
   * Qualified secret reference of the form `<environment>:<secret-name>`.
   * The orchestrator resolves it at dispatch via `secretResolver.resolveForJob(orgId, environment)`.
   */
  readonly tokenSecret: string;
  /** Whether to require auth on every request (rendered as `always-auth=true` in `.npmrc`). Defaults to `true`. */
  readonly alwaysAuth?: boolean;
}

/** Workflow definition returned by workflow() factory */
export interface Workflow {
  readonly _tag: 'Workflow';
  readonly name: string;
  /**
   * Jobs array (may contain static jobs and dynamic job generators).
   * Dynamic generators are expanded at agent runtime.
   */
  readonly jobs: JobOrFactory[];
  /** Trigger configs (built from Trigger instances) */
  readonly on?: TriggerConfig[];
  /** Rules for conditional execution */
  readonly rules?: Rule[];
  /** Optional description */
  readonly description?: string;
  /**
   * Optional paths or glob patterns (relative to repo root) to include in the workflow content hash.
   * When any of these files change, the lock file content hash changes so cache is invalidated.
   */
  readonly hashFiles?: string[];
  /**
   * Private npm registries the agent should authenticate against before `npm install`.
   * Each registry's `tokenSecret` uses qualified `<environment>:<secret-name>` syntax.
   */
  readonly registries?: readonly Registry[];
  /**
   * Extra secrets to project as environment variables on the install subprocess.
   * Used together with a customer-committed `.kici/.npmrc` containing `${VAR}` placeholders.
   * Each entry uses qualified `<environment>:<secret-name>` syntax; the resolved value is
   * exposed to the install subprocess under the `<secret-name>` key (the environment
   * prefix is stripped for the env-var name).
   */
  readonly installEnv?: readonly string[];
  /** Whole-run wall-clock timeout in milliseconds across all jobs. On breach the orchestrator cancels outstanding/queued jobs and marks the run timed out. Orchestrator-enforced. Independent of job-level timeout. */
  readonly timeout?: number;
  /** Runs on cancellation. */
  readonly onCancel?: HookInput;
  /** Always runs after workflow (success, failure, or cancel). */
  readonly cleanup?: HookInput;
  /** Runs on workflow success. */
  readonly onSuccess?: HookInput;
  /** Runs on workflow failure. */
  readonly onFailure?: HookInput;
  /** Concurrency configuration for this workflow. */
  readonly concurrency?: {
    readonly group: (ctx: { branch: string; event: EventPayload }) => string;
    readonly cancelInProgress?: boolean;
    readonly max?: number;
  };
  /** Pause for a manual human approval before the whole workflow dispatches. */
  readonly requireApproval?: RequireApproval;
}

/** Options for workflow() factory */
export interface WorkflowOptions {
  /**
   * Jobs in the workflow.
   * Can be static Job objects or async functions that generate jobs.
   * Dynamic job functions are evaluated at agent runtime.
   */
  jobs: JobOrFactory[];
  /** Trigger conditions - when should this workflow run */
  on?: Trigger | Trigger[];
  /** Rules that must pass for workflow to execute */
  rules?: Rule[];
  /** Optional description for documentation */
  description?: string;
  /**
   * Optional paths or glob patterns (relative to repo root) to include in the workflow content hash.
   * When any of these files change, the lock file content hash changes so cache is invalidated.
   */
  hashFiles?: string[];
  /**
   * Private npm registries the agent should authenticate against before `npm install`.
   * Each registry's `tokenSecret` uses qualified `<environment>:<secret-name>` syntax.
   */
  registries?: Registry[];
  /**
   * Extra secrets to project as environment variables on the install subprocess.
   * Used together with a customer-committed `.kici/.npmrc` containing `${VAR}` placeholders.
   * Each entry uses qualified `<environment>:<secret-name>` syntax; the resolved value is
   * exposed to the install subprocess under the `<secret-name>` key.
   */
  installEnv?: string[];
  /** Whole-run wall-clock timeout in milliseconds across all jobs. On breach the orchestrator cancels outstanding/queued jobs and marks the run timed out. Orchestrator-enforced. Independent of job-level timeout. */
  timeout?: number;
  /** Runs on cancellation. */
  onCancel?: HookInput;
  /** Always runs after workflow (success, failure, or cancel). */
  cleanup?: HookInput;
  /** Runs on workflow success. */
  onSuccess?: HookInput;
  /** Runs on workflow failure. */
  onFailure?: HookInput;
  /** Concurrency configuration for this workflow. */
  concurrency?: {
    group: (ctx: { branch: string; event: EventPayload }) => string;
    cancelInProgress?: boolean;
    max?: number;
  };
  /** Pause for a manual human approval before the whole workflow dispatches. */
  requireApproval?: RequireApproval;
}

// Re-export trigger and rule types for external use
export type { TriggerConfig, PrTriggerConfig, PushTriggerConfig } from './triggers/types.js';
export type { Rule, RuleContext, RuleCheckFn, RuleResult } from './rules/types.js';
export type { Matrix, MatrixInclude, MatrixExclude, MatrixValues } from './matrix/types.js';
export type { HookInput, HookFn, HookConfig, HookContext, OutcomeMetadata } from './hooks/types.js';
