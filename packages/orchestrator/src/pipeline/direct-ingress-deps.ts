/**
 * The `ProcessingDeps` bag the DIRECT-INGRESS pipeline runs on.
 *
 * `server.ts` builds the bag the Platform WS relay hands to `processWebhook`;
 * this module builds the one every HTTP ingress uses — the direct GitHub route,
 * the generic webhook routes, and the internal-event dispatch adapter. An
 * independent orchestrator has no relay, so this is its ONLY bag.
 *
 * It lives outside `app.ts` because a forgotten field reads as `undefined`,
 * every downstream guard degrades rather than throws, and the feature is
 * silently inert. A function with a declared return type lets a test assert the
 * wiring directly, not through a 2,000-line composition root no test constructs.
 */
import type { ProcessingDeps } from './processor.js';
import { TrustDirectoryStore } from '../security/trust-directory-store.js';
import { TrustPolicyStore } from '../security/trust-policy-store.js';
import type { SourceLocationData } from '../reporting/check-run-summary.js';

/**
 * Everything the bag reads that `AppDependencies` already carries.
 *
 * Structural, so this module does not import `app.ts` (which imports it) and
 * the consumed fields are listed in one place. The `createApp` call site is the
 * compiler's check that `AppDependencies` satisfies it.
 */
export interface DirectIngressDepsSource {
  db: ProcessingDeps['db'] & {};
  config: {
    mode: NonNullable<ProcessingDeps['orchestratorMode']>;
    secretKey?: string | undefined;
    instanceId?: string | undefined;
    rosterGraceMs?: number | undefined;
    maxFanoutHosts?: number | undefined;
    globalEvalRoundTimeoutMs?: number | undefined;
    globalEvalCandidateTimeoutMs?: number | undefined;
    globalEvalWaitTimeoutMs?: number | undefined;
  };
  dedup: ProcessingDeps['dedup'];
  providerRegistry: ProcessingDeps['providerRegistry'];
  ensureProviderBundle?: ProcessingDeps['ensureProviderBundle'];
  lockFileCache: ProcessingDeps['lockFileCache'];
  contentRequirementsCache?: ProcessingDeps['contentRequirementsCache'];
  dispatcher: ProcessingDeps['dispatcher'];
  platformClient?: ProcessingDeps['platformClient'];
  sourceCache?: ProcessingDeps['sourceCache'];
  buildCoordinator?: ProcessingDeps['buildCoordinator'];
  depCache?: ProcessingDeps['depCache'];
  pendingBuilds?: ProcessingDeps['pendingBuilds'];
  pendingInits?: ProcessingDeps['pendingInits'];
  pendingDynamics?: ProcessingDeps['pendingDynamics'];
  pendingGlobalEvals?: ProcessingDeps['pendingGlobalEvals'];
  globalEvalCache?: ProcessingDeps['globalEvalCache'];
  checkRunReporter?: ProcessingDeps['checkRunReporter'];
  executionTracker?: ProcessingDeps['executionTracker'];
  eventRouter?: ProcessingDeps['eventRouter'];
  invokeGateDeps?: ProcessingDeps['invokeGateDeps'];
  registrationStore?: ProcessingDeps['registrationStore'];
  registrationIndex?: ProcessingDeps['registrationIndex'];
  secretResolver?: ProcessingDeps['secretResolver'];
  sandboxAllowListReader?: ProcessingDeps['sandboxAllowListReader'];
  logStorage?: ProcessingDeps['logStorage'];
  contextStore?: ProcessingDeps['contextStore'];
  variableStore?: ProcessingDeps['variableStore'];
  heldRunStore?: ProcessingDeps['heldRunStore'];
  coordinator?: ProcessingDeps['coordinator'];
  cronScheduler?: ProcessingDeps['cronScheduler'];
  globalWorkflowPolicy?: ProcessingDeps['globalWorkflowPolicy'];
  eventLogWriter?: ProcessingDeps['eventLog'];
  accessLogWriter?: ProcessingDeps['accessLogWriter'];
  hostRosterStore?: ProcessingDeps['hostRosterStore'];
  clusterSettings?: ProcessingDeps['clusterSettings'];
  compileSchemaView?: ProcessingDeps['compileSchemaView'];
}

/** The per-process stores this factory owns, exposed so the caller can reuse them. */
export interface DirectIngressStores {
  trustDirectoryStore: TrustDirectoryStore;
  trustPolicyStore: TrustPolicyStore;
}

/**
 * The returned function assembles a fresh bag per call, so every field reads
 * the CURRENT subsystem instance: a source reload swaps the provider registry
 * wholesale, and a bag captured once would keep dispatching through the old one.
 *
 * The two stores are built once, not per call: both are stateless over the
 * database handle, and one is read on every PR delivery.
 */
export function createDirectIngressProcessingDeps(
  deps: DirectIngressDepsSource,
  hooks: {
    onSourceLocationsExtracted: (
      workflowName: string,
      jobName: string,
      locations: Array<SourceLocationData | undefined>,
    ) => void;
  },
): { build: () => ProcessingDeps; stores: DirectIngressStores } {
  // Read per `/kici` command. On an independent orchestrator it is the only
  // home of the operator's `kici-admin trust-policy directory-set` registrations.
  const trustDirectoryStore = new TrustDirectoryStore(deps.db);

  // Read once per PR delivery by the org fork switch. Without it
  // `evaluateSecurityPolicy` applies `FAIL_CLOSED_POLICY` (`forkPolicy: ignore`),
  // dropping every fork PR on this pipeline whatever the org chose.
  const trustPolicyStore = new TrustPolicyStore(deps.db);

  const build = (): ProcessingDeps => ({
    dedup: deps.dedup,
    providerRegistry: deps.providerRegistry,
    ensureProviderBundle: deps.ensureProviderBundle,
    lockFileCache: deps.lockFileCache,
    contentRequirementsCache: deps.contentRequirementsCache,
    dispatcher: deps.dispatcher,
    platformClient: deps.platformClient,
    sourceCache: deps.sourceCache,
    buildCoordinator: deps.buildCoordinator,
    depCache: deps.depCache,
    pendingBuilds: deps.pendingBuilds,
    pendingInits: deps.pendingInits,
    pendingDynamics: deps.pendingDynamics,
    pendingGlobalEvals: deps.pendingGlobalEvals,
    globalEvalCache: deps.globalEvalCache,
    checkRunReporter: deps.checkRunReporter,
    executionTracker: deps.executionTracker,
    onSourceLocationsExtracted: hooks.onSourceLocationsExtracted,
    eventRouter: deps.eventRouter,
    invokeGateDeps: deps.invokeGateDeps,
    registrationStore: deps.registrationStore,
    registrationIndex: deps.registrationIndex,
    db: deps.db,
    secretKey: deps.config.secretKey,
    secretResolver: deps.secretResolver,
    sandboxAllowListReader: deps.sandboxAllowListReader,
    logStorage: deps.logStorage,
    contextStore: deps.contextStore,
    variableStore: deps.variableStore,
    // Supplied by the mode hook: both `server.ts` (platform / hybrid / observed)
    // and `standalone.ts` (independent) name it, so every mode's direct ingress
    // can raise, persist and release a hold.
    heldRunStore: deps.heldRunStore,
    // No `identityLinks` / `orgMemberPermissions`: outside the Platform WS
    // connection there is no pushed directory, so the approval path reads the store.
    trustDirectoryStore,
    trustPolicyStore,
    // `resolveEffectivePolicy` does not branch on the mode (a stored row wins
    // and an absent row fails closed everywhere), but the read site defaults an
    // absent value to `platform`, so pass the mode this orchestrator really runs.
    orchestratorMode: deps.config.mode,
    coordinator: deps.coordinator,
    cronScheduler: deps.cronScheduler,
    globalWorkflowPolicy: deps.globalWorkflowPolicy,
    eventLog: deps.eventLogWriter,
    eventLogSource: 'direct',
    accessLogWriter: deps.accessLogWriter,
    hostRosterStore: deps.hostRosterStore,
    instanceId: deps.config.instanceId,
    rosterGraceMs: deps.config.rosterGraceMs,
    maxFanoutHosts: deps.config.maxFanoutHosts,
    globalEvalRoundTimeoutMs: deps.config.globalEvalRoundTimeoutMs,
    globalEvalCandidateTimeoutMs: deps.config.globalEvalCandidateTimeoutMs,
    globalEvalWaitTimeoutMs: deps.config.globalEvalWaitTimeoutMs,
    clusterSettings: deps.clusterSettings,
    compileSchemaView: deps.compileSchemaView,
  });

  return { build, stores: { trustDirectoryStore, trustPolicyStore } };
}
