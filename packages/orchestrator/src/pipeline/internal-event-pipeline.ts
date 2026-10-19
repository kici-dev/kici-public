/**
 * Dispatches an internally-triggered workflow through the SHARED pipeline
 * (`dispatchMatchedWorkflow`), never a bespoke path: a bespoke path resolves no
 * bound contexts (no context vars, scoped secrets or protection rules) and drops
 * every non-static job.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createLogger } from '@kici-dev/shared';
import {
  ExecutionRunStatus,
  TRIGGER_EVENT_TYPES,
  TrustTierSchema,
  resolveScheduleInputs,
} from '@kici-dev/engine';
import type {
  LockFile,
  LockScheduleTrigger,
  LockWorkflow,
  ProviderType,
  SimulatedEvent,
  TrustTier,
  WorkflowDecision,
} from '@kici-dev/engine';
import { SCALER_EVENT_NAMES } from '../scaler/scaler-events.js';
import { resolveOrgId, type ProcessingDeps } from './processor.js';
import { dispatchMatchedWorkflow } from './dispatch-matched-workflow.js';
import type { WorkflowDispatchContext } from './dispatch-matched-workflow.js';
import type { TrustResolution } from '../security/trust-resolver.js';
import type { RerunLineage } from '../reporting/execution-tracker.js';
import type { WebhookInfo } from '../webhook/handler.js';
import type { ProviderBundle } from '../provider-registry.js';

const logger = createLogger({ prefix: 'internal-event-pipeline' });

/**
 * The LIFECYCLE event names the orchestrator emits to itself. The `__` prefix
 * keeps them from colliding with a user `kiciEvent()` name; each maps onto a
 * canonical trigger-event type (`__schedule_fire` is not a plain de-prefixing).
 *
 * NOT every orchestrator-minted event (the scaler manager mints two more under
 * the other reserved prefix), and NOT the trusted set: two of these four are
 * caused by a run and inherit its tier — trust classification reads
 * `ORCHESTRATOR_MINTED_TRUSTED_EVENT_NAMES`.
 *
 * NOT yet the single source: `cron/cron-scheduler.ts`, `events/event-emitter.ts`
 * and `events/event-router.ts` still spell the names inline. The names are a
 * protocol between those emitters, the router and this adapter, so a typo in
 * any one of them silently stops matching.
 */
export const InternalSystemEventName = z.enum([
  '__schedule_fire',
  '__workflow_complete',
  '__workflows_failed_batch',
  '__job_complete',
]);

const TriggerEventType = z.enum(TRIGGER_EVENT_TYPES);

const INTERNAL_EVENT_PREFIX = '__';

/** The provider stamped on an internal event that carries no routing key of its own. */
const INTERNAL_PROVIDER = 'internal';

/**
 * Context for dispatching one internally-triggered workflow. Declared here, not
 * in `orchestrator-core.ts`: the adapter defines the shape and the composition
 * root imports it.
 */
export interface InternalEventDispatchContext {
  event: {
    id: string;
    eventName: string;
    payload?: Record<string, unknown>;
  };
  routingKey: string;
  repoIdentifier: string;
  providerContext: Record<string, unknown>;
  providerType: 'github' | undefined;
  /**
   * Provider bundle for the acting repository, resolved by the composition root
   * from the live registry; it also carries the clone-token provider and the
   * check-status poster.
   *
   * Required, not derived here: every dispatch site builds its clone URL as
   * `bundle?.repoUrlBuilder?.buildCloneUrl(repoIdentifier) ?? ''`, and nothing
   * downstream resolves a bundle from `deps.providerRegistry`. `undefined`
   * dispatches every job with an empty repo URL AND classifies the run as a
   * local-working-tree dispatch (the source-pack build and the source-cache
   * probe both gate on `!!ctx.bundle`), so no source tarball is produced and the
   * agent clones `''`.
   *
   * Legitimately `undefined` when the event carries no routing key, or the
   * registry has no bundle for it.
   */
  bundle: ProviderBundle | undefined;
  cronCommitSha: string;
  /**
   * The registration's default branch, or `null` when never captured.
   *
   * A `__schedule_fire` run executes the default branch's lock file, so that
   * branch IS the run's branch for a context's branch restrictions. `null`
   * presents no branch and the gate rejects with its named-cause verdict;
   * nothing substitutes a value, because a branch nobody proved is worse than an
   * honest refusal.
   */
  registrationDefaultBranch: string | null;
  /**
   * The run that summoned this one through an invoke gate. Set ONLY by the
   * invoke-gate summon path, whose synthesized event id matches no
   * `kici_events` row; naming the emitting run directly lets the summoned run
   * inherit its summoner's trust tier instead of falling back to isolated on a
   * lookup that cannot succeed.
   */
  summonedByRunId?: string;
  /**
   * Chain depth to stamp on the started run: unset (0) for a webhook-triggered
   * run, the summoner's depth + 1 for an invoke-gate summon, so the chain-depth
   * circuit breaker bounds recursion.
   */
  chainDepth?: number;
}

/**
 * The two identities an internal event renders into, which are NOT the same
 * value for a user `kiciEvent()`:
 *
 * - `jobConfigType` is what workflows observe as `ctx.event.type` and what the
 *   trigger matcher matched against — the literal `kici_event` for a custom
 *   event.
 * - `triggerEvent` is what the run carries and forwards to the Platform — the
 *   actual event name, so the dashboard can say which event fired.
 *
 * A system (`__`-prefixed) event renders both from its de-prefixed name, with
 * `__schedule_fire` collapsing onto `schedule`.
 */
export function deriveInternalEventIdentity(eventName: string): {
  jobConfigType: string;
  triggerEvent: string;
} {
  if (eventName === InternalSystemEventName.enum.__schedule_fire) {
    return {
      jobConfigType: TriggerEventType.enum.schedule,
      triggerEvent: TriggerEventType.enum.schedule,
    };
  }
  if (eventName.startsWith(INTERNAL_EVENT_PREFIX)) {
    const stripped = eventName.slice(INTERNAL_EVENT_PREFIX.length);
    return { jobConfigType: stripped, triggerEvent: stripped };
  }
  return { jobConfigType: TriggerEventType.enum.kici_event, triggerEvent: eventName };
}

/**
 * True when the trigger this decision matched is a failure-lifecycle one
 * (`workflows_failed_batch`, or a `workflow_complete` filtered on a failed
 * status). Runs it dispatches are excluded from batch accumulation so a broken
 * notifier cannot re-trigger itself — see `EventRouter.isFailureLifecycleRun`.
 */
function isFailureLifecycleDispatch(workflow: LockWorkflow, decision: WorkflowDecision): boolean {
  const matched = workflow.triggers?.[decision.matchedTrigger ?? -1];
  if (!matched) return false;
  if (matched._type === TriggerEventType.enum.workflows_failed_batch) return true;
  return (
    matched._type === TriggerEventType.enum.workflow_complete &&
    Array.isArray(matched.status) &&
    matched.status.includes(ExecutionRunStatus.enum.failed)
  );
}

/**
 * Resolve the defaults-only `dispatchInputs` of an internally-triggered run, so
 * `ctx.dispatchInputs` reads the same as for a manual "fire now".
 *
 * Values come from the trigger's declared defaults. Among several `schedule()`
 * triggers, the one matching the fired cron + timezone wins; an event with no
 * cron of its own (`__workflow_complete`, `__job_complete`, a user
 * `kiciEvent()`) uses the first declared schedule. No schedule trigger → the
 * field is omitted.
 */
function resolveInternalDispatchInputs(
  workflow: LockWorkflow,
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const scheduleTriggers = (workflow.triggers ?? []).filter(
    (t): t is LockScheduleTrigger => t._type === TriggerEventType.enum.schedule,
  );
  if (scheduleTriggers.length === 0) return undefined;
  const firedCron = typeof payload.cronExpression === 'string' ? payload.cronExpression : undefined;
  const firedTz = typeof payload.timezone === 'string' ? payload.timezone : undefined;
  const trigger = firedCron
    ? (scheduleTriggers.find(
        (t) => t.cronExpression === firedCron && (t.timezone ?? '') === (firedTz ?? ''),
      ) ?? scheduleTriggers[0])
    : scheduleTriggers[0];
  return resolveScheduleInputs(trigger?.inputs);
}

const ORCHESTRATOR_MINTED_TRUST_REASON =
  'Orchestrator-minted internal event -- no external influence (trusted ref)';

/**
 * The contributor when none can be inherited: the same empty string a
 * default-branch push with no resolvable sender records.
 */
const NO_CONTRIBUTOR = '';

/**
 * ONE builder for every internal branch (minted, inherited-trusted,
 * inherited-unknown), so the audit fields cannot disagree by branch.
 */
function makeInternalTrustResolution(
  tier: TrustTier,
  contributorUsername: string,
  reason: string,
): TrustResolution {
  return { tier, contributorUsername, reason };
}

/**
 * The event names the orchestrator mints for itself with NO CAUSING RUN, across
 * both reserved namespaces: `__schedule_fire`, and the scaler manager's two
 * `kici.scaler.*` events.
 *
 * Membership is a property of the event, not its prefix: the orchestrator is
 * the sole emitter (each from its own state), the payload carries no external
 * influence, the emit path refuses the name from a workflow step, AND no run
 * causes the event — so there is no emitter whose privilege the subscriber
 * could inherit instead.
 *
 * That last clause excludes the other lifecycle events. `__workflow_complete`
 * and `__job_complete` are each caused by ONE run (their `source_run_id`) and
 * inherit its tier; `__workflows_failed_batch` is caused by MANY runs and
 * resolves the most restrictive tier across them
 * ({@link resolveFailedBatchTrustResolution}). Minting an event is not evidence
 * that nothing external shaped the run that caused it: an untrusted fork-PR
 * run's `__workflow_complete` subscriber would otherwise get the shared cache
 * scope and the Dockerfile builds the emitter was denied.
 *
 * Enumerated, never prefix-matched: an unrecognized name in either namespace
 * was not emitted by this orchestrator, so it takes the strict path. This is
 * load-bearing: the `__` namespace already holds a CALLER-CONTROLLED name, the
 * generic-webhook idempotency marker `__dedup:<idempotencyKey>`
 * (`webhook/generic-sources.ts`). It is written straight into `kici_events`,
 * bypassing the emit-time reservation, reaches the router on a catch-up scan,
 * and a workflow CAN subscribe to it (only emitting a reserved name is
 * refused). Being unenumerated, such a run is classified isolated — the correct
 * strict verdict for a value a webhook sender chose.
 *
 * ANY future addition to `InternalSystemEventName` must be checked against it:
 * a member of the form `__dedup:…`, or a prefix match that admitted one, would
 * hand a trusted classification to a value a webhook sender chooses.
 */
const ORCHESTRATOR_MINTED_TRUSTED_EVENT_NAMES: ReadonlySet<string> = new Set<string>([
  InternalSystemEventName.enum.__schedule_fire,
  ...Object.values(SCALER_EVENT_NAMES),
]);

/**
 * True for {@link ORCHESTRATOR_MINTED_TRUSTED_EVENT_NAMES}.
 *
 * That a user step cannot produce one of these names is ENFORCED:
 * `reservedEventNamePrefix` refuses BOTH the `__` and the `kici.` namespace at
 * the emit path, in the SDK client-side and authoritatively in the
 * orchestrator's `event.emit` handler. Without it an untrusted fork-PR job
 * could emit `__schedule_fire` or `kici.scaler.scale-up` and be classified
 * trusted here.
 *
 * A scaler event carries no `sourceRunId`, so emitter inheritance would resolve
 * no tier — isolating the run's caches and making
 * `resolveWorkflowDockerfileBuilds` deny a `container: { dockerfile }` job
 * unless the org opted in, which breaks the scaler's headline use case (a
 * provisioning or teardown workflow building its own image).
 */
function isOrchestratorMintedTrustedEvent(eventName: string): boolean {
  return ORCHESTRATOR_MINTED_TRUSTED_EVENT_NAMES.has(eventName);
}

/** Matches a full commit sha, which `execution_runs.ref` sometimes carries. */
const COMMIT_SHA_REF = /^[0-9a-f]{40}$/;

/**
 * Read a run's `ref` as a BRANCH, or `''` when it is not one.
 *
 * Older run rows can hold the cron commit sha in `ref`. An operator cannot list
 * a commit sha in a branch restriction, so a sha-shaped ref resolves to no
 * branch and the gate rejects with its named cause.
 */
function branchFromRef(ref: string | null | undefined): string {
  if (!ref || COMMIT_SHA_REF.test(ref)) return '';
  return ref;
}

/**
 * What a run INHERITS from the run that emitted its event. One lookup produces
 * both fields, so they never disagree about which run they were read from.
 */
interface EmitterInheritance {
  trustResolution: TrustResolution | undefined;
  /** `''` when there is none to inherit. */
  branch: string;
}

/** The strict direction for every failure path. */
const NO_INHERITANCE: EmitterInheritance = { trustResolution: undefined, branch: '' };

/**
 * Read a persisted `trust_tier` back as the tier the emitting run carried.
 *
 * SQL NULL (a feature-branch push, a run that predates trust resolution) stays
 * unresolved. A NON-null value the schema does not recognize (an older row's
 * `known`, meaning "not trusted") reads as `unknown`, the strict tier: reading
 * it as unresolved fails open, because `isUntrustedTier(undefined)` passes the
 * trust gate and the subscriber would inherit MORE privilege than the run had.
 */
function inheritedTier(stored: unknown): TrustTier | undefined {
  if (stored === null || stored === undefined) return undefined;
  const parsed = TrustTierSchema.safeParse(stored);
  return parsed.success ? parsed.data : TrustTierSchema.enum.unknown;
}

/**
 * Read a run's persisted trust tier and branch, and inherit both.
 *
 * EVERY failure is the strict direction: no db, a missing run row, an absent
 * tier, or a throwing query resolve to no tier (`deriveCacheRefScope` → the
 * isolated scope) and no branch (rejected by the context branch gate); an
 * unrecognized tier resolves to `unknown` (`inheritedTier`). A lookup failure
 * never fails the dispatch: a run that silently never fires is worse than one
 * with the narrower privilege.
 *
 * Tier and branch resolve independently: a row with no tier still yields its
 * branch.
 */
async function inheritRunResolution(
  runId: string,
  deps: ProcessingDeps,
): Promise<EmitterInheritance> {
  if (!deps.db) return NO_INHERITANCE;
  try {
    const runRow = await deps.db
      .selectFrom('execution_runs')
      .select(['trust_tier', 'contributor_username', 'ref'])
      .where('run_id', '=', runId)
      .executeTakeFirst();
    const branch = branchFromRef(runRow?.ref);
    const tier = inheritedTier(runRow?.trust_tier);
    if (tier === undefined) return { trustResolution: undefined, branch };
    return {
      trustResolution: makeInternalTrustResolution(
        tier,
        runRow?.contributor_username ?? NO_CONTRIBUTOR,
        `Inherited the '${tier}' tier of the emitting run ${runId}`,
      ),
      branch,
    };
  } catch (err) {
    logger.warn('Failed to read the emitting run trust tier; treating the run as isolated', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NO_INHERITANCE;
  }
}

/**
 * Resolve the tier a user `kiciEvent()` subscriber INHERITS from the emitting
 * run, via the event's `source_run_id`.
 *
 * Inheritance, not blanket trust: `emit` is not trust-gated and an untrusted
 * ref still executes (the security gate `securityDecision` and the privilege
 * level `trustResolution.tier` are separate), so trusting its subscribers would
 * hand them privileges their emitter was denied.
 *
 * A missing event row or a null `source_run_id` takes the strict direction.
 */
async function inheritEmitterResolution(
  eventId: string,
  deps: ProcessingDeps,
): Promise<EmitterInheritance> {
  if (!deps.db) return NO_INHERITANCE;
  try {
    const eventRow = await deps.db
      .selectFrom('kici_events')
      .select('source_run_id')
      .where('id', '=', eventId)
      .executeTakeFirst();
    const sourceRunId = eventRow?.source_run_id;
    if (!sourceRunId) return NO_INHERITANCE;
    return await inheritRunResolution(sourceRunId, deps);
  } catch (err) {
    logger.warn(
      'Failed to resolve the emitting run of an internal event; treating it as isolated',
      {
        eventId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return NO_INHERITANCE;
  }
}

/**
 * How restrictive each trust tier is, ascending: "the most restrictive of
 * several" is the greatest rank. Only `trusted` is privileged
 * (`isUntrustedTier` is `tier !== 'trusted'`; `deriveCacheRefScope` gives the
 * shared scope to `trusted` alone).
 *
 * A `Record<TrustTier, number>`, NOT an ordered array: the mapped type makes a
 * tier added to `TrustTierSchema` fail to compile until ranked. With an array,
 * `indexOf` of an unranked tier returns `-1`, sorting it LESS restrictive than
 * `trusted`, so a batch carrying one would resolve `trusted` — fail-open.
 * `trustTierRanksCoverEverySchemaTier` re-asserts it at runtime.
 */
const TRUST_TIER_RANK: Record<TrustTier, number> = {
  [TrustTierSchema.enum.trusted]: 0,
  [TrustTierSchema.enum.unknown]: 1,
};

/**
 * True when every tier the schema admits carries a rank. Only false if the two
 * drift through a cast; exported so a test asserts it against the live
 * `TrustTierSchema.options`, not a transcription of it.
 */
export function trustTierRanksCoverEverySchemaTier(): boolean {
  return TrustTierSchema.options.every((tier) => typeof TRUST_TIER_RANK[tier] === 'number');
}

/**
 * The `__workflows_failed_batch` payload fields the trust classification reads.
 * `total` is REQUIRED: without it a capped batch is indistinguishable from an
 * uncapped one, and "cannot tell" takes the strict path.
 */
const FailedBatchTrustPayload = z.object({
  total: z.number(),
  runs: z.array(z.object({ runId: z.string() })),
});

/**
 * Resolve the tier a `__workflows_failed_batch` subscriber runs with.
 *
 * The batch is one synthetic event per swept accumulation window, with NO
 * `sourceRunId`, so it resolves the MOST RESTRICTIVE tier across the runs it
 * names: a notifier fired by a window with one fork-PR failure does not get the
 * privileges of the maintainer pushes beside it.
 *
 * EVERY failure is the strict direction: no db, an unparseable payload, an
 * empty run list, or ANY member whose tier cannot be read resolve to
 * `undefined` (isolated) — a minimum over a subset is not a minimum.
 *
 * A CAPPED batch is refused outright: the retry scanner carries
 * `runs.slice(0, BATCH_MAX_RUNS)` while `total` stays the true count, so the
 * omitted runs' tiers are unknown and an all-trusted sample would fail open.
 */
async function resolveFailedBatchTrustResolution(
  payload: Record<string, unknown>,
  deps: ProcessingDeps,
): Promise<TrustResolution | undefined> {
  if (!deps.db) return undefined;
  const parsed = FailedBatchTrustPayload.safeParse(payload);
  if (!parsed.success) return undefined;
  const { total, runs } = parsed.data;
  if (runs.length === 0) return undefined;
  if (total > runs.length) return undefined;

  // Serial is fine while only an uncapped batch (at most `BATCH_MAX_RUNS`, 200)
  // reaches here; if the cap rises, use one `where('run_id', 'in', runIds)` and
  // fold the rows in memory.
  let mostRestrictive: TrustTier = TrustTierSchema.enum.trusted;
  for (const run of runs) {
    const { trustResolution } = await inheritRunResolution(run.runId, deps);
    if (!trustResolution) return undefined;
    if (TRUST_TIER_RANK[trustResolution.tier] > TRUST_TIER_RANK[mostRestrictive]) {
      mostRestrictive = trustResolution.tier;
    }
  }

  // No contributor: naming one of the batch's many would read as a fact about
  // the whole batch.
  return makeInternalTrustResolution(
    mostRestrictive,
    NO_CONTRIBUTOR,
    `Inherited the most restrictive ('${mostRestrictive}') tier across the ${runs.length} failed runs the batch carries`,
  );
}

/**
 * Classify an internally-triggered run: its trust tier, and the branch it
 * inherits from the emitting run. ONE resolution, so both are read from the
 * SAME run. The branch is `''` where there is no single emitting run: a minted
 * event (a `__schedule_fire` presents the registration's default branch at the
 * dispatch site instead) and a failure batch.
 *
 * Ordered SUMMON FIRST, deliberately:
 *
 * 1. An invoke-gate summon names its emitting run DIRECTLY
 *    (`summonedByRunId`); its synthesized event id matches no `kici_events`
 *    row, so that lookup could only fail (isolated for a trusted summoner, as a
 *    recurring production error). It goes FIRST because its event name comes
 *    from the workflow author (`invokeSource('...')`), and a summoned run must
 *    never claim minted-trust by naming a minted event. `runInvokeGate` also
 *    refuses the reservation, so this ordering is the second of two stops.
 * 2. An orchestrator-minted event with NO CAUSING RUN (`__schedule_fire`, the
 *    two `kici.scaler.*` events) is trusted: no external influence, the same
 *    reasoning as its `securityDecision: { action: 'pass' }`. That holds only
 *    because the whole `__` namespace is refused at every path a workflow can
 *    reach.
 * 3. `__workflows_failed_batch`: the most restrictive tier across its runs.
 * 4. Everything else inherits via the event's `source_run_id` — a user
 *    `kiciEvent()`, and `__workflow_complete` / `__job_complete`, which set it
 *    to the completing run. Classifying those two by name would hand an
 *    untrusted run's subscriber the privileges the run was denied.
 */
async function resolveInternalInheritance(
  ctx: InternalEventDispatchContext,
  deps: ProcessingDeps,
): Promise<EmitterInheritance> {
  if (ctx.summonedByRunId) return inheritRunResolution(ctx.summonedByRunId, deps);
  if (isOrchestratorMintedTrustedEvent(ctx.event.eventName)) {
    return {
      trustResolution: makeInternalTrustResolution(
        TrustTierSchema.enum.trusted,
        NO_CONTRIBUTOR,
        ORCHESTRATOR_MINTED_TRUST_REASON,
      ),
      branch: '',
    };
  }
  if (ctx.event.eventName === InternalSystemEventName.enum.__workflows_failed_batch) {
    return {
      trustResolution: await resolveFailedBatchTrustResolution(ctx.event.payload ?? {}, deps),
      branch: '',
    };
  }
  return inheritEmitterResolution(ctx.event.id, deps);
}

/**
 * How a run started by a person rather than by the event itself differs from
 * the event's own run: a schedule fired by hand (`manual-schedule.ts`) and a
 * re-run of an internally triggered run (`rerun.ts`). Each claims its run id
 * first, so a relay failover re-send returns the same run.
 */
export interface InternalDispatchOverrides {
  runId: string;
  /** Recorded as the run's `trigger_event` (`manual_schedule`, `rerun`). */
  triggerEvent: string;
  triggeredBy: string | null;
  triggeredByAgentLabel: string | null;
  rerunLineage?: RerunLineage;
  /** The trigger event the run's OIDC subject derives from; see `subjectTriggerEvent`. */
  subjectTriggerEvent?: string;
  /** Replaces the inputs derived from the fired schedule, for a fire that names none. */
  dispatchInputs?: Record<string, unknown>;
}

/**
 * Dispatch one matched workflow for an internal event through the shared
 * pipeline. Returns `null` when the decision names a workflow the lock file
 * does not carry.
 */
export async function dispatchInternalEventViaPipeline(
  decision: WorkflowDecision,
  lockFile: LockFile,
  ctx: InternalEventDispatchContext,
  deps: ProcessingDeps,
  overrides?: InternalDispatchOverrides,
): Promise<{ runId: string; repo: string; workflow: string } | null> {
  const workflow = lockFile.workflows.find((w) => w.name === decision.workflowName);
  if (!workflow) return null;

  const { jobConfigType, triggerEvent } = deriveInternalEventIdentity(ctx.event.eventName);
  const runId = overrides?.runId ?? randomUUID();
  const payload = ctx.event.payload ?? {};

  // The branch presented to a context's branch restrictions: the registration's
  // default branch for a `__schedule_fire`, else the emitting run's branch.
  // `''` when unknown (no `default_branch` captured, a vanished emitting run, a
  // sha-shaped ref); the gate rejects it with its named cause. Nothing
  // substitutes a branch: an unproven one would let a restricted context accept
  // a run from anywhere.
  const { trustResolution, branch: inheritedBranch } = await resolveInternalInheritance(ctx, deps);
  const presentedBranch =
    ctx.event.eventName === InternalSystemEventName.enum.__schedule_fire
      ? (ctx.registrationDefaultBranch ?? '')
      : inheritedBranch;

  // For the TRIGGER MATCHER and the run row's branch; never reaches user code
  // (`eventEnvelope` does).
  const simulatedEvent: SimulatedEvent = {
    type: jobConfigType,
    payload,
    targetBranch: presentedBranch,
    changedFiles: [],
  };

  // What USER CODE observes (`RuleContext.event` on the agent, the `event` half
  // of `buildConcurrencyGroupContext`), where every field is read as fact.
  // `targetBranch` stays OMITTED: setting it would re-key the documented
  // `ctx.event.targetBranch ?? 'default'` concurrency group of every internal
  // workflow into per-branch groups; the branch is provenance only the
  // orchestrator evaluates. `changedFiles` is omitted because an internal event
  // has none. Both are optional on `EventBase`, so user code reads `undefined`.
  const eventEnvelope: Record<string, unknown> = { type: jobConfigType, payload };

  const info: WebhookInfo = {
    routingKey: ctx.routingKey,
    deliveryId: ctx.event.id,
    event: jobConfigType,
    action: null,
    // Deliberate cast: `internal` is not a `ProviderType`, only a passthrough
    // label the run row carries (nothing branches on it). Widening the union
    // would make every exhaustive switch over real providers accept a value
    // none of them can serve.
    provider: (ctx.providerType ?? INTERNAL_PROVIDER) as ProviderType,
    payload,
  };

  const resolvedOrgId = deps.db ? await resolveOrgId(deps.db, ctx.routingKey) : '__default__';
  const dispatchedByFailureLifecycle = isFailureLifecycleDispatch(workflow, decision);
  const dispatchInputs =
    overrides?.dispatchInputs ?? resolveInternalDispatchInputs(workflow, payload);

  const dispatchCtx: WorkflowDispatchContext = {
    info,
    deps,
    // See `InternalEventDispatchContext.bundle`.
    bundle: ctx.bundle,
    payload,
    repoIdentifier: ctx.repoIdentifier,
    // An internal event dispatches the acting repository's own lock file.
    workflowRepoIdentifier: ctx.repoIdentifier,
    // Persisted as `execution_runs.provider_context`, the source of the run's
    // `installationId` for every status forward, and the check-run reporter's
    // credentials — a blank object silently un-authenticates the whole run.
    credentials: ctx.providerContext,
    event: simulatedEvent,
    eventWithFiles: simulatedEvent,
    // `ref` is the COMMIT (the run row's `sha`; the branch comes from
    // `event.targetBranch`). Only a cron fire carries one; nothing substitutes
    // it.
    ref: ctx.cronCommitSha || '',
    fullLockFile: lockFile,
    resolvedOrgId,
    workflow,
    decision,
    runId,
    // `undefined` is NOT neutral: `deriveCacheRefScope` maps it to the isolated
    // scope, and `resolveWorkflowDockerfileBuilds` then denies image builds
    // unless the org opted in.
    trustResolution,
    lockFileSource: undefined,
    localWorkingTree: false,
    crossSource: false,
    triggeredBy: overrides?.triggeredBy ?? null,
    triggeredByAgentLabel: overrides?.triggeredByAgentLabel ?? null,
    ...(overrides?.rerunLineage && { rerunLineage: overrides.rerunLineage }),
    ...(overrides?.subjectTriggerEvent !== undefined && {
      subjectTriggerEvent: overrides.subjectTriggerEvent,
    }),
    // No pull-request provenance for the org trust policy to evaluate; the
    // centralized evaluator returns `pass` on a non-PR event, so this is the
    // same verdict, not a bypass (as in `test-pipeline.ts`).
    securityDecision: { action: 'pass' },
    // Lets the context branch gate tell a branchless run (empty
    // `event.targetBranch`) from a branch mismatch and name the real cause.
    internallyTriggered: true,
    triggerEventOverride: overrides?.triggerEvent ?? triggerEvent,
    eventEnvelopeOverride: eventEnvelope,
    ...(dispatchInputs && { dispatchInputs }),
    ...(ctx.chainDepth !== undefined && { chainDepth: ctx.chainDepth }),
    ...(dispatchedByFailureLifecycle && { dispatchedByFailureLifecycle: true }),
  };

  const result = await dispatchMatchedWorkflow(dispatchCtx);

  // A run whose jobs are all deferred (dynamic matrix / deferred init) has
  // dispatched nothing YET and still runs; it is not a failure.
  if (result.dispatchedJobCount === 0 && (result.deferredJobCount ?? 0) === 0 && !result.held) {
    logger.warn('Internal event run dispatched no jobs', {
      runId,
      workflow: workflow.name,
      eventName: ctx.event.eventName,
    });
  }

  return { runId, repo: ctx.repoIdentifier, workflow: workflow.name };
}
