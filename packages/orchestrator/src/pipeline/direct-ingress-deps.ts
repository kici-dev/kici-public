/**
 * The `ProcessingDeps` bag the DIRECT-INGRESS pipeline runs on.
 *
 * Two pipelines assemble this bag. `server.ts` builds the one the Platform WS
 * relay hands to `processWebhook`; this module builds the one every HTTP
 * ingress uses — the direct GitHub route, the generic webhook routes, and the
 * internal-event dispatch adapter. On an independent orchestrator there is no
 * relay, so this is the ONLY bag it ever has.
 *
 * It lives outside `app.ts` because it is the seam an approval defect hides in.
 * A field the composition root forgets is invisible: the pipeline reads it as
 * `undefined`, every guard downstream is written to degrade rather than throw,
 * and the feature is silently inert. Assembling the bag in a function with a
 * declared return type is what lets a test assert the wiring directly instead
 * of asserting it through a 2,000-line composition root that no test
 * constructs.
 */
import type { ProcessingDeps } from './processor.js';
import { TrustDirectoryStore } from '../security/trust-directory-store.js';
import { TrustPolicyStore } from '../security/trust-policy-store.js';
import type { SourceLocationData } from '../reporting/check-run-summary.js';

/**
 * Everything the bag reads that `AppDependencies` already carries.
 *
 * Declared structurally rather than as `AppDependencies` so this module does
 * not import `app.ts` (which imports it) and so the fields the bag actually
 * consumes are enumerated in one readable place. `AppDependencies` satisfies it
 * by construction — the `createApp` call site is the compiler's check of that.
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
}

/** The per-process stores this factory owns, exposed so the caller can reuse them. */
export interface DirectIngressStores {
  trustDirectoryStore: TrustDirectoryStore;
  trustPolicyStore: TrustPolicyStore;
}

/**
 * Build the direct-ingress `ProcessingDeps` factory.
 *
 * The returned function assembles a fresh bag per call, so every field reads
 * the CURRENT subsystem instance — the provider registry is swapped wholesale
 * on a source reload, and a bag captured once would keep dispatching through
 * the replaced one.
 *
 * The two stores are constructed once here rather than per call: both are
 * stateless over the database handle, and one of them is read on every PR
 * delivery.
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
  // Read per `/kici` command rather than per delivery. On an independent
  // orchestrator it is the only place the operator's own
  // `kici-admin trust-policy directory-set` registrations exist.
  const trustDirectoryStore = new TrustDirectoryStore(deps.db);

  // Read once per PR delivery by the org fork switch. Without it
  // `evaluateSecurityPolicy` sees no stored row and applies
  // `FAIL_CLOSED_POLICY`, whose `forkPolicy` is `ignore` — so every fork PR
  // arriving on this pipeline was DROPPED whatever the org had chosen, and an
  // operator's `kici-admin trust-policy set --fork-policy hold` had no effect
  // on the one ingress an independent orchestrator has.
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
    // Supplied by the mode hook. `server.ts` (platform / hybrid / observed)
    // always names it; `standalone.ts` (independent) names it too, so every
    // mode's direct ingress can raise, persist and release a hold.
    heldRunStore: deps.heldRunStore,
    // No `identityLinks` / `orgMemberPermissions` here: this bag is assembled
    // outside the Platform WS connection, so there is no pushed directory in
    // memory to hand over. The store is what the approval path reads instead.
    trustDirectoryStore,
    trustPolicyStore,
    // The mode the fork switch is resolved under. `resolveEffectivePolicy` no
    // longer branches on it — a stored row wins in every mode and the
    // absent-row answer is fail-closed everywhere — but the read site defaults
    // an absent value to `platform`, and reporting a mode this orchestrator is
    // not running in would be a lie waiting for the day the parameter means
    // something again.
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
  });

  return { build, stores: { trustDirectoryStore, trustPolicyStore } };
}
