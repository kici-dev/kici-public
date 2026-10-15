/**
 * Test-trigger adapter for CLI-initiated runs (`kici run`).
 *
 * Resolves the lock file, matched decisions, and fixture-specific concerns
 * (inline-vs-provider lock, fixture-payload storage, the
 * `allow_local_execution` context gate, CLI-secret overlay, in-memory
 * test-run marking), then dispatches each matched workflow through the SAME
 * core as webhooks (`dispatchMatchedWorkflow`), which supplies needs-DAG
 * scheduling, `expansionMap` fan-out edges, `runsOnAll` host fan-out, and
 * deferred init/dynamic dispatch.
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
  LockWorkflow,
  ProviderType,
  SimulatedEvent,
  WorkflowDecision,
} from '@kici-dev/engine';
import { matchAllWorkflows, createWorkflowDecision } from '@kici-dev/engine';
import { agentLabelOf, stringifyActor, type ActorPrincipal } from '@kici-dev/engine';
import { coerceDispatchInputs } from '@kici-dev/engine';
import type { CheckMode, HostTargetSelector, InputsDescriptorMap } from '@kici-dev/engine';
import { webhookPayloadPath } from './webhook-payload-store.js';

const logger = createLogger({ prefix: 'test-pipeline' });

export interface TestTriggerInput {
  fixtureId: string;
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
  /** Uploaded tarball reference. */
  uploadId?: string;
  /** Fixture secret context mappings `{ contextName: envName }`. */
  secrets?: Record<string, string>;
  /** Base64 X25519+AES-GCM blob of the developer's local secrets ({flat, contexts}). */
  encryptedSecrets?: string;
  /** Base64 ephemeral CLI public key that encrypted `encryptedSecrets`. */
  encryptedSecretsKey?: string;
  /** Direct workflow run, bypassing triggers. */
  workflowName?: string;
  /** Resolved overlay metadata for tarball download + decryption. */
  resolvedOverlay?: {
    tarballUrl: string;
    cliPublicKey: string;
    orchestratorPrivateKey: string;
  };
  /** Trace ID of the HTTP request. */
  requestId: string;
  /**
   * The initiating principal: the one the Platform relays on
   * `test.relay.trigger`, or the admin token's service account on the direct
   * test-run routes. Required so no caller can silently leave
   * `execution_runs.triggered_by` NULL.
   */
  actor: ActorPrincipal;
  /** JSON-stringified lock file content for local repos with no remote. */
  inlineLockFile?: string;
  /** When true, repo has no remote -- skip provider lookup, skip clone. */
  fullRepo?: boolean;
  /**
   * Run mode for idempotent steps, set on each job's config and persisted on
   * the run. Omitted means `apply`.
   */
  checkMode?: CheckMode;
  /** `kici run --target`: post-filters each runsOnAll job's matched roster. */
  target?: HostTargetSelector;
  /**
   * Raw `kici run --input KEY=VALUE` pairs, validated, coerced and defaulted
   * here against the matched workflow's lock dispatch descriptor.
   */
  dispatchInputs?: Record<string, string>;
}

interface TestTriggerResult {
  runId: string;
  status: 'accepted' | 'rejected';
  reason?: string;
  jobIds: string[];
  /**
   * Warnings the CLI prints on acceptance: one per job whose bound test-run
   * contexts were unavailable (non-test or unconfigured) and skipped.
   */
  warnings?: string[];
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
    { full_name?: string; provider?: string } | undefined;
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

  const bundle = deps.providerRegistry.getByRoutingKey(input.routingKey);
  if (!bundle?.lockFileFetcher) {
    return { rejected: `No provider found for routing key: ${input.routingKey}` };
  }

  // As in the webhook pipeline: the internal provider's full_name '.' resolves
  // to repoBasePath, GitHub's 'owner/repo' feeds API calls, and a payload with
  // no repository falls back to the routing key.
  const repository = input.event.payload?.repository as
    { full_name?: string; owner?: { login?: string }; name?: string } | undefined;
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
 * Persist the fixture payload where the payload viewer reads webhook payloads.
 * A failure is logged and does not abort the run.
 */
async function storeFixturePayload(
  input: TestTriggerInput,
  deps: ProcessingDeps,
  runId: string,
): Promise<void> {
  if (!deps.logStorage) return;
  const payloadPath = webhookPayloadPath(runId);
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
 * Decrypt the CLI-uploaded secrets blob; empty maps when there is none. Secret
 * values are never logged.
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
 * Resolve the fixture's `secrets` mapping into namespaced secrets, failing
 * closed on contexts that do not allow test runs, then overlay the CLI-uploaded
 * contexts (CLI wins per context). Keyed by the fixture context name (e.g.
 * `db`), not the env name; every job gets them via `extraJobConfig.namespacedSecrets`.
 *
 * Each `envName` matches like a job's declared context (exact name, then glob),
 * and the matched row both gates the test run and supplies the secret bindings.
 * Without a context store nothing resolves and a warning names the skipped
 * mappings; every orchestrator that serves test runs wires one.
 */
async function resolveFixtureNamespacedSecrets(
  input: TestTriggerInput,
  deps: ProcessingDeps,
  orgId: string,
): Promise<{ namespaced: Record<string, Record<string, string>> } | { rejected: string }> {
  const namespaced: Record<string, Record<string, string>> = {};

  const mappings = Object.entries(input.secrets ?? {});
  // fails-when: a fixture's secret mappings are dropped with no trace
  if (mappings.length > 0 && !deps.contextStore) {
    logger.warn('Fixture secret mappings not resolved: no context store is configured', {
      orgId,
      mappings: mappings.map(([ctxName, envName]) => `${ctxName}=${envName}`),
    });
  }
  for (const [ctxName, envName] of mappings) {
    if (!deps.contextStore) continue;
    const env = await deps.contextStore.matchContext(orgId, envName);
    // fails-when: a context that does not allow test runs (or no context) hands its secrets to a test run
    // breaks-if-wrong: a fixed or glob context with allow_local_execution must still resolve
    if (!env || !env.allow_local_execution) {
      return {
        rejected: `Fixture secret context '${ctxName}' maps to context '${envName}' which does not allow test runs`,
      };
    }
    if (deps.secretResolver) {
      namespaced[ctxName] = await deps.secretResolver.resolveForContext(orgId, {
        id: env.id,
        name: envName,
      });
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
 * Merge the matched workflows' dispatch-trigger `inputs` descriptors, last
 * write wins per key; the operator's `--input` is validated against the union.
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
 * Validate, coerce and default the raw `--input` pairs against the matched
 * workflows' dispatch descriptors; a failure rejects with no dispatch.
 */
function resolveDispatchInputs(
  input: TestTriggerInput,
  fullLockFile: FullLockFile,
  matchedDecisions: WorkflowDecision[],
): { values?: Record<string, unknown> } | { rejected: string } {
  const descriptor = mergeMatchedDispatchDescriptors(fullLockFile, matchedDecisions);
  // No declared inputs: reject only if the operator passed some anyway.
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
    // A test run drives the repository's own lock file (fetched or inline), so
    // the workflow is defined by the repository the run acts on.
    workflowRepoIdentifier: shared.repoIdentifier,
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
    // The same pair the dashboard re-run path uses for these columns, so one
    // identity never gets two drifting renderings.
    triggeredBy: stringifyActor(shared.input.actor),
    triggeredByAgentLabel: agentLabelOf(shared.input.actor),
    // `kici run` is operator-initiated against a synthetic event, with no PR
    // provenance (contributor, fork, base-vs-head diff) to evaluate. The
    // central evaluator short-circuits a non-PR event to `pass`, so this is
    // the same verdict, not a bypass.
    securityDecision: { action: 'pass' },
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
 * Process a test trigger through the shared dispatch core: one
 * `WorkflowDispatchContext` per matched workflow, into `dispatchMatchedWorkflow`.
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

  // Resolve the tenant exactly as the webhook pipeline does (sources ->
  // generic_webhook_sources -> '__default__'): a wrong org id would resolve
  // another tenant's contexts and secrets. Resolved ONCE and shared by the
  // context gate, the fixture secret resolution, and the dispatch core.
  const resolvedOrgId = deps.db ? await resolveOrgId(deps.db, input.routingKey) : '__default__';

  // The authoritative --input validation; a rejection dispatches no agent.
  const dispatchInputsResult = resolveDispatchInputs(input, fullLockFile, matchedDecisions);
  if ('rejected' in dispatchInputsResult) {
    return { runId, status: 'rejected', reason: dispatchInputsResult.rejected, jobIds: [] };
  }

  const namespacedResult = await resolveFixtureNamespacedSecrets(input, deps, resolvedOrgId);
  if ('rejected' in namespacedResult) {
    return { runId, status: 'rejected', reason: namespacedResult.rejected, jobIds: [] };
  }

  await storeFixturePayload(input, deps, runId);

  // The core resolves per-job env secrets through this decorator, so CLI flat
  // secrets win over orchestrator env secrets.
  const cliSecrets = decryptCliSecrets(input);
  const testDeps: ProcessingDeps = deps.secretResolver
    ? { ...deps, secretResolver: new DecoratingSecretResolver(deps.secretResolver, cliSecrets) }
    : deps;

  // Mark BEFORE dispatch so the live-log observer broadcasts to the waiting CLI,
  // without waiting for the core's async is_test_run column write.
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
    // Reach EVERY job, env-declaring or not, and win a key collision with a
    // job's env-resolved secret.
    runWideFlatSecrets: cliSecrets.flat,
    ...(dispatchInputsResult.values && { dispatchInputs: dispatchInputsResult.values }),
  };

  const jobIds: string[] = [];
  const warnings: string[] = [];
  let deferredJobCount = 0;
  for (const decision of matchedDecisions) {
    const workflow = fullLockFile.workflows.find(
      (w: LockWorkflow) => w.name === decision.workflowName,
    );
    if (!workflow) continue;
    const ctx = buildTestDispatchContext(shared, workflow, decision, runId);
    const result = await dispatchMatchedWorkflow(ctx);
    jobIds.push(...result.dispatchedJobIds);
    deferredJobCount += result.deferredJobCount ?? 0;
    if (result.envWarnings?.length) warnings.push(...result.envWarnings);
  }

  // Jobs with a dynamic context, or a deferred init, dispatch from the agent
  // init round, so `jobIds` can be empty with work queued. Reject only when
  // there is neither a dispatched job nor deferred work.
  if (jobIds.length === 0 && deferredJobCount === 0) {
    return {
      runId,
      status: 'rejected',
      reason:
        'No jobs dispatched (all matched workflows had no static jobs or dispatch was rejected)',
      jobIds: [],
    };
  }

  return { runId, status: 'accepted', jobIds, ...(warnings.length > 0 && { warnings }) };
}
