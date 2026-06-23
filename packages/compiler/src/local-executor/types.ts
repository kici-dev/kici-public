import type { MatrixValues, Job } from '@kici-dev/sdk';
import type { CheckMode } from '@kici-dev/engine';
import type { JobResult } from '../test-runner/job-executor.js';

/**
 * All CLI flags for `kici run local`.
 */
export interface RunLocalOptions {
  /** Positional arg: event type (e.g. 'push', 'pr:open'). Optional when `pick` is true. */
  event?: string;
  /** --pick / -p: interactive workflow picker (derives event arg from the selected trigger) */
  pick?: boolean;
  /** --workflow filter: run only matching workflow */
  workflow?: string;
  /** --job filter: run only matching job (includes transitive deps) */
  job?: string;
  /** --branch override: override detected git branch */
  branch?: string;
  /** --sha override: override detected git SHA */
  sha?: string;
  /** --payload path: explicit event payload JSON file */
  payload?: string;
  /** --concurrency: max parallel jobs (default: os.availableParallelism()) */
  concurrency?: number;
  /** --keep-going: continue after job failure (default: false) */
  keepGoing?: boolean;
  /** --container: use Podman isolation (default: false) */
  container?: boolean;
  /** --env KEY=VALUE overrides (repeatable) */
  env?: string[];
  /** --quiet: minimal output */
  quiet?: boolean;
  /** --json: JSON output format */
  json?: boolean;
  /** --junit: path for JUnit XML report */
  junit?: string;
  /** --files: override changed file paths (repeatable) */
  files?: string[];
  /** --debug: verbose debug output */
  debug?: boolean;
  /** --kici-dir: path to .kici directory */
  kiciDir?: string;
  /** --in-place: run against the real working directory instead of an isolated tmp checkout */
  inPlace?: boolean;
  /** --keep: always retain the isolated tmp checkout (default: keep only on failure) */
  keep?: boolean;
  /**
   * Run mode resolved from --check / --fail-on-drift. Threads to the agent step
   * loop: `apply` (default) converges, `check` previews drift, `check-fail-on-drift`
   * previews drift and fails the run if any step reports drift. Defaults to `apply`.
   */
  checkMode?: CheckMode;
}

/**
 * A job after matrix expansion with resolved values.
 */
export interface ResolvedJob {
  /** Original job definition */
  job: Job;
  /** Expanded name (e.g. 'test (node-18, linux)') */
  expandedName: string;
  /** Matrix values for this expansion (empty object if no matrix) */
  matrixValues: MatrixValues;
  /** Resolved dependency names (expanded names of upstream jobs) */
  resolvedNeeds: string[];
}

/**
 * Result for a single job execution in local mode.
 * Extends JobResult with matrix context and cancellation.
 */
export interface LocalJobResult extends Omit<JobResult, 'status'> {
  /** Job completion status (adds 'cancelled' to base JobResult statuses) */
  status: 'success' | 'failure' | 'skipped' | 'cancelled';
  /** Matrix values if this job was part of a matrix expansion */
  matrixValues?: MatrixValues;
  /** Whether this job was cancelled (e.g. by AbortSignal) */
  cancelled?: boolean;
}

/**
 * Result of executing a workflow locally.
 */
export interface WorkflowExecutionResult {
  /** Workflow name */
  name: string;
  /** Overall status */
  status: 'success' | 'failure' | 'skipped';
  /** Individual job results */
  jobs: LocalJobResult[];
  /** Total execution duration in milliseconds */
  durationMs: number;
}
