import type { $ as Shell } from 'zx';
import type { MatrixValues } from './matrix/types.js';
import type { EventEmitOptions } from './events/types.js';
import type { StepSecrets } from './secrets.js';
import type { KiciApi } from './api-types.js';

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
 * a flat outputs object, identically under `kici run local` and the remote path.
 */
export interface MatrixJobOutputs<T = Record<string, unknown>> {
  /** Keyed by the combination suffix (the text inside `(...)` of the child name). */
  byMatrix: Record<string, T>;
  /** Last-write-wins flat merge across children, in child (name) order. */
  merged: T;
}

/** Runtime discriminator: true when `ctx.jobOutputs(ref)` returned a matrix envelope. */
export function isMatrixJobOutputs(
  value: Record<string, unknown> | MatrixJobOutputs | HostJobOutputs,
): value is MatrixJobOutputs {
  return (
    typeof value === 'object' &&
    value !== null &&
    'byMatrix' in value &&
    'merged' in value &&
    typeof (value as MatrixJobOutputs).byMatrix === 'object'
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
export function isHostJobOutputs(
  value: Record<string, unknown> | MatrixJobOutputs | HostJobOutputs,
): value is HostJobOutputs {
  return (
    typeof value === 'object' &&
    value !== null &&
    'byHost' in value &&
    'summary' in value &&
    typeof (value as HostJobOutputs).byHost === 'object'
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
 * When KnownSecretKeys is augmented (via .d.ts generation), narrows get/expose key parameter.
 * When empty (no augmentation), falls back to StepSecrets with string keys.
 */
export type StepSecretsTyped =
  IsAugmented<KnownSecretKeys> extends true
    ? {
        get(key: keyof KnownSecretKeys): Promise<string>;
        expose(key: keyof KnownSecretKeys): Promise<void>;
        has(key: string): boolean;
        getMeta(key: string): import('./secrets.js').SecretMeta | undefined;
      }
    : StepSecrets;

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
  /** Typed inputs from dependencies */
  inputs: TInputs;
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
   * Raw webhook payload from the git provider.
   * Contains the full, unmodified payload as received from the webhook.
   * In local test mode (kici test), contains the simulated payload.
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
   * Whether this execution was triggered by `kici test` (remote test run).
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
   * The resolved deployment environment name for this job.
   * Set when the job declares an `environment` property.
   * Undefined for jobs without an environment.
   */
  environment?: string;
  /**
   * Secrets resolved for this job's environment.
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
   * // Emit a simple event
   * await ctx.emit('deploy-complete', { env: 'prod', version: '1.2.3' });
   *
   * // Emit with cross-repo targeting
   * await ctx.emit('deploy-complete', { env: 'prod' }, { target: { repos: ['org/other-repo'] } });
   */
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
   * combination suffix — identical under `kici run local` and the remote path.
   * Use {@link isMatrixJobOutputs} (or `'byMatrix' in result`) to discriminate.
   *
   * @example
   * const setupOutputs = ctx.jobOutputs(setupJob);
   * @example
   * const m = ctx.jobOutputs(buildMatrixJob);
   * if (isMatrixJobOutputs(m)) console.log(m.byMatrix['linux, arm64']);
   */
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
   * Build, sign, and persist a KiCI build-provenance attestation for a produced
   * artifact. The in-toto statement's identity is derived from a Platform-minted
   * identity token (unforgeable); the bundle is signed with an ephemeral key and
   * is offline-verifiable. Pass the artifact via a precomputed digest or a path
   * the agent digests with SHA-256.
   */
  attestProvenance(
    opts: import('./provenance-types.js').AttestProvenanceOptions,
  ): Promise<import('./provenance-types.js').AttestProvenanceResult>;
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
