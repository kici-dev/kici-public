/**
 * Test pipeline processor for CLI-initiated test runs.
 *
 * Reuses the existing webhook processing pipeline steps (lock file fetch,
 * trigger matching, job dispatch) but injects a synthetic event instead
 * of processing a real webhook. This avoids the anti-pattern of calling
 * processWebhook() directly (which expects WebhookInfo from a real webhook).
 *
 * Key differences from processWebhook():
 * - Skips dedup check (test runs are always unique)
 * - Skips webhook normalization (event is already in SimulatedEvent shape)
 * - Skips repo extraction from payload (routing key is provided directly)
 * - deliveryId has `test:` prefix for identification
 * - Execution runs are marked with is_test_run=true and fixture_id
 * - Supports direct workflow execution (bypass trigger matching)
 */

import { randomUUID } from 'node:crypto';
import { createLogger, toErrorMessage, decryptJson } from '@kici-dev/shared';
import { resolveOrgId } from './processor.js';
import type { LockFileCache } from '../lockfile-cache.js';
import type { Dispatcher } from '../agent/dispatcher.js';
import type { QueuedJobInput } from '../queue/job-queue.js';
import type { CheckRunReporter } from '../reporting/check-run-reporter.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';
import type { AgentRegistry } from '../agent/registry.js';
import type { ProviderRegistry } from '../provider-registry.js';
import type { SourceCache } from '../cache/index.js';
import type { BuildCoordinator } from '../cache/index.js';
import type { DepCache } from '../cache/index.js';
import type { PendingBuildTracker } from '../cache/index.js';
import type { SecretResolver } from '../secrets/secret-resolver.js';
import type { EnvironmentStore } from '../environments/environment-store.js';
import { toEnvironment } from '../environments/environment-store.js';
import type { VariableStore } from '../environments/variable-store.js';
import type { LogStorage } from '../reporting/log-storage.js';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type {
  LockFile as FullLockFile,
  LockJob,
  LockWorkflow,
  SimulatedEvent,
  WorkflowDecision,
} from '@kici-dev/engine';
import {
  isLockInlineValue,
  isLockStaticJob,
  matchAllWorkflows,
  createWorkflowDecision,
  materializeFanout,
  matrixEnvelopeFields,
} from '@kici-dev/engine';
import type { MaterializedJob } from '@kici-dev/engine';
import { evaluateInlineFields } from './inline-eval.js';

const logger = createLogger({ prefix: 'test-pipeline' });

/**
 * Input for a test trigger request.
 */
export interface TestTriggerInput {
  /** Unique fixture identifier from the CLI. */
  fixtureId: string;
  /** The simulated event to inject into the pipeline. */
  event: {
    type: string;
    action?: string;
    targetBranch: string;
    sourceBranch?: string;
    payload: Record<string, unknown>;
    changedFiles?: string[];
  };
  /** Routing key for provider lookup and lock file fetch. */
  routingKey: string;
  /** Reference to uploaded tarball (optional). */
  uploadId?: string;
  /** Fixture secret context mappings (optional). */
  secrets?: Record<string, string>;
  /** Base64 X25519+AES-GCM blob of the developer's local secrets ({flat, contexts}). */
  encryptedSecrets?: string;
  /** Base64 ephemeral CLI public key that encrypted `encryptedSecrets`. */
  encryptedSecretsKey?: string;
  /** Direct workflow run -- bypass triggers (optional). */
  workflowName?: string;
  /** Resolved overlay metadata for tarball download + decryption. */
  resolvedOverlay?: {
    tarballUrl: string;
    cliPublicKey: string;
    orchestratorPrivateKey: string;
  };
  /** Request trace ID from the HTTP request. */
  requestId: string;
  /** JSON-stringified lock file content for local repos with no remote. */
  inlineLockFile?: string;
  /** When true, repo has no remote -- skip provider lookup, skip clone. */
  fullRepo?: boolean;
}

/**
 * Result of processing a test trigger.
 */
interface TestTriggerResult {
  /** Unique run identifier. */
  runId: string;
  /** Whether the test trigger was accepted or rejected. */
  status: 'accepted' | 'rejected';
  /** Reason for rejection (if rejected). */
  reason?: string;
  /** Dispatched job IDs. */
  jobIds: string[];
}

/**
 * Dependencies for the test pipeline processor.
 * All injected for testability.
 */
export interface TestPipelineDeps {
  lockFileCache: LockFileCache;
  dispatcher: Dispatcher;
  executionTracker?: ExecutionTracker;
  checkRunReporter?: CheckRunReporter;
  sourceCache?: SourceCache;
  buildCoordinator?: BuildCoordinator;
  depCache?: DepCache;
  pendingBuilds?: PendingBuildTracker;
  secretResolver?: SecretResolver;
  agentRegistry: AgentRegistry;
  providerRegistry: ProviderRegistry;
  /** Log storage for persisting test fixture payloads. Optional -- if not set, payload storage is skipped. */
  logStorage?: LogStorage;
  /** Database connection for environment protection checks. Optional. */
  db?: Kysely<Database>;
  /** Environment store for resolving environment ids in test dispatch parity. Optional. */
  environmentStore?: EnvironmentStore;
  /** Variable store for resolving environment variables in test dispatch parity. Optional. */
  variableStore?: VariableStore;
}

type ProviderBundle = ReturnType<ProviderRegistry['getByRoutingKey']>;

interface ResolvedLockFile {
  fullLockFile: FullLockFile;
  bundle: ProviderBundle | undefined;
  repoIdentifier: string;
}

interface DispatchedJobRef {
  jobId: string;
  jobName: string;
  matrixValues?: Record<string, unknown>;
  runsOnLabels?: string[];
}

/**
 * Resolve the lock file for a test run. Local (`inlineLockFile`) inputs use
 * the lock content from the CLI directly; remote inputs go through the same
 * provider-driven fetch as the webhook pipeline.
 */
async function resolveLockFileForTest(
  input: TestTriggerInput,
  deps: TestPipelineDeps,
  runId: string,
): Promise<ResolvedLockFile | { rejected: string }> {
  if (input.inlineLockFile) {
    // Local repo -- use inline lock file directly, skip provider fetch
    let fullLockFile: FullLockFile;
    try {
      fullLockFile = JSON.parse(input.inlineLockFile) as FullLockFile;
    } catch {
      return { rejected: 'Invalid inline lock file JSON' };
    }
    const repoIdentifier = input.routingKey.replace('local:', '');
    logger.info('Using inline lock file for local repo', {
      routingKey: input.routingKey,
      runId,
    });
    return { fullLockFile, bundle: undefined, repoIdentifier };
  }

  // Remote repo -- existing provider-based lock file fetch
  const bundle = deps.providerRegistry.getByRoutingKey(input.routingKey);
  if (!bundle?.lockFileFetcher) {
    return { rejected: `No provider found for routing key: ${input.routingKey}` };
  }

  // Extract repo identifier from event payload (same as webhook pipeline).
  // For internal provider, full_name is '.' which resolves to repoBasePath.
  // For GitHub provider, full_name is 'owner/repo' used for API calls.
  // Falls back to routing key if payload doesn't include repository info.
  const repository = input.event.payload?.repository as
    | { full_name?: string; owner?: { login?: string }; name?: string }
    | undefined;
  const repoIdentifier =
    repository?.full_name ??
    (repository?.owner?.login && repository?.name
      ? `${repository.owner.login}/${repository.name}`
      : input.routingKey);

  const lockFile = await deps.lockFileCache.get(bundle.lockFileFetcher, repoIdentifier, 'HEAD', {});
  if (!lockFile) {
    return { rejected: 'No lock file found for routing key' };
  }

  return {
    fullLockFile: lockFile as unknown as FullLockFile,
    bundle,
    repoIdentifier,
  };
}

/** Either a direct workflow lookup or normal trigger matching against the lock file. */
function selectMatchedDecisions(
  input: TestTriggerInput,
  fullLockFile: FullLockFile,
  simulatedEvent: SimulatedEvent,
): WorkflowDecision[] | { rejected: string } {
  let decisions: WorkflowDecision[];

  if (input.workflowName) {
    // Direct workflow execution -- bypass trigger matching
    const workflow = fullLockFile.workflows.find(
      (w: LockWorkflow) => w.name === input.workflowName,
    );
    if (!workflow) {
      return { rejected: `Workflow '${input.workflowName}' not found in lock file` };
    }
    decisions = [
      createWorkflowDecision(input.workflowName, true, [], undefined, 'Direct test run'),
    ];
  } else {
    decisions = matchAllWorkflows(fullLockFile.workflows, simulatedEvent);
  }

  const matched = decisions.filter((d) => d.matched);
  if (matched.length === 0) {
    return { rejected: 'No matching workflows found for the simulated event' };
  }
  return matched;
}

/** Per-job dynamic fields resolved once per test run and shared by the gate, secret resolution, and dispatch. */
interface ResolvedJobFields {
  environmentName?: string;
  jobEnv?: Record<string, string>;
}

/** Key: `${workflowName}:${jobName}` composite (see resolvedFieldsKey). */
type ResolvedFieldsMap = Map<string, ResolvedJobFields>;

function resolvedFieldsKey(workflowName: string, jobName: string): string {
  return `${workflowName}:${jobName}`;
}

/**
 * Resolve each matched static job's environment and env once, evaluating pure
 * inline expressions against the fixture's simulated event (the normalized
 * envelope — the same argument production dispatch passes). Impure dynamic
 * fields (marker set, no inline value) stay unresolved: test runs dispatch no
 * init jobs. Inline evaluation failures reject the run (no fallback), matching
 * production's immediate-failure semantics.
 */
function resolveJobFieldsForRun(
  fullLockFile: FullLockFile,
  matchedDecisions: WorkflowDecision[],
  simulatedEvent: SimulatedEvent,
): { resolved: ResolvedFieldsMap } | { rejected: string } {
  const map: ResolvedFieldsMap = new Map();
  for (const decision of matchedDecisions) {
    const workflow = fullLockFile.workflows.find(
      (w: LockWorkflow) => w.name === decision.workflowName,
    );
    if (!workflow) continue;
    for (const job of workflow.jobs.filter(isLockStaticJob)) {
      const lockJob = job as LockJob;
      let inline;
      try {
        inline = evaluateInlineFields(lockJob, simulatedEvent);
      } catch (err) {
        return { rejected: toErrorMessage(err) };
      }
      const fields: ResolvedJobFields = {};
      const environmentName =
        inline.inlineEnvironmentName ??
        (typeof lockJob.environment === 'string' ? lockJob.environment : undefined);
      if (environmentName) fields.environmentName = environmentName;
      const jobEnv =
        inline.inlineEnv ??
        (lockJob.env && !isLockInlineValue(lockJob.env) ? lockJob.env : undefined);
      if (jobEnv) fields.jobEnv = jobEnv;
      map.set(resolvedFieldsKey(workflow.name, lockJob.name), fields);
    }
  }
  return { resolved: map };
}

/**
 * Environment protection gate for all remote test runs.
 * Returns a rejection reason if any matched workflow targets an environment
 * that disallows test runs; null otherwise.
 *
 * The gate covers static string environments AND pure inline environments
 * resolved against the fixture's simulated event (via `resolvedFields`).
 * Impure dynamic environments (marker set, no inline value) are skipped
 * because the test pipeline dispatches static jobs only (no init jobs).
 *
 * The environments lookup is scoped by `org_id` + `name` so a tenant's
 * environment can only match its own org's row (a name-only filter would let
 * org A match org B's same-named environment).
 *
 * Build jobs (__build__) are automatically skipped for test runs
 * because the test pipeline dispatches static jobs only.
 */
async function enforceEnvironmentProtection(
  deps: TestPipelineDeps,
  fullLockFile: FullLockFile,
  matchedDecisions: WorkflowDecision[],
  orgId: string,
  resolvedFields: ResolvedFieldsMap,
): Promise<string | null> {
  if (!deps.db) return null;

  for (const decision of matchedDecisions) {
    const workflow = fullLockFile.workflows.find(
      (w: LockWorkflow) => w.name === decision.workflowName,
    );
    if (!workflow) continue;
    const staticJobs = workflow.jobs.filter(isLockStaticJob);
    for (const job of staticJobs) {
      const envName = resolvedFields.get(
        resolvedFieldsKey(workflow.name, job.name),
      )?.environmentName;
      if (!envName) continue;
      const env = await deps.db
        .selectFrom('environments')
        .select(['allow_local_execution'])
        .where('org_id', '=', orgId)
        .where('name', '=', envName)
        .executeTakeFirst();
      if (env && !env.allow_local_execution) {
        return `Environment '${envName}' does not allow test runs. Enable test access for this environment (allowLocalExecution) to allow them.`;
      }
    }
  }
  return null;
}

/**
 * Persist the test fixture payload to object storage so the payload viewer
 * can resolve it the same way it does for real webhook runs. Failures are
 * logged but do not abort the run.
 */
async function storeFixturePayload(
  input: TestTriggerInput,
  deps: TestPipelineDeps,
  runId: string,
): Promise<void> {
  if (!deps.logStorage) return;
  const payloadPath = `executions/${runId}/webhook-payload.json`;
  try {
    await deps.logStorage.append(payloadPath, JSON.stringify(input.event.payload));
  } catch (err) {
    logger.warn('Failed to store test fixture payload', {
      runId,
      error: toErrorMessage(err),
    });
  }
}

interface DispatchContext {
  runId: string;
  deliveryId: string;
  bundle: ProviderBundle | undefined;
  repoIdentifier: string;
  fullLockFile: FullLockFile;
  simulatedEvent: SimulatedEvent;
  resolvedFields: ResolvedFieldsMap;
}

/** Resolved secrets for a dispatched test job: flat env + per-context namespaces. */
interface TestSecretBundle {
  flat: Record<string, string>;
  namespaced: Record<string, Record<string, string>>;
}

/**
 * Decrypt the CLI-uploaded local secrets blob ({flat, contexts}). Returns
 * empty maps when the run carries no encrypted secrets. Secret values are
 * never logged.
 */
function decryptCliSecrets(input: TestTriggerInput): {
  flat: Record<string, string>;
  contexts: Record<string, Record<string, string>>;
} {
  if (!input.encryptedSecrets || !input.encryptedSecretsKey || !input.resolvedOverlay) {
    return { flat: {}, contexts: {} };
  }
  return decryptJson(
    input.encryptedSecrets,
    Buffer.from(input.encryptedSecretsKey, 'base64'),
    Buffer.from(input.resolvedOverlay.orchestratorPrivateKey, 'base64'),
  );
}

/**
 * Resolve the secrets a dispatched test job should receive, merging two
 * sources with CLI-wins precedence:
 *
 * - Source B (orchestrator-stored): B1 resolves the job's own declared
 *   environment into flat secrets; B2 resolves each fixture `secrets` mapping
 *   entry `{ contextName: environmentName }` into a namespaced context. Both
 *   only consider environments flagged `allow_local_execution = true`.
 * - Source A (CLI-uploaded): decrypts the developer's local secrets and
 *   overwrites the baseline (flat overwrites flat; contexts overwrite
 *   namespaced per-context).
 *
 * Fail-closed: if a fixture maps a context to an environment that does not
 * exist or has `allow_local_execution = false`, the run is rejected.
 */
async function resolveTestRunSecrets(
  input: TestTriggerInput,
  deps: TestPipelineDeps,
  orgId: string,
  jobEnvironment: string | undefined,
): Promise<TestSecretBundle | { rejected: string }> {
  const flat: Record<string, string> = {};
  const namespaced: Record<string, Record<string, string>> = {};

  // B1 — the job's own declared environment (test-allowed gate already ran upstream).
  if (jobEnvironment && deps.secretResolver) {
    Object.assign(flat, await deps.secretResolver.resolveForJob(orgId, jobEnvironment));
  }

  // B2 — fixture mapping { contextName: environmentName }, fail-closed on non-test envs.
  for (const [ctxName, envName] of Object.entries(input.secrets ?? {})) {
    if (deps.db) {
      const env = await deps.db
        .selectFrom('environments')
        .select(['allow_local_execution'])
        .where('org_id', '=', orgId)
        .where('name', '=', envName)
        .executeTakeFirst();
      if (!env || !env.allow_local_execution) {
        return {
          rejected: `Fixture secret context '${ctxName}' maps to environment '${envName}' which does not allow test runs`,
        };
      }
    }
    if (deps.secretResolver) {
      namespaced[ctxName] = await deps.secretResolver.resolveForJob(orgId, envName);
    }
  }

  // A — CLI-uploaded local secrets win on collision.
  const cli = decryptCliSecrets(input);
  Object.assign(flat, cli.flat);
  for (const [ctxName, vals] of Object.entries(cli.contexts)) {
    namespaced[ctxName] = { ...(namespaced[ctxName] ?? {}), ...vals };
  }

  return { flat, namespaced };
}

function buildJobInput(
  workflow: LockWorkflow,
  mat: MaterializedJob,
  ctx: DispatchContext,
  input: TestTriggerInput,
  secretBundle: TestSecretBundle,
  fields: ResolvedJobFields | undefined,
  environmentVars: Record<string, string> | undefined,
): QueuedJobInput {
  const staticJob = mat.lockJob;
  const runsOnLabels = Array.isArray(staticJob.runsOn) ? staticJob.runsOn : [staticJob.runsOn];
  return {
    runId: ctx.runId,
    workflowName: workflow.name,
    jobName: mat.expandedName,
    runsOnLabels,
    jobConfig: {
      source: workflow.source ?? ctx.fullLockFile.source,
      workflowName: workflow.name,
      ...matrixEnvelopeFields(mat),
      steps: staticJob.steps,
      needs: staticJob.needs,
      rules: staticJob.rules,
      isTestRun: true,
      fixtureId: input.fixtureId,
      ...(input.uploadId && { tarballUploadId: input.uploadId }),
      ...(input.resolvedOverlay && {
        tarballUrl: input.resolvedOverlay.tarballUrl,
        cliPublicKey: input.resolvedOverlay.cliPublicKey,
        orchestratorPrivateKey: input.resolvedOverlay.orchestratorPrivateKey,
      }),
      ...(Object.keys(secretBundle.flat).length > 0 && { secrets: secretBundle.flat }),
      ...(Object.keys(secretBundle.namespaced).length > 0 && {
        namespacedSecrets: secretBundle.namespaced,
      }),
      ...(input.fullRepo && { fullRepo: true }),
      // Production parity: the fixture's normalized envelope drives rules,
      // ctx.rawPayload and dynamic-function semantics exactly like a real run.
      event: ctx.simulatedEvent,
      ...(fields?.environmentName && { environment: fields.environmentName }),
      ...(environmentVars && { environmentVars }),
      ...(fields?.jobEnv && { jobEnv: fields.jobEnv }),
    } as QueuedJobInput['jobConfig'],
    repoUrl: input.fullRepo
      ? ''
      : (ctx.bundle?.repoUrlBuilder?.buildCloneUrl(ctx.repoIdentifier) ?? ''),
    ref: ctx.simulatedEvent.sourceBranch ?? ctx.simulatedEvent.targetBranch,
    sha: 'HEAD',
    deliveryId: ctx.deliveryId,
    provider: input.routingKey.split(':')[0] ?? 'test',
    providerContext: {},
    routingKey: input.routingKey,
    requestId: input.requestId,
  };
}

async function dispatchStaticJobsForWorkflow(
  workflow: LockWorkflow,
  ctx: DispatchContext,
  input: TestTriggerInput,
  deps: TestPipelineDeps,
  orgId: string,
): Promise<{ dispatched: DispatchedJobRef[] } | { rejected: string }> {
  const dispatched: DispatchedJobRef[] = [];
  const staticJobs = workflow.jobs.filter(isLockStaticJob);
  const materializedJobs = materializeFanout(staticJobs).jobs;
  // Platform detection from agents is deferred until per-job dispatch.

  for (const mat of materializedJobs) {
    // Environment fields are resolved per base job (matrix children share them).
    const fields = ctx.resolvedFields.get(resolvedFieldsKey(workflow.name, mat.baseName));
    const bundle = await resolveTestRunSecrets(input, deps, orgId, fields?.environmentName);
    if ('rejected' in bundle) {
      return { rejected: bundle.rejected };
    }

    // Production parity (dispatch-matched-workflow.applyEnvironmentRulesAndSecrets):
    // match the job's resolved environment, then resolve its variables against
    // the environment id + routing key.
    let environmentVars: Record<string, string> | undefined;
    if (fields?.environmentName && deps.environmentStore && deps.variableStore) {
      const envConfig = await deps.environmentStore.matchEnvironment(orgId, fields.environmentName);
      if (envConfig) {
        const vars = await deps.variableStore.getResolvedVars(
          orgId,
          toEnvironment(envConfig).id,
          input.routingKey,
        );
        if (Object.keys(vars).length > 0) environmentVars = vars;
      }
    }

    const jobInput = buildJobInput(workflow, mat, ctx, input, bundle, fields, environmentVars);
    const result = await deps.dispatcher.dispatch(jobInput);
    if (result.status !== 'rejected') {
      dispatched.push({
        jobId: result.jobId,
        jobName: jobInput.jobName,
        ...(mat.variantValues && { matrixValues: mat.variantValues }),
        runsOnLabels: jobInput.runsOnLabels,
      });
    }

    logger.info('Test job dispatched', {
      runId: ctx.runId,
      workflow: workflow.name,
      job: jobInput.jobName,
      status: result.status,
      fixtureId: input.fixtureId,
    });
  }
  return { dispatched };
}

/**
 * Record the execution-start row + test-run markers. MUST be awaited so the
 * execution_runs row exists before the agent reports completion (race with
 * fast internal provider).
 */
async function recordTestExecutionStart(
  workflow: LockWorkflow,
  decision: WorkflowDecision,
  dispatched: DispatchedJobRef[],
  ctx: DispatchContext,
  input: TestTriggerInput,
  deps: TestPipelineDeps,
): Promise<void> {
  if (!deps.executionTracker || dispatched.length === 0) return;

  // Mark run as test run in memory for observer broadcasting (before async DB ops).
  deps.executionTracker.markTestRun(ctx.runId);
  try {
    await deps.executionTracker.onExecutionStarted(
      ctx.runId,
      workflow.name,
      input.routingKey.split(':')[0] ?? 'test',
      input.routingKey,
      ctx.simulatedEvent.targetBranch,
      'HEAD',
      ctx.deliveryId,
      {},
      {
        workflowName: decision.workflowName,
        matched: decision.matched,
        summary: decision.summary,
        checksCount: decision.checks.length,
      },
      dispatched,
      input.routingKey,
      undefined, // contexts
      undefined, // triggerEvent
      undefined, // commitMessage
      undefined, // parentRunId
      undefined, // triggeredBy
      undefined, // originalRunId
      workflow.concurrency
        ? {
            cancelInProgress: workflow.concurrency.cancelInProgress,
            max: workflow.concurrency.max,
          }
        : undefined,
      workflow.timeout, // workflowTimeoutMs
    );
    try {
      await (deps.executionTracker as any).db
        .updateTable('execution_runs')
        .set({
          is_test_run: true,
          fixture_id: input.fixtureId,
        })
        .where('run_id', '=', ctx.runId)
        .execute();
    } catch (err) {
      logger.error('Failed to mark execution as test run', {
        runId: ctx.runId,
        error: toErrorMessage(err),
      });
    }
  } catch (err) {
    logger.error('Failed to record test execution start', {
      runId: ctx.runId,
      error: toErrorMessage(err),
    });
  }
}

/**
 * Process a test trigger through the existing pipeline.
 *
 * Reuses pipeline steps starting from lock file fetch, skipping webhook
 * normalization and dedup. Supports both trigger-matched and direct
 * workflow execution modes.
 */
export async function processTestTrigger(
  input: TestTriggerInput,
  deps: TestPipelineDeps,
): Promise<TestTriggerResult> {
  const runId = randomUUID();
  const deliveryId = `test:${randomUUID()}`;

  logger.info('Processing test trigger', {
    fixtureId: input.fixtureId,
    eventType: input.event.type,
    routingKey: input.routingKey,
    workflowName: input.workflowName,
    requestId: input.requestId,
  });

  const lockResult = await resolveLockFileForTest(input, deps, runId);
  if ('rejected' in lockResult) {
    return { runId, status: 'rejected', reason: lockResult.rejected, jobIds: [] };
  }
  const { fullLockFile, bundle, repoIdentifier } = lockResult;

  const simulatedEvent: SimulatedEvent = {
    type: input.event.type,
    action: input.event.action,
    targetBranch: input.event.targetBranch,
    sourceBranch: input.event.sourceBranch,
    payload: input.event.payload,
    changedFiles: input.event.changedFiles,
  };

  const matchResult = selectMatchedDecisions(input, fullLockFile, simulatedEvent);
  if (!Array.isArray(matchResult)) {
    return { runId, status: 'rejected', reason: matchResult.rejected, jobIds: [] };
  }
  const matchedDecisions = matchResult;

  // Resolve the tenant the SAME way the webhook pipeline does
  // (sources -> generic_webhook_sources -> '__default__'). A wrong org id would
  // resolve another tenant's environments/secrets, so this MUST match the real
  // path. Resolved ONCE here and shared by both the environment-protection gate
  // and the per-job secret resolution below.
  const orgId = deps.db ? await resolveOrgId(deps.db, input.routingKey) : '__default__';

  const fieldsResult = resolveJobFieldsForRun(fullLockFile, matchedDecisions, simulatedEvent);
  if ('rejected' in fieldsResult) {
    return { runId, status: 'rejected', reason: fieldsResult.rejected, jobIds: [] };
  }
  const resolvedFields = fieldsResult.resolved;

  const protectionRejection = await enforceEnvironmentProtection(
    deps,
    fullLockFile,
    matchedDecisions,
    orgId,
    resolvedFields,
  );
  if (protectionRejection) {
    return { runId, status: 'rejected', reason: protectionRejection, jobIds: [] };
  }

  await storeFixturePayload(input, deps, runId);

  const ctx: DispatchContext = {
    runId,
    deliveryId,
    bundle,
    repoIdentifier,
    fullLockFile,
    simulatedEvent,
    resolvedFields,
  };

  const allJobIds: string[] = [];
  for (const decision of matchedDecisions) {
    const workflow = fullLockFile.workflows.find(
      (w: LockWorkflow) => w.name === decision.workflowName,
    );
    if (!workflow) continue;

    const dispatchResult = await dispatchStaticJobsForWorkflow(workflow, ctx, input, deps, orgId);
    if ('rejected' in dispatchResult) {
      return { runId, status: 'rejected', reason: dispatchResult.rejected, jobIds: [] };
    }
    const dispatched = dispatchResult.dispatched;
    for (const d of dispatched) allJobIds.push(d.jobId);

    await recordTestExecutionStart(workflow, decision, dispatched, ctx, input, deps);
  }

  if (allJobIds.length === 0) {
    return {
      runId,
      status: 'rejected',
      reason:
        'No jobs dispatched (all matched workflows had no static jobs or dispatch was rejected)',
      jobIds: [],
    };
  }

  return { runId, status: 'accepted', jobIds: allJobIds };
}
