import type { GenericInitConfig, InitItem, Job, MiseInitConfig } from '@kici-dev/sdk';

/** A normalized init step, for agent-side expansion. */
export type InitDirective =
  | { kind: 'generic'; config: GenericInitConfig }
  | { kind: 'preset'; name: 'mise'; config: MiseInitConfig }
  | { kind: 'auto' };

function isPresetString(item: unknown): item is 'mise' {
  return item === 'mise';
}

function isMiseObject(item: unknown): item is { mise: MiseInitConfig } {
  return typeof item === 'object' && item !== null && 'mise' in item;
}

function normalizeOne(item: InitItem): InitDirective {
  if (isPresetString(item)) return { kind: 'preset', name: 'mise', config: {} };
  if (isMiseObject(item)) return { kind: 'preset', name: 'mise', config: item.mise };
  return { kind: 'generic', config: item as GenericInitConfig };
}

/**
 * Pure (no filesystem). `false`/`undefined` -> []; `'auto'` -> one auto
 * directive; presets/generic configs -> their directive; arrays map
 * element-wise. `'auto'` is a scalar only — inside an array it throws.
 */
export function normalizeInitItems(job: Job | undefined): InitDirective[] {
  const init = job?.init;
  if (init === undefined || init === false) return [];
  if (init === 'auto') return [{ kind: 'auto' }];
  if (Array.isArray(init)) {
    return init.map((item) => {
      // Backs the compile-time ban for callers that cast around the type (e.g. `as never`).
      if ((item as unknown) === 'auto') {
        throw new Error("init: 'auto' cannot be combined in an array — use it as the sole value");
      }
      return normalizeOne(item);
    });
  }
  return [normalizeOne(init)];
}
