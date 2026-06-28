import type { InputDescriptorT, InputsDescriptorMap } from './descriptor.js';
import { coerceDispatchInputs } from './coerce.js';

/**
 * A schedule input resolves with no operator value, so it must be satisfiable
 * from an empty value set: it either declares a default or is optional. Bare
 * required and bare nullable inputs are not satisfiable (Zod still requires the
 * key to be present).
 */
export function isInputSatisfiableFromDefaults(d: InputDescriptorT): boolean {
  return d.default !== undefined || d.optional === true;
}

/** Throw naming the first schedule input that can never resolve on a fire. */
export function assertScheduleInputsSatisfiable(map: InputsDescriptorMap): void {
  for (const [name, d] of Object.entries(map)) {
    if (!isInputSatisfiableFromDefaults(d)) {
      throw new Error(
        `schedule input "${name}" must declare a .default() or be .optional() ` +
          `— schedule triggers fire with no operator input`,
      );
    }
  }
}

/**
 * Resolve defaults-only schedule inputs (no operator pairs). Returns undefined
 * when the trigger declares no inputs or nothing resolves to a value. Throws
 * `DispatchInputError` on an invalid descriptor — compile-time validation
 * (`assertScheduleInputsSatisfiable`) makes this unreachable for a
 * freshly-compiled lock; no silent fallback.
 */
export function resolveScheduleInputs(
  map: InputsDescriptorMap | undefined,
): Record<string, unknown> | undefined {
  if (!map || Object.keys(map).length === 0) return undefined;
  const r = coerceDispatchInputs({}, map);
  if ('error' in r) throw r.error;
  return Object.keys(r.values).length > 0 ? r.values : undefined;
}
