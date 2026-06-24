import { createSnapshotOutputProxy } from './outputs.js';
import type { OutputProxy, DynamicJobNeed } from './types.js';
import type { ExecutionJobStatus } from '@kici-dev/engine';

/**
 * Frozen snapshot of upstream outputs + statuses, captured once at first eval of
 * a result-aware dynamic generator and replayed unchanged on re-eval.
 *
 * - `jobs` maps an upstream job name to its outputs record.
 * - `groups` maps a dynamic group name to its ordered member job names.
 * - `statuses` maps an upstream job name to its terminal status. Absent entries
 *   default to `success` (the only status that satisfies a default needs edge,
 *   so an upstream resolved into the snapshot is success unless told otherwise).
 */
export interface UpstreamSnapshot {
  jobs: Record<string, Record<string, unknown>>;
  groups: Record<string, string[]>;
  statuses?: Record<string, ExecutionJobStatus>;
}

/** One entry in the array exposed for a `dynamicGroup(...)` need. */
export interface GroupNeedEntry {
  name: string;
  result: OutputProxy<any>;
  status: ExecutionJobStatus;
}

/** A single-job need exposes `{ result, status }`; a group need exposes an ordered array. */
export type NeedEntry = { result: OutputProxy<any>; status: ExecutionJobStatus } | GroupNeedEntry[];

/** The resolved `ctx.needs` map keyed by job name or group name. */
export type NeedsContext = Record<string, NeedEntry>;

function needKey(need: DynamicJobNeed): { kind: 'job' | 'group'; key: string } {
  if (typeof need === 'string') return { kind: 'job', key: need };
  if ('group' in need) return { kind: 'group', key: need.group };
  if ('name' in need) return { kind: 'job', key: need.name };
  // A Job object as a need — resolve via its name (parity with JobOptions.needs).
  return { kind: 'job', key: (need as { name: string }).name };
}

/** Read an upstream's terminal status from the snapshot, defaulting to success. */
function statusFor(snapshot: UpstreamSnapshot, name: string): ExecutionJobStatus {
  return snapshot.statuses?.[name] ?? ('success' as ExecutionJobStatus);
}

/**
 * Resolve declared needs against a frozen snapshot into the `ctx.needs` map.
 *
 * - A single static/named-job need resolves to `{ result: <proxy over jobs[name]>, status }`.
 * - A `dynamicGroup(...)` need resolves to an ordered array of `{ name, result, status }`,
 *   one entry per group member in the snapshot's deterministic eval order.
 */
export function buildNeedsContext(
  snapshot: UpstreamSnapshot,
  declaredNeeds: ReadonlyArray<DynamicJobNeed>,
): NeedsContext {
  const out: NeedsContext = {};
  for (const need of declaredNeeds) {
    const { kind, key } = needKey(need);
    if (kind === 'group') {
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
