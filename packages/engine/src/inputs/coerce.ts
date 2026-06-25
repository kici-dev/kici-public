import { buildZodObjectFromMap } from './build.js';
import type { InputsDescriptorMap } from './descriptor.js';

/** A single normalized validation issue for one dispatch input key. */
export interface DispatchInputIssue {
  key: string;
  code: string;
  message: string;
}

/** Structured rejection for invalid dispatch inputs (CLI + dashboard rendering). */
export class DispatchInputError extends Error {
  constructor(public readonly issues: DispatchInputIssue[]) {
    super(`Invalid dispatch inputs: ${issues.map((i) => `${i.key}: ${i.message}`).join('; ')}`);
    this.name = 'DispatchInputError';
  }
}

/** Split `key=value` pairs; throws `DispatchInputError` on a missing `=`. */
export function parseInputPairs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq <= 0) {
      throw new DispatchInputError([
        { key: p, code: 'malformed', message: `expected key=value, got "${p}"` },
      ]);
    }
    out[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return out;
}

/**
 * Coerce + validate raw operator pairs against the descriptor map, applying
 * defaults. Strict: unknown keys are errors. Returns typed values or a
 * structured `DispatchInputError`.
 */
export function coerceDispatchInputs(
  raw: Record<string, string>,
  map: InputsDescriptorMap,
): { values: Record<string, unknown> } | { error: DispatchInputError } {
  const parsed = buildZodObjectFromMap(map).safeParse(raw);
  if (parsed.success) return { values: parsed.data };
  const issues: DispatchInputIssue[] = parsed.error.issues.flatMap((i) => {
    // `unrecognized_keys` carries the offending key(s) on `keys`, not on `path`
    // (its `path` is the empty root) — surface one issue per unknown key.
    if (i.code === 'unrecognized_keys' && Array.isArray((i as { keys?: unknown }).keys)) {
      return (i as { keys: string[] }).keys.map((k) => ({
        key: k,
        code: i.code,
        message: `unknown input "${k}"`,
      }));
    }
    return [{ key: String(i.path[0] ?? '(root)'), code: i.code, message: i.message }];
  });
  return { error: new DispatchInputError(issues) };
}
