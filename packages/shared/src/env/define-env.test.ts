import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineEnv, validateUnknownKiciVars } from './define-env.js';
import { isConfigValidationError } from '@kici-dev/core';

describe('defineEnv', () => {
  it('parses a flat schema from env vars', () => {
    const schema = z.object({
      url: z.string(),
      port: z.coerce.number().default(8080),
      flag: z.enum(['on', 'off']).default('off'),
    });
    const envDef = defineEnv({
      service: 'test',
      schema,
      envMap: {
        url: 'KICI_URL',
        port: 'KICI_PORT',
        flag: 'KICI_FLAG',
      },
    });
    const cfg = envDef.parse({ KICI_URL: 'https://example', KICI_PORT: '9090', KICI_FLAG: 'on' });
    expect(cfg).toEqual({ url: 'https://example', port: 9090, flag: 'on' });
  });

  it('throws with the expected error shape on validation failure', () => {
    const schema = z.object({ url: z.string() });
    const envDef = defineEnv({ service: 'test', schema, envMap: { url: 'KICI_URL' } });
    expect(() => envDef.parse({})).toThrow(/Configuration validation failed/);
  });

  it('honors alias precedence (first non-undefined wins)', () => {
    const schema = z.object({ heartbeat: z.coerce.number().default(60000) });
    const envDef = defineEnv({
      service: 'test',
      schema,
      envMap: { heartbeat: ['KICI_HEARTBEAT_MS', 'JOB_HEARTBEAT_MS'] },
    });
    expect(envDef.parse({ KICI_HEARTBEAT_MS: '5000' }).heartbeat).toBe(5000);
    expect(envDef.parse({ JOB_HEARTBEAT_MS: '7000' }).heartbeat).toBe(7000);
    // Both set — first wins.
    expect(envDef.parse({ KICI_HEARTBEAT_MS: '5000', JOB_HEARTBEAT_MS: '7000' }).heartbeat).toBe(
      5000,
    );
  });

  it('reads nested objects from a nested env map', () => {
    const schema = z.object({
      cluster: z.object({
        instanceId: z.string().optional(),
        role: z.enum(['coordinator', 'worker']).default('coordinator'),
      }),
    });
    const envDef = defineEnv({
      service: 'test',
      schema,
      envMap: {
        cluster: {
          instanceId: 'KICI_CLUSTER_INSTANCE_ID',
          role: 'KICI_CLUSTER_ROLE',
        },
      },
    });
    const cfg = envDef.parse({ KICI_CLUSTER_INSTANCE_ID: 'orch-a', KICI_CLUSTER_ROLE: 'worker' });
    expect(cfg.cluster).toEqual({ instanceId: 'orch-a', role: 'worker' });
  });

  it('runs an outer parser (e.g. .superRefine) when supplied', () => {
    const inner = z.object({
      role: z.enum(['coordinator', 'worker']).default('coordinator'),
      coordinatorUrl: z.string().optional(),
    });
    const outer = inner.superRefine((data, ctx) => {
      if (data.role === 'worker' && !data.coordinatorUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'coordinatorUrl required for workers',
          path: ['coordinatorUrl'],
        });
      }
    });
    const envDef = defineEnv({
      service: 'test',
      schema: inner,
      parser: outer,
      envMap: { role: 'KICI_ROLE', coordinatorUrl: 'KICI_COORD' },
    });
    expect(() => envDef.parse({ KICI_ROLE: 'worker' })).toThrow(/coordinatorUrl required/);
    const cfg = envDef.parse({ KICI_ROLE: 'worker', KICI_COORD: 'http://x' });
    expect(cfg.coordinatorUrl).toBe('http://x');
  });

  it('runs a per-call parser override when supplied', () => {
    const inner = z.object({
      role: z.enum(['coordinator', 'worker']).default('coordinator'),
      coordinatorUrl: z.string().optional(),
    });
    const strict = inner.superRefine((data, ctx) => {
      if (data.role === 'worker' && !data.coordinatorUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'coordinatorUrl required for workers',
          path: ['coordinatorUrl'],
        });
      }
    });
    const envDef = defineEnv({
      service: 'test',
      schema: inner,
      parser: strict,
      envMap: { role: 'KICI_ROLE', coordinatorUrl: 'KICI_COORD' },
    });
    // Default parser (strict) rejects a worker with no coordinator URL.
    expect(() => envDef.parse({ KICI_ROLE: 'worker' })).toThrow(/coordinatorUrl required/);
    // The override parser omits that cross-field rule, so the same env passes.
    const cfg = envDef.parse({ KICI_ROLE: 'worker' }, inner);
    expect(cfg.role).toBe('worker');
    expect(cfg.coordinatorUrl).toBeUndefined();
  });

  it('lists known KICI_ env vars including aliases and nested fields', () => {
    const schema = z.object({
      heartbeat: z.coerce.number().default(60000),
      cluster: z.object({
        instanceId: z.string().optional(),
      }),
      url: z.string(),
    });
    const envDef = defineEnv({
      service: 'test',
      schema,
      envMap: {
        heartbeat: ['KICI_HEARTBEAT_MS', 'JOB_HEARTBEAT_MS'],
        cluster: { instanceId: 'OTEL_EXPORTER_OTLP_ENDPOINT' },
        url: 'KICI_URL',
      },
    });
    expect(envDef.listKnownEnvVars().sort()).toEqual([
      'JOB_HEARTBEAT_MS',
      'KICI_HEARTBEAT_MS',
      'KICI_URL',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
    ]);
    expect(envDef.listKnownKiciVars().sort()).toEqual(['KICI_HEARTBEAT_MS', 'KICI_URL']);
  });

  it('describe() walks nested ZodObjects wrapped in optional/default/prefault', () => {
    // The orchestrator's cluster pattern, z.object({...}).prefault({}): a
    // wrapped nested object must not drop its inner fields from the operator
    // env reference.
    const schema = z.object({
      optionalGroup: z
        .object({
          a: z.string(),
        })
        .optional(),
      defaultGroup: z
        .object({
          b: z.string(),
        })
        .default({ b: 'x' }),
      prefaultGroup: z
        .object({
          c: z.string().optional(),
        })
        .prefault({}),
    });
    const envDef = defineEnv({
      service: 'test',
      schema,
      envMap: {
        optionalGroup: { a: 'KICI_A' },
        defaultGroup: { b: 'KICI_B' },
        prefaultGroup: { c: 'KICI_C' },
      },
    });
    const envVars = envDef.describe().map((s) => s.envVar);
    expect(envVars.sort()).toEqual(['KICI_A', 'KICI_B', 'KICI_C']);
  });

  it('describe() renders function-based defaults as <computed> for deterministic docs', () => {
    // A rendered UUID would differ per run, so pnpm docs:env:check would fail
    // right after pnpm docs:env (the orchestrator's cluster.instanceId pattern).
    const schema = z.object({
      runId: z
        .string()
        .optional()
        .default(() => `id-${Math.floor(Math.random() * 1_000_000)}`),
      staticPort: z.coerce.number().default(8080),
    });
    const envDef = defineEnv({
      service: 'test',
      schema,
      envMap: { runId: 'KICI_RUN_ID', staticPort: 'KICI_STATIC_PORT' },
    });
    const specs = envDef.describe();
    const byEnv = Object.fromEntries(specs.map((s) => [s.envVar, s]));
    expect(byEnv['KICI_RUN_ID']?.defaultValue).toBe('"<computed>"');
    // Static defaults still render literally.
    expect(byEnv['KICI_STATIC_PORT']?.defaultValue).toBe('8080');
  });

  it('describe() emits a sorted list with required/default/type metadata', () => {
    const schema = z.object({
      url: z.string(),
      port: z.coerce.number().default(8080),
      flag: z.enum(['on', 'off']).default('off'),
      cluster: z.object({
        instanceId: z.string().optional(),
      }),
    });
    const envDef = defineEnv({
      service: 'test',
      schema,
      envMap: {
        url: 'KICI_URL',
        port: 'KICI_PORT',
        flag: 'KICI_FLAG',
        cluster: { instanceId: 'KICI_CLUSTER_INSTANCE_ID' },
      },
      descriptions: { url: 'The service URL.' },
    });
    const specs = envDef.describe();
    const byEnv = Object.fromEntries(specs.map((s) => [s.envVar, s]));
    expect(byEnv['KICI_URL']?.required).toBe(true);
    expect(byEnv['KICI_URL']?.description).toBe('The service URL.');
    expect(byEnv['KICI_PORT']?.defaultValue).toBe('8080');
    expect(byEnv['KICI_FLAG']?.type).toBe('enum:on|off');
    expect(byEnv['KICI_CLUSTER_INSTANCE_ID']?.required).toBe(false);
    // sorted alphabetically by envVar
    expect(specs.map((s) => s.envVar)).toEqual([...specs.map((s) => s.envVar)].sort());
  });
});

describe('validateUnknownKiciVars', () => {
  it('throws with a clear message when an unknown KICI_ var is set', () => {
    expect(() =>
      validateUnknownKiciVars(['KICI_SECRET_KEY'], {}, { KICI_SECERT_KEY: 'oops' }),
    ).toThrow(/Unknown KICI_\* env var/);
  });

  it('suggests the closest known name when a typo is close', () => {
    let captured: string | undefined;
    expect(() =>
      validateUnknownKiciVars(
        ['KICI_SECRET_KEY'],
        { warnOnly: false },
        { KICI_SECERT_KEY: 'oops' },
      ),
    ).toThrow(/did you mean KICI_SECRET_KEY/);
    // sanity: warn-only path captures
    validateUnknownKiciVars(
      ['KICI_SECRET_KEY'],
      { warnOnly: true, onWarn: (m) => (captured = m) },
      { KICI_SECERT_KEY: 'oops' },
    );
    expect(captured).toMatch(/Unknown KICI_/);
  });

  it('downgrades to a warning when KICI_DEV=true', () => {
    let captured: string | undefined;
    validateUnknownKiciVars(
      ['KICI_SECRET_KEY'],
      { onWarn: (m) => (captured = m) },
      { KICI_SECERT_KEY: 'oops', KICI_DEV: 'true' },
    );
    expect(captured).toMatch(/Unknown KICI_/);
  });

  it('passes when every KICI_ var is known', () => {
    expect(() =>
      validateUnknownKiciVars(
        ['KICI_SECRET_KEY', 'KICI_BOOTSTRAP_ADMIN_TOKEN'],
        {},
        { KICI_SECRET_KEY: 'x', KICI_BOOTSTRAP_ADMIN_TOKEN: 'y' },
      ),
    ).not.toThrow();
  });

  it('ignores non-KICI_ env vars (PATH, HOME, etc.)', () => {
    expect(() =>
      validateUnknownKiciVars(
        ['KICI_SECRET_KEY'],
        {},
        { KICI_SECRET_KEY: 'x', PATH: '/usr/bin', HOME: '/root', NODE_ENV: 'production' },
      ),
    ).not.toThrow();
  });

  it('respects extraKnown (allows transient env vars during migration)', () => {
    expect(() =>
      validateUnknownKiciVars(
        ['KICI_SECRET_KEY'],
        { extraKnown: ['KICI_TRANSIENT'] },
        { KICI_SECRET_KEY: 'x', KICI_TRANSIENT: 'y' },
      ),
    ).not.toThrow();
  });

  it('allowlists RESERVED_NON_SCHEMA_KICI_VARS (shim/dev env vars)', () => {
    // KICI_CACHE: set by the Windows CMD shim (see RESERVED_NON_SCHEMA_KICI_VARS).
    expect(() =>
      validateUnknownKiciVars(
        ['KICI_SECRET_KEY'],
        {},
        { KICI_SECRET_KEY: 'x', KICI_CACHE: 'C:\\kici\\node-binaries\\v24.14.0' },
      ),
    ).not.toThrow();
  });

  it('allowlists KICI_CONFIG_DIR (the vitest config-isolation dir)', () => {
    // Set by every vitest config (hack/lib/vitest-isolation.ts) and inherited
    // by every test-spawned service.
    expect(() =>
      validateUnknownKiciVars(
        ['KICI_SECRET_KEY'],
        {},
        { KICI_SECRET_KEY: 'x', KICI_CONFIG_DIR: '/tmp/kici-test-config-xyz' },
      ),
    ).not.toThrow();
  });

  it('allowlists KICI_ORCHESTRATOR_TOKEN (the CLI direct-target credential)', () => {
    // A developer or CI job exports it for `kici run remote` against an
    // orchestrator; a service started from that shell inherits it.
    // fails-when: the name leaves RESERVED_NON_SCHEMA_KICI_VARS — the service
    // refuses to boot with "Unknown KICI_* env var".
    expect(() =>
      validateUnknownKiciVars(
        ['KICI_SECRET_KEY'],
        {},
        { KICI_SECRET_KEY: 'x', KICI_ORCHESTRATOR_TOKEN: 'tok' },
      ),
    ).not.toThrow();
  });

  it('leaves KICI_CONFIG to the one service that reads it', () => {
    // KICI_CONFIG picks the local YAML the reload path and `kici-admin scaler`
    // read; only the orchestrator reads it, so only its call site allows it —
    // the agent's and Platform's catchers must still reject it.
    // fails-when: 'KICI_CONFIG' is put back into RESERVED_NON_SCHEMA_KICI_VARS.
    const env = { KICI_SECRET_KEY: 'x', KICI_CONFIG: '/etc/kici/other.yaml' };
    expect(() => validateUnknownKiciVars(['KICI_SECRET_KEY'], {}, env)).toThrow(/KICI_CONFIG/);
    // breaks-if-wrong: the orchestrator passes it as extraKnown, which must
    // still accept it — otherwise the boot failure this replaced comes back.
    expect(() =>
      validateUnknownKiciVars(['KICI_SECRET_KEY'], { extraKnown: ['KICI_CONFIG'] }, env),
    ).not.toThrow();
  });

  it('still rejects near-misses of an allowlisted name', () => {
    // breaks-if-wrong: the allowlist entry is an exact name, never a prefix.
    for (const name of [
      'KICI_CONFIGX',
      'KICI_CONFG',
      'KICI_CONFIG_DIRX',
      'KICI_ORCHESTRATOR_TOKN',
    ]) {
      expect(() =>
        validateUnknownKiciVars(['KICI_SECRET_KEY'], {}, { KICI_SECRET_KEY: 'x', [name]: 'y' }),
      ).toThrow(/Unknown KICI_\* env var/);
    }
  });

  describe('notStartupVars advice', () => {
    it('reports the advice instead of a Levenshtein guess', () => {
      // fails-when: the advice table is ignored — the message would read
      // "no close match in the schema" and name nothing to try instead.
      expect(() =>
        validateUnknownKiciVars(
          ['KICI_PORT'],
          { notStartupVars: { KICI_SERVER_PORT: 'not a startup variable — set KICI_PORT' } },
          { KICI_SERVER_PORT: '4999' },
        ),
      ).toThrow(/KICI_SERVER_PORT {4}\(not a startup variable — set KICI_PORT\)/);
    });

    it('still rejects the name it gives advice for', () => {
      // breaks-if-wrong: advice is a message change, never an allowlist.
      expect(() =>
        validateUnknownKiciVars(
          ['KICI_PORT'],
          { notStartupVars: { KICI_SERVER_PORT: 'not a startup variable — set KICI_PORT' } },
          { KICI_SERVER_PORT: '4999' },
        ),
      ).toThrow(/Unknown KICI_\* env var/);
    });

    it('leaves a name outside the table on the Levenshtein path', () => {
      // breaks-if-wrong: the table must not become a catch-all that launders
      // an ordinary typo into "helpful" advice.
      let message = '';
      try {
        validateUnknownKiciVars(
          ['KICI_PORT'],
          { notStartupVars: { KICI_SERVER_PORT: 'not a startup variable — set KICI_PORT' } },
          { KICI_PROT: '4999' },
        );
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/KICI_PROT {4}\(did you mean KICI_PORT\?\)/);
      expect(message).not.toMatch(/not a startup variable/);
    });
  });

  it('allowlists RESERVED_NON_SCHEMA_KICI_PREFIXES (test-framework namespace)', () => {
    // A harness's KICI_E2E_* vars leak into an orchestrator it spawns.
    expect(() =>
      validateUnknownKiciVars(
        ['KICI_SECRET_KEY'],
        {},
        {
          KICI_SECRET_KEY: 'x',
          KICI_E2E_PROVIDER: 'internal',
          KICI_E2E_MODE: 'warm',
        },
      ),
    ).not.toThrow();
  });

  it('allowlists KICI_AGENT_ENV_* (agent-env forwarding namespace)', () => {
    // The forwarding prefix's suffix is user-controlled, so no schema lists it.
    expect(() =>
      validateUnknownKiciVars(
        ['KICI_SECRET_KEY'],
        {},
        {
          KICI_SECRET_KEY: 'x',
          KICI_AGENT_ENV_HTTP_PROXY: 'http://proxy:3128',
          KICI_AGENT_ENV_KICI_FC_ENV_PROBE: 'fc-probe-value',
        },
      ),
    ).not.toThrow();
  });

  it('allowlists KICI_*_ENV_PROBE (diagnostic probe suffix)', () => {
    // The agent sees a forwarded KICI_AGENT_ENV_KICI_FC_ENV_PROBE as
    // KICI_FC_ENV_PROBE; rejecting it would stop the agent starting and break
    // the firecracker-pipeline happy-path test.
    expect(() =>
      validateUnknownKiciVars(
        ['KICI_SECRET_KEY'],
        {},
        {
          KICI_SECRET_KEY: 'x',
          KICI_FC_ENV_PROBE: 'fc-probe-value',
          KICI_FC_REQUIRE_ENV_PROBE: '1',
          KICI_SOME_ENV_PROBE_SUFFIX: 'value-after-suffix',
        },
      ),
    ).not.toThrow();
  });
});

describe('validation errors name env vars', () => {
  const envDef = defineEnv({
    service: 't',
    schema: z.object({ url: z.string().url(), n: z.coerce.number() }),
    envMap: { url: 'KICI_URL', n: 'KICI_N' },
    validationHint: 'See the docs.',
  });

  function errorOf(fn: () => unknown): Error {
    try {
      fn();
    } catch (err) {
      return err as Error;
    }
    throw new Error('expected a throw');
  }

  // fails-when: the renderer prints the Zod path (`url: Invalid input…`).
  it('names the env var and says not set for a missing required var', () => {
    expect(() => envDef.parse({ KICI_N: '1' })).toThrow('  - KICI_URL: not set (required)');
  });

  // fails-when: the "not set" rule tests falsiness instead of undefined.
  it('empty value is not reported as not set', () => {
    const err = errorOf(() => envDef.parse({ KICI_URL: '', KICI_N: '1' }));
    expect(err.message).toMatch(/KICI_URL: Invalid URL/);
    expect(err.message).not.toContain('not set');
  });

  it('keeps the zod message for a wrong type', () => {
    expect(() => envDef.parse({ KICI_URL: 'https://x', KICI_N: 'x' })).toThrow(
      /KICI_N: Invalid input: expected number/,
    );
  });

  it('keeps a custom issue message on an unset field', () => {
    const schema = z.object({ role: z.string(), coordinatorUrl: z.string().optional() });
    const refined = schema.superRefine((cfg, ctx) => {
      if (cfg.role === 'worker' && !cfg.coordinatorUrl) {
        ctx.addIssue({
          code: 'custom',
          path: ['coordinatorUrl'],
          message: 'coordinatorUrl required for workers',
        });
      }
    });
    const def = defineEnv({
      service: 't',
      schema,
      parser: refined,
      envMap: { role: 'KICI_ROLE', coordinatorUrl: 'KICI_COORD' },
    });
    expect(() => def.parse({ KICI_ROLE: 'worker' })).toThrow(
      '  - KICI_COORD: coordinatorUrl required for workers',
    );
  });

  it('resolves a nested envMap path', () => {
    const def = defineEnv({
      service: 't',
      schema: z.object({ cluster: z.object({ id: z.string() }) }),
      envMap: { cluster: { id: 'KICI_CLUSTER_ID' } },
    });
    const err = errorOf(() => def.parse({}));
    expect(err.message.split('\n')[1]).toBe('  - KICI_CLUSTER_ID: not set (required)');
  });

  it('names the leaf var for an issue inside a parsed list', () => {
    const def = defineEnv({
      service: 't',
      schema: z.object({
        ports: z
          .string()
          .transform((v) => v.split(','))
          .pipe(z.array(z.string().min(2))),
      }),
      envMap: { ports: 'KICI_PORTS' },
    });
    const err = errorOf(() => def.parse({ KICI_PORTS: 'ab,c' }));
    expect(err.message).toMatch(/^ {2}- KICI_PORTS: /m);
    expect(err.message).not.toContain('not set');
  });

  it('appends the validationHint and throws a ConfigValidationError', () => {
    const err = errorOf(() => envDef.parse({ KICI_N: '1' }));
    expect(isConfigValidationError(err)).toBe(true);
    expect(err.message.endsWith('\nSee the docs.')).toBe(true);
    if (!isConfigValidationError(err)) throw err;
    expect(err.issues[0]).toEqual({
      envVar: 'KICI_URL',
      field: 'url',
      message: 'not set (required)',
    });
  });

  it('never prints the internal field name for a mapped field', () => {
    const err = errorOf(() => envDef.parse({ KICI_N: 'x' }));
    expect(err.message).not.toMatch(/\burl:/);
    expect(err.message).not.toMatch(/\bn:/);
  });

  it('toValidationError renders issues from a caller-run safeParse', () => {
    const schema = z.object({ url: z.string() });
    const def = defineEnv({ service: 't', schema, envMap: { url: 'KICI_URL' } });
    const raw = { url: undefined };
    const result = schema.safeParse(raw);
    if (result.success) throw new Error('expected failure');
    expect(def.toValidationError(result.error.issues, raw).message).toBe(
      'Configuration validation failed:\n  - KICI_URL: not set (required)',
    );
  });
});
