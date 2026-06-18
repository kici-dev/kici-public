import { createSnapshotOutputProxy } from './outputs.js';
import type { OutputProxy, DynamicJobNeed } from './types.js';

/**
 * Frozen snapshot of upstream outputs, captured once at first eval of a
 * result-aware dynamic generator and replayed unchanged on re-eval.
 *
 * - `jobs` maps an upstream job name to its outputs record.
 * - `groups` maps a dynamic group name to its ordered member job names.
 */
export interface UpstreamSnapshot {
  jobs: Record<string, Record<string, unknown>>;
  groups: Record<string, string[]>;
}

/** One entry in the array exposed for a `dynamicGroup(...)` need. */
export interface GroupNeedEntry {
  name: string;
  result: OutputProxy<any>;
}

/** A single-job need exposes `{ result }`; a group need exposes an ordered array. */
export type NeedEntry = { result: OutputProxy<any> } | GroupNeedEntry[];

/** The resolved `ctx.needs` map keyed by job name or group name. */
export type NeedsContext = Record<string, NeedEntry>;

function needKey(need: DynamicJobNeed): { kind: 'job' | 'group'; key: string } {
  if (typeof need === 'string') return { kind: 'job', key: need };
  if ('group' in need) return { kind: 'group', key: need.group };
  if ('name' in need) return { kind: 'job', key: need.name };
  // A Job object as a need — resolve via its name (parity with JobOptions.needs).
  return { kind: 'job', key: (need as { name: string }).name };
}

/**
 * Resolve declared needs against a frozen snapshot into the `ctx.needs` map.
 *
 * - A single static/named-job need resolves to `{ result: <proxy over jobs[name]> }`.
 * - A `dynamicGroup(...)` need resolves to an ordered array of `{ name, result }`,
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
      }));
    } else {
      out[key] = { result: createSnapshotOutputProxy(key, snapshot.jobs[key]) };
    }
  }
  return out;
}
