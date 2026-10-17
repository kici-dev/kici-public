import type {
  AptInitConfig,
  GenericInitConfig,
  InitItem,
  Job,
  MiseInitConfig,
} from '@kici-dev/sdk';

/** A normalized init step, for agent-side expansion. */
export type InitDirective =
  | { kind: 'generic'; config: GenericInitConfig }
  | { kind: 'preset'; name: 'mise'; config: MiseInitConfig }
  | { kind: 'preset'; name: 'apt'; config: AptInitConfig }
  | { kind: 'auto' };

function isPresetString(item: unknown): item is 'mise' {
  return item === 'mise';
}

function isMiseObject(item: unknown): item is { mise: MiseInitConfig } {
  return typeof item === 'object' && item !== null && 'mise' in item;
}

function isAptObject(item: unknown): item is { apt: AptInitConfig } {
  return typeof item === 'object' && item !== null && 'apt' in item;
}

function isGenericConfig(item: unknown): item is GenericInitConfig {
  return (
    typeof item === 'object' && item !== null && typeof (item as { run?: unknown }).run === 'string'
  );
}

function describeItem(item: unknown): string {
  if (typeof item === 'object' && item !== null) return `{ ${Object.keys(item).join(', ')} }`;
  return typeof item === 'string' ? `'${item}'` : String(item);
}

/**
 * One init item to its directive. An item this agent does not know, such as a
 * preset added in a newer release, throws a named error that fails the job.
 */
function normalizeOne(item: InitItem, index: number): InitDirective {
  if (isPresetString(item)) return { kind: 'preset', name: 'mise', config: {} };
  if (isMiseObject(item)) return { kind: 'preset', name: 'mise', config: item.mise };
  if (isAptObject(item)) return { kind: 'preset', name: 'apt', config: item.apt };
  if (isGenericConfig(item)) return { kind: 'generic', config: item };
  throw new Error(
    `init[${index}]: unknown init item ${describeItem(item)}; this agent knows 'mise', ` +
      `{ mise }, { apt }, 'auto' and { run } — upgrade the agent to run a newer preset`,
  );
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
    return init.map((item, i) => {
      // Backs the compile-time ban for callers that cast around the type (e.g. `as never`).
      if ((item as unknown) === 'auto') {
        throw new Error("init: 'auto' cannot be combined in an array — use it as the sole value");
      }
      return normalizeOne(item, i);
    });
  }
  return [normalizeOne(init, 0)];
}
