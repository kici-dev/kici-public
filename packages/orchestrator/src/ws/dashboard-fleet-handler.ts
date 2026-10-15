/**
 * Fleet-management read-relay handlers, answered from `HostRosterStore`. Roster
 * reads return `FleetHostEntry` (`HostInventoryEntry` plus `confirmed`) so the
 * dashboard can show dashboard-declared hosts no agent or operator confirmed
 * yet. Handlers take their deps as arguments, keeping the `server.ts` wiring a
 * thin adapter and the logic unit-testable without a live DB or Platform.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { HostRosterStore, HostStatus } from '../agent/host-roster.js';
import type { RegistrationStore } from '../registration/registration-store.js';
import { canonicalizeLabelSet, canonicalizeMatcher, matcherSatisfiedBy } from '@kici-dev/engine';
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
  /** Backs the host-centric workflows-for-host read. */
  registrationStore: RegistrationStore;
}

/** Roster: every host, unconfirmed placeholders included, flagged `confirmed`. */
export async function handleFleetHostsRequest(
  deps: FleetHandlerDeps,
  requestId: string,
): Promise<DashboardFleetHostsResponse> {
  const hosts = await deps.rosterStore.listFleetHosts(deps.rosterGraceMs);
  return { type: 'dashboard.fleet.hosts.response', requestId, hosts };
}

/** Host detail: one host (or null) plus its most-recent pinned runs. */
export async function handleFleetHostRequest(
  deps: FleetHandlerDeps,
  requestId: string,
  agentId: string,
): Promise<DashboardFleetHostResponse> {
  const host = await deps.rosterStore.getFleetHost(agentId, deps.rosterGraceMs);
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

  // The join yields one row per pinned job; dedup runs, keeping newest-first order.
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
  // Mirrors the dispatcher's resolver so the preview shows the hosts the run
  // would actually target — auto-scaler agents are not fan-out targets.
  const matched = await deps.rosterStore.findFanoutTargets(
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
 * workflows-for-host: the host-centric inverse of the preview. Tests every
 * non-disabled workflow's runsOnAll predicate against this host's labels and
 * returns each match with its `onUnreachable` policy and the host's disposition.
 */
export async function handleFleetWorkflowsForHostRequest(
  deps: FleetHandlerDeps,
  requestId: string,
  agentId: string,
): Promise<DashboardFleetWorkflowsForHostResponse> {
  const entry = await deps.rosterStore.getFleetHost(agentId, deps.rosterGraceMs);
  // An unconfirmed host is never a fan-out target (findFanoutTargets skips it),
  // so it lists no fan-outs.
  if (!entry || !entry.confirmed) {
    return { type: 'dashboard.fleet.workflows-for-host.response', requestId, workflows: [] };
  }
  // Mirrors `findFanoutTargets` (dispatcher + preview): an auto-scaler agent is
  // never a `runsOnAll` target, so the host page must not name fan-outs no run
  // produces. The flag comes off the roster row, not `entry`, because
  // `FleetHostEntry` extends the SDK-facing `ctx.kici.inventory` shape.
  const row = await deps.rosterStore.get(agentId);
  if (row?.scaler_managed) {
    return { type: 'dashboard.fleet.workflows-for-host.response', requestId, workflows: [] };
  }
  // Wire-shape labels are plain strings: fold them before matching.
  const labelSet = canonicalizeLabelSet(entry.labels);
  const workflows: DashboardFleetWorkflowsForHostResponse['workflows'] = [];
  for (const reg of await deps.registrationStore.getAll()) {
    if (reg.disabled) continue;
    const predicate = extractRunsOnAll(reg.lock_entry);
    if (!predicate) continue;
    const excluded = predicate.exclude.some((e) =>
      matcherSatisfiedBy(canonicalizeMatcher(e), labelSet),
    );
    const included =
      predicate.include.length === 0 ||
      predicate.include.some((grp) =>
        grp.every((m) => matcherSatisfiedBy(canonicalizeMatcher(m), labelSet)),
      );
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
