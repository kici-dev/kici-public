/**
 * Execution run commands for kici-admin.
 *
 * Provides operator-facing read access to execution runs and their
 * sub-resources via the orchestrator's admin HTTP API. This is the
 * dogfooded replacement for hand-rolled curl commands when inspecting
 * run state.
 *
 *   runs list                          List execution runs (table or JSON)
 *   runs show <runId>                  Show run detail with jobs and steps
 *   runs jobs <runId>                  List jobs for a run (optional steps)
 *   runs ephemeral-key <runId>         Show scrub status of the run's key
 *   runs secret-outputs <runId>        List secret outputs (masked / reveal)
 *
 * Filter flags for `runs list`:
 *   --status            -> ?status=<csv>  (comma-separated, e.g. success,failed)
 *   --workflow-name     -> ?workflowName=<name>
 *   --repo              -> ?repo=<owner/repo>
 *   --since             -> ?since=<ISO-8601>
 *   --count             -> ?count=true    (emits only the count)
 *   --limit             -> ?limit=<n>     (default 20, max 100)
 *   --offset            -> ?offset=<n>    (default 0)
 *
 * Output:
 *   default             Aligned ASCII table
 *   --json              Raw JSON.stringify of the full response
 */

import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { toErrorMessage } from '@kici-dev/shared';

/** Run summary shape returned by GET /api/v1/admin/runs. */
interface RunSummaryDTO {
  runId: string;
  workflowName: string;
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
  environment: string | null;
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

/** Step detail nested inside job detail. */
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
}

/** Job detail returned by GET /api/v1/admin/runs/:runId/jobs. */
interface JobDTO {
  jobId: string;
  jobName: string;
  status: string;
  matrixValues: Record<string, unknown> | null;
  agentId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  runsOnLabels: string[] | null;
  createdAt: string;
  /** Present only when ?includeSteps=true. */
  steps?: StepDTO[];
}

/** Run detail shape returned by GET /api/v1/admin/runs/:runId. */
interface RunDetailDTO {
  runId: string;
  workflowName: string;
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
  environment: string | null;
  trustTier: string | null;
  lockFileSource: string | null;
  contributorUsername: string | null;
  failureReason: string | null;
  createdAt: string;
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

/** Minimal AgentRunResult shape for human rendering (full type lives in engine). */
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
    }>;
  }>;
}

/**
 * Render an aligned ASCII table.
 * Same pattern as workflow.ts — deliberately no cli-table dependency.
 */
function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));

  const fmtRow = (cells: string[]) =>
    cells
      .map((c, i) => (c ?? '').padEnd(widths[i]!))
      .join('  ')
      .trimEnd();

  const lines: string[] = [];
  lines.push(fmtRow(headers));
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) lines.push(fmtRow(r));
  return lines.join('\n');
}

/** Format duration in ms to human-readable string. */
function formatDuration(ms: number | null): string {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m${remainSecs}s`;
}

/**
 * Register the `runs` command group with kici-admin.
 */
export function registerRunsCommands(program: Command, getClient: () => AdminApiClient): void {
  const runs = program.command('runs').description('Inspect execution runs, jobs, and steps');

  // ── runs list ──────────────────────────────────────────────────
  runs
    .command('list')
    .description('List execution runs (dogfooded via /api/v1/admin/runs)')
    .option(
      '--status <statuses>',
      'Filter by run status. Accepts a single value or a comma-separated list (e.g. success,failed)',
    )
    .option('--workflow-name <name>', 'Filter by workflow name')
    .option('--repo <ownerRepo>', 'Filter by repo identifier (owner/repo)')
    .option(
      '--since <iso8601>',
      'Only include runs with created_at strictly later than this ISO-8601 timestamp',
    )
    .option('--count', 'Return only the count of matching runs, skipping the row listing')
    .option('--limit <n>', 'Max results (default 20, max 100)', '20')
    .option('--offset <n>', 'Skip first N results', '0')
    .option('--json', 'Emit raw JSON instead of a table')
    .action(async (opts) => {
      try {
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
          r.workflowName,
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
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── runs show <runId> ──────────────────────────────────────────
  // The orchestrator splits run detail across two endpoints:
  //   GET /api/v1/admin/runs/:runId         → run fields only
  //   GET /api/v1/admin/runs/:runId/jobs    → jobs (with ?includeSteps=true)
  // The CLI composes both calls to preserve the historical "one shot"
  // human view.
  runs
    .command('show <runId>')
    .description('Show run detail with jobs and steps')
    .option('--json', 'Emit raw JSON instead of formatted output')
    .action(async (runId: string, opts) => {
      try {
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

        // Run header
        console.log(`Run: ${run.runId}`);
        console.log(`  Workflow:    ${run.workflowName}`);
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
        if (run.environment) console.log(`  Environment: ${run.environment}`);
        if (run.trustTier) console.log(`  Trust tier:  ${run.trustTier}`);
        if (run.failureReason) console.log(`  Failure:     ${run.failureReason}`);
        if (run.isTestRun) console.log(`  Test run:    yes`);

        if (jobs.length === 0) {
          console.log('\nNo jobs.');
          return;
        }

        // Jobs table
        console.log('');
        const jobHeaders = ['job_id', 'name', 'status', 'agent', 'duration', 'steps'];
        const jobRows = jobs.map((j) => [
          j.jobId,
          j.jobName,
          j.status,
          j.agentId ?? '-',
          formatDuration(j.durationMs),
          String(j.steps?.length ?? 0),
        ]);
        console.log(renderTable(jobHeaders, jobRows));

        // Steps per job (only show if any job has steps)
        const jobsWithSteps = jobs.filter((j) => (j.steps?.length ?? 0) > 0);
        if (jobsWithSteps.length > 0) {
          for (const job of jobsWithSteps) {
            console.log('');
            console.log(`Steps for ${job.jobName} (${job.jobId}):`);
            const stepHeaders = ['#', 'name', 'status', 'exit', 'duration', 'type'];
            const stepRows = (job.steps ?? []).map((s) => [
              String(s.stepIndex),
              s.stepName,
              s.status,
              s.exitCode != null ? String(s.exitCode) : '-',
              formatDuration(s.durationMs),
              s.stepType === 'step' ? '' : s.stepType,
            ]);
            console.log(renderTable(stepHeaders, stepRows));
          }
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── runs structured <runId> ────────────────────────────────────
  // Machine-first provenance-tagged run result. --json is lossless (untrusted
  // envelopes preserved); the human view unwraps for display only.
  runs
    .command('structured <runId>')
    .description(
      'Show the provenance-tagged structured run result (agent read path; /structured)',
    )
    .option('--json', 'Emit the raw AgentRunResult (untrusted envelopes preserved)')
    .action(async (runId: string, opts) => {
      try {
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
          const stepRows = job.steps.map((s) => [
            String(s.stepIndex),
            uv(s.stepName),
            s.status,
            s.exitCode != null ? String(s.exitCode) : '-',
            formatDuration(s.durationMs),
          ]);
          console.log(renderTable(stepHeaders, stepRows));
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── runs jobs <runId> ──────────────────────────────────────────
  runs
    .command('jobs <runId>')
    .description('List jobs for a run (dogfooded via /api/v1/admin/runs/:runId/jobs)')
    .option('--include-steps', 'Embed step list inside each job (default false)')
    .option('--json', 'Emit raw JSON instead of a table')
    .action(async (runId: string, opts) => {
      try {
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

        const headers = ['job_id', 'name', 'status', 'agent', 'duration', 'started_at'];
        const rows = response.jobs.map((j) => [
          j.jobId,
          j.jobName,
          j.status,
          j.agentId ?? '-',
          formatDuration(j.durationMs),
          j.startedAt ?? '-',
        ]);
        console.log(renderTable(headers, rows));

        if (opts.includeSteps) {
          for (const job of response.jobs) {
            const steps = job.steps ?? [];
            if (steps.length === 0) continue;
            console.log('');
            console.log(`Steps for ${job.jobName} (${job.jobId}):`);
            const stepHeaders = ['#', 'name', 'status', 'exit', 'duration'];
            const stepRows = steps.map((s) => [
              String(s.stepIndex),
              s.stepName,
              s.status,
              s.exitCode != null ? String(s.exitCode) : '-',
              formatDuration(s.durationMs),
            ]);
            console.log(renderTable(stepHeaders, stepRows));
          }
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── runs ephemeral-key <runId> ─────────────────────────────────
  runs
    .command('ephemeral-key <runId>')
    .description('Show whether the run-ephemeral key has been scrubbed yet')
    .option('--json', 'Emit raw JSON instead of plain text')
    .action(async (runId: string, opts) => {
      try {
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
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── runs secret-outputs <runId> ────────────────────────────────
  runs
    .command('secret-outputs <runId>')
    .description('List per-job secret outputs (masked by default; --reveal decrypts and audits)')
    .option('--output-key <key>', 'Filter to a single output_key')
    .option(
      '--reveal',
      'Decrypt and print plaintext values. Audited with actor=secret-outputs.reveal; requires secret.reveal permission',
    )
    .option('--json', 'Emit raw JSON instead of a table')
    .action(async (runId: string, opts) => {
      try {
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
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
