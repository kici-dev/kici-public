import type { Job, Workflow } from '@kici-dev/sdk';
import type { WorkflowWithSource } from '../types.js';
import { analyzePurity } from './purity-analyzer.js';

/** Which dynamic-value slot on a job carried the impure function. */
export enum DynamicValueField {
  Context = 'context',
  Env = 'env',
  ConcurrencyGroup = 'concurrencyGroup',
}

/**
 * One impure dynamic-value function found on a static job. Each impurity forces
 * the orchestrator to dispatch an agent-side `__init__` job (~5-10s) instead of
 * inlining the value, so we surface it to the author at compile / preview time.
 */
export interface JobPurityWarning {
  workflowName: string;
  sourceFile?: string;
  jobName: string;
  field: DynamicValueField;
  reason: string;
}

function pushIfImpure(
  out: JobPurityWarning[],
  fn: unknown,
  field: DynamicValueField,
  base: { workflowName: string; sourceFile?: string; jobName: string },
): void {
  if (typeof fn !== 'function') return;
  const result = analyzePurity((fn as () => unknown).toString());
  if (!result.pure) {
    out.push({ ...base, field, reason: result.reason ?? 'unknown' });
  }
}

/**
 * Analyze a single static job's dynamic-value functions (context(s), env,
 * concurrencyGroup) for impurity. Returns one warning per impure function.
 */
export function analyzeJobPurity(
  job: Job,
  workflowName: string,
  sourceFile?: string,
): JobPurityWarning[] {
  const out: JobPurityWarning[] = [];
  const base = { workflowName, sourceFile, jobName: job.name };

  const contextRefs = job.contexts ?? (job.context !== undefined ? [job.context] : undefined);
  if (contextRefs) {
    for (const ref of contextRefs) {
      pushIfImpure(out, ref, DynamicValueField.Context, base);
    }
  }
  pushIfImpure(out, job.env, DynamicValueField.Env, base);
  pushIfImpure(out, job.concurrencyGroup, DynamicValueField.ConcurrencyGroup, base);

  return out;
}

/**
 * Walk every workflow's static jobs and collect impurity warnings. Function-typed
 * jobs (dynamic job generators) are skipped — their purity is analyzed at dispatch.
 */
export function collectWorkflowPurityWarnings(workflows: WorkflowWithSource[]): JobPurityWarning[] {
  const out: JobPurityWarning[] = [];
  for (const { workflow, source } of workflows) {
    for (const job of (workflow as Workflow).jobs) {
      if (typeof job === 'function') continue;
      out.push(...analyzeJobPurity(job, workflow.name, source.file));
    }
  }
  return out;
}
