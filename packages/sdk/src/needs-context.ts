import { createSnapshotOutputProxy } from './outputs.js';
import type { OutputProxy, DynamicJobNeed } from './types.js';
import type { ExecutionJobStatus } from '@kici-dev/engine';

/**
 * Frozen snapshot of upstream outputs + statuses, captured once at first eval of
 * a result-aware dynamic generator and replayed unchanged on re-eval.
 *
 * - `groups` lists each dynamic group's member job names in order.
 * - `statuses` entries default to `success` when absent: the only status that
 *   satisfies a default needs edge.
 */
export interface UpstreamSnapshot {
  jobs: Record<string, Record<string, unknown>>;
  groups: Record<string, string[]>;
  statuses?: Record<string, ExecutionJobStatus>;
  /** Per invoke-gate job, one ordered result per run it triggered. Present only for invoke gates. */
  invokeResults?: Record<string, InvokeResult[]>;
}

/**
 * One entry of `ctx.needs[gate].result` per run an invoke gate triggered.
 * `outputs` carries the invoked run's non-secret declared outputs.
 */
export interface InvokeResult {
  readonly repo: string;
  readonly workflow: string;
  readonly runId: string;
  readonly status: string;
  readonly outputs: Readonly<Record<string, unknown>>;
}

/**
 * A single-job need: the upstream's outputs proxy plus terminal status. A typed
 * `needs: [jobRef]` threads the reference's outputs into `T`, so
 * `ctx.needs.<job>.result.<field>` is checked.
 */
export interface SingleNeedEntry<T = Record<string, unknown>> {
  result: OutputProxy<T>;
  status: ExecutionJobStatus;
}

/** One entry in the array exposed for a `dynamicGroup(...)` need. */
export interface GroupNeedEntry<T = Record<string, unknown>> {
  name: string;
  result: OutputProxy<T>;
  status: ExecutionJobStatus;
}

/** `ctx.needs['<gate>'].result`: one {@link InvokeResult} per triggered run, in order. */
export interface InvokeNeedEntry {
  result: readonly InvokeResult[];
}

/** A single-job, group (ordered array), or invoke-gate need entry. */
export type NeedEntry<T = Record<string, unknown>> =
  SingleNeedEntry<T> | GroupNeedEntry[] | InvokeNeedEntry;

/** `ctx.needs`, keyed by job or group name. */
export type NeedsContext = Record<string, NeedEntry>;

function needKey(need: DynamicJobNeed): { kind: 'job' | 'group'; key: string } {
  if (typeof need === 'string') return { kind: 'job', key: need };
  if ('group' in need) return { kind: 'group', key: need.group };
  if ('name' in need) return { kind: 'job', key: need.name };
  // A Job object as a need — resolve via its name (parity with JobOptions.needs).
  return { kind: 'job', key: (need as { name: string }).name };
}

function statusFor(snapshot: UpstreamSnapshot, name: string): ExecutionJobStatus {
  return snapshot.statuses?.[name] ?? ('success' as ExecutionJobStatus);
}

/**
 * Resolve declared needs against a frozen snapshot into `ctx.needs`. Group
 * members keep the snapshot's deterministic eval order.
 */
export function buildNeedsContext(
  snapshot: UpstreamSnapshot,
  declaredNeeds: ReadonlyArray<DynamicJobNeed>,
): NeedsContext {
  const out: NeedsContext = {};
  for (const need of declaredNeeds) {
    const { kind, key } = needKey(need);
    const invokeResults = snapshot.invokeResults?.[key];
    if (kind === 'job' && invokeResults !== undefined) {
      out[key] = { result: invokeResults };
    } else if (kind === 'group') {
      const members = snapshot.groups[key] ?? [];
      out[key] = members.map((name) => ({
        name,
        result: createSnapshotOutputProxy(name, snapshot.jobs[name]),
        status: statusFor(snapshot, name),
      }));
    } else {
      out[key] = {
        result: createSnapshotOutputProxy(key, snapshot.jobs[key]),
        status: statusFor(snapshot, key),
      };
    }
  }
  return out;
}
