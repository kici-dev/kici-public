/**
 * The dispatch-time compile-schema gate.
 *
 * An agent rejects a lock entry whose `compileSchemaVersion` differs from the
 * schema its workflow loader implements, so a run whose every candidate agent
 * implements another schema can only fail. The gate fails such a run before a
 * build job, a scaler request or an agent dispatch, with the message the agent
 * would have produced.
 *
 * It refuses only on proof: every candidate's schema is known and none matches.
 * An unknown candidate, no candidate, or another live cluster instance (whose
 * agents and scaler this instance cannot see) all dispatch, and the agent stays
 * the backstop. It never compares against the orchestrator's own release
 * schema: agents upgrade independently, and a refused run starts no agent, so
 * a wrong refusal would never correct itself.
 */

import type { Kysely } from 'kysely';
import {
  createLogger,
  formatCompileSchemaMismatch,
  formatRerunLockNote,
  isCompileSchemaMismatchMessage,
  lockCompileSchema,
  toErrorMessage,
} from '@kici-dev/shared';
import { partitionMatchers, type LockJob } from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import type { AgentRegistry } from '../agent/registry.js';
import type { ScalerManager } from '../scaler/manager.js';
import { hasOtherLiveInstance } from '../cluster/instance-heartbeat.js';
import type { WorkflowDispatchContext } from './dispatch-matched-workflow.js';

const logger = createLogger({ prefix: 'pipeline' });

/** One agent, or one scaler label set, that could first load the workflow source. */
export interface CompileSchemaCandidate {
  source: string;
  /** The schema it implements; `null` when unknown. */
  schema: number | null;
  release: string | null;
}

export type CompileSchemaVerdict =
  | { doomed: false }
  | { doomed: true; implementedSchema: number; implementerRelease: string | undefined };

/**
 * Doomed iff there is at least one candidate, every candidate's schema is known,
 * and none equals the lock's. The verdict names the implemented schema (the
 * lowest when candidates disagree) and the release when every known one agrees.
 */
export function judgeCompileSchema(
  lockSchema: number,
  candidates: readonly CompileSchemaCandidate[],
): CompileSchemaVerdict {
  if (candidates.length === 0) return { doomed: false };
  const schemas: number[] = [];
  for (const c of candidates) {
    if (c.schema === null || c.schema === lockSchema) return { doomed: false };
    schemas.push(c.schema);
  }
  const releases = new Set(candidates.map((c) => c.release).filter((r) => r !== null));
  return {
    doomed: true,
    implementedSchema: Math.min(...schemas),
    implementerRelease: releases.size === 1 ? [...releases][0]! : undefined,
  };
}

/** What this orchestrator instance can see of the agents a run could reach. */
export interface CompileSchemaView {
  /** False while another cluster instance is live: its agents are invisible here. */
  isCompleteView(): Promise<boolean>;
  /** Every connected agent and scaler label set that would serve one of the label sets. */
  candidatesFor(labelSets: readonly string[][]): Promise<CompileSchemaCandidate[]>;
}

export function createCompileSchemaView(deps: {
  registry: Pick<AgentRegistry, 'getAllEntries' | 'agentSatisfies'>;
  scaler?: Pick<ScalerManager, 'compileSchemaForLabels'>;
  db?: Kysely<Database>;
  instanceId?: string;
  livenessGraceMs: number;
}): CompileSchemaView {
  return {
    async isCompleteView() {
      // No DB or instance id: a standalone in-memory stack, alone by construction.
      if (!deps.db || !deps.instanceId) return true;
      return !(await hasOtherLiveInstance(deps.db, deps.instanceId, deps.livenessGraceMs));
    },
    async candidatesFor(labelSets) {
      const out: CompileSchemaCandidate[] = [];
      for (const labels of labelSets) {
        for (const agent of deps.registry.getAllEntries()) {
          if (!deps.registry.agentSatisfies(agent, labels)) continue;
          out.push({
            source: `agent:${agent.agentId}`,
            schema: agent.compileSchemaVersion,
            release: agent.version,
          });
        }
        // An empty label set is asked too: a job with no exact label reaches
        // `requestScale([])`, which spawns from an ungated label set.
        if (!deps.scaler) continue;
        out.push(...(await deps.scaler.compileSchemaForLabels(labels)));
      }
      return out;
    },
  };
}

/**
 * The label sets whose agents check the lock's schema first: the build job's
 * when the source build runs, else each static job's exact `runsOn` labels
 * (regex selectors dropped).
 */
export function gateLabelSets(args: {
  buildNeeded: boolean;
  sourceHit: boolean;
  buildLabels: string[];
  staticJobs: readonly LockJob[];
}): string[][] {
  if (args.buildNeeded && !args.sourceHit) return [args.buildLabels];
  return args.staticJobs.map((job) => partitionMatchers(job.runsOn ?? []).exact);
}

export type CompileSchemaGateOutcome = { doomed: false } | { doomed: true; reason: string };

/**
 * Judge a run before its build or dispatch. Dispatches (not doomed) whenever the
 * agent would not check either: a test run or a local working tree (no content
 * hash reaches the agent), an empty `contentHash`, a lock entry with no schema,
 * or no view. A view error also dispatches: missing knowledge never refuses.
 */
export async function evaluateCompileSchemaGate(
  ctx: Pick<
    WorkflowDispatchContext,
    | 'deps'
    | 'workflow'
    | 'testRun'
    | 'localWorkingTree'
    | 'global'
    | 'repoIdentifier'
    | 'rerunLineage'
    | 'ref'
    | 'runId'
  >,
  args: {
    buildNeeded: boolean;
    sourceHit: boolean;
    buildLabels: string[];
    staticJobs: readonly LockJob[];
    contentHash: string | undefined;
  },
): Promise<CompileSchemaGateOutcome> {
  const view = ctx.deps.compileSchemaView;
  const lockSchema = lockCompileSchema(ctx.workflow);
  if (!view || ctx.testRun || ctx.localWorkingTree || !args.contentHash || lockSchema === null) {
    return { doomed: false };
  }
  let verdict: CompileSchemaVerdict;
  try {
    if (!(await view.isCompleteView())) return { doomed: false };
    verdict = judgeCompileSchema(lockSchema, await view.candidatesFor(gateLabelSets(args)));
  } catch (err) {
    logger.warn('Compile-schema gate could not read its view; dispatching', {
      runId: ctx.runId,
      error: toErrorMessage(err),
    });
    return { doomed: false };
  }
  if (!verdict.doomed) return { doomed: false };

  const lockRepo = ctx.global?.workflowRepoIdentifier ?? ctx.repoIdentifier;
  const reason = formatCompileSchemaMismatch({
    lockSchema,
    implementedSchema: verdict.implementedSchema,
    implementer: 'agents',
    lockRepo,
    implementerRelease: verdict.implementerRelease,
    rerun: rerunLockOf(ctx),
  });
  logger.warn('Run refused at dispatch: every candidate agent rejects its compile schema', {
    runId: ctx.runId,
    workflow: ctx.workflow.name,
    lockRepo,
    lockSchema,
    agentSchema: verdict.implementedSchema,
  });
  return { doomed: true, reason };
}

/**
 * For a re-run: the repository and commit whose recorded lock it replays, which
 * every compile-schema mismatch message of the re-run names. `undefined` for a
 * first run.
 */
export function rerunLockOf(
  ctx: Pick<WorkflowDispatchContext, 'rerunLineage' | 'global' | 'repoIdentifier' | 'ref'>,
): { repo: string; sha: string } | undefined {
  if (!ctx.rerunLineage) return undefined;
  return {
    repo: ctx.global?.workflowRepoIdentifier ?? ctx.repoIdentifier,
    sha: ctx.global?.workflowSha || ctx.ref,
  };
}

/**
 * The job-config field that lets an agent's own compile-schema rejection say a
 * re-run keeps its recorded lock. Set only on a re-run job that carries a
 * content hash (only then does the agent check the schema).
 */
export function lockRerunField(
  ctx: Pick<WorkflowDispatchContext, 'rerunLineage' | 'global' | 'repoIdentifier' | 'ref'>,
  contentHash: string | undefined,
): { lockRerun?: { repo: string; sha: string } } {
  const rerun = contentHash ? rerunLockOf(ctx) : undefined;
  return rerun ? { lockRerun: rerun } : {};
}

/**
 * A build failure's reason, with the re-run note appended when the run is a
 * re-run and the agent rejected the lock's compile schema: a re-run replays the
 * recorded lock, so recompiling does not fix it. Recognises the legacy agent
 * text too.
 */
export function withRerunLockNote(
  ctx: Pick<WorkflowDispatchContext, 'rerunLineage' | 'global' | 'repoIdentifier' | 'ref'>,
  reason: string,
): string {
  const rerun = rerunLockOf(ctx);
  if (!rerun || !isCompileSchemaMismatchMessage(reason)) return reason;
  // An agent of this release already wrote the note from `lockRerun`.
  if (reason.includes(formatRerunLockNote(rerun))) return reason;
  return `${reason} ${formatRerunLockNote(rerun)}`;
}
