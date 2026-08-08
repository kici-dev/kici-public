import type { $ as Shell } from 'zx';
import type { z } from 'zod';
import type { TempHandle } from '@kici-dev/core/tmp';
import type { Job } from './types.js';
import type { MatrixValues } from './matrix/types.js';
import type { EventEmitOptions } from './events/types.js';
import type { EventDefinition } from './events/define-event.js';
import type { StepSecrets } from './secrets.js';
import type { KiciApi } from './api-types.js';
import type { FanoutPosition } from './fanout-context.js';

/** Logger interface for step execution */
export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

/** Workflow metadata available in step context */
export interface WorkflowInfo {
  name: string;
}

/** Job metadata available in step context */
export interface JobInfo {
  name: string;
  runsOn: string;
}

/**
 * Facts about the agent a `runsOnAll` host-fanout child is pinned to, exposed
 * as `ctx.agent`. Present only for jobs that use `runsOnAll`.
 */
export interface AgentInfo {
  /** Hostname of the agent. */
  host: string;
  /** The agent's label set. */
  labels: readonly string[];
  /** Operating-system platform (os.platform()). */
  platform?: string;
  /** CPU architecture (os.arch()). */
  arch?: string;
}

/**
 * Outputs of a matrix job as seen by a downstream `needs:` consumer.
 * A downstream that consumes a matrix upstream receives this envelope instead of
 * a flat outputs object, identically under `kici run --local` and the remote path.
 */
export interface MatrixJobOutputs<T = Record<string, unknown>> {
  /** Keyed by the combination suffix (the text inside `(...)` of the child name). */
  byMatrix: Record<string, T>;
  /** Last-write-wins flat merge across children, in child (name) order. */
  merged: T;
}

/** Runtime discriminator: true when `ctx.jobOutputs(ref)` returned a matrix envelope. */
export function isMatrixJobOutputs<T = Record<string, unknown>>(
  value: T | MatrixJobOutputs<T> | HostJobOutputs<T>,
): value is MatrixJobOutputs<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'byMatrix' in value &&
    'merged' in value &&
    typeof (value as MatrixJobOutputs<T>).byMatrix === 'object'
  );
}

/**
 * Outputs of a `runsOnAll` host-fanout job as seen by a downstream `needs:`
 * consumer. Keyed by hostname. Unlike {@link MatrixJobOutputs}, the summary does
 * NOT collapse to a last-write-wins scalar (a fleet footgun): `summary.outputs`
 * is an array view across hosts, and `succeededHosts`/`failedHosts` name the
 * per-host outcome.
 */
export interface HostJobOutputs<T = Record<string, unknown>> {
  /** Keyed by hostname. */
  byHost: Record<string, T>;
  summary: {
    succeededHosts: string[];
    failedHosts: string[];
    /** Per output key, every host's value (array view; never a collapsing scalar). */
    outputs: Record<string, unknown[]>;
  };
}

/** Runtime discriminator: true when `ctx.jobOutputs(ref)` returned a host envelope. */
export function isHostJobOutputs<T = Record<string, unknown>>(
  value: T | MatrixJobOutputs<T> | HostJobOutputs<T>,
): value is HostJobOutputs<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'byHost' in value &&
    'summary' in value &&
    typeof (value as HostJobOutputs<T>).byHost === 'object'
  );
}

/**
 * Augmentable interface for known secret keys.
 * When augmented via `kici types` (.d.ts generation), narrows get/expose key parameter.
 * When empty (no augmentation), StepSecrets accepts any string key.
 */
export interface KnownSecretKeys {}

/**
 * Check if an interface has been augmented (has any keys).
 * Uses distributive-safe pattern: [keyof T] extends [never].
 */
type IsAugmented<T> = [keyof T] extends [never] ? false : true;

/**
 * Step secrets with async get/expose accessors.
 * Use ctx.secrets.get('KEY') to retrieve a value, ctx.secrets.expose('KEY') to inject into env.
 *
 * When KnownSecretKeys is augmented (via .d.ts generation), only the `get`/`expose`
 * key parameter is narrowed to the known keys — every other accessor
 * (`has`, `getMeta`, `list`, `mountFile`, `exposeFile`) is preserved verbatim
 * from StepSecrets. When empty (no augmentation), the whole StepSecrets surface
 * accepts any string key.
 */
/**
 * The augmented secrets surface: narrows `get`/`expose` to the provided key set
 * while preserving every other StepSecrets accessor (`has`, `getMeta`, `list`,
 * `mountFile`, `exposeFile`) verbatim. Deriving from StepSecrets via `Omit`
 * keeps the file-mount accessors from silently dropping off whenever the
 * StepSecrets surface grows a new method.
 */
export type AugmentedStepSecrets<TKeys> = Omit<StepSecrets, 'get' | 'expose'> & {
  get(key: keyof TKeys): Promise<string>;
  expose(key: keyof TKeys): Promise<void>;
};

export type StepSecretsTyped =
  IsAugmented<KnownSecretKeys> extends true ? AugmentedStepSecrets<KnownSecretKeys> : StepSecrets;

/** Repository metadata for global workflow context */
export interface RepoInfo {
  /** Repository identifier (e.g., "owner/repo") */
  identifier: string;
  /** Local filesystem path where the repo is cloned */
  path: string;
  /** Branch/ref that was cloned */
  ref?: string;
  /** Commit SHA that was cloned */
  sha?: string;
}

/** Step execution context passed to run functions */
export interface StepContext<TInputs = Record<string, unknown>> {
  /** zx shell executor for running commands */
  $: typeof Shell;
  /** Structured logger */
  log: Logger;
  /** Environment variables */
  env: Record<string, string | undefined>;
  /** Set an environment variable visible to this step and all subsequent steps. */
  setEnv(key: string, value: string): void;
  /** Prepend a directory to PATH, visible to this step and all subsequent steps. */
  addPath(dir: string): void;
  /**
   * Aborted when this step should stop early — the job is being cancelled, the
   * job-level timeout fired, or (in a `parallel()` group) a sibling failed under
   * fail-fast. Pass it to `fetch`, `ctx.$`, timers, or any cancellable async work
   * to cooperatively unwind. Unaborted for a normally-running step.
   */
  signal: AbortSignal;
  /** Typed inputs from dependencies */
  inputs: TInputs;
  /**
   * Operator-supplied, validated + coerced workflow-dispatch inputs (from `dispatch({ inputs })`).
   * Distinct from `inputs` (typed outputs from `needs` dependencies). Empty when none declared.
   * Prefer the typed `defineDispatchInputs(...).from(ctx)` accessor for per-key types.
   */
  dispatchInputs: Readonly<Record<string, string | number | boolean | null>>;
  /** Current workflow metadata */
  workflow: WorkflowInfo;
  /** Current job metadata */
  job: JobInfo;
  /**
   * Matrix values for the current job instance.
   * - Single dimension: ctx.matrix.value contains the value
   * - Multi-dimensional: ctx.matrix.os, ctx.matrix.node, etc.
   * - Undefined for jobs without matrix configuration
   */
  matrix?: MatrixValues;
  /**
   * Hostname of the agent this job instance is running on.
   * Set only for jobs that use `runsOnAll` (host fan-out — one pinned execution
   * per matching host). Undefined for jobs without host fan-out.
   */
  host?: string;
  /**
   * Facts about the agent this job instance is pinned to (hostname, labels,
   * platform, arch). Set only for jobs that use `runsOnAll`. Undefined otherwise.
   */
  agent?: AgentInfo;
  /**
   * Position of this child within its fan-out (a `runsOnAll` host or a matrix
   * combination), deterministically ordered (host: by `agentId`; matrix: by
   * variant label). Undefined on a non-fan-out job.
   */
  fanout?: FanoutPosition;
  /**
   * Raw webhook payload from the git provider.
   * Contains the full, unmodified payload as received from the webhook.
   * In local preview/run mode (`kici preview` / `kici run --local`), contains the simulated payload.
   * Use this for provider-specific data not covered by normalized fields.
   */
  rawPayload?: Record<string, unknown>;
  /**
   * Which git provider triggered this workflow.
   * Examples: 'github', 'gitlab', 'bitbucket'.
   * Undefined in local test mode unless explicitly set.
   */
  provider?: string;
  /**
   * Whether this execution was triggered by `kici run remote` (developer-initiated remote run).
   * Use to conditionally skip destructive operations in test mode.
   * Defaults to false for backward compatibility.
   */
  isTestRun: boolean;
  /**
   * Workflow repo metadata -- only set for global workflows.
   * The registering repo where the workflow code is defined.
   * For non-global workflows, this is undefined (the workflow repo IS the source repo).
   */
  workflowRepo?: RepoInfo;
  /**
   * Source repo metadata -- only set for global workflows.
   * The repo where the triggering event occurred.
   * For non-global workflows, this is undefined (use env.GITHUB_WORKSPACE or CWD).
   */
  sourceRepo?: RepoInfo;
  /**
   * The resolved context name for this job.
   * Set when the job declares a `context` property.
   * Undefined for jobs without a context.
   */
  context?: string;
  /**
   * Secrets resolved for this job's context.
   * Use ctx.secrets.get('KEY') to retrieve a value asynchronously.
   * Use ctx.secrets.expose('KEY') to inject into process.env explicitly.
   * Use ctx.secrets.has('KEY') to check existence synchronously.
   * Values are NEVER automatically injected as environment variables.
   */
  secrets: StepSecretsTyped;
  /**
   * Emit a custom event that can trigger other workflows.
   * Returns a delivery receipt after the event is persisted and routed.
   * Events are delivered immediately (mid-workflow, not queued until completion).
   *
   * @example
   * // Typed via a defineEvent() definition — payload is schema-checked
   * await ctx.emit(deployComplete, { env: 'prod', version: '1.2.3' });
   *
   * // Or by ad-hoc name (payload typed as Record<string, unknown>)
   * await ctx.emit('deploy-complete', { env: 'prod', version: '1.2.3' });
   *
   * // Emit with cross-repo targeting
   * await ctx.emit('deploy-complete', { env: 'prod' }, { target: { repos: ['org/other-repo'] } });
   */
  emit<T extends z.ZodTypeAny>(
    definition: EventDefinition<T>,
    payload: z.infer<T>,
    options?: EventEmitOptions,
  ): Promise<{ deliveryId: string }>;
  emit(
    eventName: string,
    payload?: Record<string, unknown>,
    options?: EventEmitOptions,
  ): Promise<{ deliveryId: string }>;
  /**
   * Resolve outputs from a preceding step by reference.
   * Works with both Step objects and bare function references.
   *
   * @example
   * const buildOutputs = ctx.outputsOf(buildStep);
   * console.log(buildOutputs.version);
   *
   * @example
   * // With bare function reference
   * const bareFnOutputs = ctx.outputsOf(myBareFn);
   */
  outputsOf<T>(ref: { _tag: 'Step'; name: string } | ((...args: any[]) => any)): T;
  /**
   * Resolve outputs from a preceding job by reference.
   *
   * For a plain upstream this returns the job's collected outputs (step-keyed
   * for multi-step, flat for run shorthand). For a **matrix** upstream it returns
   * a {@link MatrixJobOutputs} envelope `{ byMatrix, merged }` keyed by the
   * combination suffix — identical under `kici run --local` and the remote path.
   * Use {@link isMatrixJobOutputs} (or `'byMatrix' in result`) to discriminate.
   *
   * @example
   * const setupOutputs = ctx.jobOutputs(setupJob);
   * @example
   * const m = ctx.jobOutputs(buildMatrixJob);
   * if (isMatrixJobOutputs(m)) console.log(m.byMatrix['linux, arm64']);
   */
  jobOutputs<T>(ref: Job<T>): T | MatrixJobOutputs<T> | HostJobOutputs<T>;
  jobOutputs(ref: { name: string }): Record<string, unknown> | MatrixJobOutputs | HostJobOutputs;
  /**
   * Publish a secret output value from this job.
   * Secret outputs are encrypted before leaving the agent and can be consumed
   * by downstream jobs (via `needs`) merged into their `ctx.secrets`.
   *
   * Unlike regular outputs, secret output values are never logged, never stored in plaintext,
   * and are deleted when the workflow run completes.
   *
   * @param key - Output name (must be unique within the job)
   * @param value - Secret value to publish
   */
  setSecretOutput(key: string, value: string): void;
  /** Typed KiCI API — orchestrator queries over WS (e.g., kici.infrastructure.list()) */
  kici: KiciApi;
  /**
   * Imperative cache API for fine-grained control.
   *
   * `ctx.cache.restore(spec)` restores from object storage (exact key, then
   * restoreKeys prefix fallback). `ctx.cache.save(spec)` archives `spec.paths`
   * under `spec.key` (immutable — first save wins). Scoped per org + ref.
   */
  cache: import('./cache-types.js').CacheApi;
  /**
   * Imperative artifacts API for named, durable build deliverables.
   *
   * `ctx.artifacts.upload(name, paths)` packs the paths and uploads them under
   * `name` (immutable per run — first upload wins, a duplicate name fails).
   * `ctx.artifacts.download(name, destDir?)` retrieves an artifact uploaded by
   * an earlier job of the same run. Artifacts are surfaced in the dashboard run
   * detail and downloadable from there. Distinct from `cache` (content-keyed
   * speedup) and job outputs (small JSON via `needs`).
   */
  artifacts: import('./artifacts-types.js').ArtifactsApi;
  /**
   * Build, sign, and persist a KiCI build-provenance attestation for a produced
   * artifact. The in-toto statement's identity is derived from an
   * orchestrator-minted identity token (unforgeable); the bundle is signed with
   * an ephemeral key and is offline-verifiable. Pass the artifact via a
   * precomputed digest or a path the agent digests with SHA-256.
   */
  attestProvenance(
    opts: import('./provenance-types.js').AttestProvenanceOptions,
  ): Promise<import('./provenance-types.js').AttestProvenanceResult>;
  /**
   * Allocate a scratch directory for this job. The directory is removed
   * automatically when the job ends (success, failure, or cancel); the returned
   * `cleanup()` may also be called manually at any time and is idempotent.
   *
   * When `label` is omitted it defaults to a sanitized step id. Use the returned
   * handle's `path` for scratch work, or `await using h = await ctx.mktemp()` to
   * tie the directory's lifetime to the enclosing scope.
   */
  mktemp(label?: string): Promise<TempHandle>;
  /**
   * Allocate a scratch file for this job. Like {@link mktemp}, the file (and its
   * holder) is removed automatically when the job ends, and the returned
   * `cleanup()` is idempotent and manually callable. `opts.suffix` appends a file
   * extension to the generated name.
   */
  mktempFile(label?: string, opts?: { suffix?: string }): Promise<TempHandle>;
  /**
   * Upstream needs resolved for this job, keyed by upstream job or group name.
   * `ctx.needs.<job>.result` is the upstream's outputs proxy and
   * `ctx.needs.<job>.status` its terminal status (`success | failed | skipped |
   * …`). A group / matrix / `runsOnAll` fan-out upstream is an ordered array of
   * `{ name, result, status }`, one entry per child. Undefined for a job with no
   * declared `needs`.
   */
  needs?: import('./needs-context.js').NeedsContext;
}
