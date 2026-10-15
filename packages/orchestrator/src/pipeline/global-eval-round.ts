/**
 * Tier-2 global eval round — orchestrator side.
 *
 * The orchestrator never runs author code, so global candidates with a `filter`
 * or `DynamicJobFn` generators go to ONE pre-run job per
 * (event × workflow repo × registered SHA). That job checks out both repos once,
 * runs each candidate's filter then its generators, and reports a verdict per
 * candidate.
 *
 * The round precedes any run row by design: it decides which global workflows
 * produce a run at all.
 *
 * This module owns the partition, the grouping, and the dispatch-and-await; the
 * caller acts on the verdicts.
 */

import { randomUUID } from 'node:crypto';
import { createLogger, getRequestContext, toErrorMessage } from '@kici-dev/shared';
import type {
  GlobalEvalCandidateResult,
  GlobalEvalRoundResult,
  LockJob,
  LockJobOrFactory,
  LockWorkflow,
  SimulatedEvent,
  WorkflowDecision,
} from '@kici-dev/engine';
import {
  GLOBAL_EVAL_SKIPS_RESULT_AWARE_LABEL,
  INIT_RUNNER_ROLE_LABEL,
  isLockDynamicJobFn,
} from '@kici-dev/engine';
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
   * The trigger-match decision, carried so the verdict can be appended to its
   * trace. Optional: only the caller that explains an exclusion reads it.
   */
  decision?: WorkflowDecision;
}

/**
 * The per-candidate payload the agent's round runner expects, mirroring
 * `GlobalEvalCandidate` in `packages/agent/src/execution/global-eval-runner.ts`.
 * Its own type because the orchestrator's candidate carries the whole
 * registration, of which the agent needs three fields.
 */
interface GlobalEvalWireCandidate {
  workflowName: string;
  sourceFile: string;
  hasFilter: boolean;
  /** The `paths` lists the orchestrator could only match conservatively; omitted when none. */
  deferredPaths?: string[][];
}

/**
 * Stable identity for one candidate across a round's results. The workflow name
 * is appended so a malformed registration with a blank id still separates two
 * workflows.
 */
export function candidateKey(candidate: GlobalEvalCandidate): string {
  return [candidate.reg.id, candidate.lockEntry.name].join(KEY_SEPARATOR);
}

/**
 * True for a `DynamicJobFn` entry the pre-run round runs: a generator with no
 * upstream `needs`. A result-aware generator (`resultAware`, or any `needs`)
 * reads upstream outputs that do not exist yet, so it runs on the deferred path.
 */
export function isRoundGenerator(job: LockJobOrFactory): boolean {
  return (
    isLockDynamicJobFn(job) && job.resultAware !== true && !(job.needs && job.needs.length > 0)
  );
}

/** True for a `DynamicJobFn` entry that runs on the deferred path, never in the round. */
export function isDeferredGenerator(job: LockJobOrFactory): boolean {
  return isLockDynamicJobFn(job) && !isRoundGenerator(job);
}

/** True when the workflow carries at least one generator the round runs. */
function hasRoundGenerator(lockEntry: LockWorkflow): boolean {
  return (lockEntry.jobs ?? []).some(isRoundGenerator);
}

/** True when the workflow carries at least one generator the round must NOT run. */
export function hasDeferredGenerator(lockEntry: LockWorkflow): boolean {
  return (lockEntry.jobs ?? []).some(isDeferredGenerator);
}

/**
 * Split matched global candidates into immediate dispatch and eval-round.
 *
 * A candidate needs the round when it declares a `filter`, carries a needs-free
 * `DynamicJobFn` (only the agent may run either), or matched with deferred
 * `paths` (only the agent's clone holds the diff). Static jobs and result-aware
 * generators dispatch as declared; a round would add a dispatch for nothing.
 */
export function partitionCandidates(candidates: readonly GlobalEvalCandidate[]): {
  immediate: GlobalEvalCandidate[];
  needsRound: GlobalEvalCandidate[];
} {
  const immediate: GlobalEvalCandidate[] = [];
  const needsRound: GlobalEvalCandidate[] = [];
  for (const candidate of candidates) {
    // fails-when: a candidate whose only generators are result-aware is sent to the round
    // breaks-if-wrong: a candidate with a needs-free generator, a filter or deferred paths must still need the round
    if (
      candidate.lockEntry.hasFilter === true ||
      hasRoundGenerator(candidate.lockEntry) ||
      (candidate.decision?.deferredPaths?.length ?? 0) > 0
    ) {
      needsRound.push(candidate);
    } else {
      immediate.push(candidate);
    }
  }
  return { immediate, needsRound };
}

/**
 * Group by workflow repo, routing key, and registered SHA. Repo and SHA pin the
 * tree the round checks out; the routing key pins the provider bundle that mints
 * clone credentials, so two providers owning one repo path stay separate.
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
  /** Drop a still-queued round job nobody waits for. Optional for test doubles. */
  cancelQueuedJob?(jobId: string, reason: string): Promise<void>;
}

/**
 * Resolves the bundle owning a routing key: the workflow repo and the event's
 * source repo can live behind different providers.
 */
export interface GlobalEvalProviderRegistry {
  getByRoutingKey(routingKey: string): ProviderBundle | undefined;
}

/** Minimal agent-registry surface used to pick the round job's platform labels. */
export interface GlobalEvalAgentRegistry {
  findAvailable(
    labels: string[],
  ): Array<{ platform: string; arch: string; version?: string | null }>;
  /** Every registered agent, busy or idle. Optional so a test double can omit it. */
  getAllEntries?(): Iterable<{
    labels: ReadonlySet<string>;
    platform: string;
    arch: string;
    version: string | null;
  }>;
}

/**
 * First agent release whose job runner understands a `globalEvalRound`
 * dispatch. An older agent runs it through the standard executor, which fails
 * or succeeds without sending `globalEvalComplete`, so the round never settles.
 *
 * An orchestrator ahead of its fleet is a supported state, but this module must
 * recognise it: a global workflow that merely *contains* a generator routes
 * through the round, so its static jobs would stop running too.
 */
export const MIN_GLOBAL_EVAL_AGENT_VERSION = '0.5.0';

export interface GlobalEvalRoundDeps {
  dispatcher: GlobalEvalDispatcher;
  pendingGlobalEvals: PendingGlobalEvalTracker;
  /** Required: without it the round has no clone URL for the WORKFLOW repo. */
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
  /**
   * The source `dispatchBundle` and `dispatchCredentials` belong to, when a
   * cross-provider lock-file fallback made it a different source from
   * `info.routingKey`. Absent means the inbound source.
   */
  dispatchRoutingKey?: string;
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
   * How long this orchestrator waits for the round to settle. The budgets above
   * are agent-enforced and start only once the job runs, so neither bounds a
   * round the fleet never picked up.
   */
  waitTimeoutMs: number;
}

/**
 * Ratio a too-low wait ceiling is raised to: the shipped defaults pair a 120s
 * agent budget with a 240s ceiling.
 */
const WAIT_CEILING_MULTIPLIER = 2;

/**
 * Hard cap on a raised wait ceiling: the relay's admitted-pipeline
 * force-release window, imported from the platform client so the two cannot
 * drift. Neither round-budget input has an upper bound (the admin route checks
 * `min(1000)`, the env schema nothing), and a ceiling past the relay window buys
 * latency and no verdict.
 */
const MAX_RAISED_WAIT_CEILING_MS = ADMITTED_PIPELINE_LIFETIME_MS;

/**
 * Least ratio of wait ceiling to agent round budget that still works: the
 * ceiling must cover the budget PLUS the queue wait for a free init-runner. A
 * ratio, not a fixed margin, because queue wait scales with the round.
 *
 * Also closes a dead band: with `raised = min(round * 2, 300_000)` and a
 * fail-fast test of `raised <= round`, the `[150s, 300s)` band "succeeded" with
 * a ceiling that could never outlive the budget. The boundary now falls at
 * `round > 240s`.
 */
const MIN_WAIT_CEILING_RATIO = 1.25;

/**
 * Raise a wait ceiling that cannot outlive the agent's own round budget, or
 * every round that waited for a free agent fails.
 *
 * The admin route and CLI check the pair, but miss two cases: `cluster-settings
 * reset` nulls one knob while the other stays stored, and the
 * `KICI_GLOBAL_EVAL_{ROUND,WAIT}_TIMEOUT_MS` env pair has no cross-field
 * validation. This is the one place both EFFECTIVE values are known. It raises
 * rather than lowers because the agent enforces the round budget the job was
 * dispatched with.
 *
 * The raise is capped at {@link MAX_RAISED_WAIT_CEILING_MS}; when the cap cannot
 * clear {@link MIN_WAIT_CEILING_RATIO}, the configured ceiling is left alone so
 * the round fails fast and visibly. Both branches log at `error`: a standing
 * misconfiguration. The entry test uses the same ratio, not `wait > round`,
 * since a ceiling barely above the budget is the same defect.
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
 * Lower a per-candidate budget that can consume the whole round; otherwise the
 * first candidate uses it up, every sibling is padded indeterminate, and the
 * partly decided group is never retried.
 *
 * Lowered, not raised: the round budget is the outer bound the agent enforces,
 * and raising it would extend the inline wait on a per-candidate knob. The
 * divisor reuses `WAIT_CEILING_MULTIPLIER`: the shipped pairing is 20s under a
 * 120s round, so half the round is generous and never exceeds the operator's
 * value.
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
 * Read all three budgets per round so a change applies on the next push, not
 * the next restart. The cluster reader serves a short-lived snapshot, so this is
 * no per-round database round trip.
 */
async function resolveBudgets(
  deps: GlobalEvalRoundDeps,
  config: GlobalEvalRoundArgs['config'],
): Promise<RoundBudgets> {
  const { clusterSettings } = deps;
  // Both clamps run on the EFFECTIVE values (see clampWaitCeiling for why the
  // admin route alone is not enough).
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
 * The role and feature labels a round job requires. A round holding a
 * result-aware generator also requires the agent-feature label, so it runs (or
 * queues) only for an agent that skips such generators.
 */
function roundLabels(requiresResultAwareSkip: boolean): string[] {
  return requiresResultAwareSkip
    ? [INIT_RUNNER_ROLE_LABEL, GLOBAL_EVAL_SKIPS_RESULT_AWARE_LABEL]
    : [INIT_RUNNER_ROLE_LABEL];
}

/**
 * Pick the round job's platform labels by probing the fleet for an
 * init-runner (as the per-workflow dispatch picks its build target), preferring one new enough to decide the round (a fleet
 * mid-upgrade). A round needing the agent-feature label with no such agent idle
 * takes a busy one's platform so the queued round can still match it. Falls
 * back to linux/x64 only when no suitable agent is registered.
 */
function chooseRoundTarget(
  agentRegistry: GlobalEvalAgentRegistry | undefined,
  requiresResultAwareSkip: boolean,
): {
  targetPlatform: string;
  targetArch: string;
} {
  if (!agentRegistry) return { ...FALLBACK_TARGET };
  const available = agentRegistry.findAvailable(roundLabels(requiresResultAwareSkip));
  const first =
    available.find((agent) => agentVersionAtLeast(agent.version, MIN_GLOBAL_EVAL_AGENT_VERSION)) ??
    available[0];
  const chosen =
    first ?? (requiresResultAwareSkip ? registeredResultAwareRunner(agentRegistry) : undefined);
  // fails-when: a result-aware round targets linux/x64 while its only capable agent is a busy darwin/arm64 one
  if (!chosen) return { ...FALLBACK_TARGET };
  return { targetPlatform: chosen.platform, targetArch: chosen.arch };
}

/** A registered init-runner carrying the agent-feature label, busy or idle. */
function registeredResultAwareRunner(
  agentRegistry: GlobalEvalAgentRegistry,
): { platform: string; arch: string } | undefined {
  if (!agentRegistry.getAllEntries) return undefined;
  for (const agent of agentRegistry.getAllEntries()) {
    if (
      agent.labels.has(INIT_RUNNER_ROLE_LABEL) &&
      agent.labels.has(GLOBAL_EVAL_SKIPS_RESULT_AWARE_LABEL)
    ) {
      return { platform: agent.platform, arch: agent.arch };
    }
  }
  return undefined;
}

/**
 * Why a fleet cannot decide a round, or `null` when it might.
 *
 * Refuses only when every registered init-runner reports a readable version
 * below the minimum. An empty fleet is not refused (the queue's unroutable
 * handling covers it), nor is a fleet with even ONE unreadable version: refusing
 * suppresses every global workflow for the delivery, so it must rest on proof.
 *
 * Refusing before dispatch saves two full wait ceilings of inline webhook
 * latency and yields a message that names agent versions.
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
 * `sourceFile` prefers the workflow's own lock entry over the registration's
 * recorded path, matching how the global dispatch path resolves `source`.
 */
function toWireCandidate(candidate: GlobalEvalCandidate): GlobalEvalWireCandidate {
  const { reg, lockEntry } = candidate;
  return {
    workflowName: lockEntry.name,
    sourceFile: lockEntry.source?.file ?? reg.lockEntry.source?.file ?? reg.sourceFile ?? '',
    hasFilter: lockEntry.hasFilter === true,
    ...(candidate.decision?.deferredPaths?.length && {
      deferredPaths: candidate.decision.deferredPaths,
    }),
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
  /** The source `dispatchBundle` belongs to, when it is not the inbound one. */
  dispatchRoutingKey?: string;
  budgets: RoundBudgets;
  target: { targetPlatform: string; targetArch: string };
  /**
   * Id for this attempt's queue row, minted by the retry loop: the last one is
   * the id an errored run row is written under. Not a real run's id — no
   * `execution_runs` row exists yet; `dispatch_queue.run_id` has no foreign key,
   * so it correlates queue row and logs without inventing a run.
   */
  runId: string;
  /** The group holds a result-aware generator, so the round needs an agent that skips it. */
  requiresResultAwareSkip: boolean;
}): QueuedJobInput {
  const { info, event, group, repoIdentifier, ref, dispatchBundle, dispatchCredentials } = args;
  const reg = group[0].reg;
  const workflowSha = reg.commitSha ?? '';
  // The WORKFLOW repo's clone URL comes from the bundle owning the workflow's
  // routing key, not the inbound event's: a local-source event triggering a
  // GitHub-authored global would otherwise build an unclonable file:// URL.
  // Mirrors `regBundle` in process-webhook.ts.
  const regBundle = args.deps.providerRegistry.getByRoutingKey(reg.routingKey);
  const workflowRepoUrl = regBundle?.repoUrlBuilder?.buildCloneUrl(reg.repoIdentifier) ?? '';
  return {
    runId: args.runId,
    workflowName: `${ROUND_JOB_PREFIX}${reg.repoIdentifier}`,
    jobName: `${ROUND_JOB_PREFIX}${reg.repoIdentifier}__${workflowSha.slice(0, 12)}`,
    runsOnLabels: [
      // fails-when: a round holding a result-aware generator reaches an agent that would run it
      // breaks-if-wrong: a round of needs-free generators must carry no feature label
      ...roundLabels(args.requiresResultAwareSkip),
      `kici:os:${args.target.targetPlatform}`,
      `kici:arch:${args.target.targetArch}`,
    ],
    jobConfig: {
      globalEvalRound: true,
      candidates: group.map(toWireCandidate),
      event,
      // Selects the agent's dual-checkout path, with the workflow-repo quartet.
      isGlobalWorkflow: true,
      workflowRepoUrl,
      // Empty: clone the default branch; `workflowSha` drives post-clone
      // verification, as in the global execution dispatch.
      workflowRef: '',
      workflowSha,
      workflowRepoIdentifier: reg.repoIdentifier,
      // The dispatcher mints `workflowAuth` through this key's bundle,
      // separately from `sourceAuth`.
      workflowRoutingKey: reg.routingKey,
      workflowProviderContext: reg.providerContext,
      roundTimeoutMs: args.budgets.roundTimeoutMs,
      candidateTimeoutMs: args.budgets.candidateTimeoutMs,
    },
    repoUrl: dispatchBundle.repoUrlBuilder?.buildCloneUrl(repoIdentifier) ?? '',
    ref: event.sourceBranch ?? event.targetBranch,
    sha: ref,
    deliveryId: info.deliveryId,
    // Routing key, provider, clone URL and credentials must all name the clone's
    // source: the dispatcher mints source auth through this key's bundle, so the
    // inbound key under a cross-provider fallback would mint the wrong provider.
    provider:
      args.dispatchRoutingKey !== undefined ? dispatchBundle.normalizer.provider : info.provider,
    providerContext: dispatchCredentials,
    routingKey: args.dispatchRoutingKey ?? info.routingKey,
    requestId: getRequestContext().requestId,
  };
}

/**
 * Narrow one wire verdict into a value the dispatch path can trust.
 *
 * The round-result schema passes `jobs` through unvalidated (`LockJob` has no
 * Zod mirror), so every field is re-checked: `run` is compared, not coerced, and
 * a generated job without a usable `name` makes the whole candidate
 * indeterminate. Fail-closed: half-dispatching unreadable output is worse.
 */
export function narrowVerdict(raw: unknown, workflowName: string): GlobalEvalCandidateResult {
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
 * Fold a round result into the per-candidate map, matching by workflow name. A
 * candidate with no verdict is indeterminate; dropping it would read as "does
 * not apply".
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
 * The bound rejects the tracker entry rather than racing the promise:
 * `PendingTracker.reject` settles the await AND deletes the entry, so an
 * unreported round cannot leak in the tracker map.
 *
 * Without it, a merely queued job blocks `processWebhook` forever: no
 * `event_log` row is written, while `dedup.claim` already drops the provider's
 * redelivery as a duplicate. A breach throws, so the caller records the group
 * indeterminate and the delivery completes.
 *
 * A breach also CANCELS the queue row: an abandoned job would still run later
 * and hold an init-runner slot the retry queues behind, a feedback loop under
 * load.
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
    // Awaited (one indexed UPDATE) so the delivery never finishes with the orphan
    // still queued. A failed cancel must not replace the timeout error.
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
 * The agent's round runner **never throws on its own budget breach**: it
 * returns `success` with every candidate `indeterminate`, so this must be
 * treated as a failure (retry, errored run, check). It agrees with what
 * {@link isCacheableRoundResult} refuses to store. Scoped to ALL candidates: a
 * round that decided even one must still dispatch it.
 */
function roundDecidedNothing(verdicts: Map<string, GlobalEvalCandidateResult>): boolean {
  const collected = [...verdicts.values()];
  return collected.length > 0 && collected.every((verdict) => verdict.indeterminate === true);
}

/**
 * Cap on the joined reason string a decided-nothing round reports. Reasons come
 * from author code, unbounded, and land in the commit check's `output.summary`,
 * which GitHub caps at 65535 characters; an overflow 422 is swallowed by the
 * best-effort post, so the check would vanish.
 */
export const MAX_ROUND_REASON_CHARS = 4_000;

/** Appended to a cut string so a summary never silently stops mid-sentence. */
const TRUNCATION_MARKER = '… (truncated)';

/**
 * Truncate `text` to at most `max` UTF-16 code units, marking that it was cut.
 *
 * - A `max` no larger than the marker returns the truncated marker, never a
 *   string longer than `max`.
 * - The cut backs off one unit rather than split a surrogate pair.
 */
export function truncateReasonText(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  if (max <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, max);
  let cut = max - TRUNCATION_MARKER.length;
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
 * Read one cached round. Counts unkeyable lookups too, so the hit rate's
 * denominator is honest.
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
  requiresResultAwareSkip: boolean,
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
    ...(args.dispatchRoutingKey !== undefined && { dispatchRoutingKey: args.dispatchRoutingKey }),
    budgets,
    target: chooseRoundTarget(deps.agentRegistry, requiresResultAwareSkip),
    runId,
    requiresResultAwareSkip,
  });

  // Keyed off the job input the agent receives, so key and round cannot drift.
  const cacheKey = cache
    ? globalEvalRoundCacheKey({
        workflowRepoIdentifier: reg.repoIdentifier,
        workflowSha: reg.commitSha ?? '',
        workflowRoutingKey: reg.routingKey,
        sourceRepoIdentifier: args.repoIdentifier,
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
    // The cache write gates on every candidate decided, and the key covers the
    // candidate list, so a hit is never a decided-nothing round.
    const cached = new Map<string, GlobalEvalCandidateResult>();
    collectGroupResults(group, hit, cached);
    // Recorded on a hit too: the panel promises one sample per settled round.
    globalEvalJobsGenerated.record(generatedJobCount(cached));
    return cached;
  }

  // Timed from here, so a cache hit records no near-zero duration sample.
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
 * Split from {@link runOneRound} so the duration metric covers only this.
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

  // Gated on THIS GROUP's verdicts, not the raw wire result: an undecided
  // candidate is a failure reported as success (an agent budget breach), and
  // caching it would make a redelivery and the retry replay the failure.
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
 * Attempts allowed per group. Two: the recoverable failures (agent died,
 * connection dropped, dispatch rejected during a restart) clear on the next try
 * or not at all, and each attempt costs a full wait ceiling of webhook latency.
 */
const ROUND_MAX_ATTEMPTS = 2;

/**
 * What a group's round produced, once its retries are exhausted. The success
 * arm carries `runId` and `attempts` because a partial outcome is recorded too.
 */
type GroupRoundOutcome =
  | { ok: true; verdicts: Map<string, GlobalEvalCandidateResult>; attempts: number; runId: string }
  | { ok: false; error: string; attempts: number; runId: string };

/**
 * Run one group's round, up to {@link ROUND_MAX_ATTEMPTS} attempts. Each attempt
 * mints its own run id (one per queue row); the last is returned for the errored
 * run row.
 */
async function runGroupRound(
  args: GlobalEvalRoundArgs,
  group: readonly GlobalEvalCandidate[],
  budgets: RoundBudgets,
  requiresResultAwareSkip: boolean,
): Promise<GroupRoundOutcome> {
  let lastError = 'Global eval round did not run';
  let lastRunId = '';
  for (let attempt = 1; attempt <= ROUND_MAX_ATTEMPTS; attempt++) {
    lastRunId = randomUUID();
    try {
      return {
        ok: true,
        verdicts: await runOneRound(args, group, budgets, lastRunId, requiresResultAwareSkip),
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
 * One round that produced no verdicts after every attempt. Exactly one per
 * failed round, never one per candidate (the round exists to collapse N
 * workflows into one job); `workflowNames` names every suppressed workflow.
 */
export interface GlobalEvalRoundFailure {
  /** The last attempt's round-job run id — what an errored run row is written under. */
  runId: string;
  workflowRepoIdentifier: string;
  /** Every candidate workflow this round suppressed. */
  workflowNames: string[];
  /** The last attempt's error. */
  error: string;
  /** `0` ⇒ never dispatched. */
  attempts: number;
  /**
   * True when the round completed but left only {@link workflowNames}
   * undecided. Kept distinct from a total failure so a broken filter surfaces
   * whether or not other global workflows share its workflow repo.
   */
  partial?: boolean;
}

/**
 * One record for a round that left some candidates undecided, or `null`. A
 * decided-nothing round throws inside the attempt and is retried instead; a
 * partial cannot retry, since its decided candidates would double-dispatch.
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

/** True when any candidate has a result-aware generator, so the round needs the feature label. */
function requiresResultAwareSkip(group: readonly GlobalEvalCandidate[]): boolean {
  // fails-when: a candidate with a result-aware generator runs on an agent without the label
  // breaks-if-wrong: a group with no result-aware generator must run exactly as it always has
  return group.some((candidate) => hasDeferredGenerator(candidate.lockEntry));
}

/** Fold one round outcome into the delivery's verdicts and failure records. */
function settleGroupOutcome(
  args: GlobalEvalRoundArgs,
  group: readonly GlobalEvalCandidate[],
  outcome: GroupRoundOutcome,
  verdicts: Map<string, GlobalEvalCandidateResult>,
  failures: GlobalEvalRoundFailure[],
): void {
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
    return;
  }
  // `attempts: 0` never reached an agent, so it reads "not attempted": "failed"
  // would send an author looking for a job that never ran.
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

/**
 * Run every eval round the candidate set needs and return one verdict per
 * candidate, plus one failure record per round that produced none.
 *
 * Groups run sequentially (several workflow repos per push is uncommon). A
 * failed group marks only its own candidates indeterminate. Failures are
 * returned, not recorded: this module has no database handle nor the inbound
 * bundle a commit check posts through.
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

  // Once per delivery: the answer cannot differ between groups.
  const unsupported = unsupportedFleetReason(args.deps.agentRegistry);

  for (const group of groups.values()) {
    if (unsupported) {
      settleGroupOutcome(
        args,
        group,
        { ok: false, error: unsupported, attempts: 0, runId: randomUUID() },
        verdicts,
        failures,
      );
      continue;
    }
    const outcome = await runGroupRound(args, group, budgets, requiresResultAwareSkip(group));
    settleGroupOutcome(args, group, outcome, verdicts, failures);
  }

  recordVerdictOutcomes(verdicts);
  return { verdicts, failures };
}

/**
 * Meter candidates a round never got to decide on: the caller's fail-closed
 * paths (no pending-eval tracker) return before {@link runGlobalEvalRounds} and
 * suppress EVERY global workflow for the delivery. Counted `indeterminate`,
 * which keeps `candidates` equal to the sum of the verdicts on every path.
 */
export function recordUnrunCandidates(count: number): void {
  if (count <= 0) return;
  globalEvalCandidatesTotal.add(count);
  globalEvalVerdictsTotal.add(count, { outcome: GlobalEvalVerdictOutcome.Indeterminate });
}

/**
 * Meter what the round decided, one sample per candidate. `filtered` and
 * `indeterminate` stay apart so a fleet-wide failure never reads as deliberate
 * exclusions.
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
