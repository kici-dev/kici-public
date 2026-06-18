/**
 * Dynamic group helpers for cross-domain needs.
 *
 * A DynamicGroupRef allows static jobs to declare a dependency on a dynamic
 * job group by name, without knowing the concrete generated job names.
 *
 * Usage in workflow definition:
 *   needs: [dynamicGroup('test-shards')]
 *   needs: [dynamicGroup('test-shards', { ifFailed: 'run' })]
 */

const DYNAMIC_GROUP_TAG = Symbol.for('kici:dynamicGroup');

export interface DynamicGroupRef {
  readonly [DYNAMIC_GROUP_TAG]: true;
  readonly group: string;
  readonly ifFailed?: 'skip' | 'run';
}

/**
 * Create a reference to a dynamic job group for use in a static job's `needs` array.
 *
 * @param name - The group name (must match the name used in `dynamicJob(name, fn)`)
 * @param opts - Optional failure policy override
 */
export function dynamicGroup(name: string, opts?: { ifFailed?: 'skip' | 'run' }): DynamicGroupRef {
  return {
    [DYNAMIC_GROUP_TAG]: true,
    group: name,
    ...(opts?.ifFailed && { ifFailed: opts.ifFailed }),
  };
}

/** Type guard to check if a value is a DynamicGroupRef. */
export function isDynamicGroupRef(value: unknown): value is DynamicGroupRef {
  return typeof value === 'object' && value !== null && DYNAMIC_GROUP_TAG in value;
}

export { DYNAMIC_GROUP_TAG };
