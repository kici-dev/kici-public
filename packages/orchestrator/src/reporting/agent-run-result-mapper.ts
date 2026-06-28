/**
 * Map the canonical run detail into the provenance-tagged `AgentRunResult`.
 *
 * Trusted (plain): ids, enum statuses, exit codes, durations, timestamps,
 * hashes, the derived failure category. Untrusted (enveloped): every name, ref,
 * error string, contributor, job output value — anything sourced from the user's
 * repo / contributor / process output. Secret output *values* are never emitted;
 * only their key names appear.
 */
import {
  wrapUntrusted,
  ExecutionJobStatus,
  type AgentRunResult,
  type AgentJobResult,
  type AgentStepResult,
} from '@kici-dev/engine';
import { deriveFailureCategory } from './agent-failure-category.js';
import type { CanonicalRunDetail, CanonicalRunDetailJob } from './run-aggregator.js';

type CanonicalJob = CanonicalRunDetailJob;
type CanonicalStep = CanonicalRunDetailJob['steps'][number];

/** Epoch-ms (or null) → ISO-8601 string (or null). */
function epochToIso(ms: number | null | undefined): string | null {
  return typeof ms === 'number' ? new Date(ms).toISOString() : null;
}

/** Date (or null) → ISO-8601 string (or null). */
function dateToIso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/** Wrap a nullable string in an untrusted envelope, preserving null. */
function wrapNullable(s: string | null | undefined): { untrusted: true; value: string } | null {
  return s == null ? null : wrapUntrusted(s);
}

/**
 * Flatten the step-keyed non-secret job outputs into a flat
 * `"<stepKey>.<outputKey>" → untrusted(stringified value)` map. Secret outputs
 * are never present here (they live in `secretOutputKeys`).
 */
function mapOutputs(
  outputs: CanonicalJob['outputs'],
): Record<string, { untrusted: true; value: string }> | null {
  if (!outputs || typeof outputs !== 'object') return null;
  const flat: Record<string, { untrusted: true; value: string }> = {};
  for (const [stepKey, stepOutputs] of Object.entries(outputs as Record<string, unknown>)) {
    if (stepOutputs && typeof stepOutputs === 'object') {
      for (const [outKey, value] of Object.entries(stepOutputs as Record<string, unknown>)) {
        flat[`${stepKey}.${outKey}`] = wrapUntrusted(String(value));
      }
    } else {
      flat[stepKey] = wrapUntrusted(String(stepOutputs));
    }
  }
  return flat;
}

function mapStep(s: CanonicalStep): AgentStepResult {
  const secretsAccessed = Array.isArray(s.secretsAccessed) ? (s.secretsAccessed as string[]) : [];
  return {
    stepIndex: s.stepIndex,
    stepName: wrapUntrusted(s.stepName),
    status: s.status as AgentStepResult['status'],
    exitCode: s.exitCode ?? null,
    durationMs: s.durationMs ?? null,
    startedAt: epochToIso(s.startedAt),
    completedAt: epochToIso(s.completedAt),
    errorMessage: wrapNullable(s.errorMessage),
    stepType: s.stepType ?? 'step',
    checkOutcome: (s.checkOutcome as AgentStepResult['checkOutcome']) ?? null,
    secretsAccessed,
  };
}

function mapJob(j: CanonicalJob): AgentJobResult {
  return {
    jobId: j.jobId,
    jobName: wrapUntrusted(j.jobName),
    status: j.status as AgentJobResult['status'],
    startedAt: epochToIso(j.startedAt),
    completedAt: epochToIso(j.completedAt),
    durationMs: j.durationMs ?? null,
    agentId: j.agentId ?? null,
    errorMessage: wrapNullable(j.errorMessage),
    initFailure: j.initFailure
      ? {
          scope: j.initFailure.scope,
          category: j.initFailure.category,
          message: wrapUntrusted(j.initFailure.message),
        }
      : null,
    needs: (j.needs ?? []).map((n) => ({
      ref: wrapUntrusted(n.upstreamName),
      runOn: n.runOn,
    })),
    outputs: mapOutputs(j.outputs),
    secretOutputKeys: j.secretOutputKeys ?? [],
    steps: j.steps.map(mapStep),
  };
}

export function mapToAgentRunResult(d: CanonicalRunDetail): AgentRunResult {
  const anyStepNonZeroExit = d.jobs.some((j) =>
    j.steps.some((s) => typeof s.exitCode === 'number' && s.exitCode !== 0),
  );
  const timedOut = d.jobs.some((j) => j.status === ExecutionJobStatus.enum.timed_out_stale);
  const jobInitFailure = d.jobs.find((j) => j.initFailure)?.initFailure ?? null;
  const initFailure = d.initFailure ?? jobInitFailure;

  return {
    runId: d.runId,
    workflowName: wrapUntrusted(d.workflowName),
    status: d.status as AgentRunResult['status'],
    provider: d.provider,
    repoIdentifier: wrapUntrusted(d.repoIdentifier),
    ref: wrapUntrusted(d.ref),
    sha: d.sha,
    baseSha: d.baseSha ?? null,
    startedAt: dateToIso(d.startedAt),
    completedAt: dateToIso(d.completedAt),
    durationMs: d.durationMs ?? null,
    trustTier: (d.trustTier as AgentRunResult['trustTier']) ?? null,
    contributorUsername: wrapNullable(d.contributorUsername),
    failureCategory: deriveFailureCategory({
      runStatus: d.status,
      hasInitFailure: initFailure != null,
      initFailureCategory: initFailure?.category ?? null,
      timedOut,
      anyStepNonZeroExit,
    }),
    failureReason: wrapNullable(d.failureReason),
    triggeredBy: d.triggeredBy ?? null,
    jobs: d.jobs.map(mapJob),
  };
}
