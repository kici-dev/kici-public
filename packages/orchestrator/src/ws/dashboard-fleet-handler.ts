/**
 * Orchestrator-side handlers for the fleet-management read path (P2).
 *
 * Each handler answers one Platform->orchestrator read-relay request from
 * `HostRosterStore`, returning the canonical `HostInventoryEntry` shape on the
 * wire. The handlers are pure (they take their dependencies as arguments) so
 * the WS wiring in `server.ts` stays a thin adapter and the logic is unit
 * testable without a live DB / Platform connection.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { HostRosterStore, HostStatus } from '../agent/host-roster.js';
import type { RegistrationStore } from '../registration/registration-store.js';
import { matcherSatisfiedBy } from '@kici-dev/engine';
import type {
  DashboardFleetHostsResponse,
  DashboardFleetHostResponse,
  DashboardFleetPreviewResponse,
  DashboardFleetWorkflowsForHostResponse,
  FleetHostDisposition,
  FleetPinnedRun,
  FleetPreviewHost,
  LabelMatcher,
  OnUnreachableMode,
} from '@kici-dev/engine';
import { extractRunsOnAll } from './fleet-runs-on-all.js';

/** A workflow's resolved runsOnAll predicate, or null when it has none. */
export interface ResolvedRunsOnAll {
  include: readonly (readonly LabelMatcher[])[];
  exclude: readonly LabelMatcher[];
  onUnreachable: OnUnreachableMode;
}

export interface FleetHandlerDeps {
  db: Kysely<Database>;
  rosterStore: HostRosterStore;
  rosterGraceMs: number;
  /** Resolve a workflow's runsOnAll predicate + onUnreachable, or null. */
  resolveRunsOnAll: (workflowName: string) => Promise<ResolvedRunsOnAll | null>;
  /** All registered workflows (for the host-centric workflows-for-host read). */
  registrationStore: RegistrationStore;
}

/** Roster: every declared/live host as a `HostInventoryEntry`. */
export async function handleFleetHostsRequest(
  deps: FleetHandlerDeps,
  requestId: string,
): Promise<DashboardFleetHostsResponse> {
  const hosts = await deps.rosterStore.queryInventory(undefined, deps.rosterGraceMs);
  return { type: 'dashboard.fleet.hosts.response', requestId, hosts };
}

/** Host detail: one host (or null) plus its most-recent pinned runs. */
export async function handleFleetHostRequest(
  deps: FleetHandlerDeps,
  requestId: string,
  agentId: string,
): Promise<DashboardFleetHostResponse> {
  const host = await deps.rosterStore.getInventory(agentId, deps.rosterGraceMs);
  const runRows = await deps.db
    .selectFrom('execution_jobs')
    .innerJoin('execution_runs', 'execution_runs.run_id', 'execution_jobs.run_id')
    .select([
      'execution_runs.run_id as run_id',
      'execution_runs.workflow_name as workflow_name',
      'execution_runs.status as status',
      'execution_runs.created_at as created_at',
    ])
    .where('execution_jobs.agent_id', '=', agentId)
    .orderBy('execution_runs.created_at', 'desc')
    .limit(40)
    .execute();

  // The job→run join can return the same run more than once (one row per pinned
  // job); dedup by run id while preserving the newest-first ordering.
  const seen = new Set<string>();
  const runs: FleetPinnedRun[] = [];
  for (const r of runRows) {
    if (seen.has(r.run_id)) continue;
    seen.add(r.run_id);
    runs.push({
      runId: r.run_id,
      workflowName: r.workflow_name ?? null,
      status: r.status,
      createdAt: new Date(r.created_at).toISOString(),
    });
    if (runs.length >= 20) break;
  }
  return { type: 'dashboard.fleet.host.response', requestId, host, runs };
}

/** runsOnAll preview: matched hosts + the fan-out policy + estimated child count. */
export async function handleFleetPreviewRequest(
  deps: FleetHandlerDeps,
  requestId: string,
  workflowName: string,
): Promise<DashboardFleetPreviewResponse> {
  const predicate = await deps.resolveRunsOnAll(workflowName);
  if (!predicate) {
    return {
      type: 'dashboard.fleet.preview.response',
      requestId,
      matched: [],
      onUnreachable: 'hold',
      estimatedChildCount: 0,
    };
  }
  const matched = await deps.rosterStore.findMatching(
    predicate.include,
    predicate.exclude,
    deps.rosterGraceMs,
  );
  const out: FleetPreviewHost[] = [];
  let targetCount = 0;
  for (const h of matched) {
    const entry = await deps.rosterStore.getInventory(h.agentId, deps.rosterGraceMs);
    if (!entry) continue;
    if (h.status === HostStatus.ready) {
      out.push({ entry, disposition: 'target' });
      targetCount++;
    } else if (h.lifecycleClass === 'ephemeral') {
      // Ephemeral hosts that are not live are always skipped.
      out.push({ entry, disposition: 'skipped-ephemeral' });
    } else {
      // Declared-but-absent durable host: counted toward the fan-out only when
      // the policy holds a pinned child for it to (re)connect.
      out.push({ entry, disposition: 'unreachable-durable' });
      if (predicate.onUnreachable === 'hold') targetCount++;
    }
  }
  return {
    type: 'dashboard.fleet.preview.response',
    requestId,
    matched: out,
    onUnreachable: predicate.onUnreachable,
    estimatedChildCount: targetCount,
  };
}

/**
 * workflows-for-host: the host-centric inverse of the preview. Resolves this
 * host's label set once, then tests every registered (non-disabled) workflow's
 * runsOnAll predicate against it, returning each match with the fan-out's
 * `onUnreachable` policy and the host's per-workflow disposition.
 */
export async function handleFleetWorkflowsForHostRequest(
  deps: FleetHandlerDeps,
  requestId: string,
  agentId: string,
): Promise<DashboardFleetWorkflowsForHostResponse> {
  const entry = await deps.rosterStore.getInventory(agentId, deps.rosterGraceMs);
  if (!entry) {
    return { type: 'dashboard.fleet.workflows-for-host.response', requestId, workflows: [] };
  }
  const labelSet = new Set(entry.labels);
  const workflows: DashboardFleetWorkflowsForHostResponse['workflows'] = [];
  for (const reg of await deps.registrationStore.getAll()) {
    if (reg.disabled) continue;
    const predicate = extractRunsOnAll(reg.lock_entry);
    if (!predicate) continue;
    const excluded = predicate.exclude.some((e) => matcherSatisfiedBy(e, labelSet));
    const included =
      predicate.include.length === 0 ||
      predicate.include.some((grp) => grp.every((m) => matcherSatisfiedBy(m, labelSet)));
    if (excluded || !included) continue;

    let disposition: FleetHostDisposition;
    if (entry.status === HostStatus.ready) disposition = 'target';
    else if (entry.lifecycleClass === 'ephemeral') disposition = 'skipped-ephemeral';
    else disposition = predicate.onUnreachable === 'hold' ? 'target' : 'unreachable-durable';

    workflows.push({
      workflowName: reg.workflow_name,
      repoIdentifier: reg.repo_identifier,
      sourceFile: reg.sourceFile,
      onUnreachable: predicate.onUnreachable,
      disposition,
    });
  }
  return { type: 'dashboard.fleet.workflows-for-host.response', requestId, workflows };
}
