/**
 * Tier-2 global eval round — orchestrator side.
 *
 * A global workflow can declare a `filter` predicate and `DynamicJobFn`
 * generators, neither of which the orchestrator may run: author code never
 * returns to this process. So the candidates that need either one are grouped by
 * the workflow repo they live in and handed to ONE pre-run job per
 * (event × workflow repo × registered SHA). That job checks out the workflow
 * repo and the source repo once, runs every candidate's filter and then its
 * generators, and reports a verdict per candidate.
 *
 * The round precedes any run row by design: its whole purpose is to decide which
 * global workflows produce a run at all, so creating one up-front would defeat
 * it.
 *
 * This module owns the partition, the grouping, and the dispatch-and-await. The
 * caller decides what to do with the verdicts.
 */

import { randomUUID } from 'node:crypto';
import { createLogger, getRequestContext, toErrorMessage } from '@kici-dev/shared';
import type {
  GlobalEvalCandidateResult,
  GlobalEvalRoundResult,
  LockJob,
  LockWorkflow,
  SimulatedEvent,
  WorkflowDecision,
} from '@kici-dev/engine';
import { INIT_RUNNER_ROLE_LABEL, isLockDynamicJobFn } from '@kici-dev/engine';
import {
  globalEvalCacheLookupsTotal,
  globalEvalCandidatesTotal,
  globalEvalJobsGenerated,
  globalEvalRoundDurationSeconds,
  globalEvalVerdictsTotal,
} from '../metrics/prometheus.js';
import {
  globalEvalRoundCacheKey,
  isCacheableRoundResult,
  type GlobalEvalRoundCache,
} from '../cache/global-eval-round-cache.js';
import { agentVersionAtLeast, parseVersionBase } from '../agent/agent-version.js';
import { ADMITTED_PIPELINE_LIFETIME_MS } from '../ws/platform-client.js';
import type { PendingGlobalEvalTracker } from '../cache/pending-global-evals.js';
import type { ClusterSettingsReader } from '../cluster/cluster-settings-reader.js';
import type { ProviderBundle } from '../provider-registry.js';
import type { QueuedJobInput } from '../queue/job-queue.js';
import type { RegisteredWorkflow } from '../registration/registration-index.js';
import type { WebhookInfo } from '../webhook/handler.js';

const logger = createLogger({ prefix: 'global-eval-round' });

/** Name prefix identifying a round job in the queue, logs, and the dashboard. */
export const ROUND_JOB_PREFIX = '__globaleval__';

/** Platform/arch used when no agent is registered to probe. */
const FALLBACK_TARGET = { targetPlatform: 'linux', targetArch: 'x64' } as const;

/** Dispatch outcomes that mean the round job is on its way to an agent. */
const ACCEPTED_DISPATCH_STATUSES = new Set(['dispatched', 'queued']);

/**
 * NUL joins group-key and candidate-key parts so no identifier containing the
 * separator can forge a neighbouring key. Written as an escape, never a raw
 * byte: a literal control character makes the whole file opaque to `grep -I`.
 */
const KEY_SEPARATOR = '\u0000';

/** Metric label values for a per-candidate round verdict. */
export const GlobalEvalVerdictOutcome = {
  /** The candidate's `filter` admitted it and its jobs are dispatching. */
  Run: 'run',
  /** The candidate's `filter` returned false — a decided exclusion. */
  Filtered: 'filtered',
  /** The round could not decide: it failed, breached a budget, or never reported. */
  Indeterminate: 'indeterminate',
} as const;
export type GlobalEvalVerdictOutcome =
  (typeof GlobalEvalVerdictOutcome)[keyof typeof GlobalEvalVerdictOutcome];

/** Metric label values for a dispatched round's outcome. */
export const GlobalEvalRoundResultLabel = {
  Success: 'success',
  Error: 'error',
} as const;
export type GlobalEvalRoundResultLabel =
  (typeof GlobalEvalRoundResultLabel)[keyof typeof GlobalEvalRoundResultLabel];

/** Metric label values for one round-cache lookup. */
export const GlobalEvalCacheLookupResult = {
  Hit: 'hit',
  Miss: 'miss',
  /** The round input could not be serialized, so no key exists to look up. */
  Unkeyable: 'unkeyable',
} as const;
export type GlobalEvalCacheLookupResult =
  (typeof GlobalEvalCacheLookupResult)[keyof typeof GlobalEvalCacheLookupResult];

/** One matched global workflow the round may have to decide on. */
export interface GlobalEvalCandidate {
  reg: RegisteredWorkflow;
  lockEntry: LockWorkflow;
  /**
   * The trigger-match decision this candidate came from, carried so the round's
   * verdict can be appended to its trace. Optional because the round itself
   * never reads it — only the caller that explains an exclusion does.
   */
  decision?: WorkflowDecision;
}

/**
 * The per-candidate payload the agent's round runner expects, mirroring
 * `GlobalEvalCandidate` in `packages/agent/src/execution/global-eval-runner.ts`.
 * Kept as its own type because the orchestrator's candidate carries the whole
 * registration, of which the agent needs three fields.
 */
interface GlobalEvalWireCandidate {
  workflowName: string;
  sourceFile: string;
  hasFilter: boolean;
}

/**
 * Stable identity for one candidate across a round's results.
 *
 * The registration id alone is unique, but the workflow name is appended so a
 * lookup reads honestly at the call site and a malformed registration with a
 * blank id still separates two workflows.
 */
export function candidateKey(candidate: GlobalEvalCandidate): string {
  return [candidate.reg.id, candidate.lockEntry.name].join(KEY_SEPARATOR);
}

/** True when the workflow carries at least one `DynamicJobFn` entry. */
function hasDynamicJob(lockEntry: LockWorkflow): boolean {
  return (lockEntry.jobs ?? []).some((job) => isLockDynamicJobFn(job));
}

/**
 * Split matched global candidates into those that can dispatch straight away and
 * those that must go through an eval round first.
 *
 * A candidate needs the round when it declares a `filter` (only the agent may
 * run the predicate) or carries a `DynamicJobFn` (only the agent may run the
 * generator). Everything else is fully described by the lock file, so routing it
 * through a round would add a job dispatch and an agent round trip for nothing.
 */
export function partitionCandidates(candidates: readonly GlobalEvalCandidate[]): {
  immediate: GlobalEvalCandidate[];
  needsRound: GlobalEvalCandidate[];
} {
  const immediate: GlobalEvalCandidate[] = [];
  const needsRound: GlobalEvalCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.lockEntry.hasFilter === true || hasDynamicJob(candidate.lockEntry)) {
      needsRound.push(candidate);
    } else {
      immediate.push(candidate);
    }
  }
  return { immediate, needsRound };
}

/**
 * Group by workflow repo, routing key, and registered SHA.
 *
 * All three parts are load-bearing. The repo identifier and the SHA together pin
 * the exact tree the round checks out, so two registrations of one repo at
 * different commits can never share a checkout; the routing key pins which
 * provider bundle mints the clone credentials, so two providers owning the same
 * repo path stay separate.
 */
export function groupCandidates(
  candidates: readonly GlobalEvalCandidate[],
): Map<string, GlobalEvalCandidate[]> {
  const groups = new Map<string, GlobalEvalCandidate[]>();
  for (const candidate of candidates) {
    const key = [
      candidate.reg.repoIdentifier,
      candidate.reg.routingKey,
      candidate.reg.commitSha ?? '',
    ].join(KEY_SEPARATOR);
    const existing = groups.get(key);
    if (existing) existing.push(candidate);
    else groups.set(key, [candidate]);
  }
  return groups;
}

/** Minimal dispatcher surface the round needs (the real one is the job dispatcher). */
export interface GlobalEvalDispatcher {
  dispatch(input: QueuedJobInput): Promise<{ status: string; jobId: string }>;
  /**
   * Take a still-queued round job out of the queue when nobody is waiting for
   * it any more. Optional so a test double can omit it.
   */
  cancelQueuedJob?(jobId: string, reason: string): Promise<void>;
}

/**
 * Minimal provider-registry surface: resolving the bundle that owns a routing
 * key. The round needs it because the workflow repo and the event's source repo
 * can live behind different providers.
 */
export interface GlobalEvalProviderRegistry {
  getByRoutingKey(routingKey: string): ProviderBundle | undefined;
}

/** Minimal agent-registry surface used to pick the round job's platform labels. */
export interface GlobalEvalAgentRegistry {
  findAvailable(
    labels: string[],
  ): Array<{ platform: string; arch: string; version?: string | null }>;
}

/**
 * First agent release whose job runner understands a `globalEvalRound`
 * dispatch.
 *
 * Below it the agent has no round branch at all: the job falls through to the
 * standard executor, whose `jobConfig` carries no `source.file`, so it either
 * fails outright or reports success without the `globalEvalComplete` the
 * orchestrator is waiting for. Either way the round never settles.
 *
 * Customers upgrade their orchestrator and their agents on their own schedule
 * (`.claude/rules/compatibility.md`), so an orchestrator ahead of its fleet is
 * a supported state and not an error — but it is one this module has to
 * recognise, because the damage is not confined to the new feature. A global
 * workflow that merely *contains* a generator now routes through the round, so
 * an unrecognised round means static jobs that ran yesterday stop running.
 */
export const MIN_GLOBAL_EVAL_AGENT_VERSION = '0.5.0';

export interface GlobalEvalRoundDeps {
  dispatcher: GlobalEvalDispatcher;
  pendingGlobalEvals: PendingGlobalEvalTracker;
  /**
   * Required, unlike the three optional deps below: it is what resolves the
   * WORKFLOW repo's own provider bundle. Omitting it would leave the round with
   * no clone URL for the workflow repo at all, so it is not a dep that can
   * degrade quietly.
   */
  providerRegistry: GlobalEvalProviderRegistry;
  clusterSettings?: ClusterSettingsReader;
  globalEvalCache?: GlobalEvalRoundCache;
  agentRegistry?: GlobalEvalAgentRegistry;
}

export interface GlobalEvalRoundArgs {
  deps: GlobalEvalRoundDeps;
  info: WebhookInfo;
  event: SimulatedEvent;
  candidates: readonly GlobalEvalCandidate[];
  /** Source repo that triggered the event. */
  repoIdentifier: string;
  /** Source repo SHA the event lands on. */
  ref: string;
  dispatchBundle: ProviderBundle;
  dispatchCredentials: Record<string, unknown>;
  /** Cluster defaults for the round budgets and the wait ceiling (`config.ts`). */
  config: {
    globalEvalRoundTimeoutMs: number;
    globalEvalCandidateTimeoutMs: number;
    globalEvalWaitTimeoutMs: number;
  };
}

/** Both agent-side budgets plus the orchestrator's wait ceiling, for one round. */
interface RoundBudgets {
  roundTimeoutMs: number;
  candidateTimeoutMs: number;
  /**
   * How long this orchestrator waits for the round to settle before giving up.
   *
   * The two budgets above are enforced by the AGENT and only start once the
   * round job is running, so neither bounds a round the fleet never picked up.
   */
  waitTimeoutMs: number;
}

/**
 * Ratio the wait ceiling is raised to when it does not exceed the round budget.
 *
 * The shipped defaults are 120s of agent budget under a 240s ceiling, so 2 is
 * the pairing the system is designed around rather than an invented margin.
 */
const WAIT_CEILING_MULTIPLIER = 2;

/**
 * Hard cap on a raised wait ceiling: the relay's admitted-pipeline
 * force-release window, taken from the platform client that enforces it rather
 * than restated here. Same package, so the two cannot drift.
 *
 * The raise is bounded because neither `globalEvalRoundTimeoutMs` input has an
 * upper bound of its own — the admin route validates `min(1000)` and the env
 * schema validates nothing — so an unbounded `round * 2` turns a large round
 * budget into an arbitrarily long inline wait, twice, on every delivery. A
 * ceiling past this point holds the delivery beyond the window the relay will
 * wait for it anyway, so raising further buys latency and no verdict.
 */
const MAX_RAISED_WAIT_CEILING_MS = ADMITTED_PIPELINE_LIFETIME_MS;

/**
 * Least a wait ceiling may exceed the agent's round budget by and still be
 * treated as a workable pairing.
 *
 * The headroom is what the ceiling has to absorb: the agent's budget starts
 * only once the round job is RUNNING, so the ceiling must cover the budget PLUS
 * however long the job sat queued for a free init-runner. A ceiling only a few
 * percent above the budget fails every round that waited at all.
 *
 * Expressed as a ratio rather than a fixed number of milliseconds because the
 * queue wait scales with the round: a 5-second round on a busy init-runner
 * waits seconds, a 5-minute round waits proportionally longer, and a fixed
 * floor would be both too strict for the first and too loose for the second.
 *
 * It closes a silent dead band. `raised = min(round * 2, 300_000)` degenerates
 * as the round budget approaches the cap — at `round = 299_000` the raise buys
 * one second, at `299_999` one millisecond — while the fail-fast test was
 * `raised <= round`, true only from `round >= 300_000`. So the whole
 * `[150s, 300s)` band took the SUCCESS path and logged as if it had fixed
 * something, with a ceiling that in practice could never outlive the budget.
 * The boundary now falls at `round > 240s`, where a round budget genuinely
 * stops fitting under the relay's window.
 */
const MIN_WAIT_CEILING_RATIO = 1.25;

/**
 * Raise a wait ceiling that cannot outlive the agent's own round budget.
 *
 * The agent's budget starts only once the round job is RUNNING, so a ceiling at
 * or below it fires on every round that merely waited for a free agent: every
 * round fails, permanently and silently. The admin route refuses that pairing
 * on the values it is handed, and the CLI warns — but neither sees the two
 * cases this does. `cluster-settings reset` sends `null` for one knob while the
 * other stays stored, so the merged pair the route validated is not the pair
 * that ends up in effect; and the `KICI_GLOBAL_EVAL_{ROUND,WAIT}_TIMEOUT_MS`
 * env pair passes through no cross-field validation at all.
 *
 * This is the one place both EFFECTIVE values are known, so it is where the
 * pairing is made to hold. Raising rather than lowering is deliberate: the
 * round budget is what the agent enforces, and shrinking it here would silently
 * disagree with the budget the job was dispatched with.
 *
 * The raise is capped at {@link MAX_RAISED_WAIT_CEILING_MS}. When the cap
 * cannot clear the round budget by {@link MIN_WAIT_CEILING_RATIO}, no ceiling
 * under it is workable and raising past it would only hold the delivery beyond
 * the point the relay stops waiting — so the configured ceiling is left alone
 * and the round fails fast and visibly instead of slowly and quietly. Both
 * branches log at `error`: this is a standing misconfiguration that makes every
 * round fail, not a transient condition.
 *
 * The entry test is the same ratio, not `wait > round`. A ceiling one percent
 * above the budget is the same defect as one below it — every round that waited
 * for a free agent fails — and reads as coherent to a bare `>`.
 */
function clampWaitCeiling(budgets: RoundBudgets): RoundBudgets {
  if (budgets.waitTimeoutMs >= budgets.roundTimeoutMs * MIN_WAIT_CEILING_RATIO) return budgets;
  const raised = Math.min(
    budgets.roundTimeoutMs * WAIT_CEILING_MULTIPLIER,
    MAX_RAISED_WAIT_CEILING_MS,
  );
  if (raised < budgets.roundTimeoutMs * MIN_WAIT_CEILING_RATIO) {
    logger.error(
      'Global eval round budget exceeds the relay force-release window — lower it; ' +
        'the wait ceiling cannot be raised above it',
      {
        configuredWaitTimeoutMs: budgets.waitTimeoutMs,
        roundTimeoutMs: budgets.roundTimeoutMs,
        maxRaisedWaitTimeoutMs: MAX_RAISED_WAIT_CEILING_MS,
        minWaitCeilingRatio: MIN_WAIT_CEILING_RATIO,
      },
    );
    return budgets;
  }
  logger.error('Global eval wait ceiling does not exceed the round budget — raising it', {
    configuredWaitTimeoutMs: budgets.waitTimeoutMs,
    roundTimeoutMs: budgets.roundTimeoutMs,
    effectiveWaitTimeoutMs: raised,
    maxRaisedWaitTimeoutMs: MAX_RAISED_WAIT_CEILING_MS,
  });
  return { ...budgets, waitTimeoutMs: raised };
}

/**
 * Lower a per-candidate budget that can consume the whole round.
 *
 * The adjacent axis to {@link clampWaitCeiling}, unguarded until now: the admin
 * route, the CLI warning and that clamp all covered wait-vs-round exclusively.
 * With `candidate = 300s` and `round = 120s`, the first candidate consumes the
 * entire round, the agent's own deadline check returns, and every sibling is
 * padded indeterminate — and because the group WAS decided in part, nothing
 * retried it.
 *
 * Lowered rather than raised, the opposite of the wait ceiling, because the
 * direction of authority is opposite too. The round budget is the outer bound
 * the agent enforces on the whole job; a per-candidate slice larger than it is
 * not a budget at all. Raising the round instead would extend the delivery's
 * inline wait on the strength of a per-candidate knob.
 *
 * `WAIT_CEILING_MULTIPLIER` is reused as the divisor deliberately: the shipped
 * pairing is 20s per candidate under a 120s round, so halving the round is
 * already generous, and the value the operator asked for is never exceeded.
 */
function clampCandidateBudget(budgets: RoundBudgets): RoundBudgets {
  const ceiling = Math.floor(budgets.roundTimeoutMs / WAIT_CEILING_MULTIPLIER);
  if (budgets.candidateTimeoutMs <= ceiling) return budgets;
  logger.error(
    'Global eval candidate budget can consume the whole round — lowering it; ' +
      'a candidate that uses up the round suppresses every sibling workflow in it',
    {
      configuredCandidateTimeoutMs: budgets.candidateTimeoutMs,
      roundTimeoutMs: budgets.roundTimeoutMs,
      effectiveCandidateTimeoutMs: ceiling,
    },
  );
  return { ...budgets, candidateTimeoutMs: ceiling };
}

/**
 * Read all three budgets fresh for every round rather than at construction, so
 * an operator raising one takes effect on the next push instead of the next
 * restart. The cluster reader serves them from its own short-lived snapshot, so
 * this is not a per-round database round trip.
 */
async function resolveBudgets(
  deps: GlobalEvalRoundDeps,
  config: GlobalEvalRoundArgs['config'],
): Promise<RoundBudgets> {
  const { clusterSettings } = deps;
  // Both axes, in one place, on the EFFECTIVE values — which is the whole
  // reason the clamps live here rather than only at the admin route: a
  // `cluster-settings reset` nulls one knob while the other stays stored, and
  // the `KICI_GLOBAL_EVAL_*_MS` env trio passes through no cross-field
  // validation at all.
  const clamp = (budgets: RoundBudgets): RoundBudgets =>
    clampCandidateBudget(clampWaitCeiling(budgets));
  if (!clusterSettings) {
    return clamp({
      roundTimeoutMs: config.globalEvalRoundTimeoutMs,
      candidateTimeoutMs: config.globalEvalCandidateTimeoutMs,
      waitTimeoutMs: config.globalEvalWaitTimeoutMs,
    });
  }
  return clamp({
    roundTimeoutMs: await clusterSettings.getNumber(
      'global_eval_round_timeout_ms',
      config.globalEvalRoundTimeoutMs,
    ),
    candidateTimeoutMs: await clusterSettings.getNumber(
      'global_eval_candidate_timeout_ms',
      config.globalEvalCandidateTimeoutMs,
    ),
    waitTimeoutMs: await clusterSettings.getNumber(
      'global_eval_wait_timeout_ms',
      config.globalEvalWaitTimeoutMs,
    ),
  });
}

/**
 * Pick the platform labels for the round job by probing the fleet for an
 * init-runner, mirroring how the per-workflow dispatch picks its build target.
 * Falls back to linux/x64 when nothing is registered.
 *
 * An init-runner new enough to understand the round is preferred over one that
 * is not, so a fleet mid-upgrade targets the platform of an agent that can
 * actually decide the round rather than the first one indexed.
 */
function chooseRoundTarget(agentRegistry?: GlobalEvalAgentRegistry): {
  targetPlatform: string;
  targetArch: string;
} {
  if (!agentRegistry) return { ...FALLBACK_TARGET };
  const available = agentRegistry.findAvailable([INIT_RUNNER_ROLE_LABEL]);
  const first =
    available.find((agent) => agentVersionAtLeast(agent.version, MIN_GLOBAL_EVAL_AGENT_VERSION)) ??
    available[0];
  if (!first) return { ...FALLBACK_TARGET };
  return { targetPlatform: first.platform, targetArch: first.arch };
}

/**
 * Why a fleet cannot decide a round, or `null` when it might.
 *
 * Only ONE state is refused: every registered init-runner reports a version, and
 * every one of them is below the minimum. Everything else returns `null`.
 *
 * An empty fleet is not refused — nothing is registered yet, an agent may
 * register a second from now, and the queue's own unroutable handling already
 * covers a round nobody picks up.
 *
 * A fleet containing even ONE agent whose version cannot be read is not refused
 * either, and the bar is deliberately that strict rather than "all unknown".
 * Refusing suppresses every global workflow for the delivery — the exact damage
 * this function exists to prevent — so it must rest on proof, not on ignorance
 * about part of the fleet. Getting it wrong in the other direction merely costs
 * a slow failure with a less useful message.
 *
 * Refusing here rather than at dispatch is deliberate. A too-old fleet does not
 * clear within a retry, so dispatching would spend two full wait ceilings of
 * inline webhook latency to reach the same verdict — and reach it with a
 * timeout message that says nothing about agent versions.
 */
export function unsupportedFleetReason(agentRegistry?: GlobalEvalAgentRegistry): string | null {
  if (!agentRegistry) return null;
  const available = agentRegistry.findAvailable([INIT_RUNNER_ROLE_LABEL]);
  if (available.length === 0) return null;
  const versions = available.map((agent) => agent.version);
  if (versions.some((v) => typeof v !== 'string' || parseVersionBase(v) === null)) return null;
  if (versions.some((v) => agentVersionAtLeast(v, MIN_GLOBAL_EVAL_AGENT_VERSION))) return null;
  const seen = [...new Set(versions as string[])].sort();
  return (
    `every registered init-runner agent is older than ${MIN_GLOBAL_EVAL_AGENT_VERSION}, ` +
    `which is the first version that can evaluate a global workflow's filter or ` +
    `generators (versions seen: ${seen.join(', ')}). Upgrade your agents to at least ` +
    `${MIN_GLOBAL_EVAL_AGENT_VERSION} — an orchestrator upgraded ahead of its agents ` +
    'suppresses every global workflow that declares a filter or a dynamic job'
  );
}

/**
 * Reduce one candidate to the three fields the agent's round runner reads.
 *
 * `sourceFile` prefers the workflow's own lock entry over the registration's
 * recorded path, matching how the global dispatch path resolves `source`.
 */
function toWireCandidate(candidate: GlobalEvalCandidate): GlobalEvalWireCandidate {
  const { reg, lockEntry } = candidate;
  return {
    workflowName: lockEntry.name,
    sourceFile: lockEntry.source?.file ?? reg.lockEntry.source?.file ?? reg.sourceFile ?? '',
    hasFilter: lockEntry.hasFilter === true,
  };
}

/** Build the single round job for one group of candidates. */
function buildRoundJobInput(args: {
  info: WebhookInfo;
  deps: GlobalEvalRoundDeps;
  event: SimulatedEvent;
  group: readonly GlobalEvalCandidate[];
  repoIdentifier: string;
  ref: string;
  dispatchBundle: ProviderBundle;
  dispatchCredentials: Record<string, unknown>;
  budgets: RoundBudgets;
  target: { targetPlatform: string; targetArch: string };
  /**
   * Id for this attempt's queue row. Minted by the caller, which owns the retry
   * loop and therefore has to remember the last attempt's id: that is the id an
   * errored run row is written under when every attempt has failed.
   *
   * Not a real run's id — the round decides whether any run exists at all, so
   * there is no `execution_runs` row to attribute it to up front.
   * `dispatch_queue.run_id` is a plain NOT NULL text column with no foreign key,
   * so a distinct id here keeps the queue row and its logs correlatable without
   * inventing a run.
   */
  runId: string;
}): QueuedJobInput {
  const { info, event, group, repoIdentifier, ref, dispatchBundle, dispatchCredentials } = args;
  const reg = group[0].reg;
  const workflowSha = reg.commitSha ?? '';
  // The WORKFLOW repo's clone URL must come from the bundle that owns the
  // workflow's routing key, not from the inbound event's. A local-source event
  // triggering a GitHub-authored global otherwise asks the file:// builder for a
  // GitHub repo and produces an unclonable URL. Mirrors the cross-source path in
  // process-webhook.ts (`regBundle`, "registration's bundle, NOT inbound
  // generic"), and matches how `workflowRoutingKey` below already resolves auth.
  const regBundle = args.deps.providerRegistry.getByRoutingKey(reg.routingKey);
  const workflowRepoUrl = regBundle?.repoUrlBuilder?.buildCloneUrl(reg.repoIdentifier) ?? '';
  return {
    runId: args.runId,
    workflowName: `${ROUND_JOB_PREFIX}${reg.repoIdentifier}`,
    jobName: `${ROUND_JOB_PREFIX}${reg.repoIdentifier}__${workflowSha.slice(0, 12)}`,
    runsOnLabels: [
      INIT_RUNNER_ROLE_LABEL,
      `kici:os:${args.target.targetPlatform}`,
      `kici:arch:${args.target.targetArch}`,
    ],
    jobConfig: {
      globalEvalRound: true,
      candidates: group.map(toWireCandidate),
      event,
      // The agent takes the same dual-checkout path the global execution jobs
      // take, which is keyed on this flag plus the workflow-repo quartet.
      isGlobalWorkflow: true,
      workflowRepoUrl,
      // Empty so the agent's clone falls through to the default-branch path;
      // `workflowSha` drives the post-clone verification, exactly as the global
      // execution dispatch does.
      workflowRef: '',
      workflowSha,
      workflowRepoIdentifier: reg.repoIdentifier,
      // Cross-provider auth plumbing: when the registration's routing key
      // differs from the inbound one, the dispatcher resolves the workflow-repo
      // bundle by this key and mints `workflowAuth` independently of
      // `sourceAuth`.
      workflowRoutingKey: reg.routingKey,
      workflowProviderContext: reg.providerContext,
      roundTimeoutMs: args.budgets.roundTimeoutMs,
      candidateTimeoutMs: args.budgets.candidateTimeoutMs,
    },
    repoUrl: dispatchBundle.repoUrlBuilder?.buildCloneUrl(repoIdentifier) ?? '',
    ref: event.sourceBranch ?? event.targetBranch,
    sha: ref,
    deliveryId: info.deliveryId,
    provider: info.provider,
    providerContext: dispatchCredentials,
    routingKey: info.routingKey,
    requestId: getRequestContext().requestId,
  };
}

/**
 * Narrow one wire verdict into a value the dispatch path can trust.
 *
 * The round-result schema proves only "array of objects with string keys" — its
 * `jobs` entries are a deliberate unvalidated pass-through of `LockJob`, whose
 * single source of truth is a TypeScript interface with no Zod mirror. So every
 * field is re-checked here rather than dereferenced: `run` is compared, not
 * coerced, and a generated job missing a usable `name` makes the whole candidate
 * indeterminate rather than being dropped silently. Fail-closed is the right
 * direction — a generator whose output we cannot read is a generator whose
 * verdict we cannot act on, and half-dispatching its jobs would be worse than
 * reporting that we could not decide.
 */
function narrowVerdict(raw: unknown, workflowName: string): GlobalEvalCandidateResult {
  const v = (raw ?? {}) as Partial<GlobalEvalCandidateResult> & { jobs?: unknown };
  const base: GlobalEvalCandidateResult = {
    workflowName,
    run: v.run === true,
    ...(v.indeterminate === true ? { indeterminate: true } : {}),
    ...(typeof v.reason === 'string' ? { reason: v.reason } : {}),
  };
  if (v.jobs === undefined) return base;
  if (!Array.isArray(v.jobs)) {
    return {
      workflowName,
      run: false,
      indeterminate: true,
      reason: 'The global eval round returned a non-array job list for this workflow',
    };
  }
  const named = v.jobs.filter(
    (job): job is LockJob =>
      typeof job === 'object' &&
      job !== null &&
      typeof (job as { name?: unknown }).name === 'string' &&
      (job as { name: string }).name.length > 0,
  );
  if (named.length !== v.jobs.length) {
    return {
      workflowName,
      run: false,
      indeterminate: true,
      reason:
        `The global eval round returned ${v.jobs.length - named.length} generated job(s) ` +
        'without a usable name',
    };
  }
  return { ...base, jobs: named };
}

/**
 * Fold a round result into the per-candidate map.
 *
 * The agent keys its verdicts by workflow name, so they are matched back to the
 * group by name; a candidate the round never reported on is recorded as
 * indeterminate rather than silently dropped, which would read as a clean
 * "does not apply".
 */
function collectGroupResults(
  group: readonly GlobalEvalCandidate[],
  result: GlobalEvalRoundResult,
  into: Map<string, GlobalEvalCandidateResult>,
): void {
  const list: unknown[] = Array.isArray(result?.candidates) ? result.candidates : [];
  const byName = new Map<string, unknown>();
  for (const verdict of list) {
    const name = (verdict as { workflowName?: unknown } | null)?.workflowName;
    if (typeof name === 'string') byName.set(name, verdict);
  }
  for (const candidate of group) {
    const name = candidate.lockEntry.name;
    const verdict = byName.get(name);
    into.set(
      candidateKey(candidate),
      verdict === undefined
        ? {
            workflowName: name,
            run: false,
            indeterminate: true,
            reason: 'The global eval round returned no verdict for this workflow',
          }
        : narrowVerdict(verdict, name),
    );
  }
}

/** Record every candidate in a group as indeterminate with one shared reason. */
function markGroupIndeterminate(
  group: readonly GlobalEvalCandidate[],
  reason: string,
  into: Map<string, GlobalEvalCandidateResult>,
): void {
  for (const candidate of group) {
    into.set(candidateKey(candidate), {
      workflowName: candidate.lockEntry.name,
      run: false,
      indeterminate: true,
      reason,
    });
  }
}

/**
 * Await one dispatched round under an orchestrator-side ceiling.
 *
 * The bound is applied by rejecting the tracker entry rather than by racing the
 * promise: `PendingTracker.reject` both settles the awaited promise AND deletes
 * the entry, so a round nobody will ever report on cannot accumulate in the
 * tracker map. Racing would settle the await and leave the entry — and its
 * closure — pending for the life of the process.
 *
 * Without this ceiling the wait is unbounded in a way that loses the delivery,
 * not merely delays it: webhook processing awaits the round inline, so a job
 * that merely queues (an empty init-runner fleet is enough — a `queued`
 * dispatch counts as accepted) blocks `processWebhook` forever, which means no
 * `event_log` row is ever written, while `dedup.claim` has already recorded the
 * delivery id so the provider's redelivery is dropped as a duplicate.
 *
 * A ceiling breach throws, so the caller records the whole group indeterminate
 * and the delivery completes with a row that explains it.
 *
 * A breach also CANCELS the queue row. Giving up on the wait does not stop the
 * job: it stays queued, and later runs a full dual checkout plus author code
 * with nobody left to receive the verdict, while holding an init-runner slot
 * that the retry's own round job then queues behind. Under load that is a
 * positive feedback loop — each breach makes the next one likelier — so the
 * wait bound and the queue row have to be abandoned together.
 */
async function awaitRoundResult(
  deps: GlobalEvalRoundDeps,
  jobId: string,
  waitTimeoutMs: number,
): Promise<GlobalEvalRoundResult> {
  const settled = deps.pendingGlobalEvals.track(jobId);
  let breached = false;
  const timer = setTimeout(() => {
    breached = true;
    deps.pendingGlobalEvals.reject(
      jobId,
      new Error(
        `Global eval round did not settle within ${waitTimeoutMs}ms ` +
          '(the round job never reached a terminal state)',
      ),
    );
  }, waitTimeoutMs);
  // Never hold the process open for a round that is already over.
  timer.unref?.();
  try {
    return await settled;
  } finally {
    clearTimeout(timer);
    // Awaited rather than fired and forgotten: it is one indexed UPDATE, and
    // leaving it unawaited would let the delivery finish while the orphan is
    // still queued — the exact window the cancel exists to close. A cancel that
    // fails must not replace the timeout the caller is about to report.
    if (breached && deps.dispatcher.cancelQueuedJob) {
      try {
        await deps.dispatcher.cancelQueuedJob(
          jobId,
          `Global eval round abandoned after ${waitTimeoutMs}ms — nothing is waiting for its verdict`,
        );
      } catch (err) {
        logger.warn('Failed to cancel an abandoned global eval round job', {
          jobId,
          error: toErrorMessage(err),
        });
      }
    }
  }
}

/**
 * A round the agent completed but which decided nothing.
 *
 * The agent's round runner **never throws on its own budget breach** — it
 * returns `success` with every candidate padded `indeterminate`. So the most
 * likely failure mode in production arrives as a successful round, and treating
 * it as one would mean no retry, no errored run, and no check: the exact
 * outcome this module exists to prevent. This is also what
 * {@link isCacheableRoundResult} already refuses to store, on the same stated
 * grounds — the cache and the surfacing must agree about what counts as a
 * failure.
 *
 * Scoped to ALL candidates, never some: a round that decided even one candidate
 * is a real round, and its decided workflows must still dispatch.
 */
function roundDecidedNothing(verdicts: Map<string, GlobalEvalCandidateResult>): boolean {
  const collected = [...verdicts.values()];
  return collected.length > 0 && collected.every((verdict) => verdict.indeterminate === true);
}

/**
 * Cap on the joined reason string a decided-nothing round reports.
 *
 * The reasons are authored by an agent running author code, so their combined
 * length is unbounded — and this string travels verbatim into the commit
 * check's `output.summary`, which GitHub caps at 65535 characters. An overflow
 * is rejected with a 422 that the best-effort post swallows, so the check
 * disappears in exactly the case it exists for. Realistic reasons are one short
 * sentence each; this bound makes that structural instead of lucky.
 */
export const MAX_ROUND_REASON_CHARS = 4_000;

/** Appended to a cut string so a summary never silently stops mid-sentence. */
const TRUNCATION_MARKER = '… (truncated)';

/**
 * Truncate `text` to at most `max` UTF-16 code units, marking that it was cut.
 *
 * Two edges the naive slice gets wrong, both of which matter because the result
 * is posted to an API with a hard character limit:
 *
 * - A `max` smaller than the marker would make `max - marker.length` negative,
 *   and appending the marker to an empty slice then returns a string LONGER
 *   than `max`. Such a `max` cannot carry both content and a marker, so the
 *   marker itself is truncated instead.
 * - Slicing at an arbitrary index can cut a surrogate pair in half, leaving a
 *   lone surrogate that is not valid text. The cut backs off by one unit when
 *   it lands between the halves of a pair.
 */
export function truncateReasonText(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  if (max <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, max);
  let cut = max - TRUNCATION_MARKER.length;
  // A high surrogate at the last kept position has its pair at `cut`, so the
  // slice would end on half a code point.
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return text.slice(0, cut) + TRUNCATION_MARKER;
}

/** The distinct reasons a round gave, for the error a failed or partial round reports. */
function distinctReasons(verdicts: Iterable<GlobalEvalCandidateResult>): string {
  const reasons = new Set<string>();
  for (const verdict of verdicts) {
    if (typeof verdict.reason === 'string' && verdict.reason.length > 0)
      reasons.add(verdict.reason);
  }
  if (reasons.size === 0) return 'no reason reported';
  return truncateReasonText([...reasons].join('; '), MAX_ROUND_REASON_CHARS);
}

/** Jobs the round's generators produced across one group's verdicts. */
function generatedJobCount(verdicts: Map<string, GlobalEvalCandidateResult>): number {
  let total = 0;
  for (const verdict of verdicts.values()) total += verdict.jobs?.length ?? 0;
  return total;
}

/**
 * Read one cached round if the cache can answer for this key.
 *
 * Counts all THREE lookup outcomes. A key the round input could not produce
 * skips the cache entirely, so it is neither a hit nor a miss — leaving it
 * uncounted would drop it from the denominator and make the hit rate read
 * higher than it is.
 */
function readRoundCache(
  cache: GlobalEvalRoundCache | undefined,
  cacheKey: string | null,
): GlobalEvalRoundResult | undefined {
  if (!cache) return undefined;
  if (!cacheKey) {
    globalEvalCacheLookupsTotal.add(1, { result: GlobalEvalCacheLookupResult.Unkeyable });
    return undefined;
  }
  const hit = cache.get(cacheKey);
  globalEvalCacheLookupsTotal.add(1, {
    result: hit ? GlobalEvalCacheLookupResult.Hit : GlobalEvalCacheLookupResult.Miss,
  });
  return hit;
}

/** Dispatch one group's round job and await its verdicts. */
async function runOneRound(
  args: GlobalEvalRoundArgs,
  group: readonly GlobalEvalCandidate[],
  budgets: RoundBudgets,
  runId: string,
): Promise<Map<string, GlobalEvalCandidateResult>> {
  const { deps, info, ref } = args;
  const reg = group[0].reg;
  const cache = deps.globalEvalCache;

  const input = buildRoundJobInput({
    info,
    deps,
    event: args.event,
    group,
    repoIdentifier: args.repoIdentifier,
    ref,
    dispatchBundle: args.dispatchBundle,
    dispatchCredentials: args.dispatchCredentials,
    budgets,
    target: chooseRoundTarget(deps.agentRegistry),
    runId,
  });

  // Keyed off the job input the agent actually receives, not off a parallel
  // description of it: the candidate list and the event travelling in the key
  // are the same objects travelling in the round, so the two cannot drift.
  const cacheKey = cache
    ? globalEvalRoundCacheKey({
        workflowRepoIdentifier: reg.repoIdentifier,
        workflowSha: reg.commitSha ?? '',
        workflowRoutingKey: reg.routingKey,
        sourceSha: ref,
        candidates: input.jobConfig.candidates,
        event: input.jobConfig.event,
      })
    : null;
  const hit = readRoundCache(cache, cacheKey);
  if (hit) {
    logger.info('Global eval round served from cache', {
      deliveryId: info.deliveryId,
      workflowRepo: reg.repoIdentifier,
      sourceSha: ref,
      candidateCount: group.length,
    });
    // A stored result decided every candidate of this exact group — the cache
    // write below gates on that, and the key covers the candidate list — so a
    // hit can never be a decided-nothing round.
    const cached = new Map<string, GlobalEvalCandidateResult>();
    collectGroupResults(group, hit, cached);
    // Recorded for a served round too: the sample describes what the round
    // decided, not how long it took, and omitting it would make the panel's
    // "once per settled round, including zero" claim false for every hit.
    globalEvalJobsGenerated.record(generatedJobCount(cached));
    return cached;
  }

  // Timed from here, so a cache hit — which dispatches nothing — records no
  // duration at all rather than a near-zero sample that would drag the
  // distribution toward a latency the round never had.
  const startedAt = Date.now();
  try {
    const verdicts = await dispatchRoundAndCollect(args, group, budgets, input, {
      cache,
      cacheKey,
    });
    globalEvalRoundDurationSeconds.record((Date.now() - startedAt) / 1000, {
      result: GlobalEvalRoundResultLabel.Success,
    });
    globalEvalJobsGenerated.record(generatedJobCount(verdicts));
    return verdicts;
  } catch (err) {
    globalEvalRoundDurationSeconds.record((Date.now() - startedAt) / 1000, {
      result: GlobalEvalRoundResultLabel.Error,
    });
    throw err;
  }
}

/**
 * Dispatch the round job, await its verdicts, and store a cacheable result.
 *
 * Split from {@link runOneRound} so the duration around it measures exactly the
 * dispatched round — everything before it is a cache read, and everything after
 * it is bookkeeping.
 */
async function dispatchRoundAndCollect(
  args: GlobalEvalRoundArgs,
  group: readonly GlobalEvalCandidate[],
  budgets: RoundBudgets,
  input: QueuedJobInput,
  cacheSlot: { cache?: GlobalEvalRoundCache; cacheKey: string | null },
): Promise<Map<string, GlobalEvalCandidateResult>> {
  const { deps, info } = args;
  const reg = group[0].reg;
  const { cache, cacheKey } = cacheSlot;

  logger.info('Dispatching global eval round', {
    deliveryId: info.deliveryId,
    workflowRepo: reg.repoIdentifier,
    workflowSha: reg.commitSha ?? '',
    sourceRepo: args.repoIdentifier,
    candidateCount: group.length,
    roundTimeoutMs: budgets.roundTimeoutMs,
    candidateTimeoutMs: budgets.candidateTimeoutMs,
  });

  const dispatchResult = await deps.dispatcher.dispatch(input);
  if (!ACCEPTED_DISPATCH_STATUSES.has(dispatchResult.status)) {
    throw new Error(`Global eval round dispatch rejected: ${dispatchResult.status}`);
  }
  const result = await awaitRoundResult(deps, dispatchResult.jobId, budgets.waitTimeoutMs);

  const verdicts = new Map<string, GlobalEvalCandidateResult>();
  collectGroupResults(group, result, verdicts);

  // Gated on the verdicts THIS GROUP actually got, not on the raw wire result:
  // a round that left any candidate undecided is a failure that happened to
  // report success (an agent-side budget breach reports exactly that shape).
  // Storing it would make a redelivery — the moment an operator is retrying —
  // replay the failure instead of running again, and the cache read sits ahead
  // of the retry below, so a stored breach would short-circuit it too.
  if (cache && cacheKey && isCacheableRoundResult({ candidates: [...verdicts.values()] })) {
    cache.set(cacheKey, result);
  }

  if (roundDecidedNothing(verdicts)) {
    throw new Error(
      `Global eval round decided no candidate (${distinctReasons(verdicts.values())})`,
    );
  }
  return verdicts;
}

/**
 * Attempts allowed per group.
 *
 * Two, not more: the failures a retry actually recovers are transient — the
 * agent holding the round died, its connection dropped mid-round, the queue
 * rejected a dispatch during a restart — and those clear on the next try or not
 * at all. A round is also expensive (a dual checkout plus author code), and the
 * whole delivery waits on it, so each further attempt costs another full wait
 * ceiling of webhook latency.
 */
const ROUND_MAX_ATTEMPTS = 2;

/**
 * What a group's round produced, once its retries are exhausted.
 *
 * The success arm carries `runId` and `attempts` too: a round can succeed
 * overall and still leave individual candidates undecided, and that partial
 * outcome is recorded under the same round-job id as a total failure would be.
 */
type GroupRoundOutcome =
  | { ok: true; verdicts: Map<string, GlobalEvalCandidateResult>; attempts: number; runId: string }
  | { ok: false; error: string; attempts: number; runId: string };

/**
 * Run one group's round, retrying a failed attempt up to
 * {@link ROUND_MAX_ATTEMPTS} times.
 *
 * Each attempt mints its own run id so two queue rows never share one, and the
 * last one is reported back: it is the id the caller writes the errored run row
 * under, which keeps that row correlatable with the queue row and the logs of
 * the attempt that actually failed last.
 */
async function runGroupRound(
  args: GlobalEvalRoundArgs,
  group: readonly GlobalEvalCandidate[],
  budgets: RoundBudgets,
): Promise<GroupRoundOutcome> {
  let lastError = 'Global eval round did not run';
  let lastRunId = '';
  for (let attempt = 1; attempt <= ROUND_MAX_ATTEMPTS; attempt++) {
    lastRunId = randomUUID();
    try {
      return {
        ok: true,
        verdicts: await runOneRound(args, group, budgets, lastRunId),
        attempts: attempt,
        runId: lastRunId,
      };
    } catch (err) {
      lastError = toErrorMessage(err);
      if (attempt < ROUND_MAX_ATTEMPTS) {
        logger.warn('Global eval round attempt failed, retrying', {
          deliveryId: args.info.deliveryId,
          workflowRepo: group[0].reg.repoIdentifier,
          runId: lastRunId,
          attempt,
          maxAttempts: ROUND_MAX_ATTEMPTS,
          error: lastError,
        });
      }
    }
  }
  return { ok: false, error: lastError, attempts: ROUND_MAX_ATTEMPTS, runId: lastRunId };
}

/**
 * One round that produced no verdicts after every attempt, described well enough
 * for the caller to record it.
 *
 * There is exactly one of these per failed round — never one per candidate. The
 * round exists to collapse N candidate workflows into a single pre-run job, so
 * fanning its failure back out into N run rows and N checks would undo the fan-out
 * reduction the whole design is for. `workflowNames` is what makes the single
 * record honest: it names every workflow the failure suppressed.
 */
export interface GlobalEvalRoundFailure {
  /** The last attempt's round-job run id — what an errored run row is written under. */
  runId: string;
  /** Repo the suppressed workflows are authored in. */
  workflowRepoIdentifier: string;
  /** Every candidate workflow this round suppressed. */
  workflowNames: string[];
  /** The last attempt's error. */
  error: string;
  /** How many attempts were made before giving up. `0` ⇒ never dispatched. */
  attempts: number;
  /**
   * True when the round itself completed and decided some candidates, leaving
   * only {@link workflowNames} undecided.
   *
   * Recorded as its own record rather than folded into a total failure because
   * the two read differently to an author: a total failure means nothing from
   * this repo ran, a partial one means their workflow specifically could not be
   * decided while its neighbours ran fine. Without it, whether a broken filter
   * is visible at all depends on how many unrelated global workflows happen to
   * share a workflow repo — a per-candidate budget breach in a group of one
   * produces a check, and the identical fault in a group of two produces
   * nothing.
   */
  partial?: boolean;
}

/**
 * One record for a round that completed but left some of its candidates
 * undecided, or `null` when every candidate got a verdict.
 *
 * A round that decided NOTHING never reaches here: `roundDecidedNothing` throws
 * inside the attempt, so it arrives as a total failure with a retry behind it.
 * Retrying is exactly why a partial cannot take that path — the round's decided
 * candidates are already dispatching, and re-running them would double-dispatch.
 */
function partialFailure(
  group: readonly GlobalEvalCandidate[],
  outcome: Extract<GroupRoundOutcome, { ok: true }>,
): GlobalEvalRoundFailure | null {
  const undecided = [...outcome.verdicts.values()].filter(
    (verdict) => verdict.indeterminate === true,
  );
  if (undecided.length === 0) return null;
  return {
    runId: outcome.runId,
    workflowRepoIdentifier: group[0].reg.repoIdentifier,
    workflowNames: undecided.map((verdict) => verdict.workflowName),
    error: distinctReasons(undecided),
    attempts: outcome.attempts,
    partial: true,
  };
}

/** Every candidate's verdict, plus the rounds that produced none. */
export interface GlobalEvalRoundsOutcome {
  /** One verdict per candidate, keyed by {@link candidateKey}. */
  verdicts: Map<string, GlobalEvalCandidateResult>;
  /** One entry per round that failed outright — never one per candidate. */
  failures: GlobalEvalRoundFailure[];
}

/**
 * Run every eval round the candidate set needs and return one verdict per
 * candidate, plus one failure record per round that produced none.
 *
 * Rounds run one group at a time: a group is one dual checkout on one agent, and
 * a push touching several workflow repos is the uncommon case. A group whose
 * round fails marks only its own candidates indeterminate — one unreachable
 * workflow repo must not suppress the workflows living in another.
 *
 * The failures are returned rather than recorded here: this module owns the
 * partition, the grouping, and the dispatch-and-await, and has neither a
 * database handle nor the inbound provider bundle a commit check must be posted
 * through.
 */
export async function runGlobalEvalRounds(
  args: GlobalEvalRoundArgs,
): Promise<GlobalEvalRoundsOutcome> {
  const verdicts = new Map<string, GlobalEvalCandidateResult>();
  const failures: GlobalEvalRoundFailure[] = [];
  if (args.candidates.length === 0) return { verdicts, failures };

  globalEvalCandidatesTotal.add(args.candidates.length);

  const budgets = await resolveBudgets(args.deps, args.config);
  const groups = groupCandidates(args.candidates);

  // Checked once for the whole delivery rather than per group: the fleet is one
  // fleet, and the answer cannot differ between two workflow repos.
  const unsupported = unsupportedFleetReason(args.deps.agentRegistry);

  for (const group of groups.values()) {
    const outcome: GroupRoundOutcome = unsupported
      ? { ok: false, error: unsupported, attempts: 0, runId: randomUUID() }
      : await runGroupRound(args, group, budgets);
    if (outcome.ok) {
      for (const [key, verdict] of outcome.verdicts) verdicts.set(key, verdict);
      const partial = partialFailure(group, outcome);
      if (partial) {
        logger.warn('Global eval round left some candidates undecided', {
          deliveryId: args.info.deliveryId,
          workflowRepo: group[0].reg.repoIdentifier,
          candidateCount: group.length,
          undecidedCount: partial.workflowNames.length,
          error: partial.error,
        });
        failures.push(partial);
      }
      continue;
    }
    // `attempts: 0` is the one outcome that never reached an agent, so it reads
    // as "not attempted" everywhere it surfaces — including the commit check,
    // where "failed" would send an author looking for a job that never ran.
    const failureReason =
      outcome.attempts === 0
        ? `Global eval round not attempted: ${outcome.error}`
        : `Global eval round failed: ${outcome.error}`;
    logger.error('Global eval round failed', {
      deliveryId: args.info.deliveryId,
      workflowRepo: group[0].reg.repoIdentifier,
      candidateCount: group.length,
      attempts: outcome.attempts,
      error: outcome.error,
    });
    markGroupIndeterminate(group, failureReason, verdicts);
    failures.push({
      runId: outcome.runId,
      workflowRepoIdentifier: group[0].reg.repoIdentifier,
      workflowNames: group.map((candidate) => candidate.lockEntry.name),
      error: outcome.error,
      attempts: outcome.attempts,
    });
  }

  recordVerdictOutcomes(verdicts);
  return { verdicts, failures };
}

/**
 * Meter candidates a round never got to decide on.
 *
 * The caller's fail-closed paths — no pending-eval tracker, so a round could
 * never settle — return before {@link runGlobalEvalRounds} is reached, and they
 * suppress EVERY global workflow for that delivery. That is this subsystem's
 * most severe outcome, and without this call it appeared in none of its
 * metrics: one `logger.warn` was the whole record.
 *
 * Counted as `indeterminate` because that is exactly what happened — nothing
 * evaluated the workflows — which also keeps `candidates` equal to the sum of
 * the verdicts on every path.
 */
export function recordUnrunCandidates(count: number): void {
  if (count <= 0) return;
  globalEvalCandidatesTotal.add(count);
  globalEvalVerdictsTotal.add(count, { outcome: GlobalEvalVerdictOutcome.Indeterminate });
}

/**
 * Meter what the round decided, one sample per candidate.
 *
 * The three outcomes are kept apart because they mean different things to a
 * workflow author: `filtered` is a predicate that ran and said no, while
 * `indeterminate` is a question nobody answered. Folding them together would
 * make a fleet-wide round failure look like a wave of deliberate exclusions.
 */
function recordVerdictOutcomes(verdicts: Map<string, GlobalEvalCandidateResult>): void {
  for (const verdict of verdicts.values()) {
    const outcome =
      verdict.indeterminate === true
        ? GlobalEvalVerdictOutcome.Indeterminate
        : verdict.run === true
          ? GlobalEvalVerdictOutcome.Run
          : GlobalEvalVerdictOutcome.Filtered;
    globalEvalVerdictsTotal.add(1, { outcome });
  }
}
