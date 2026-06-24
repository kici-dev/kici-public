/**
 * Dynamic group helpers for cross-domain needs.
 *
 * A DynamicGroupRef allows static jobs to declare a dependency on a dynamic
 * job group by name, without knowing the concrete generated job names.
 *
 * Usage in workflow definition:
 *   needs: [dynamicGroup('test-shards')]
 *   needs: [dynamicGroup('test-shards', { when: 'always' })]
 */

import type { NeedsWhenInput } from './types.js';

const DYNAMIC_GROUP_TAG = Symbol.for('kici:dynamicGroup');

export interface DynamicGroupRef {
  readonly [DYNAMIC_GROUP_TAG]: true;
  readonly group: string;
  /** Run condition for the edge: keyword sugar or a raw upstream-status set. */
  readonly when?: NeedsWhenInput;
}

/**
 * Create a reference to a dynamic job group for use in a static job's `needs` array.
 *
 * @param name - The group name (must match the name used in `dynamicJob(name, fn)`)
 * @param opts - Optional run condition for the edge
 */
export function dynamicGroup(name: string, opts?: { when?: NeedsWhenInput }): DynamicGroupRef {
  return {
    [DYNAMIC_GROUP_TAG]: true,
    group: name,
    ...(opts?.when !== undefined && { when: opts.when }),
  };
}

/** Type guard to check if a value is a DynamicGroupRef. */
export function isDynamicGroupRef(value: unknown): value is DynamicGroupRef {
  return typeof value === 'object' && value !== null && DYNAMIC_GROUP_TAG in value;
}

export { DYNAMIC_GROUP_TAG };
