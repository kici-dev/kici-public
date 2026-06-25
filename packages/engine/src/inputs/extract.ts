import type { InputDescriptorT, InputsDescriptorMap } from './descriptor.js';

/** Thrown when a declared dispatch input falls outside the closed Zod subset. */
export class UnsupportedDispatchInputError extends Error {
  constructor(
    public readonly construct: string,
    public readonly key?: string,
  ) {
    super(
      `Unsupported dispatch input${key ? ` "${key}"` : ''}: ${construct}. ` +
        `Allowed: z.string/number/boolean/enum/literal with ` +
        `.optional/.nullable/.default/.min/.max/.regex/.int.`,
    );
    this.name = 'UnsupportedDispatchInputError';
  }
}

interface ZodDef {
  type: string;
  innerType?: unknown;
  defaultValue?: unknown;
  checks?: unknown[];
  entries?: Record<string, unknown>;
  values?: unknown[];
  value?: unknown;
}

interface ZodCheckDef {
  check?: string;
  format?: string;
  value?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  pattern?: { source?: string } | string;
}

const defOf = (s: unknown): ZodDef | undefined => (s as { _zod?: { def?: ZodDef } })?._zod?.def;

const checkDefOf = (c: unknown): ZodCheckDef | undefined =>
  (c as { _zod?: { def?: ZodCheckDef } })?._zod?.def;

/** Pull string/number checks (min/max/int/regex) into descriptor fields. */
function applyChecks(d: InputDescriptorT, checks: unknown[] | undefined, key?: string): void {
  for (const c of checks ?? []) {
    const cd = checkDefOf(c);
    switch (cd?.check) {
      case 'greater_than':
        d.min = Number(cd.value);
        break;
      case 'less_than':
        d.max = Number(cd.value);
        break;
      case 'min_length':
        d.min = Number(cd.minimum);
        break;
      case 'max_length':
        d.max = Number(cd.maximum);
        break;
      case 'string_format':
        if (cd.format === 'regex' && cd.pattern) {
          d.pattern = String(
            typeof cd.pattern === 'object' ? (cd.pattern.source ?? cd.pattern) : cd.pattern,
          );
        } else {
          throw new UnsupportedDispatchInputError(`string format:${cd.format ?? 'unknown'}`, key);
        }
        break;
      case 'number_format':
        if (cd.format === 'safeint' || cd.format === 'int') d.type = 'integer';
        else
          throw new UnsupportedDispatchInputError(`number format:${cd.format ?? 'unknown'}`, key);
        break;
      default:
        throw new UnsupportedDispatchInputError(`check:${cd?.check ?? 'unknown'}`, key);
    }
  }
}

/**
 * Walk a Zod schema's `_zod.def`, reject any construct outside the closed
 * subset, and extract a JSON-safe `InputDescriptor`.
 */
export function extractInputDescriptor(schema: unknown, key?: string): InputDescriptorT {
  let cur = schema;
  let optional = false;
  let nullable = false;
  let hasDefault = false;
  let defaultValue: unknown;
  // Unwrap the modifier chain (optional / nullable / default).
  for (;;) {
    const d = defOf(cur);
    if (!d) throw new UnsupportedDispatchInputError('non-zod value', key);
    if (d.type === 'optional') {
      optional = true;
      cur = d.innerType;
      continue;
    }
    if (d.type === 'nullable') {
      nullable = true;
      cur = d.innerType;
      continue;
    }
    if (d.type === 'default') {
      hasDefault = true;
      defaultValue =
        typeof d.defaultValue === 'function' ? (d.defaultValue as () => unknown)() : d.defaultValue;
      cur = d.innerType;
      continue;
    }
    break;
  }
  const d = defOf(cur);
  if (!d) throw new UnsupportedDispatchInputError('non-zod value', key);
  const out: InputDescriptorT = { type: 'string', optional, nullable };
  if (hasDefault) out.default = defaultValue;
  switch (d.type) {
    case 'string':
      out.type = 'string';
      applyChecks(out, d.checks, key);
      break;
    case 'number':
      out.type = 'number';
      applyChecks(out, d.checks, key);
      break;
    case 'boolean':
      out.type = 'boolean';
      break;
    case 'enum':
      out.type = 'enum';
      out.values = Object.values(d.entries ?? {}) as InputDescriptorT['values'];
      break;
    case 'literal':
      out.type = 'literal';
      out.literal = (d.values?.[0] ?? d.value) as InputDescriptorT['literal'];
      break;
    default:
      throw new UnsupportedDispatchInputError(`z.${d.type}`, key);
  }
  return out;
}

/** Extract a descriptor for every key in a `{ name: ZodSchema }` map. */
export function extractInputsDescriptorMap(map: Record<string, unknown>): InputsDescriptorMap {
  const out: InputsDescriptorMap = {};
  for (const [k, v] of Object.entries(map)) out[k] = extractInputDescriptor(v, k);
  return out;
}
