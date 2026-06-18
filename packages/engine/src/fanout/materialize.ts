import {
  expandMatrix,
  applyIncludeExclude,
  type MatrixValues,
  type StaticMatrixArray,
  type StaticMatrixObject,
} from '../matrix/expand.js';
import { formatExpandedJobName } from '../matrix/format.js';
import type { LockJob } from '../trigger/types.js';

/** Hard cap on children per fanned job — mirrors the compiler's MAX_STATIC_MATRIX_JOBS. */
export const MAX_FANOUT_JOBS = 256;

/**
 * The kind of fan-out a materialized child belongs to. `matrix` children come
 * from a matrix expansion (one per combination); `host` children come from a
 * `runsOnAll` fan-out (one pinned execution per roster host).
 */
export enum VariantKind {
  matrix = 'matrix',
  host = 'host',
}

/**
 * Thrown when a job's matrix cannot be materialized into dispatchable children:
 * zero combinations after exclude, or more combinations than {@link MAX_FANOUT_JOBS}.
 * Callers map this onto the `matrix_expansion` init-failure category.
 */
export class FanoutError extends Error {
  override readonly name = 'FanoutError';
  constructor(
    readonly jobName: string,
    message: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, FanoutError.prototype);
  }
}

/**
 * A roster host resolved as a target of a `runsOnAll` fan-out. Carries the
 * identity the dispatcher pins to and the agent facts exposed as `ctx.agent`.
 */
export interface ResolvedHostAgent {
  /** Agent id the child pins to. */
  agentId: string;
  /** Hostname (falls back to agentId). */
  host: string;
  /** The host's label set. */
  labels: readonly string[];
  platform?: string;
  arch?: string;
  /** Which orchestrator owns the live WS (null = not currently connected). */
  connectedInstanceId?: string | null;
}

/**
 * One dispatchable unit produced from a lock job. `variantKind` is `matrix` for
 * a matrix combination child and `host` for a `runsOnAll` per-host child; absent
 * for a non-fanned job.
 */
export interface MaterializedJob {
  /** The originating lock job. Its matrix/include/exclude are NOT dispatched as-is. */
  lockJob: LockJob;
  /** The lock job's name (the consumer-facing job identity). */
  baseName: string;
  /** `${baseName} (${suffix})` for fanned children, else `baseName`. */
  expandedName: string;
  /** Present only for fanned children. */
  variantKind?: VariantKind;
  /** The combination values for a matrix child; absent for non-matrix jobs. */
  variantValues?: MatrixValues;
  /**
   * True when the job carries a dynamic matrix the orchestrator cannot expand —
   * it must route through the agent-eval flow and be re-materialized from the result.
   */
  pendingDynamicMatrix?: boolean;
  // --- host-variant fields (set only when variantKind === VariantKind.host) ---
  /** The agent this child is pinned to. */
  pinnedAgentId?: string;
  /** The host this child runs on (also the variant label / name suffix). */
  host?: string;
  /** The resolved host agent facts, exposed to the step as `ctx.agent`. */
  agent?: ResolvedHostAgent;
  /** Which orchestrator owns the pinned agent's live WS (null = not connected). */
  connectedInstanceId?: string | null;
}

export interface FanoutResult {
  jobs: MaterializedJob[];
  /** baseName → expandedNames (length 1 for non-fanned jobs). Drives needs-edge expansion. */
  expansionMap: Map<string, string[]>;
}

/**
 * The job-config envelope fields that identify a materialized child: the
 * expanded `name`, the `baseJobName` (what the agent exposes as `ctx.job.name`),
 * and `matrixValues` (exposed as `ctx.matrix`). Every dispatch site spreads
 * these into its job config so the envelopes stay identical. The raw
 * matrix/include/exclude are intentionally NOT included — they are consumed at
 * dispatch time, not shipped to the agent.
 */
export function matrixEnvelopeFields(mat: MaterializedJob): {
  name: string;
  baseJobName: string;
  matrixValues?: MatrixValues;
} {
  return {
    name: mat.expandedName,
    baseJobName: mat.baseName,
    ...(mat.variantValues && { matrixValues: mat.variantValues }),
  };
}

/**
 * Build materialized children from a resolved dynamic-matrix combination list
 * (produced by the agent eval flow). Mirrors the static-matrix branch of
 * {@link materializeFanout} but takes the already-resolved combinations and
 * enforces the same cap / zero-combination guards.
 */
export function materializeResolvedMatrix(
  lockJob: LockJob,
  combos: readonly MatrixValues[],
): FanoutResult {
  if (combos.length === 0) {
    throw new FanoutError(
      lockJob.name,
      `dynamic matrix for job '${lockJob.name}' resolved to zero combinations`,
    );
  }
  if (combos.length > MAX_FANOUT_JOBS) {
    throw new FanoutError(
      lockJob.name,
      `dynamic matrix for job '${lockJob.name}' resolved to ${combos.length} combinations (max ${MAX_FANOUT_JOBS})`,
    );
  }
  const jobs: MaterializedJob[] = [];
  const names: string[] = [];
  for (const variantValues of combos) {
    const expandedName = formatExpandedJobName(lockJob.name, variantValues);
    names.push(expandedName);
    jobs.push({
      lockJob,
      baseName: lockJob.name,
      expandedName,
      variantKind: VariantKind.matrix,
      variantValues,
    });
  }
  return { jobs, expansionMap: new Map([[lockJob.name, names]]) };
}

/**
 * The job-config envelope fields that identify a materialized host child: the
 * expanded `name`, the `baseJobName`, the `pinnedAgentId`, the `host` (exposed as
 * `ctx.host` and persisted as `variant_label`), and the resolved `agent` facts
 * (exposed as `ctx.agent`). The matrix sibling is {@link matrixEnvelopeFields}.
 */
export function hostEnvelopeFields(mat: MaterializedJob): {
  name: string;
  baseJobName: string;
  pinnedAgentId?: string;
  host?: string;
  agent?: ResolvedHostAgent;
  connectedInstanceId?: string | null;
} {
  return {
    name: mat.expandedName,
    baseJobName: mat.baseName,
    ...(mat.pinnedAgentId && { pinnedAgentId: mat.pinnedAgentId }),
    ...(mat.host && { host: mat.host }),
    ...(mat.agent && { agent: mat.agent }),
    ...(mat.connectedInstanceId !== undefined && { connectedInstanceId: mat.connectedInstanceId }),
  };
}

/**
 * Build materialized host children from a resolved target-host list (produced by
 * the roster-backed resolution branch at dispatch time). Emits one pinned child
 * per host, sibling to {@link materializeResolvedMatrix}. `maxHosts` is the
 * orchestrator `maxFanoutHosts` config (default 1024) — NOT {@link MAX_FANOUT_JOBS}
 * (the 256 matrix cap is GitHub-Actions author-error parity, irrelevant to fleet size).
 */
export function materializeResolvedHosts(
  lockJob: LockJob,
  agents: readonly ResolvedHostAgent[],
  maxHosts: number,
): FanoutResult {
  if (agents.length === 0) {
    throw new FanoutError(
      lockJob.name,
      `runsOnAll for job '${lockJob.name}' matched zero matching hosts`,
    );
  }
  if (agents.length > maxHosts) {
    throw new FanoutError(
      lockJob.name,
      `runsOnAll for job '${lockJob.name}' matched ${agents.length} hosts (max ${maxHosts})`,
    );
  }
  const jobs: MaterializedJob[] = [];
  const names: string[] = [];
  for (const agent of agents) {
    const expandedName = `${lockJob.name} (${agent.host})`;
    names.push(expandedName);
    jobs.push({
      lockJob,
      baseName: lockJob.name,
      expandedName,
      variantKind: VariantKind.host,
      pinnedAgentId: agent.agentId,
      host: agent.host,
      agent,
      connectedInstanceId: agent.connectedInstanceId ?? null,
    });
  }
  return { jobs, expansionMap: new Map([[lockJob.name, names]]) };
}

/**
 * Expand each lock job's static matrix into N dispatchable children (one per
 * combination), passing non-matrix and dynamic-matrix jobs through 1:1.
 * Dynamic-matrix jobs are flagged `pendingDynamicMatrix` for the eval flow.
 */
export function materializeFanout(staticJobs: readonly LockJob[]): FanoutResult {
  const jobs: MaterializedJob[] = [];
  const expansionMap = new Map<string, string[]>();

  for (const lockJob of staticJobs) {
    const matrix = lockJob.matrix;

    if (!matrix) {
      jobs.push({ lockJob, baseName: lockJob.name, expandedName: lockJob.name });
      expansionMap.set(lockJob.name, [lockJob.name]);
      continue;
    }

    if (matrix._type === 'dynamic') {
      jobs.push({
        lockJob,
        baseName: lockJob.name,
        expandedName: lockJob.name,
        pendingDynamicMatrix: true,
      });
      expansionMap.set(lockJob.name, [lockJob.name]);
      continue;
    }

    // Static matrix: expand → include/exclude → suffix naming identical to the
    // local executor so the dashboard's matrix grouping works unchanged.
    const values = matrix.values;
    if (!values) {
      throw new FanoutError(lockJob.name, `static matrix for job '${lockJob.name}' has no values`);
    }
    const expanded = expandMatrix(values as StaticMatrixArray | StaticMatrixObject);
    const combos = applyIncludeExclude(
      expanded,
      lockJob.include as Record<string, string>[] | undefined,
      lockJob.exclude as Record<string, string>[] | undefined,
    );

    if (combos.length === 0) {
      throw new FanoutError(
        lockJob.name,
        `matrix for job '${lockJob.name}' expands to zero combinations`,
      );
    }
    if (combos.length > MAX_FANOUT_JOBS) {
      throw new FanoutError(
        lockJob.name,
        `matrix for job '${lockJob.name}' expands to ${combos.length} combinations (max ${MAX_FANOUT_JOBS})`,
      );
    }

    const names: string[] = [];
    for (const variantValues of combos) {
      const expandedName = formatExpandedJobName(lockJob.name, variantValues);
      names.push(expandedName);
      jobs.push({
        lockJob,
        baseName: lockJob.name,
        expandedName,
        variantKind: VariantKind.matrix,
        variantValues,
      });
    }
    expansionMap.set(lockJob.name, names);
  }

  return { jobs, expansionMap };
}
