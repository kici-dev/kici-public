/**
 * defineEnv — small helper that ties a Zod schema to its env-var mapping so
 * services can:
 *   1. parse process.env into a typed config (the existing pattern, just
 *      centralised),
 *   2. reject unknown KICI_* env vars (typo catcher),
 *   3. emit machine-readable field metadata for docs/operator/env-reference.md.
 *
 * The helper deliberately stays small. Each service still owns its schema
 * (defaults, refinements, cross-field rules); we only standardise the boring
 * env-name <-> field-name plumbing and the "did you mean ...?" UX.
 *
 * `envMap` accepts:
 *   - a string: the single env var that backs this top-level field, OR
 *   - a string[]: multiple aliases, first non-undefined wins (legacy
 *     pattern; the only historical user was the agent's
 *     KICI_JOB_HEARTBEAT_INTERVAL_MS alias, collapsed in P3 of the
 *     env-var standardization plan). OR
 *   - an object: nested map for fields that are themselves z.object(...)
 *     (orchestrator's `cluster: { instanceId: '...', ... }`). Nested objects
 *     can recurse arbitrarily, but in practice we only need one level.
 *
 * The schema may be a plain z.object(...) OR a `.superRefine`'d composition
 * built on top of one (orchestrator does this for cross-field rules). We keep
 * the input type as `z.ZodType` so both shapes are accepted; we reach into
 * `.shape` only when the caller asks for `describe()` output.
 */

import { z } from 'zod';

/** Recursive env-var map. Leaf is the env var name (or array of aliases). */
export type EnvMapValue = string | string[] | EnvMap;
export interface EnvMap {
  [field: string]: EnvMapValue;
}

/** Description of a single env var, suitable for docs generation. */
export interface EnvFieldSpec {
  /** Env var name (the canonical one when there are aliases). */
  envVar: string;
  /** Aliases (other env vars that map to the same field). */
  aliases: string[];
  /** Dotted JS path inside the parsed config (e.g. `cluster.instanceId`). */
  fieldPath: string;
  /** Whether the field is required (no default, not optional). */
  required: boolean;
  /** Default value, if present, formatted as a string. */
  defaultValue?: string;
  /** Type label (e.g. `string`, `number`, `enum:a|b`, `boolean`). */
  type: string;
  /** Description from the schema's `.describe()`, or an explicit override. */
  description?: string;
}

export interface DefineEnvOptions<TShape extends z.ZodRawShape> {
  /** Service identifier (free-form, used for docs grouping + error messages). */
  service: string;
  /**
   * The Zod object schema. Pass the underlying ZodObject before any
   * `.superRefine(...)` chain so we can walk `.shape` for docs metadata. The
   * returned `parse()` runs the full schema (with refinements) — pass that as
   * the `parser`.
   */
  schema: z.ZodObject<TShape>;
  /** Optional outer schema (e.g., `schema.superRefine(...)` for cross-field). */
  parser?: z.ZodType;
  /** Mapping from field name (or nested path) to env var(s). */
  envMap: EnvMap;
  /** Optional per-field description override (keyed by dotted path). */
  descriptions?: Record<string, string>;
}

export interface DefineEnvResult<T> {
  /** Parse `env` (defaults to `process.env`) into a typed config. */
  parse(env?: NodeJS.ProcessEnv): T;
  /** Machine-readable field specs for docs generation. */
  describe(): EnvFieldSpec[];
  /** Flat list of every env var the schema reads (for the unknown-var scanner). */
  listKnownEnvVars(): string[];
  /** Subset of `listKnownEnvVars()` starting with `KICI_`. */
  listKnownKiciVars(): string[];
}

/** Read an env value following the alias precedence (first non-undefined wins). */
function readEnv(envMap: EnvMapValue, env: NodeJS.ProcessEnv): unknown {
  if (typeof envMap === 'string') return env[envMap];
  if (Array.isArray(envMap)) {
    for (const name of envMap) {
      const v = env[name];
      if (v !== undefined) return v;
    }
    return undefined;
  }
  // Nested object — recurse into each child.
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(envMap)) {
    result[k] = readEnv(v, env);
  }
  return result;
}

/** Walk an EnvMap and yield every leaf env var name. */
function* walkEnvNames(envMap: EnvMap): Generator<string> {
  for (const value of Object.values(envMap)) {
    if (typeof value === 'string') {
      yield value;
    } else if (Array.isArray(value)) {
      for (const name of value) yield name;
    } else {
      yield* walkEnvNames(value);
    }
  }
}

/**
 * In zod 4, `z.ZodRawShape` values are typed as the internal `$ZodType`,
 * which is structurally narrower than `z.ZodType`. We only ever read `.def`
 * and `.shape` off these values, so `unknown` is the honest signature.
 */
type ZodLike = unknown;

/** Best-effort type label for docs. Walks through default / optional / pipe / transform wrappers. */
function describeType(field: ZodLike): string {
  let t: ZodLike = field;
  for (let i = 0; i < 8; i++) {
    const def = (
      t as {
        def?: {
          type?: string;
          innerType?: ZodLike;
          in?: ZodLike;
          out?: ZodLike;
          entries?: Record<string, string>;
          values?: string[];
        };
      }
    ).def;
    if (!def) return 'unknown';
    switch (def.type) {
      case 'string':
        return 'string';
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'enum': {
        const values = def.entries ? Object.keys(def.entries) : (def.values ?? []);
        return `enum:${values.join('|')}`;
      }
      case 'object':
        return 'object';
      case 'optional':
      case 'default':
      case 'nullable':
        if (def.innerType) {
          t = def.innerType;
          continue;
        }
        return def.type ?? 'unknown';
      case 'pipe':
        if (def.in) {
          // string -> coerce -> number: prefer the source type for docs.
          t = def.in;
          continue;
        }
        return 'string';
      case 'transform':
        return 'string';
      case 'union':
        return 'union';
      default:
        return def.type ?? 'unknown';
    }
  }
  return 'unknown';
}

/** Best-effort default value extraction for docs. Recurses into pipe/transform wrappers. */
function extractDefault(field: ZodLike): string | undefined {
  let t: ZodLike = field;
  for (let i = 0; i < 6; i++) {
    const def = (
      t as {
        def?: {
          type?: string;
          defaultValue?: unknown;
          innerType?: ZodLike;
          in?: ZodLike;
          out?: ZodLike;
        };
      }
    ).def;
    if (!def) return undefined;
    if (def.type === 'default' && def.defaultValue !== undefined) {
      // Zod 4 exposes function-based defaults (`.default(() => randomUUID())`)
      // through a getter that invokes the function on every access. Two
      // consecutive reads returning different values is the reliable
      // signal that the default is computed; rendering the actual value
      // would make the generated docs non-deterministic. `typeof === 'function'`
      // (the Zod 3 shape) is also kept as a belt-and-braces signal.
      const probe1 = def.defaultValue;
      const probe2 = def.defaultValue;
      if (typeof probe1 === 'function' || probe1 !== probe2) return '"<computed>"';
      if (probe1 === '' || probe1 === undefined) return undefined;
      return JSON.stringify(probe1);
    }
    // Walk through pipe / transform / optional / nullable to find an inner default.
    if (def.in) {
      t = def.in;
      continue;
    }
    if (def.innerType) {
      t = def.innerType;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function isOptional(field: ZodLike): boolean {
  let t: ZodLike = field;
  for (let i = 0; i < 6; i++) {
    const def = (t as { def?: { type?: string; innerType?: ZodLike; in?: ZodLike } }).def;
    if (!def) return false;
    if (def.type === 'optional' || def.type === 'default' || def.type === 'prefault') return true;
    if (def.in) {
      t = def.in;
      continue;
    }
    if (def.innerType) {
      t = def.innerType;
      continue;
    }
    return false;
  }
  return false;
}

/**
 * Walk through `.optional()` / `.default(...)` / `.prefault(...)` wrappers to
 * find a nested ZodObject's `.shape`. Returns undefined if `field` does not
 * (eventually) wrap a ZodObject. Mirrors the unwrap loop in
 * `extractDefault` / `isOptional` so that a nested object can be wrapped in
 * any of the common compositional modifiers and still be walked for docs.
 */
function findInnerShape(field: ZodLike): z.ZodRawShape | undefined {
  let t: ZodLike = field;
  for (let i = 0; i < 8; i++) {
    const node = t as {
      shape?: z.ZodRawShape;
      def?: { type?: string; shape?: z.ZodRawShape; innerType?: ZodLike };
    };
    if (node.shape) return node.shape;
    if (node.def?.shape) return node.def.shape;
    if (node.def?.innerType) {
      t = node.def.innerType;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function describeFieldRecursive(
  shape: z.ZodRawShape,
  envMap: EnvMap,
  fieldPath: string,
  descriptions: Record<string, string> | undefined,
  out: EnvFieldSpec[],
): void {
  for (const [name, field] of Object.entries(shape)) {
    const path = fieldPath ? `${fieldPath}.${name}` : name;
    const mapping = envMap[name];
    if (mapping === undefined) continue;
    if (typeof mapping === 'string' || Array.isArray(mapping)) {
      const aliases = Array.isArray(mapping) ? mapping : [mapping];
      const explicitDesc = descriptions?.[path];
      // zod's .describe() stores text on def.description in zod 4
      const zodDesc = (field as { description?: string }).description;
      const def2 = (field as { def?: { description?: string } }).def;
      out.push({
        envVar: aliases[0],
        aliases: aliases.slice(1),
        fieldPath: path,
        required: !isOptional(field) && extractDefault(field) === undefined,
        defaultValue: extractDefault(field),
        type: describeType(field),
        description: explicitDesc ?? zodDesc ?? def2?.description,
      });
    } else {
      // Nested object — recurse if the field is (or wraps) a ZodObject.
      // findInnerShape unwraps `.optional()`, `.default(...)`, and
      // `.prefault(...)` modifiers so the cluster-style
      // `z.object({...}).prefault({})` pattern still emits its inner fields.
      const innerShape = findInnerShape(field);
      if (innerShape) {
        describeFieldRecursive(innerShape, mapping, path, descriptions, out);
      }
    }
  }
}

/**
 * Build a `defineEnv` helper for a service.
 *
 * Example:
 *   const envDef = defineEnv({
 *     service: 'agent',
 *     schema: configSchema,
 *     envMap: {
 *       orchestratorUrl: 'KICI_ORCHESTRATOR_URL',
 *       cluster: { instanceId: 'KICI_CLUSTER_INSTANCE_ID' },
 *     },
 *   });
 *   const config = envDef.parse();
 */
export function defineEnv<TShape extends z.ZodRawShape>(
  opts: DefineEnvOptions<TShape>,
): DefineEnvResult<z.infer<z.ZodObject<TShape>>> {
  const parserSchema: z.ZodType = opts.parser ?? opts.schema;

  function parse(env: NodeJS.ProcessEnv = process.env): z.infer<z.ZodObject<TShape>> {
    const raw = readEnv(opts.envMap, env) as Record<string, unknown>;
    const result = parserSchema.safeParse(raw);
    if (!result.success) {
      const errors = result.error.issues
        .map((err) => `  - ${err.path.join('.')}: ${err.message}`)
        .join('\n');
      throw new Error(`Configuration validation failed:\n${errors}`);
    }
    return result.data as z.infer<z.ZodObject<TShape>>;
  }

  function describe(): EnvFieldSpec[] {
    const out: EnvFieldSpec[] = [];
    describeFieldRecursive(opts.schema.shape, opts.envMap, '', opts.descriptions, out);
    return out.sort((a, b) => a.envVar.localeCompare(b.envVar));
  }

  function listKnownEnvVars(): string[] {
    return [...new Set(walkEnvNames(opts.envMap))].sort();
  }

  function listKnownKiciVars(): string[] {
    return listKnownEnvVars().filter((n) => n.startsWith('KICI_'));
  }

  return { parse, describe, listKnownEnvVars, listKnownKiciVars };
}

/**
 * Levenshtein distance between two strings. Small + dependency-free; we only
 * use it to suggest alternates for unknown KICI_* env vars at boot. O(n*m) is
 * fine because both strings are short env var names.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function suggestClosest(name: string, candidates: string[]): string | undefined {
  let best: { name: string; dist: number } | undefined;
  for (const c of candidates) {
    const d = levenshtein(name, c);
    if (best === undefined || d < best.dist) best = { name: c, dist: d };
  }
  // Suggest only if the distance is small relative to the name length —
  // otherwise the suggestion is noise.
  if (best && best.dist <= Math.max(2, Math.floor(name.length / 4))) return best.name;
  return undefined;
}

/**
 * `KICI_*` env vars that are NOT part of any service's config schema but are
 * legitimately set by packaging / tooling / dev shims. The scanner always
 * allowlists these so the typo-catcher doesn't false-positive on them.
 *
 * - `KICI_CACHE`: set by the packaged CLI shim (packages/… .cmd and the
 *   POSIX equivalent emitted by scripts/package.mjs) to point at the cached
 *   Node.js binary. Inherited by the orchestrator/agent process on Windows
 *   (on POSIX it's a shell-local var that doesn't leak).
 * - `KICI_DEV`: the dev-mode toggle itself — read by the scanner to flip
 *   to warn-only, so it must not trip the scanner.
 *
 * Keep this list small and well-justified. Every addition is a typo we can
 * no longer catch, so only list things that are (a) actually set in the
 * wild by our own tooling and (b) could never be a config typo.
 */
export const RESERVED_NON_SCHEMA_KICI_VARS: readonly string[] = ['KICI_CACHE', 'KICI_DEV'];

/**
 * `KICI_*` prefixes that are entirely outside the service-config namespace —
 * usually set by our own test / dev tooling and inherited into a child
 * orchestrator/agent/platform process by mistake of inheritance rather than
 * design. Any env var starting with one of these prefixes is treated as
 * known, regardless of the specific suffix.
 *
 * - `KICI_E2E_`: the E2E framework's namespace (`KICI_E2E_PROVIDER`,
 *   `KICI_E2E_MODE`, future E2E toggles). Set by `e2e/vitest.*.config.ts`
 *   files. The native orchestrator spawn in `e2e/helpers/deploy.ts`
 *   inherits the test runner's process.env, so these leak in.
 * - `KICI_AGENT_ENV_`: the agent-env forwarding namespace (see
 *   `@kici-dev/engine` → `KICI_AGENT_ENV_PREFIX`). Any env var set on the
 *   orchestrator process with this prefix is stripped and forwarded into
 *   the spawned agent (bare-metal, container, or Firecracker MMDS). The
 *   suffix is by design arbitrary and user-controlled, so it cannot be
 *   enumerated in the schema.
 *
 * As with RESERVED_NON_SCHEMA_KICI_VARS, keep this short — each prefix
 * widens the set of names we can no longer catch as typos.
 */
export const RESERVED_NON_SCHEMA_KICI_PREFIXES: readonly string[] = [
  'KICI_E2E_',
  'KICI_AGENT_ENV_',
];

/**
 * `KICI_*` suffix patterns that mark vars outside the service-config namespace.
 * A var is treated as known when its name ends with any listed suffix
 * (or the suffix appears as a boundary segment — matching
 * `${suffix}$|${suffix}_`, same rule as the agent's probe collector).
 *
 * - `_ENV_PROBE`: diagnostic probe vars (see `packages/agent/src/server.ts` —
 *   the agent collects every `KICI_*_ENV_PROBE` var and logs its value in
 *   "Agent startup env probes (diagnostic)"). The E2E firecracker-pipeline
 *   test uses `KICI_AGENT_ENV_KICI_FC_ENV_PROBE=fc-probe-value` which flows
 *   through the scaler's env-forwarding path and lands in the agent's
 *   process.env as `KICI_FC_ENV_PROBE`. Without this suffix allowlist the
 *   validator rejects it as an unknown KICI_* var and the agent refuses to
 *   start — defeating the test's entire purpose.
 *
 * As with RESERVED_NON_SCHEMA_KICI_VARS / _PREFIXES, keep this short. Every
 * suffix widens the set of names we can no longer catch as typos.
 */
export const RESERVED_NON_SCHEMA_KICI_SUFFIXES: readonly string[] = ['_ENV_PROBE'];

export interface ValidateUnknownKiciVarsOptions {
  /** Extra env-var names to treat as known (not all consumers can be migrated in one go). */
  extraKnown?: string[];
  /**
   * When `true` (default in dev mode), unknown KICI_* vars only log a warning
   * via `onWarn`. When `false`, throw — the production behaviour.
   */
  warnOnly?: boolean;
  /** Logger callback for warn-mode (defaults to `console.warn`). */
  onWarn?: (msg: string) => void;
}

/**
 * Inspect `env` for KICI_* keys that are not in `known`. Throws (or warns,
 * see options) with a single combined message listing every unknown var and
 * its closest legitimate match (when the Levenshtein distance is small).
 *
 * Production mode (the default): throws — staging deploys should never reach
 * runtime with a typo'd KICI_* variable. Set `KICI_DEV=true` (or pass
 * `warnOnly: true`) to downgrade to a warning during local development.
 */
export function validateUnknownKiciVars(
  known: string[],
  options: ValidateUnknownKiciVarsOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): void {
  const knownSet = new Set([
    ...known,
    ...(options.extraKnown ?? []),
    ...RESERVED_NON_SCHEMA_KICI_VARS,
  ]);
  const unknown: { name: string; suggestion?: string }[] = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith('KICI_')) continue;
    if (knownSet.has(key)) continue;
    if (RESERVED_NON_SCHEMA_KICI_PREFIXES.some((p) => key.startsWith(p))) continue;
    if (RESERVED_NON_SCHEMA_KICI_SUFFIXES.some((s) => key.endsWith(s) || key.includes(`${s}_`))) {
      continue;
    }
    unknown.push({ name: key, suggestion: suggestClosest(key, [...knownSet]) });
  }
  if (unknown.length === 0) return;

  const lines = unknown.map(({ name, suggestion }) =>
    suggestion
      ? `  - ${name}    (did you mean ${suggestion}?)`
      : `  - ${name}    (no close match in the schema)`,
  );
  const header =
    `Unknown KICI_* env var(s) detected — refusing to start.\n` +
    `Set KICI_DEV=true to downgrade this check to a warning.\n` +
    `Unknown vars:\n${lines.join('\n')}`;

  const warnOnly = options.warnOnly ?? env.KICI_DEV === 'true';
  if (warnOnly) {
    (options.onWarn ?? console.warn)(header);
    return;
  }
  throw new Error(header);
}
