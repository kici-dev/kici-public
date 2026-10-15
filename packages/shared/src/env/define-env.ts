/**
 * defineEnv ties a Zod schema to its env-var mapping so a service can parse
 * process.env into a typed config, reject unknown KICI_* env vars (typo
 * catcher), and emit field metadata for docs/operator/env-reference.md.
 *
 * Each service still owns its schema (defaults, refinements, cross-field
 * rules); this only standardises the env-name <-> field-name plumbing and the
 * "did you mean ...?" UX.
 *
 * `envMap` accepts:
 *   - a string: the single env var backing a top-level field;
 *   - a string[]: aliases, first non-undefined wins (legacy; no current user);
 *   - an object: a nested map for z.object(...) fields (orchestrator's
 *     `cluster: { instanceId: '...', ... }`), recursing arbitrarily.
 *
 * The parser may be a plain z.object(...) or a `.superRefine`'d composition;
 * `.shape` is read only for `describe()`.
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
   * The underlying ZodObject, before any `.superRefine(...)`, walked for docs
   * metadata. Pass the refined schema as `parser` for `parse()` to run it.
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
  /**
   * Parse `env` (defaults to `process.env`) into a typed config.
   * `parserOverride` replaces the parser for this call only, to validate the
   * same env map under a different cross-field rule set.
   */
  parse(env?: NodeJS.ProcessEnv, parserOverride?: z.ZodType): T;
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
 * zod 4 types `z.ZodRawShape` values as the internal `$ZodType`, narrower than
 * `z.ZodType`; only `.def` and `.shape` are read, so `unknown` is honest.
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
      // Zod 4 exposes a function default (`.default(() => randomUUID())`) as a
      // getter that calls it on every access, so two differing reads mark a
      // computed default; rendering it would make the docs non-deterministic.
      // `typeof === 'function'` covers the Zod 3 shape.
      const probe1 = def.defaultValue;
      const probe2 = def.defaultValue;
      if (typeof probe1 === 'function' || probe1 !== probe2) return '"<computed>"';
      if (probe1 === '' || probe1 === undefined) return undefined;
      return JSON.stringify(probe1);
    }
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
 * Unwrap `.optional()` / `.default(...)` / `.prefault(...)` to a nested
 * ZodObject's `.shape`, or undefined when there is none, so a wrapped nested
 * object is still walked for docs. Mirrors the unwrap loop in `extractDefault`
 * / `isOptional`.
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
      // Unwrapping keeps the `z.object({...}).prefault({})` pattern emitting its fields.
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
  function parse(
    env: NodeJS.ProcessEnv = process.env,
    parserOverride?: z.ZodType,
  ): z.infer<z.ZodObject<TShape>> {
    const parserSchema: z.ZodType = parserOverride ?? opts.parser ?? opts.schema;
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

/** Levenshtein distance; O(n*m) is fine for short env var names. */
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
  // A distance large relative to the name length is noise.
  if (best && best.dist <= Math.max(2, Math.floor(name.length / 4))) return best.name;
  return undefined;
}

/**
 * `KICI_*` env vars outside every service schema but legitimately set by
 * packaging, tooling or dev shims, so the typo-catcher always allows them.
 *
 * - `KICI_CACHE`: set by the packaged CLI shim (packages/… .cmd and the POSIX
 *   equivalent from scripts/package.mjs) to the cached Node.js binary;
 *   inherited by the orchestrator/agent on Windows (shell-local on POSIX).
 * - `KICI_DEV`: the dev-mode toggle the scanner itself reads to go warn-only.
 * - `KICI_BUILD_COUNTER_NO_COMMIT`: read only by the build counter (skip the
 *   per-build `.build-counter` commit on a force-synced checkout); set in the
 *   shell for `pnpm build` and inherited by a native orchestrator spawn.
 * - `KICI_CONFIG_DIR`: the empty config dir the vitest harness sets
 *   (`hack/lib/vitest-isolation.ts`) so the CLI's `getConfigDir` avoids the
 *   ambient `~/.kici`; a real CLI var every test-spawned service inherits
 *   without reading it.
 * - `KICI_ORCHESTRATOR_TOKEN`: the `kici` CLI's credential for a direct
 *   orchestrator target, exported beside `KICI_ORCHESTRATOR_URL`; no service
 *   reads it, but a service started from that shell inherits it.
 *
 * Every addition is a typo we can no longer catch: list only names (a) our own
 * tooling sets in the wild and (b) that could never be a config typo. A var one
 * service reads belongs in that service's `extraKnown` — as `KICI_CONFIG` is at
 * the orchestrator's call site, so the agent and Platform still reject it.
 */
export const RESERVED_NON_SCHEMA_KICI_VARS: readonly string[] = [
  'KICI_CACHE',
  'KICI_DEV',
  'KICI_BUILD_COUNTER_NO_COMMIT',
  'KICI_CONFIG_DIR',
  'KICI_ORCHESTRATOR_TOKEN',
];

/**
 * `KICI_*` prefixes outside the service-config namespace; any var starting with
 * one is known, whatever its suffix. Keep this short: each prefix widens the
 * set of uncatchable typos.
 *
 * - `KICI_E2E_`: a test harness's own toggles (`KICI_E2E_PROVIDER`, …), which
 *   leak into an orchestrator the harness spawns natively.
 * - `KICI_AGENT_ENV_`: the agent-env forwarding namespace (`@kici-dev/engine`
 *   → `KICI_AGENT_ENV_PREFIX`): stripped from the orchestrator's env and
 *   forwarded into the spawned agent (bare-metal, container, or Firecracker
 *   MMDS). The suffix is user-controlled, so the schema cannot enumerate it.
 */
export const RESERVED_NON_SCHEMA_KICI_PREFIXES: readonly string[] = [
  'KICI_E2E_',
  'KICI_AGENT_ENV_',
];

/**
 * `KICI_*` suffixes outside the service-config namespace, matched as
 * `${suffix}$|${suffix}_` like the agent's probe collector. Keep this short:
 * each suffix widens the set of uncatchable typos.
 *
 * - `_ENV_PROBE`: diagnostic probe vars the agent logs at startup
 *   (`packages/agent/src/server.ts`). `KICI_AGENT_ENV_KICI_FC_ENV_PROBE` set on
 *   the orchestrator reaches the agent as `KICI_FC_ENV_PROBE`; without this
 *   entry the agent would refuse to start on its own probe.
 */
const RESERVED_NON_SCHEMA_KICI_SUFFIXES: readonly string[] = ['_ENV_PROBE'];

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
  /**
   * Advice for names the caller recognises but does not accept (a documented
   * variable of another layer), reported instead of a Levenshtein guess, which
   * finds nothing for them. Changes the message only: the name is still rejected.
   */
  notStartupVars?: Record<string, string>;
}

/**
 * Reject KICI_* keys in `env` that are not in `known`, with one message listing
 * each unknown var and its closest match when the distance is small.
 *
 * Throws by default: a deployment never reaches runtime with a typo'd KICI_*
 * var. `KICI_DEV=true` (or `warnOnly: true`) downgrades it to a warning.
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
  const advice = options.notStartupVars ?? {};
  const unknown: { name: string; suggestion?: string; note?: string }[] = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith('KICI_')) continue;
    if (knownSet.has(key)) continue;
    if (RESERVED_NON_SCHEMA_KICI_PREFIXES.some((p) => key.startsWith(p))) continue;
    if (RESERVED_NON_SCHEMA_KICI_SUFFIXES.some((s) => key.endsWith(s) || key.includes(`${s}_`))) {
      continue;
    }
    const note = advice[key];
    unknown.push({
      name: key,
      note,
      suggestion: note ? undefined : suggestClosest(key, [...knownSet]),
    });
  }
  if (unknown.length === 0) return;

  const lines = unknown.map(({ name, suggestion, note }) => {
    if (note) return `  - ${name}    (${note})`;
    return suggestion
      ? `  - ${name}    (did you mean ${suggestion}?)`
      : `  - ${name}    (no close match in the schema)`;
  });
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
