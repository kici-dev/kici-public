/**
 * Adapter that dispatches an internally-triggered workflow through the SHARED
 * pipeline (`dispatchMatchedWorkflow`) instead of a bespoke path.
 *
 * The bespoke path it replaces resolved no bound contexts, so no context vars,
 * no scoped secrets and none of the context's protection rules reached an
 * internally-triggered job; it also dropped every non-static job on the floor.
 * Routing through the one pipeline is what keeps a fourth such gap from
 * appearing.
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
import type { WebhookInfo } from '../webhook/handler.js';
import type { ProviderBundle } from '../provider-registry.js';

const logger = createLogger({ prefix: 'internal-event-pipeline' });

/**
 * The LIFECYCLE event names the orchestrator emits to itself. They are
 * `__`-prefixed so they can never collide with a user `kiciEvent()` name, and
 * each one maps onto a canonical trigger-event type (`__schedule_fire` is the
 * one that is not a plain de-prefixing).
 *
 * NOT the whole set of orchestrator-minted events — the scaler manager mints two
 * more under the other reserved prefix. NOT the trusted set either: two of these
 * four are caused by a run and inherit its tier — `ORCHESTRATOR_MINTED_TRUSTED_EVENT_NAMES`
 * is what the trust classification reads.
 *
 * Enumerated so this module compares against a checked value rather than a bare
 * literal. It is NOT yet the single source: `cron/cron-scheduler.ts`,
 * `events/event-emitter.ts` and `events/event-router.ts` still spell the same
 * names inline, and converging them is a sweep this module's blast radius does
 * not cover. The names are a protocol between those emitters, the router and
 * this adapter, so a typo in any one of them silently stops matching.
 */
export const InternalSystemEventName = z.enum([
  '__schedule_fire',
  '__workflow_complete',
  '__workflows_failed_batch',
  '__job_complete',
]);

/** Zod view over the canonical trigger-event types, so no type is respelled. */
const TriggerEventType = z.enum(TRIGGER_EVENT_TYPES);

/** The prefix that marks an orchestrator-internal (system) event name. */
const INTERNAL_EVENT_PREFIX = '__';

/**
 * The provider stamped on an internal event that carries no routing key of its
 * own. Mirrors the bespoke path's `ctx.providerType ?? 'internal'` fallback.
 */
const INTERNAL_PROVIDER = 'internal';

/**
 * Context for dispatching one internally-triggered workflow.
 *
 * Declared here rather than in `orchestrator-core.ts` because the adapter is
 * the consumer that defines the shape; the composition root imports it.
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
   * from the live registry.
   *
   * Required, not derived here: every dispatch site builds its clone URL as
   * `bundle?.repoUrlBuilder?.buildCloneUrl(repoIdentifier) ?? ''`, and nothing
   * downstream resolves a bundle from `deps.providerRegistry`. Passing
   * `undefined` therefore dispatches every job with an empty repo URL AND
   * classifies the run as a local-working-tree dispatch (the source-pack build
   * and the source-cache probe both gate on `!!ctx.bundle`), so no source
   * tarball is produced and the agent falls through to cloning `''`. It also
   * carries the clone-token provider and the check-status poster.
   *
   * Legitimately `undefined` when the event carries no routing key, or when the
   * registry has no bundle for it — the same state the pre-pipeline path
   * rendered as an empty repo URL.
   */
  bundle: ProviderBundle | undefined;
  cronCommitSha: string;
  /**
   * The default branch of the registration this event dispatches, or `null`
   * when it was never captured.
   *
   * A `__schedule_fire` run executes the default branch's lock file, so that
   * branch IS the run's branch — which is what a context's branch restrictions
   * evaluate. `null` presents no branch and the gate then rejects with its
   * named-cause verdict; nothing substitutes a value, because a branch nobody
   * proved is worse than an honest refusal.
   */
  registrationDefaultBranch: string | null;
  /**
   * The run that summoned this one through an invoke gate, when there is one.
   *
   * Set ONLY by the invoke-gate summon path, whose event id is synthesized and
   * therefore matches no `kici_events` row. Stating the emitting run directly
   * is what lets a summoned run inherit its summoner's trust tier — the same
   * inheritance every other user `kiciEvent()` subscriber gets — instead of
   * always falling back to isolated on a lookup that cannot succeed.
   */
  summonedByRunId?: string;
  /**
   * Chain depth to stamp on the started run. A webhook-triggered run leaves this
   * unset (0); a run summoned by an invoke gate carries its summoner's depth + 1
   * so the chain-depth circuit breaker bounds recursion when it fires its own
   * gate.
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
  // A user `kiciEvent()`: workflows observe the literal `kici_event` as the
  // event type, while the run carries the actual event name.
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
 * Resolve the defaults-only `dispatchInputs` an internally-triggered run
 * carries, so steps and rules read `ctx.dispatchInputs` for a scheduled run
 * exactly as they do for a manual "fire now".
 *
 * A schedule fire carries no operator input, so the values come entirely from
 * the trigger's declared defaults. A workflow may declare several `schedule()`
 * triggers, and the fired event names the cron + timezone that actually
 * elapsed, so that trigger's inputs win; an internal event with no cron of its
 * own (`__workflow_complete`, `__job_complete`, a user `kiciEvent()`) falls
 * back to the first declared schedule. A workflow with no schedule trigger
 * resolves nothing and the field is omitted.
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

/**
 * The audit reason stamped on an orchestrator-minted run's trust resolution.
 */
const ORCHESTRATOR_MINTED_TRUST_REASON =
  'Orchestrator-minted internal event -- no external influence (trusted ref)';

/**
 * The contributor an internal event names when none can be inherited. An
 * orchestrator-minted event has no sender at all, which is the same empty
 * string a default-branch push with no resolvable sender already records.
 */
const NO_CONTRIBUTOR = '';

/**
 * Build the trust resolution an internally-triggered run carries.
 *
 * ONE builder for every internal branch — minted, inherited-trusted,
 * inherited-known/unknown — so the audit fields cannot disagree by branch.
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
 * The test for membership is the same for all three, and it is a property of
 * the event rather than of its prefix: the orchestrator itself is the sole
 * emitter, the payload carries no external influence, the emit path refuses the
 * name from a workflow step, AND no run causes the event — so there is no
 * emitter whose privilege the subscriber could be inheriting instead. A
 * `kici.scaler.scale-up` is minted by `ScalerManager` from its own state
 * exactly as a `__schedule_fire` is minted by the cron scheduler from its own —
 * nothing a contributor controls reaches either one.
 *
 * That last clause is what excludes the three remaining lifecycle events.
 * `__workflow_complete` and `__job_complete` are each caused by ONE run and
 * carry its id as the event's `source_run_id`, so they inherit that run's tier
 * like any other subscriber; `__workflows_failed_batch` is caused by MANY runs
 * and resolves the most restrictive tier across them
 * ({@link resolveFailedBatchTrustResolution}). Minting an event is not, on its
 * own, evidence that nothing external shaped the run that triggered it: an
 * untrusted fork-PR run completing would otherwise hand its
 * `__workflow_complete` subscriber the shared cache scope and the Dockerfile
 * builds the emitter itself was denied.
 *
 * Enumerated rather than prefix-matched, both times. An unrecognized name in
 * either namespace is not something this orchestrator emitted, so it takes the
 * strict path.
 *
 * That enumeration is load-bearing beyond tidiness, because the `__` namespace
 * already holds a name with a CALLER-CONTROLLED suffix: the generic-webhook
 * idempotency marker `__dedup:<idempotencyKey>` (`webhook/generic-sources.ts`).
 * It is written straight into `kici_events` and never travels the emit path, so
 * the emit-time reservation does not see it — the enumeration is the only thing
 * that keeps it out of the trusted set. It reaches the router on a catch-up
 * scan, and subscribing to a reserved name is allowed (only emitting one is
 * refused), so a workflow CAN subscribe to it. Today that costs nothing: the
 * name is not enumerated, so such a run is classified isolated, which is the
 * correct strict verdict for a value a webhook sender chose.
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
 * True for the events the orchestrator mints for itself with no causing run
 * ({@link ORCHESTRATOR_MINTED_TRUSTED_EVENT_NAMES}).
 *
 * The premise that a user step cannot produce one of these names is ENFORCED,
 * not assumed: `reservedEventNamePrefix` refuses BOTH the `__` and the `kici.`
 * namespace at the emit path, in the SDK client-side and in the orchestrator's
 * `event.emit` handler authoritatively. Without that guard an untrusted fork-PR
 * job could emit `__schedule_fire` — or `kici.scaler.scale-up` — and be
 * classified trusted by this very function.
 *
 * A scaler event is emitted with no `sourceRunId`, so without this it fell to
 * emitter inheritance, found no emitting run, and resolved to no tier at all —
 * which isolates the run's caches and makes `resolveWorkflowDockerfileBuilds`
 * deny a `container: { dockerfile }` job unless the org opted in. A
 * provisioning or teardown workflow that builds its own image is the scaler's
 * own headline use case, so that outcome contradicted both the documented rule
 * and the feature.
 */
function isOrchestratorMintedTrustedEvent(eventName: string): boolean {
  return ORCHESTRATOR_MINTED_TRUSTED_EVENT_NAMES.has(eventName);
}

/** Matches a full commit sha, which `execution_runs.ref` sometimes carries. */
const COMMIT_SHA_REF = /^[0-9a-f]{40}$/;

/**
 * Read a run's `ref` as a BRANCH, or the empty string when it is not one.
 *
 * A run row's `ref` is a branch for every webhook-triggered run, but a run
 * started before this branch-provenance path existed recorded the cron commit
 * sha there instead. Presenting a sha to a context's branch restrictions is the
 * exact confusion this whole path removes — an operator cannot add a commit sha
 * to a restriction list and would not want to — so a sha-shaped ref resolves to
 * no branch and the gate rejects with its named cause.
 */
function branchFromRef(ref: string | null | undefined): string {
  if (!ref || COMMIT_SHA_REF.test(ref)) return '';
  return ref;
}

/**
 * What a run INHERITS from the run that emitted its event: the trust tier, and
 * the branch. One lookup produces both, so the two facts can never disagree
 * about which run they were read from.
 */
interface EmitterInheritance {
  trustResolution: TrustResolution | undefined;
  /** The emitting run's branch, or `''` when there is none to inherit. */
  branch: string;
}

/** Nothing to inherit — the strict direction for every failure path. */
const NO_INHERITANCE: EmitterInheritance = { trustResolution: undefined, branch: '' };

/**
 * Read a run's persisted trust tier and branch, and inherit both.
 *
 * EVERY failure is the strict direction — no db, a run row that no longer
 * exists, an absent or unrecognized tier, or a query that throws all resolve to
 * no tier (which `deriveCacheRefScope` maps to the isolated scope) and no
 * branch (which the context branch gate rejects). A lookup failure never fails
 * the dispatch: an internally triggered run that silently never fires is worse
 * than one that runs with the narrower privilege.
 *
 * The tier and the branch resolve independently: a run row with an unreadable
 * tier still yields its branch, because the two answer different questions.
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
    const tier = TrustTierSchema.safeParse(runRow?.trust_tier);
    if (!tier.success) return { trustResolution: undefined, branch };
    return {
      trustResolution: makeInternalTrustResolution(
        tier.data,
        runRow?.contributor_username ?? NO_CONTRIBUTOR,
        `Inherited the '${tier.data}' tier of the emitting run ${runId}`,
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
 * Resolve the trust tier a user `kiciEvent()` subscriber INHERITS from the run
 * that emitted the event, via the event's own `source_run_id`.
 *
 * Inheritance rather than blanket trust, because `emit` is not trust-gated and
 * an untrusted ref still executes — the security gate (`securityDecision`) and
 * the privilege level (`trustResolution.tier`) are separate mechanisms. So an
 * untrusted-but-running job can emit a custom event, and trusting its
 * subscribers would hand them privileges their emitter was explicitly denied.
 *
 * A missing event row or a null `source_run_id` is the strict direction, same
 * as every failure inside the run lookup it delegates to.
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
 * How restrictive each trust tier is, ascending — so "the most restrictive of
 * several" is the greatest rank.
 *
 * Only `trusted` is actually privileged: `isUntrustedTier` is `tier !==
 * 'trusted'` and `deriveCacheRefScope` gives the shared scope to `trusted`
 * alone, so `known` and `unknown` are both untrusted for every consumer that
 * branches on the tier. They are still ranked rather than collapsed, because
 * the tier travels onward as an audit fact and `known` is genuinely a narrower
 * claim than `unknown`.
 *
 * A `Record<TrustTier, number>` and NOT an ordered array, because the mapped
 * type is what makes the exhaustiveness real: a tier added to `TrustTierSchema`
 * fails to compile here until it is ranked. An array typed `readonly
 * TrustTier[]` carries no such obligation — it would compile unchanged, an
 * `indexOf` of the new tier would return `-1`, and `-1` beats every real rank
 * downward, so the new tier would sort as LESS restrictive than `trusted` and a
 * batch carrying one would resolve `trusted`. The fail-open direction is
 * exactly the one this classifier must not have, so the safety is delegated to
 * the compiler rather than to a comment asking the next editor to remember.
 * `trustTierRanksCoverEverySchemaTier` re-asserts it at runtime for the same
 * reason the emit reservation is checked in two places.
 */
const TRUST_TIER_RANK: Record<TrustTier, number> = {
  [TrustTierSchema.enum.trusted]: 0,
  [TrustTierSchema.enum.known]: 1,
  [TrustTierSchema.enum.unknown]: 2,
};

/**
 * True when every tier the schema admits carries a rank.
 *
 * The `Record<TrustTier, number>` above already fails the build on an unranked
 * tier, so this can only ever be false if the two drift through a cast. It is
 * exported so a test asserts it against the live `TrustTierSchema.options`
 * rather than against a transcription of it — the check has to read the schema
 * to be worth having.
 */
export function trustTierRanksCoverEverySchemaTier(): boolean {
  return TrustTierSchema.options.every((tier) => typeof TRUST_TIER_RANK[tier] === 'number');
}

/**
 * The `__workflows_failed_batch` payload fields the trust classification reads.
 *
 * `total` is REQUIRED even though only the comparison against `runs.length`
 * uses it: without it there is no way to tell an uncapped batch from a capped
 * one, and "cannot tell" takes the strict path like every other failure here.
 */
const FailedBatchTrustPayload = z.object({
  total: z.number(),
  runs: z.array(z.object({ runId: z.string() })),
});

/**
 * Resolve the tier a `__workflows_failed_batch` subscriber runs with.
 *
 * The batch event carries NO `sourceRunId` — it is one synthetic event per
 * swept accumulation window, caused by every failed run in that window at once
 * — so there is no single emitter to inherit from. It resolves the MOST
 * RESTRICTIVE tier across the runs it names: a batch is only as trusted as its
 * least trusted member, so a notifier fired by a window that included one
 * fork-PR failure does not run with the privileges of the maintainer pushes
 * beside it.
 *
 * EVERY failure is the strict direction, as everywhere else in this classifier:
 * no db, a payload that does not parse, an empty run list, or ANY member whose
 * tier cannot be read all resolve to `undefined` (isolated). One unreadable
 * member is not narrowed away to a minimum over the rest — a minimum over a
 * subset is not a minimum.
 *
 * A CAPPED batch is refused without computing at all. The retry scanner carries
 * `runs.slice(0, BATCH_MAX_RUNS)` while `total` stays the true count, so on a
 * capped window `runs` is a truncated SAMPLE and the runs omitted from it are
 * exactly the ones whose tiers are unknown here. A sample that happens to be
 * entirely trusted is the case that would otherwise fail open.
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

  // Serial by design at today's cap: an uncapped batch carries at most
  // `BATCH_MAX_RUNS` (200) runs, and only an UNCAPPED one reaches this loop at
  // all. If that cap rises, replace the loop with a single
  // `where('run_id', 'in', runIds)` and fold the rows in memory — the rule is
  // unchanged either way, but N awaited round-trips per swept window is not.
  let mostRestrictive: TrustTier = TrustTierSchema.enum.trusted;
  for (const run of runs) {
    const { trustResolution } = await inheritRunResolution(run.runId, deps);
    if (!trustResolution) return undefined;
    if (TRUST_TIER_RANK[trustResolution.tier] > TRUST_TIER_RANK[mostRestrictive]) {
      mostRestrictive = trustResolution.tier;
    }
  }

  // No contributor: the batch answers to as many contributors as it carries
  // runs, and naming one of them would read as a fact about the whole batch.
  // The webhook path's own no-resolvable-sender case records the same empty
  // string.
  return makeInternalTrustResolution(
    mostRestrictive,
    NO_CONTRIBUTOR,
    `Inherited the most restrictive ('${mostRestrictive}') tier across the ${runs.length} failed runs the batch carries`,
  );
}

/**
 * Classify an internally-triggered run: the trust tier it runs at, and the
 * branch it inherits from the run that emitted its event.
 *
 * Both come from ONE resolution because both are facts about the SAME emitting
 * run — resolving them separately would let them disagree about which run they
 * read. The branch is `''` wherever there is no single emitting run to inherit
 * from: an orchestrator-minted event (a `__schedule_fire` presents the
 * registration's default branch instead, at the dispatch site) and a failure
 * batch (which many runs cause, on as many branches).
 *
 * The branches are ordered SUMMON FIRST, deliberately:
 *
 * 1. An invoke-gate summon states its emitting run DIRECTLY
 *    (`summonedByRunId`), so it inherits without the `kici_events` hop — its
 *    event id is synthesized and matches no persisted row, so the lookup could
 *    only ever fail, a wrong verdict (isolated for a trusted summoner) reported
 *    as a recurring production error. It is checked FIRST because its event
 *    name comes from the workflow author (`invokeSource('...')`), and a
 *    summoned run must never be able to claim minted-trust by naming a minted
 *    event. Inheritance is what the summon path gets, always. The reservation
 *    is refused upstream too (`runInvokeGate`), so this ordering is the second
 *    of two independent stops rather than the only one.
 * 2. An orchestrator-minted event with NO CAUSING RUN (`__schedule_fire`, the
 *    two `kici.scaler.*` events) is trusted: it carries no external influence,
 *    which is the same reasoning that already justifies its
 *    `securityDecision: { action: 'pass' }`. That premise holds only because
 *    the whole `__` namespace is refused at every path a workflow can reach.
 * 3. `__workflows_failed_batch` is minted too, but MANY runs cause it and it
 *    carries no `sourceRunId`, so it resolves the most restrictive tier across
 *    the runs it names.
 * 4. Everything else inherits its emitter's tier via the event's
 *    `source_run_id` — a user `kiciEvent()`, and the two lifecycle events a
 *    single run causes (`__workflow_complete`, `__job_complete`), which set
 *    that field to the completing run. Being orchestrator-minted says nothing
 *    about the run that CAUSED the event, so classifying those two by name
 *    instead let an untrusted run's completion hand its subscriber the
 *    privileges the run itself was denied.
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
 * Dispatch one matched workflow for an internal event through the shared
 * pipeline. Returns the spawned-run summary the bespoke path returned, or
 * `null` when the decision names a workflow the lock file does not carry.
 */
export async function dispatchInternalEventViaPipeline(
  decision: WorkflowDecision,
  lockFile: LockFile,
  ctx: InternalEventDispatchContext,
  deps: ProcessingDeps,
): Promise<{ runId: string; repo: string; workflow: string } | null> {
  const workflow = lockFile.workflows.find((w) => w.name === decision.workflowName);
  if (!workflow) return null;

  const { jobConfigType, triggerEvent } = deriveInternalEventIdentity(ctx.event.eventName);
  const runId = randomUUID();
  const payload = ctx.event.payload ?? {};

  // The branch this run presents to a context's branch restrictions.
  //
  // A `__schedule_fire` run executes the registration's default-branch lock
  // file, so that branch IS its branch. Every other internal trigger inherits
  // the branch of the run that emitted its event.
  //
  // `''` when neither is known — a registration that predates the
  // `default_branch` column, an emitting run that no longer exists, a ref that
  // is a commit sha rather than a branch. The branch gate reads the empty value
  // and rejects with its named-cause verdict. Nothing substitutes a branch:
  // presenting one the run never proved would let a restricted context accept a
  // run from anywhere.
  const { trustResolution, branch: inheritedBranch } = await resolveInternalInheritance(ctx, deps);
  const presentedBranch =
    ctx.event.eventName === InternalSystemEventName.enum.__schedule_fire
      ? (ctx.registrationDefaultBranch ?? '')
      : inheritedBranch;

  // The shape the TRIGGER MATCHER needs: `SimulatedEvent` requires
  // `targetBranch`, and the run row's branch is read off it. It never reaches
  // user code — `eventEnvelope` below is what does.
  const simulatedEvent: SimulatedEvent = {
    type: jobConfigType,
    payload,
    targetBranch: presentedBranch,
    changedFiles: [],
  };

  // The shape USER CODE observes, stated verbatim so nothing is fabricated.
  // This envelope becomes `RuleContext.event` on the agent and the `event` half
  // of `buildConcurrencyGroupContext`, where every field is read as fact.
  //
  // `targetBranch` stays OMITTED here even now that `presentedBranch` often
  // holds a real branch: setting it would re-key the documented
  // `ctx.event.targetBranch ?? 'default'` concurrency group of every existing
  // internal workflow, silently splitting one group into per-branch ones. The
  // branch is provenance the orchestrator evaluates (the trigger matcher and
  // the context branch gate), not a field user code asked for. `changedFiles`
  // is omitted for the same reason it always was: an internal event has none.
  // Both are optional on `EventBase`, so user code reads an honest `undefined`.
  const eventEnvelope: Record<string, unknown> = { type: jobConfigType, payload };

  const info: WebhookInfo = {
    routingKey: ctx.routingKey,
    deliveryId: ctx.event.id,
    event: jobConfigType,
    action: null,
    // `internal` is not a member of `ProviderType`, and the cast is deliberate:
    // it is the value the run row already carries for an internal event, and it
    // travels as a passthrough label — nothing branches on it, it only has to
    // keep saying what it has always said. Widening the union to admit it would
    // make every exhaustive switch over real providers accept a value none of
    // them can serve.
    provider: (ctx.providerType ?? INTERNAL_PROVIDER) as ProviderType,
    payload,
  };

  const resolvedOrgId = deps.db ? await resolveOrgId(deps.db, ctx.routingKey) : '__default__';
  const dispatchedByFailureLifecycle = isFailureLifecycleDispatch(workflow, decision);
  const dispatchInputs = resolveInternalDispatchInputs(workflow, payload);

  const dispatchCtx: WorkflowDispatchContext = {
    info,
    deps,
    // Resolved by the composition root from the live registry. Without it every
    // job dispatches with an empty repo URL and the run is classified as a
    // local-working-tree dispatch, so the workflow source can never be
    // materialized.
    bundle: ctx.bundle,
    payload,
    repoIdentifier: ctx.repoIdentifier,
    // An internal event dispatches the acting repository's own lock file, so
    // the defining repository is the same one.
    workflowRepoIdentifier: ctx.repoIdentifier,
    // The registration's provider context. It is what `onExecutionStarted`
    // persists as `execution_runs.provider_context`, what the run's
    // `installationId` is extracted from for every status forward, and what the
    // check-run reporter authenticates with — so a blank object silently
    // un-authenticates the whole run, it does not merely omit a label.
    credentials: ctx.providerContext,
    event: simulatedEvent,
    eventWithFiles: simulatedEvent,
    // `ref` is the COMMIT, not the branch — every dispatch site writes it as
    // the run row's `sha` and derives the row's branch from
    // `event.targetBranch` instead. A cron fire carries the commit sha it
    // resolved; every other internal event has none, and nothing substitutes
    // one.
    ref: ctx.cronCommitSha || '',
    fullLockFile: lockFile,
    resolvedOrgId,
    workflow,
    decision,
    runId,
    // Minted with no causing run => trusted; every other internal event
    // inherits the tier of the run (or runs) that caused it; every failure
    // degrades to `undefined` (isolated).
    // `undefined` here is NOT neutral — `deriveCacheRefScope` maps it to the
    // isolated user-cache scope, which `resolveWorkflowDockerfileBuilds` then
    // denies unless the org opted in, so leaving it unset denied the
    // cron-fired image builds of every org that has not opted in.
    trustResolution,
    lockFileSource: undefined,
    localWorkingTree: false,
    crossSource: false,
    triggeredBy: null,
    triggeredByAgentLabel: null,
    // An internal event has no pull-request provenance for the org trust policy
    // to evaluate — no external contributor, no fork, no base-vs-head diff. The
    // centralized evaluator short-circuits to `pass` on a non-PR event, so
    // stating it is the same verdict rather than a bypass. Same reasoning as
    // the CLI remote-run path (`test-pipeline.ts`).
    securityDecision: { action: 'pass' },
    // Every dispatch through this adapter is orchestrator-triggered. The
    // context branch gate reads this to tell a genuinely branchless run (empty
    // `event.targetBranch`) apart from a run whose branch simply does not
    // match, so it can name the real cause instead of quoting an empty value.
    internallyTriggered: true,
    triggerEventOverride: triggerEvent,
    eventEnvelopeOverride: eventEnvelope,
    ...(dispatchInputs && { dispatchInputs }),
    ...(ctx.chainDepth !== undefined && { chainDepth: ctx.chainDepth }),
    ...(dispatchedByFailureLifecycle && { dispatchedByFailureLifecycle: true }),
  };

  const result = await dispatchMatchedWorkflow(dispatchCtx);

  // A run whose jobs are all deferred (dynamic matrix / deferred init) has
  // dispatched nothing YET and still runs — treating it as a failure is the
  // bug the old path had in mirror image.
  if (result.dispatchedJobCount === 0 && (result.deferredJobCount ?? 0) === 0 && !result.held) {
    logger.warn('Internal event run dispatched no jobs', {
      runId,
      workflow: workflow.name,
      eventName: ctx.event.eventName,
    });
  }

  return { runId, repo: ctx.repoIdentifier, workflow: workflow.name };
}
