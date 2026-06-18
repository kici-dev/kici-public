import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineEnv, validateUnknownKiciVars } from './define-env.js';

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
    // Orchestrator's cluster pattern: z.object({...}).prefault({}). Earlier
    // describe() only handled bare z.object(...) and silently dropped every
    // inner field of a wrapped nested object — losing 16 KICI_CLUSTER_* vars
    // from the operator env reference. Three wrappers exercised here:
    // .optional(), .default({}), .prefault({}).
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
    // Zod 4 exposes `.default(() => randomUUID())` through a getter that
    // invokes the function on every access — left unhandled, the docs
    // generator would emit a different UUID per run and pnpm docs:env:check
    // would fail immediately after pnpm docs:env. The orchestrator's
    // cluster.instanceId uses exactly this pattern.
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
    // KICI_CACHE is set by the Windows CMD shim (packages/… .cmd via
    // scripts/package.mjs) to locate the cached Node binary. It's not a
    // config typo — must not trip the scanner.
    expect(() =>
      validateUnknownKiciVars(
        ['KICI_SECRET_KEY'],
        {},
        { KICI_SECRET_KEY: 'x', KICI_CACHE: 'C:\\kici\\node-binaries\\v24.14.0' },
      ),
    ).not.toThrow();
  });

  it('allowlists RESERVED_NON_SCHEMA_KICI_PREFIXES (test-framework namespace)', () => {
    // KICI_E2E_* is set by e2e/vitest.*.config.ts and leaks into the
    // native orchestrator spawn via inherited process.env. Not a config
    // typo — the whole KICI_E2E_ prefix is test-framework namespace.
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
    // KICI_AGENT_ENV_* is the orchestrator's passthrough prefix for env vars
    // forwarded into spawned agents (bare-metal, container, Firecracker MMDS).
    // The suffix is user-controlled, so it cannot be enumerated in any schema.
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
    // When KICI_AGENT_ENV_KICI_FC_ENV_PROBE flows through /init's env-forward
    // path, the KICI_AGENT_ENV_ prefix is stripped and the agent sees
    // KICI_FC_ENV_PROBE directly. Without this suffix allowlist the validator
    // would reject it and the agent refuses to start (breaking the
    // firecracker-pipeline happy-path test). packages/agent/src/server.ts
    // grabs these vars via the same /_ENV_PROBE$|_ENV_PROBE_/ pattern to log
    // them in "Agent startup env probes (diagnostic)".
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
