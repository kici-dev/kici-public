/** `kici-admin runs`: read access to execution runs and their sub-resources over the admin API. */

import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import {
  ExecutionJobStatus,
  StepPhase,
  compareStepsByPhase,
  initStepIndex,
  initStepLabel,
  initStepType,
  parseInitStepRef,
  stepPhase,
  type AgentStepLogs,
} from '@kici-dev/engine';
import { cliAction } from './shared/cli-action.js';
import { renderTable } from './shared/table.js';
import { resolveRunRef } from './shared/run-ref.js';

/** Run summary shape returned by GET /api/v1/admin/runs. */
interface RunSummaryDTO {
  runId: string;
  workflowName: string;
  /** Every workflow the run spans, `workflowName` first; absent from an older orchestrator. */
  workflowNames?: string[];
  status: string;
  provider: string;
  repoIdentifier: string;
  ref: string;
  sha: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  parentRunId: string | null;
  triggeredBy: string | null;
  failureReason: string | null;
  context: string | null;
  trustTier: string | null;
  createdAt: string;
}

interface ListRunsResponse {
  runs: RunSummaryDTO[];
  total: number;
  limit: number;
  offset: number;
}

interface CountRunsResponse {
  total: number;
  since: string | null;
  status: string[] | null;
  workflowName: string | null;
  repo: string | null;
}

interface StepDTO {
  stepIndex: number;
  stepName: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  errorMessage: string | null;
  stepType: string;
  /** The job phase the step ran in; absent from an older orchestrator. */
  phase?: StepPhase;
  /** The init position of an init step; absent on other steps and from an older orchestrator. */
  initIndex?: number;
}

/** Job detail returned by GET /api/v1/admin/runs/:runId/jobs. */
interface JobDTO {
  jobId: string;
  jobName: string;
  /** The workflow that defines the job; null when not recorded, absent from an older orchestrator. */
  workflowName?: string | null;
  status: string;
  matrixValues: Record<string, unknown> | null;
  agentId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  /** Why this job cannot be routed; present only while it waits, unroutable. */
  routingReason?: string | null;
  runsOnLabels: string[] | null;
  createdAt: string;
  /** Present only when ?includeSteps=true. */
  steps?: StepDTO[];
}

/** Run detail shape returned by GET /api/v1/admin/runs/:runId. */
interface RunDetailDTO {
  runId: string;
  workflowName: string;
  /** Every workflow the run spans, `workflowName` first; absent from an older orchestrator. */
  workflowNames?: string[];
  status: string;
  provider: string;
  repoIdentifier: string;
  ref: string;
  sha: string;
  deliveryId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  isTestRun: boolean;
  parentRunId: string | null;
  originalRunId: string | null;
  triggeredBy: string | null;
  cancelledBy: string | null;
  context: string | null;
  trustTier: string | null;
  lockFileSource: string | null;
  contributorUsername: string | null;
  failureReason: string | null;
  createdAt: string;
  /**
   * The repository that defines the workflow, set only when it is not the
   * repository the run acted on (an organization-wide workflow). The same
   * narrowing holds for the commit and branch below: all three are null on a
   * run of a repository's own workflow.
   */
  workflowRepoIdentifier?: string | null;
  /** The workflow repository commit the run dispatched. */
  workflowSha?: string | null;
  /** The workflow repository's registered branch. */
  workflowBranch?: string | null;
}

interface RunDetailResponse {
  run: RunDetailDTO;
}

interface JobsResponse {
  jobs: JobDTO[];
}

interface EphemeralKeyResponse {
  exists: boolean;
  createdAt: string | null;
}

interface SecretOutputDTO {
  id: string;
  jobId: string;
  outputKey: string;
  createdAt: string;
  value: string | null;
  masked: boolean;
  revealError?: string;
}

interface SecretOutputsResponse {
  outputs: SecretOutputDTO[];
}

/** An untrusted-envelope value (or null) as returned by /structured. */
type UntrustedOrNull = { untrusted: true; value: string } | null;

/** The AgentRunResult fields the human view renders; the full type is in engine. */
interface AgentRunResultDTO {
  runId: string;
  workflowName: UntrustedOrNull;
  status: string;
  failureCategory: string | null;
  failureReason: UntrustedOrNull;
  repoIdentifier: UntrustedOrNull;
  ref: UntrustedOrNull;
  sha: string;
  durationMs: number | null;
  jobs: Array<{
    jobName: UntrustedOrNull;
    status: string;
    steps: Array<{
      stepIndex: number;
      stepName: UntrustedOrNull;
      status: string;
      exitCode: number | null;
      durationMs: number | null;
      /** `step` for a plain step. */
      stepType?: string;
    }>;
  }>;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m${remainSecs}s`;
}

/** Every workflow a run spans; an older orchestrator reports only the first. */
function runWorkflows(run: { workflowName: string; workflowNames?: string[] }): string[] {
  return run.workflowNames?.length ? run.workflowNames : [run.workflowName];
}

/**
 * The `workflow` cell of `runs list`: the run's workflow, plus how many more it
 * spans (`hello-world +3`), so a run of several workflows never reads as one.
 */
function workflowListCell(run: { workflowName: string; workflowNames?: string[] }): string {
  const names = runWorkflows(run);
  return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0];
}

/**
 * A job's label in the per-job lines: qualified with its workflow when the run
 * spans several, where two jobs can share a name.
 */
function jobLabel(job: JobDTO, spansWorkflows: boolean): string {
  return spansWorkflows && job.workflowName ? `${job.workflowName} / ${job.jobName}` : job.jobName;
}

/**
 * Header lines naming where an organization-wide run's workflow is defined.
 * "Defined in" prints only when the workflow repository differs from the run's
 * own, the same condition as the dashboard's run metadata panel; the commit and
 * branch print whenever set.
 */
function workflowProvenanceLines(run: RunDetailDTO): string[] {
  const lines: string[] = [];
  if (run.workflowRepoIdentifier && run.workflowRepoIdentifier !== run.repoIdentifier) {
    lines.push(`  Defined in:  ${run.workflowRepoIdentifier} (organization-wide workflow)`);
  }
  if (run.workflowSha) lines.push(`  Workflow SHA: ${run.workflowSha}`);
  if (run.workflowBranch) lines.push(`  Workflow branch: ${run.workflowBranch}`);
  return lines;
}

/**
 * A job's steps in run order: setup and init pseudo-steps first, whatever order the
 * orchestrator sent. An older orchestrator orders init steps by their stored index, last.
 */
function stepsInRunOrder<T extends { stepIndex: number; stepType?: string | null }>(
  steps: T[],
): T[] {
  return [...steps].sort(compareStepsByPhase);
}

/**
 * The `#` cell of a step row: the step index, or `init[<n>]` for an init step, whose
 * stored index is a high internal value and not a position among the steps.
 */
function stepNumberCell(step: { stepIndex: number; stepType?: string | null }): string {
  const initIndex = initStepIndex(step.stepType);
  return initIndex === undefined ? String(step.stepIndex) : initStepLabel(initIndex);
}

/** The `type` cell of a `runs show` step row: blank for a plain step, `init` for any init. */
function stepTypeCell(stepType: string): string {
  if (stepPhase(stepType) === StepPhase.enum.init) return StepPhase.enum.init;
  return stepType === 'step' ? '' : stepType;
}

/**
 * The stored step index `runs logs --step` names. An init step is shown as `init[<n>]`,
 * not by its stored index, so that label resolves through the job's steps; any other
 * value passes through for the server to validate.
 */
async function resolveStepRef(
  client: AdminApiClient,
  runId: string,
  jobId: string,
  step: unknown,
): Promise<string> {
  const ref = String(step);
  const initIndex = parseInitStepRef(ref);
  if (initIndex === undefined) return ref;
  const { jobs } = (await client.getRunJobs(runId, {
    includeSteps: true,
  })) as unknown as JobsResponse;
  const job = jobs.find((j) => j.jobId === jobId);
  if (!job) throw new Error(`Job ${jobId} not found in run ${runId}`);
  const match = (job.steps ?? []).find((s) => s.stepType === initStepType(initIndex));
  if (!match) throw new Error(`Job ${jobId} has no ${initStepLabel(initIndex)} step`);
  return String(match.stepIndex);
}

/** The step index of a job's setup log: the clone, the install and the module load. */
const SETUP_LOG_STEP_INDEX = -1;

/**
 * The note `runs logs` prints when a step has no lines: whether no log was ever
 * recorded, or a log is stored and holds nothing. `null` when the step has
 * lines, or when the orchestrator does not report which case applies.
 */
export function emptyStepLogNote(
  /** The step index, or an init step's `init[<n>]` label. */
  step: number | string,
  logs: Pick<AgentStepLogs, 'totalLines' | 'recorded'>,
): string | null {
  if (logs.totalLines > 0 || logs.recorded === undefined) return null;
  if (step === SETUP_LOG_STEP_INDEX) {
    return logs.recorded
      ? '(the setup log for this job is empty)'
      : '(no setup log recorded for this job)';
  }
  return logs.recorded
    ? `(the log for step ${step} is empty)`
    : `(no log recorded for step ${step})`;
}

const RUN_ID_ARG_HELP = 'Run id, or its first 4 or more characters';

export function registerRunsCommands(program: Command, getClient: () => AdminApiClient): void {
  const runs = program.command('runs').description('Inspect execution runs, jobs, and steps');

  // ── runs list ──────────────────────────────────────────────────
  runs
    .command('list')
    .description('List execution runs (admin API: /api/v1/admin/runs)')
    .option(
      '--status <statuses>',
      'Filter by run status. Accepts a single value or a comma-separated list (e.g. success,failed)',
    )
    .option(
      '--workflow-name <name>',
      'Filter by workflow name. A run that spans several workflows matches any of them',
    )
    .option('--repo <ownerRepo>', 'Filter by repo identifier (owner/repo)')
    .option(
      '--since <iso8601>',
      'Only include runs with created_at strictly later than this ISO-8601 timestamp',
    )
    .option('--count', 'Return only the count of matching runs, skipping the row listing')
    .option('--limit <n>', 'Max results (default 20, max 100)', '20')
    .option('--offset <n>', 'Skip first N results', '0')
    .option('--json', 'Emit raw JSON instead of a table')
    .action(
      cliAction(async (opts) => {
        if (opts.count) {
          const response = await getClient().countRuns({
            status: opts.status,
            workflowName: opts.workflowName,
            repo: opts.repo,
            since: opts.since,
          });
          const data = response as unknown as CountRunsResponse;
          if (opts.json) {
            console.log(JSON.stringify(data, null, 2));
          } else {
            console.log(String(data.total));
          }
          return;
        }

        const response = await getClient().listRuns({
          status: opts.status,
          workflowName: opts.workflowName,
          repo: opts.repo,
          since: opts.since,
          limit: parseInt(opts.limit, 10),
          offset: parseInt(opts.offset, 10),
        });
        const data = response as unknown as ListRunsResponse;

        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }

        if (data.runs.length === 0) {
          console.log('No execution runs found.');
          return;
        }

        const headers = [
          'run_id',
          'workflow',
          'status',
          'repo',
          'ref',
          'sha',
          'started_at',
          'duration',
        ];
        const rows = data.runs.map((r) => [
          r.runId,
          workflowListCell(r),
          r.status,
          r.repoIdentifier,
          r.ref,
          r.sha.slice(0, 7),
          r.startedAt ?? '-',
          formatDuration(r.durationMs),
        ]);

        console.log(renderTable(headers, rows));
        console.log('');
        console.log(
          `Showing ${data.runs.length} of ${data.total} (offset ${data.offset}, limit ${data.limit})`,
        );
      }),
    );

  // ── runs show <runId> ──────────────────────────────────────────
  // Run fields and jobs (?includeSteps=true) are separate endpoints; this
  // composes both into one view.
  runs
    .command('show')
    .argument('<runId>', RUN_ID_ARG_HELP)
    .description('Show run detail with jobs and steps')
    .option('--json', 'Emit raw JSON instead of formatted output')
    .action(
      cliAction(async (runRef: string, opts) => {
        const runId = await resolveRunRef(getClient(), runRef);
        const client = getClient();
        const [runRespRaw, jobsRespRaw] = await Promise.all([
          client.getRun(runId),
          client.getRunJobs(runId, { includeSteps: true }),
        ]);
        const runResp = runRespRaw as unknown as RunDetailResponse;
        const jobsResp = jobsRespRaw as unknown as JobsResponse;

        const data = { run: runResp.run, jobs: jobsResp.jobs };

        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }

        const { run, jobs } = data;
        const workflows = runWorkflows(run);
        const spansWorkflows = workflows.length > 1;

        console.log(`Run: ${run.runId}`);
        if (spansWorkflows) console.log(`  Workflows:   ${workflows.join(', ')}`);
        else console.log(`  Workflow:    ${run.workflowName}`);
        console.log(`  Status:      ${run.status}`);
        console.log(`  Repo:        ${run.repoIdentifier}`);
        console.log(`  Ref:         ${run.ref}`);
        console.log(`  SHA:         ${run.sha}`);
        console.log(`  Provider:    ${run.provider}`);
        console.log(`  Started:     ${run.startedAt ?? '-'}`);
        console.log(`  Completed:   ${run.completedAt ?? '-'}`);
        console.log(`  Duration:    ${formatDuration(run.durationMs)}`);
        if (run.triggeredBy) console.log(`  Triggered by: ${run.triggeredBy}`);
        if (run.cancelledBy) console.log(`  Cancelled by: ${run.cancelledBy}`);
        if (run.parentRunId) console.log(`  Parent run:  ${run.parentRunId}`);
        if (run.originalRunId) console.log(`  Original run: ${run.originalRunId}`);
        if (run.context) console.log(`  Context:     ${run.context}`);
        if (run.trustTier) console.log(`  Trust tier:  ${run.trustTier}`);
        for (const line of workflowProvenanceLines(run)) console.log(line);
        if (run.failureReason) console.log(`  Failure:     ${run.failureReason}`);
        if (run.isTestRun) console.log(`  Test run:    yes`);

        if (jobs.length === 0) {
          console.log('\nNo jobs.');
          return;
        }

        console.log('');
        const jobHeaders = ['job_id', 'name', 'workflow', 'status', 'agent', 'duration', 'steps'];
        const jobRows = jobs.map((j) => [
          j.jobId,
          j.jobName,
          j.workflowName ?? '-',
          j.status,
          j.agentId ?? '-',
          formatDuration(j.durationMs),
          String(j.steps?.length ?? 0),
        ]);
        console.log(renderTable(jobHeaders, jobRows));

        // A waiting job nothing can route shows its unmatched selectors. Gated on
        // the job still waiting: not every dequeue path clears `routingReason`,
        // and a terminal job states its cause in `errorMessage`.
        const unroutableJobs = jobs.filter(
          (j) =>
            j.routingReason &&
            (j.status === ExecutionJobStatus.enum.pending ||
              j.status === ExecutionJobStatus.enum.queued),
        );
        if (unroutableJobs.length > 0) {
          console.log('');
          for (const job of unroutableJobs) {
            console.log(`  ! ${jobLabel(job, spansWorkflows)}: ${job.routingReason}`);
          }
        }

        const jobsWithSteps = jobs.filter((j) => (j.steps?.length ?? 0) > 0);
        if (jobsWithSteps.length > 0) {
          for (const job of jobsWithSteps) {
            console.log('');
            console.log(`Steps for ${jobLabel(job, spansWorkflows)} (${job.jobId}):`);
            const stepHeaders = ['#', 'name', 'status', 'exit', 'duration', 'type'];
            const stepRows = stepsInRunOrder(job.steps ?? []).map((s) => [
              stepNumberCell(s),
              s.stepName,
              s.status,
              s.exitCode != null ? String(s.exitCode) : '-',
              formatDuration(s.durationMs),
              stepTypeCell(s.stepType),
            ]);
            console.log(renderTable(stepHeaders, stepRows));
          }
        }
      }),
    );

  // ── runs structured <runId> ────────────────────────────────────
  // Machine-first provenance-tagged run result. --json is lossless (untrusted
  // envelopes preserved); the human view unwraps for display only.
  runs
    .command('structured')
    .argument('<runId>', RUN_ID_ARG_HELP)
    .description('Show the provenance-tagged structured run result (agent read path; /structured)')
    .option('--json', 'Emit the raw AgentRunResult (untrusted envelopes preserved)')
    .action(
      cliAction(async (runRef: string, opts) => {
        const runId = await resolveRunRef(getClient(), runRef);
        const result = (await getClient().getRunStructured(runId)) as unknown as AgentRunResultDTO;
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        const uv = (v: UntrustedOrNull): string =>
          v == null ? '-' : typeof v === 'object' ? v.value : String(v);

        console.log(`Run: ${result.runId}`);
        console.log(`  Workflow:    ${uv(result.workflowName)}`);
        console.log(`  Status:      ${result.status}`);
        console.log(`  Failure:     ${result.failureCategory ?? '-'}`);
        if (result.failureReason) console.log(`  Reason:      ${uv(result.failureReason)}`);
        console.log(`  Repo:        ${uv(result.repoIdentifier)}`);
        console.log(`  Ref:         ${uv(result.ref)}`);
        console.log(`  SHA:         ${result.sha}`);
        console.log(`  Duration:    ${formatDuration(result.durationMs)}`);

        if (result.jobs.length === 0) {
          console.log('\nNo jobs.');
          return;
        }
        console.log('');
        const jobHeaders = ['job', 'status', 'failed_steps'];
        const jobRows = result.jobs.map((j) => [
          uv(j.jobName),
          j.status,
          String(j.steps.filter((s) => s.exitCode != null && s.exitCode !== 0).length),
        ]);
        console.log(renderTable(jobHeaders, jobRows));

        for (const job of result.jobs) {
          if (job.steps.length === 0) continue;
          console.log('');
          console.log(`Steps for ${uv(job.jobName)}:`);
          const stepHeaders = ['#', 'name', 'status', 'exit', 'duration'];
          const stepRows = stepsInRunOrder(job.steps).map((s) => [
            stepNumberCell(s),
            uv(s.stepName),
            s.status,
            s.exitCode != null ? String(s.exitCode) : '-',
            formatDuration(s.durationMs),
          ]);
          console.log(renderTable(stepHeaders, stepRows));
        }
      }),
    );

  // ── runs jobs <runId> ──────────────────────────────────────────
  runs
    .command('jobs')
    .argument('<runId>', RUN_ID_ARG_HELP)
    .description('List jobs for a run (admin API: /api/v1/admin/runs/:runId/jobs)')
    .option('--include-steps', 'Embed step list inside each job (default false)')
    .option('--json', 'Emit raw JSON instead of a table')
    .action(
      cliAction(async (runRef: string, opts) => {
        const runId = await resolveRunRef(getClient(), runRef);
        const response = (await getClient().getRunJobs(runId, {
          includeSteps: Boolean(opts.includeSteps),
        })) as unknown as JobsResponse;

        if (opts.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }

        if (response.jobs.length === 0) {
          console.log('No jobs for this run.');
          return;
        }

        const headers = ['job_id', 'name', 'workflow', 'status', 'agent', 'duration', 'started_at'];
        const rows = response.jobs.map((j) => [
          j.jobId,
          j.jobName,
          j.workflowName ?? '-',
          j.status,
          j.agentId ?? '-',
          formatDuration(j.durationMs),
          j.startedAt ?? '-',
        ]);
        console.log(renderTable(headers, rows));

        if (opts.includeSteps) {
          const spansWorkflows =
            new Set(response.jobs.map((j) => j.workflowName).filter(Boolean)).size > 1;
          for (const job of response.jobs) {
            const steps = job.steps ?? [];
            if (steps.length === 0) continue;
            console.log('');
            console.log(`Steps for ${jobLabel(job, spansWorkflows)} (${job.jobId}):`);
            const stepHeaders = ['#', 'name', 'status', 'exit', 'duration'];
            const stepRows = stepsInRunOrder(steps).map((s) => [
              stepNumberCell(s),
              s.stepName,
              s.status,
              s.exitCode != null ? String(s.exitCode) : '-',
              formatDuration(s.durationMs),
            ]);
            console.log(renderTable(stepHeaders, stepRows));
          }
        }
      }),
    );

  // ── runs logs <runId> ──────────────────────────────────────────
  // The only kici-admin path to step log lines. It reads the admin route, not
  // the dashboard plane, so it serves a global eval round, which writes no
  // execution_runs row. Find the round's ids with
  // `kici-admin queue list --workflow-name '__globaleval__<owner>/<repo>' --json`
  // (`id` is the job id, `run_id` the run id).
  runs
    .command('logs')
    .argument('<runId>', RUN_ID_ARG_HELP)
    .description(
      'Print a page of a step log (admin API: /api/v1/admin/runs/:runId/jobs/:jobId/steps/:i/logs)',
    )
    .requiredOption('--job <jobId>', 'Job id (the dispatch_queue row id for an eval round)')
    .option(
      '--step <n>',
      'Step index (default 0; -1 is the job setup log), or an init step as init[<n>]',
      '0',
    )
    .option('--limit <n>', 'Max lines to return (default 500, server caps at 2000)', '500')
    .option('--cursor <c>', 'Line-offset cursor from a previous page')
    .option('--json', 'Emit raw JSON instead of plain lines')
    .action(
      cliAction(async (runRef: string, opts) => {
        const runId = await resolveRunRef(getClient(), runRef);
        const stepIndex = await resolveStepRef(getClient(), runId, String(opts.job), opts.step);
        const params = new URLSearchParams({ limit: String(opts.limit) });
        if (opts.cursor) params.set('cursor', String(opts.cursor));
        const path =
          `/api/v1/admin/runs/${encodeURIComponent(runId)}` +
          `/jobs/${encodeURIComponent(String(opts.job))}` +
          `/steps/${encodeURIComponent(stepIndex)}/logs?${params.toString()}`;
        const response = await getClient().get<AgentStepLogs>(path);

        if (opts.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }
        // Only line values go to stdout so it stays pipeable; hints go to stderr.
        for (const line of response.lines) console.log(line.value);
        if (response.nextCursor) {
          console.error(`(more: re-run with --cursor ${response.nextCursor})`);
        }
        // An init step is named by its label, never by its stored index.
        const initIndex = parseInitStepRef(String(opts.step));
        const note = emptyStepLogNote(
          initIndex === undefined ? parseInt(stepIndex, 10) : initStepLabel(initIndex),
          response,
        );
        if (note) console.error(note);
      }),
    );

  // ── runs ephemeral-key <runId> ─────────────────────────────────
  runs
    .command('ephemeral-key')
    .argument('<runId>', RUN_ID_ARG_HELP)
    .description('Show whether the run-ephemeral key has been scrubbed yet')
    .option('--json', 'Emit raw JSON instead of plain text')
    .action(
      cliAction(async (runRef: string, opts) => {
        const runId = await resolveRunRef(getClient(), runRef);
        const response = (await getClient().getRunEphemeralKey(
          runId,
        )) as unknown as EphemeralKeyResponse;
        if (opts.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }
        if (response.exists) {
          console.log(`exists: true`);
          console.log(`created_at: ${response.createdAt}`);
        } else {
          console.log(`exists: false`);
          console.log(`created_at: -`);
        }
      }),
    );

  // ── runs secret-outputs <runId> ────────────────────────────────
  runs
    .command('secret-outputs')
    .argument('<runId>', RUN_ID_ARG_HELP)
    .description('List per-job secret outputs (masked by default; --reveal decrypts and audits)')
    .option('--output-key <key>', 'Filter to a single output_key')
    .option(
      '--reveal',
      'Decrypt and print plaintext values. Audited with actor=secret-outputs.reveal; requires secret.reveal permission',
    )
    .option('--json', 'Emit raw JSON instead of a table')
    .action(
      cliAction(async (runRef: string, opts) => {
        const runId = await resolveRunRef(getClient(), runRef);
        if (opts.reveal) {
          process.stderr.write(
            '⚠  --reveal will decrypt secret values; this call is recorded in secret_audit_log.\n',
          );
        }
        const response = (await getClient().getRunSecretOutputs(runId, {
          outputKey: opts.outputKey,
          reveal: Boolean(opts.reveal),
        })) as unknown as SecretOutputsResponse;

        if (opts.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }

        if (response.outputs.length === 0) {
          console.log('No secret outputs for this run.');
          return;
        }

        const headers = opts.reveal
          ? ['job_id', 'output_key', 'value', 'created_at']
          : ['job_id', 'output_key', 'masked', 'created_at'];
        const rows = response.outputs.map((o) =>
          opts.reveal
            ? [o.jobId, o.outputKey, o.value ?? o.revealError ?? '(decrypt failed)', o.createdAt]
            : [o.jobId, o.outputKey, String(o.masked), o.createdAt],
        );
        console.log(renderTable(headers, rows));
      }),
    );
}
