/**
 * Test-trigger adapter for CLI-initiated runs (`kici run`).
 *
 * Resolves the lock file, matched decisions, and fixture-specific concerns
 * (inline-vs-provider lock, decision selection, fixture-payload storage, the
 * `allow_local_execution` environment gate, CLI-secret overlay, in-memory
 * test-run marking), then dispatches each matched workflow through the SAME
 * shared core as webhooks (`dispatchMatchedWorkflow`). The test path is a thin
 * adapter — needs-DAG scheduling, `expansionMap` fan-out edges, `runsOnAll`
 * host fan-out, and deferred init/dynamic dispatch all come from the core.
 *
 * Differences from a webhook run:
 * - the synthetic event is injected directly (no provider normalization/dedup);
 * - the lock file may be inline (local repos have no remote provider, so
 *   `bundle` is undefined);
 * - `deliveryId` carries a `test:` prefix;
 * - the run is stamped `is_test_run = true` + `fixture_id` (via the core's
 *   `testRun` meta) and marked in-memory for live-log broadcast to the CLI;
 * - CLI-uploaded local secrets win over orchestrator env secrets (the
 *   decorating secret resolver), and the fixture's `secrets` context mapping
 *   resolves into namespaced secrets;
 * - direct workflow execution (bypass trigger matching) is supported.
 */

import { randomUUID } from 'node:crypto';
import { createLogger, toErrorMessage, decryptJson } from '@kici-dev/shared';
import { resolveOrgId, type ProcessingDeps } from './processor.js';
import { dispatchMatchedWorkflow } from './dispatch-matched-workflow.js';
import type { WorkflowDispatchContext } from './dispatch-matched-workflow.js';
import { DecoratingSecretResolver } from './decorating-secret-resolver.js';
import type { WebhookInfo } from '../webhook/handler.js';
import type { ProviderRegistry } from '../provider-registry.js';
import type {
  LockFile as FullLockFile,
  LockJob,
  LockWorkflow,
  ProviderType,
  SimulatedEvent,
  WorkflowDecision,
} from '@kici-dev/engine';
import { isLockStaticJob, matchAllWorkflows, createWorkflowDecision } from '@kici-dev/engine';
import { coerceDispatchInputs } from '@kici-dev/engine';
import type { CheckMode, HostTargetSelector, InputsDescriptorMap } from '@kici-dev/engine';
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
  /**
   * Run mode for idempotent steps (`apply` | `check` | `check-fail-on-drift`).
   * Threaded onto each dispatched job's config and persisted on the run.
   * Omitted means `apply`.
   */
  checkMode?: CheckMode;
  /**
   * Runtime host narrowing from `kici run --target`. Threaded onto the dispatch
   * context, where it post-filters each runsOnAll job's matched roster.
   */
  target?: HostTargetSelector;
  /**
   * Raw operator-supplied `kici run --input KEY=VALUE` pairs (not coerced /
   * defaulted). Validated + coerced + defaulted here against the matched
   * workflow's lock dispatch descriptor before dispatch.
   */
  dispatchInputs?: Record<string, string>;
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

type ProviderBundle = ReturnType<ProviderRegistry['getByRoutingKey']>;

interface ResolvedLockFile {
  fullLockFile: FullLockFile;
  bundle: ProviderBundle | undefined;
  repoIdentifier: string;
  provider?: string;
}

/**
 * Repo identity for an inline-lock (local working tree) run. Derived from the
 * event payload the CLI stamps -- NOT the relay routing key, which is the
 * Platform-internal `remote:<orgId>` anchor and is meaningless as a repo.
 */
export function repoIdentityFromInlineInput(input: TestTriggerInput): {
  repoIdentifier: string;
  provider: string;
} {
  const repository = input.event.payload?.repository as
    | { full_name?: string; provider?: string }
    | undefined;
  return {
    repoIdentifier: repository?.full_name ?? 'local/unknown',
    provider: repository?.provider ?? 'local',
  };
}

/**
 * Resolve the lock file for a test run. Local (`inlineLockFile`) inputs use
 * the lock content from the CLI directly; remote inputs go through the same
 * provider-driven fetch as the webhook pipeline.
 */
async function resolveLockFileForTest(
  input: TestTriggerInput,
  deps: ProcessingDeps,
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
    const { repoIdentifier, provider } = repoIdentityFromInlineInput(input);
    logger.info('Using inline lock file for local working tree', {
      routingKey: input.routingKey,
      repoIdentifier,
      runId,
    });
    return { fullLockFile, bundle: undefined, repoIdentifier, provider };
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

/**
 * Validate each matched static job's pure inline dynamic fields once per test
 * run by evaluating them against the fixture's simulated event (the normalized
 * envelope — the same argument production dispatch passes). Inline evaluation
 * failures reject the run (no fallback), matching production's immediate-failure
 * semantics. Non-test-allowed bound environments are NOT rejected here: the
 * shared dispatch core skips them for test runs (skip-on-test).
 */
function validateInlineFieldsForRun(
  fullLockFile: FullLockFile,
  matchedDecisions: WorkflowDecision[],
  simulatedEvent: SimulatedEvent,
): { ok: true } | { rejected: string } {
  for (const decision of matchedDecisions) {
    const workflow = fullLockFile.workflows.find(
      (w: LockWorkflow) => w.name === decision.workflowName,
    );
    if (!workflow) continue;
    for (const job of workflow.jobs.filter(isLockStaticJob)) {
      try {
        evaluateInlineFields(job as LockJob, simulatedEvent);
      } catch (err) {
        return { rejected: toErrorMessage(err) };
      }
    }
  }
  return { ok: true };
}

/**
 * Persist the test fixture payload to object storage so the payload viewer
 * can resolve it the same way it does for real webhook runs. Failures are
 * logged but do not abort the run.
 */
async function storeFixturePayload(
  input: TestTriggerInput,
  deps: ProcessingDeps,
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
 * Resolve the fixture's `secrets` context mapping `{ contextName: envName }`
 * into namespaced secrets, fail-closed on non-test-allowed environments, then
 * overlay the CLI-uploaded contexts (CLI wins per-context). Keyed by the
 * fixture context name (e.g. `db`), not the env name — the run carries these
 * verbatim on every dispatched job via `extraJobConfig.namespacedSecrets`.
 */
async function resolveFixtureNamespacedSecrets(
  input: TestTriggerInput,
  deps: ProcessingDeps,
  orgId: string,
): Promise<{ namespaced: Record<string, Record<string, string>> } | { rejected: string }> {
  const namespaced: Record<string, Record<string, string>> = {};

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

  // CLI-uploaded contexts win on collision (per-context merge).
  const cli = decryptCliSecrets(input);
  for (const [ctxName, vals] of Object.entries(cli.contexts)) {
    namespaced[ctxName] = { ...(namespaced[ctxName] ?? {}), ...vals };
  }

  return { namespaced };
}

/** The provenance fields merged onto every dispatched job's jobConfig. */
function buildExtraJobConfig(
  input: TestTriggerInput,
  namespacedSecrets: Record<string, Record<string, string>>,
): Record<string, unknown> {
  return {
    isTestRun: true,
    fixtureId: input.fixtureId,
    ...(input.uploadId && { tarballUploadId: input.uploadId }),
    ...(input.resolvedOverlay && {
      tarballUrl: input.resolvedOverlay.tarballUrl,
      cliPublicKey: input.resolvedOverlay.cliPublicKey,
      orchestratorPrivateKey: input.resolvedOverlay.orchestratorPrivateKey,
    }),
    ...(input.fullRepo && { fullRepo: true }),
    ...(input.checkMode && { checkMode: input.checkMode }),
    ...(Object.keys(namespacedSecrets).length > 0 && { namespacedSecrets }),
  };
}

/** Inputs shared by every per-decision dispatch context the adapter builds. */
interface TestDispatchShared {
  input: TestTriggerInput;
  testDeps: ProcessingDeps;
  bundle: ProviderBundle | undefined;
  repoIdentifier: string;
  fullLockFile: FullLockFile;
  simulatedEvent: SimulatedEvent;
  deliveryId: string;
  resolvedOrgId: string;
  info: WebhookInfo;
  extraJobConfig: Record<string, unknown>;
  /** CLI `--secret` / `--env` flat secrets, layered onto every dispatched job. */
  runWideFlatSecrets: Record<string, string>;
  /** Resolved (coerced + defaulted) `kici run --input` dispatch inputs, or undefined. */
  dispatchInputs?: Record<string, unknown>;
}

/**
 * Merge the dispatch-trigger `inputs` descriptors declared by the matched
 * workflows. Multiple workflows declaring the same key are last-write-wins
 * (the operator's `--input` is validated against the union).
 */
function mergeMatchedDispatchDescriptors(
  fullLockFile: FullLockFile,
  matchedDecisions: WorkflowDecision[],
): InputsDescriptorMap | undefined {
  const merged: InputsDescriptorMap = {};
  let found = false;
  for (const decision of matchedDecisions) {
    const workflow = fullLockFile.workflows.find((w) => w.name === decision.workflowName);
    for (const trigger of workflow?.triggers ?? []) {
      if (trigger._type === 'dispatch' && trigger.inputs) {
        Object.assign(merged, trigger.inputs);
        found = true;
      }
    }
  }
  return found ? merged : undefined;
}

/**
 * Validate + coerce + default the operator's raw `--input` pairs against the
 * matched workflows' dispatch descriptors. Returns the resolved values, or a
 * `{ rejected }` reason on validation failure (no dispatch).
 */
function resolveDispatchInputs(
  input: TestTriggerInput,
  fullLockFile: FullLockFile,
  matchedDecisions: WorkflowDecision[],
): { values?: Record<string, unknown> } | { rejected: string } {
  const descriptor = mergeMatchedDispatchDescriptors(fullLockFile, matchedDecisions);
  // No declared inputs anywhere: only reject if the operator nonetheless passed
  // some (a typo against a workflow that declares none).
  if (!descriptor) {
    if (input.dispatchInputs && Object.keys(input.dispatchInputs).length > 0) {
      return {
        rejected: `Workflow declares no dispatch inputs, but --input was given: ${Object.keys(
          input.dispatchInputs,
        ).join(', ')}`,
      };
    }
    return {};
  }
  const r = coerceDispatchInputs(input.dispatchInputs ?? {}, descriptor);
  if ('error' in r) {
    return { rejected: r.error.message };
  }
  return { values: r.values };
}

/** Assemble a `WorkflowDispatchContext` for one matched workflow decision. */
function buildTestDispatchContext(
  shared: TestDispatchShared,
  workflow: LockWorkflow,
  decision: WorkflowDecision,
  runId: string,
): WorkflowDispatchContext {
  return {
    info: shared.info,
    deps: shared.testDeps,
    bundle: shared.bundle,
    payload: shared.simulatedEvent.payload,
    repoIdentifier: shared.repoIdentifier,
    credentials: {},
    event: shared.simulatedEvent,
    eventWithFiles: shared.simulatedEvent,
    ref: shared.simulatedEvent.sourceBranch ?? shared.simulatedEvent.targetBranch,
    fullLockFile: shared.fullLockFile,
    resolvedOrgId: shared.resolvedOrgId,
    workflow,
    decision,
    runId,
    trustResolution: undefined,
    lockFileSource: undefined,
    localWorkingTree: shared.input.inlineLockFile != null,
    crossSource: false,
    extraJobConfig: shared.extraJobConfig,
    testRun: { fixtureId: shared.input.fixtureId },
    ...(shared.input.target && { target: shared.input.target }),
    ...(shared.dispatchInputs && { dispatchInputs: shared.dispatchInputs }),
    ...(Object.keys(shared.runWideFlatSecrets).length > 0 && {
      runWideFlatSecrets: shared.runWideFlatSecrets,
    }),
  };
}

/**
 * Process a test trigger through the shared dispatch core.
 *
 * Resolves the lock file + matched decisions + fixture concerns, then builds a
 * `WorkflowDispatchContext` per matched workflow and calls
 * `dispatchMatchedWorkflow` — the same core the webhook path uses.
 */
export async function processTestTrigger(
  input: TestTriggerInput,
  deps: ProcessingDeps,
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
  const { fullLockFile, bundle, repoIdentifier, provider: inlineProvider } = lockResult;

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
  // path. Resolved ONCE here and shared by the environment gate, the fixture
  // namespaced-secret resolution, and the dispatch core.
  const resolvedOrgId = deps.db ? await resolveOrgId(deps.db, input.routingKey) : '__default__';

  const fieldsResult = validateInlineFieldsForRun(fullLockFile, matchedDecisions, simulatedEvent);
  if ('rejected' in fieldsResult) {
    return { runId, status: 'rejected', reason: fieldsResult.rejected, jobIds: [] };
  }

  // Authoritative dispatch-input validation: coerce + default + validate the
  // operator's raw --input pairs against the matched workflows' lock descriptor.
  // Rejected at the relay — no agent dispatched.
  const dispatchInputsResult = resolveDispatchInputs(input, fullLockFile, matchedDecisions);
  if ('rejected' in dispatchInputsResult) {
    return { runId, status: 'rejected', reason: dispatchInputsResult.rejected, jobIds: [] };
  }

  const namespacedResult = await resolveFixtureNamespacedSecrets(input, deps, resolvedOrgId);
  if ('rejected' in namespacedResult) {
    return { runId, status: 'rejected', reason: namespacedResult.rejected, jobIds: [] };
  }

  await storeFixturePayload(input, deps, runId);

  // CLI-secret overlay: the core resolves per-job env secrets through this
  // decorator, so CLI flat secrets win over orchestrator env secrets.
  const cliSecrets = decryptCliSecrets(input);
  const testDeps: ProcessingDeps = deps.secretResolver
    ? { ...deps, secretResolver: new DecoratingSecretResolver(deps.secretResolver, cliSecrets) }
    : deps;

  // Mark the run in-memory BEFORE dispatch so the live-log observer broadcasts
  // to the waiting CLI (independent of the async is_test_run column write the
  // core performs from the testRun meta).
  deps.executionTracker?.markTestRun(runId);

  // Inline (local working tree) runs carry the real origin provider on the
  // payload; provider-fetch runs derive it from the routing-key prefix.
  const provider = (inlineProvider ?? input.routingKey.split(':')[0] ?? 'local') as ProviderType;
  const info: WebhookInfo = {
    routingKey: input.routingKey,
    deliveryId,
    event: input.event.type,
    action: input.event.action ?? null,
    provider,
    payload: input.event.payload,
  };

  const shared: TestDispatchShared = {
    input,
    testDeps,
    bundle,
    repoIdentifier,
    fullLockFile,
    simulatedEvent,
    deliveryId,
    resolvedOrgId,
    info,
    extraJobConfig: buildExtraJobConfig(input, namespacedResult.namespaced),
    // CLI `--secret` / `--env` flat secrets reach EVERY job (env-declaring or
    // not), winning over a job's env-resolved secret on a key collision.
    runWideFlatSecrets: cliSecrets.flat,
    ...(dispatchInputsResult.values && { dispatchInputs: dispatchInputsResult.values }),
  };

  const jobIds: string[] = [];
  for (const decision of matchedDecisions) {
    const workflow = fullLockFile.workflows.find(
      (w: LockWorkflow) => w.name === decision.workflowName,
    );
    if (!workflow) continue;
    const ctx = buildTestDispatchContext(shared, workflow, decision, runId);
    const result = await dispatchMatchedWorkflow(ctx);
    jobIds.push(...result.dispatchedJobIds);
  }

  if (jobIds.length === 0) {
    return {
      runId,
      status: 'rejected',
      reason:
        'No jobs dispatched (all matched workflows had no static jobs or dispatch was rejected)',
      jobIds: [],
    };
  }

  return { runId, status: 'accepted', jobIds };
}
