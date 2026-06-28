/**
 * Shared run-detail aggregator.
 *
 * One source of truth for "DB rows → canonical nested run detail (jobs with
 * nested steps + needs + outputs)". The dashboard handler and the agent-facing
 * structured run-result route both build on the same `buildRunDetailJobs` /
 * `mapRunDetailStep` mapping, so the row→jobs shape never diverges between the
 * two read surfaces.
 *
 * `aggregateRunDetail` is the warm-path convenience used by the agent route: it
 * runs the run-header + per-run batch queries and returns the canonical detail.
 * (Cold-store fallback stays a dashboard-handler concern — the agent read path
 * is warm-only in v1.)
 */
import type { Kysely } from 'kysely';
import type { ExecutionJobStatus, InitFailure } from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import { groupNeedsByJobName } from '../dashboard/needs-edges.js';

/** A run-detail step row as queried from execution_steps (warm + cold paths). */
export interface RunDetailStepRow {
  step_index: number;
  step_name: string;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  duration_ms: number | null;
  exit_code: number | null;
  error_message: string | null;
  step_type: string;
  secrets_accessed: string | null;
  check_outcome: string | null;
  drift_summary: string | null;
  concurrency_kind: string | null;
  group_id: string | null;
}

/** Map a step row to the dashboard run-detail step shape (epoch-ms timestamps). */
export function mapRunDetailStep(step: RunDetailStepRow) {
  return {
    stepIndex: step.step_index,
    stepName: step.step_name,
    status: step.status,
    startedAt: step.started_at ? step.started_at.getTime() : null,
    completedAt: step.completed_at ? step.completed_at.getTime() : null,
    durationMs: step.duration_ms ?? null,
    exitCode: step.exit_code ?? null,
    errorMessage: step.error_message ?? null,
    ...(step.step_type !== 'step' && { stepType: step.step_type }),
    secretsAccessed: step.secrets_accessed ?? null,
    ...(step.check_outcome != null && { checkOutcome: step.check_outcome }),
    ...(step.drift_summary != null && { driftSummary: step.drift_summary }),
    ...(step.concurrency_kind != null && { concurrencyKind: step.concurrency_kind }),
    ...(step.group_id != null && { groupId: step.group_id }),
  };
}

/** A run-detail job row as queried from execution_jobs (warm + cold paths). */
export interface RunDetailJobRow {
  job_id: string;
  job_name: string;
  status: string;
  matrix_values: unknown;
  base_job_name: string | null;
  variant_kind: string | null;
  variant_label: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  duration_ms: number | null;
  agent_id: string | null;
  error_message: string | null;
  runs_on_labels: unknown;
  environments: unknown;
  outputs: unknown;
  init_failure: unknown;
}

/** Lookups threaded into {@link buildRunDetailJobs} from the per-run batch queries. */
export interface RunDetailJobLookups {
  stepsByJob: Map<string, RunDetailStepRow[]>;
  secretKeysByJob: Map<string, string[]>;
  needsByJob: Map<string, Array<{ upstreamName: string; runOn: ExecutionJobStatus[] }>>;
}

/** Map queried job + step rows into the dashboard run-detail job DTO shape. */
export function buildRunDetailJobs(jobs: RunDetailJobRow[], lookups: RunDetailJobLookups) {
  const { stepsByJob, secretKeysByJob, needsByJob } = lookups;
  return jobs.map((job) => {
    const jobSteps = stepsByJob.get(job.job_id) ?? [];
    const jobInitFailure = (job.init_failure as InitFailure | null) ?? undefined;
    return {
      jobId: job.job_id,
      jobName: job.job_name,
      status: job.status,
      matrixValues: (job.matrix_values as Record<string, unknown> | null) ?? null,
      baseJobName: job.base_job_name ?? null,
      variantKind: job.variant_kind ?? null,
      variantLabel: job.variant_label ?? null,
      startedAt: job.started_at ? job.started_at.getTime() : null,
      completedAt: job.completed_at ? job.completed_at.getTime() : null,
      durationMs: job.duration_ms ?? null,
      agentId: job.agent_id ?? null,
      orchestratorId: null,
      errorMessage: job.error_message ?? null,
      runsOnLabels: (job.runs_on_labels as string[] | null) ?? null,
      environments: job.environments
        ? typeof job.environments === 'string'
          ? (JSON.parse(job.environments) as string[])
          : (job.environments as string[])
        : null,
      outputs: job.outputs
        ? typeof job.outputs === 'string'
          ? JSON.parse(job.outputs)
          : job.outputs
        : null,
      secretOutputKeys: secretKeysByJob.get(job.job_id) ?? null,
      ...(jobInitFailure && { initFailure: jobInitFailure }),
      needs: needsByJob.get(job.job_name) ?? null,
      steps: jobSteps.map(mapRunDetailStep),
    };
  });
}

/** A dashboard-shaped run-detail job (epoch-ms timestamps). */
export type CanonicalRunDetailJob = ReturnType<typeof buildRunDetailJobs>[number];

/**
 * Canonical run detail: the run header (raw `Date` timestamps) plus the
 * dashboard-shaped nested jobs. The agent mapper formats timestamps to ISO and
 * wraps untrusted fields; the dashboard handler consumes `buildRunDetailJobs`
 * directly.
 */
export interface CanonicalRunDetail {
  runId: string;
  workflowName: string;
  status: string;
  provider: string;
  repoIdentifier: string;
  ref: string;
  sha: string;
  /** Best-effort base commit from provider context; null when unavailable. */
  baseSha: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  durationMs: number | null;
  trustTier: string | null;
  contributorUsername: string | null;
  triggeredBy: string | null;
  failureReason: string | null;
  /** Run-scoped init failure (the run never executed a step). */
  initFailure: InitFailure | null;
  routingKey: string | null;
  jobs: CanonicalRunDetailJob[];
}

/** Parse JSON, returning null on invalid input. */
function safeJsonParse(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Best-effort base commit SHA from the run's `provider_context` JSON. */
function extractBaseSha(providerContext: string | null | undefined): string | null {
  const parsed = safeJsonParse(providerContext);
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const candidate = obj.baseSha ?? obj.base_sha ?? obj.baseCommitSha;
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

/**
 * Aggregate a run into the canonical nested detail (warm path). Returns null
 * when the run row is absent in PostgreSQL.
 */
export async function aggregateRunDetail(
  db: Kysely<Database>,
  runId: string,
): Promise<CanonicalRunDetail | null> {
  const run = await db
    .selectFrom('execution_runs')
    .select([
      'run_id',
      'workflow_name',
      'status',
      'provider',
      'repo_identifier',
      'ref',
      'sha',
      'started_at',
      'completed_at',
      'duration_ms',
      'trust_tier',
      'contributor_username',
      'triggered_by',
      'failure_reason',
      'init_failure',
      'provider_context',
      'routing_key',
    ])
    .where('run_id', '=', runId)
    .executeTakeFirst();
  if (!run) return null;

  const jobs = await db
    .selectFrom('execution_jobs')
    .select([
      'job_id',
      'job_name',
      'status',
      'matrix_values',
      'base_job_name',
      'variant_kind',
      'variant_label',
      'agent_id',
      'started_at',
      'completed_at',
      'duration_ms',
      'error_message',
      'runs_on_labels',
      'environments',
      'outputs',
      'init_failure',
    ])
    .where('run_id', '=', runId)
    .orderBy('created_at', 'asc')
    .execute();

  const steps = await db
    .selectFrom('execution_steps')
    .select([
      'job_id',
      'step_index',
      'step_name',
      'status',
      'started_at',
      'completed_at',
      'duration_ms',
      'exit_code',
      'error_message',
      'step_type',
      'secrets_accessed',
      'check_outcome',
      'drift_summary',
      'concurrency_kind',
      'group_id',
    ])
    .where('run_id', '=', runId)
    .orderBy('step_index', 'asc')
    .execute();

  const secretOutputRows = await db
    .selectFrom('run_secret_outputs')
    .select(['job_id', 'output_key'])
    .where('run_id', '=', runId)
    .execute();

  const needsRows = await db
    .selectFrom('execution_job_needs')
    .select(['job_name', 'upstream_name', 'run_on'])
    .where('run_id', '=', runId)
    .execute();

  const stepsByJob = new Map<string, RunDetailStepRow[]>();
  for (const step of steps) {
    let jobSteps = stepsByJob.get(step.job_id);
    if (!jobSteps) {
      jobSteps = [];
      stepsByJob.set(step.job_id, jobSteps);
    }
    jobSteps.push(step as RunDetailStepRow);
  }

  const secretKeysByJob = new Map<string, string[]>();
  for (const row of secretOutputRows) {
    let keys = secretKeysByJob.get(row.job_id);
    if (!keys) {
      keys = [];
      secretKeysByJob.set(row.job_id, keys);
    }
    keys.push(row.output_key);
  }

  const needsByJob = groupNeedsByJobName(needsRows);

  const canonicalJobs = buildRunDetailJobs(jobs as RunDetailJobRow[], {
    stepsByJob,
    secretKeysByJob,
    needsByJob,
  });

  return {
    runId: run.run_id,
    workflowName: run.workflow_name,
    status: run.status,
    provider: run.provider,
    repoIdentifier: run.repo_identifier,
    ref: run.ref,
    sha: run.sha,
    baseSha: extractBaseSha(run.provider_context),
    startedAt: run.started_at ?? null,
    completedAt: run.completed_at ?? null,
    durationMs: run.duration_ms ?? null,
    trustTier: run.trust_tier ?? null,
    contributorUsername: run.contributor_username ?? null,
    triggeredBy: run.triggered_by ?? null,
    failureReason: run.failure_reason ?? null,
    initFailure: (run.init_failure as InitFailure | null) ?? null,
    routingKey: run.routing_key ?? null,
    jobs: canonicalJobs,
  };
}
