import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { initTelemetry } from '@kici-dev/shared';
import type { Environment as DbEnvironment } from '../db/types.js';
import type { Environment as EngineEnvironment, ProtectionGateResult } from '@kici-dev/engine';
import type { TrustResolution } from '../security/trust-resolver.js';
import type { SecretResolver } from '../secrets/secret-resolver.js';
import type { EnvironmentStore } from '../environments/environment-store.js';
import type { JobDispatchContext } from '../environments/protection/pipeline.js';
import {
  parseQualifiedSecretRef,
  validateRegistryUrlScheme,
  resolveInstallSecrets,
} from './install-secrets-resolver.js';
import * as metrics from '../metrics/prometheus.js';

// Init telemetry so the OTel meter has a real SDK behind it for any spies
// further down. The prometheus module already imports cleanly without an
// initialized SDK (OTel falls back to a no-op meter), so static imports are
// safe — this init just ensures the counters tick when we exercise them.
beforeAll(() => {
  initTelemetry({ serviceName: 'kici-orchestrator-test', metricPrefix: 'kici_orch_' });
});

const baseProtectionContext: JobDispatchContext = {
  branch: 'main',
  triggerType: 'push',
  repository: 'acme/web',
  runId: 'run-1',
  jobId: '__install__wf',
};

function makeEnvRow(overrides: Partial<DbEnvironment> = {}): DbEnvironment {
  return {
    id: 'env-1',
    org_id: 'org-1',
    name: 'prod',
    type: 'fixed',
    glob_pattern: null,
    branch_restrictions: '[]',
    trigger_type_filters: '[]',
    repo_patterns: '[]',
    concurrency_limit: null,
    concurrency_strategy: 'queue',
    concurrency_timeout_ms: 0,
    required_reviewers: null,
    wait_timer_seconds: null,
    hold_expiry_seconds: 3600,
    minimum_trust: null,
    allow_local_execution: false,
    enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
    created_by: null,
    ...overrides,
  } as unknown as DbEnvironment;
}

function makeEnvironmentStore(envs: Map<string, DbEnvironment>): EnvironmentStore {
  return {
    matchEnvironment: vi.fn(async (_orgId: string, name: string) => envs.get(name) ?? null),
  } as unknown as EnvironmentStore;
}

function makeSecretResolver(perEnv: Map<string, Record<string, string>>): SecretResolver {
  return {
    resolveForJob: vi.fn(async (_orgId: string, envName: string) => perEnv.get(envName) ?? {}),
  } as unknown as SecretResolver;
}

const trusted: TrustResolution = {
  tier: 'trusted',
  contributorUsername: 'alice',
  identityLinked: true,
  providerPermission: 'admin',
  reason: 'org-owner',
};

const untrusted: TrustResolution = {
  tier: 'unknown',
  contributorUsername: 'fork-user',
  identityLinked: false,
  providerPermission: 'read',
  reason: 'fork',
};

describe('parseQualifiedSecretRef', () => {
  it('accepts a normal env:secret pair', () => {
    expect(parseQualifiedSecretRef('prod:NPM_TOKEN')).toEqual({
      envName: 'prod',
      secretName: 'NPM_TOKEN',
    });
  });
  it('rejects empty halves', () => {
    expect(parseQualifiedSecretRef(':NPM_TOKEN')).toBeNull();
    expect(parseQualifiedSecretRef('prod:')).toBeNull();
    expect(parseQualifiedSecretRef('NPM_TOKEN')).toBeNull();
  });
  it('rejects multi-colon names', () => {
    expect(parseQualifiedSecretRef('prod:NPM:TOKEN')).toBeNull();
  });
});

describe('validateRegistryUrlScheme', () => {
  it('accepts https unconditionally', () => {
    expect(validateRegistryUrlScheme('https://npm.example.com/', false)).toEqual({ ok: true });
  });
  it('accepts http loopback even without toggle', () => {
    expect(validateRegistryUrlScheme('http://localhost:4873/', false)).toEqual({ ok: true });
    expect(validateRegistryUrlScheme('http://127.0.0.1:4873/', false)).toEqual({ ok: true });
    expect(validateRegistryUrlScheme('http://[::1]:4873/', false)).toEqual({ ok: true });
  });
  it('accepts *.local even without toggle', () => {
    expect(validateRegistryUrlScheme('http://npm.local/', false)).toEqual({ ok: true });
  });
  it('accepts arbitrary http when toggle enabled', () => {
    expect(validateRegistryUrlScheme('http://npm.example.com/', true)).toEqual({ ok: true });
  });
  it('rejects arbitrary http when toggle disabled', () => {
    const r = validateRegistryUrlScheme('http://npm.example.com/', false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/allow_http_npm_registries/);
  });
  it('rejects unsupported schemes', () => {
    const r = validateRegistryUrlScheme('ftp://npm.example.com/', true);
    expect(r.ok).toBe(false);
  });
  it('rejects malformed URLs', () => {
    const r = validateRegistryUrlScheme('not-a-url', false);
    expect(r.ok).toBe(false);
  });
  it('does not match 128.x.x.x as loopback', () => {
    const r = validateRegistryUrlScheme('http://128.0.0.1/', false);
    expect(r.ok).toBe(false);
  });
});

describe('resolveInstallSecrets', () => {
  it('returns pass with no fields when nothing is declared', async () => {
    const r = await resolveInstallSecrets({
      registries: undefined,
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: undefined,
      environmentStore: undefined,
      secretResolver: undefined,
      protectionContext: baseProtectionContext,
    });
    expect(r).toEqual({
      decision: 'pass',
      npmRegistries: undefined,
      installEnvSecrets: undefined,
      contributorStripped: false,
    });
  });

  it('strips registries+installEnv for an untrusted contributor', async () => {
    const r = await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com/', tokenSecret: 'prod:NPM_TOKEN' }],
      installEnv: ['prod:CARGO_TOKEN'],
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: untrusted,
      environmentStore: makeEnvironmentStore(new Map([['prod', makeEnvRow()]])),
      secretResolver: makeSecretResolver(new Map([['prod', { NPM_TOKEN: 't' }]])),
      protectionContext: baseProtectionContext,
    });
    expect(r).toEqual({
      decision: 'pass',
      npmRegistries: undefined,
      installEnvSecrets: undefined,
      contributorStripped: true,
    });
  });

  it('rejects on malformed tokenSecret', async () => {
    const r = await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com/', tokenSecret: 'bare-name' }],
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      environmentStore: makeEnvironmentStore(new Map()),
      secretResolver: makeSecretResolver(new Map()),
      protectionContext: baseProtectionContext,
    });
    expect(r.decision).toBe('reject');
    if (r.decision === 'reject') expect(r.reason).toMatch(/qualified <environment>:<secret-name>/);
  });

  it('rejects on missing environment', async () => {
    const r = await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com/', tokenSecret: 'prod:NPM_TOKEN' }],
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      environmentStore: makeEnvironmentStore(new Map()),
      secretResolver: makeSecretResolver(new Map()),
      protectionContext: baseProtectionContext,
    });
    expect(r.decision).toBe('reject');
    if (r.decision === 'reject') expect(r.reason).toMatch(/does not exist/);
  });

  it('rejects on bad URL scheme', async () => {
    const r = await resolveInstallSecrets({
      registries: [{ url: 'http://npm.example.com/', tokenSecret: 'prod:NPM_TOKEN' }],
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      environmentStore: makeEnvironmentStore(new Map([['prod', makeEnvRow()]])),
      secretResolver: makeSecretResolver(new Map([['prod', { NPM_TOKEN: 'tok' }]])),
      protectionContext: baseProtectionContext,
    });
    expect(r.decision).toBe('reject');
    if (r.decision === 'reject') expect(r.reason).toMatch(/allow_http_npm_registries/);
  });

  it('rejects when secret is missing from the env bag', async () => {
    const r = await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com/', tokenSecret: 'prod:MISSING' }],
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      environmentStore: makeEnvironmentStore(new Map([['prod', makeEnvRow()]])),
      secretResolver: makeSecretResolver(new Map([['prod', {}]])),
      protectionContext: baseProtectionContext,
    });
    expect(r.decision).toBe('reject');
    if (r.decision === 'reject') expect(r.reason).toMatch(/did not resolve/);
  });

  it('rejects when env is disabled (protection-pipeline gate)', async () => {
    const r = await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com/', tokenSecret: 'prod:NPM_TOKEN' }],
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      environmentStore: makeEnvironmentStore(new Map([['prod', makeEnvRow({ enabled: false })]])),
      secretResolver: makeSecretResolver(new Map([['prod', { NPM_TOKEN: 't' }]])),
      protectionContext: baseProtectionContext,
    });
    expect(r.decision).toBe('reject');
    if (r.decision === 'reject') expect(r.reason).toMatch(/install gate reject/);
  });

  it('returns a hold decision (not reject) when the env install gate holds for review', async () => {
    const envs = new Map<string, DbEnvironment>([
      ['prod', makeEnvRow({ id: 'env-prod', required_reviewers: JSON.stringify(['alice']) })],
    ]);
    const r = await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com/', tokenSecret: 'prod:NPM_TOKEN' }],
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      environmentStore: makeEnvironmentStore(envs),
      secretResolver: makeSecretResolver(new Map([['prod', { NPM_TOKEN: 't' }]])),
      protectionContext: baseProtectionContext,
    });
    expect(r.decision).toBe('hold');
    if (r.decision === 'hold') {
      expect(r.action).toBe('hold');
      expect(r.holdType).toBe('reviewer');
      expect(r.envName).toBe('prod');
      expect(r.environmentId).toBe('env-prod');
      expect(r.queueType).toBe('environment');
      expect(r.requirement.clauses).toEqual([{ user: 'alice' }]);
      expect(typeof r.requirement.expiresAt).toBe('string');
    }
  });

  it('returns a hold decision with wait_timer hold type for a wait-timer env', async () => {
    const envs = new Map<string, DbEnvironment>([
      ['prod', makeEnvRow({ id: 'env-prod', wait_timer_seconds: 30 })],
    ]);
    const r = await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com/', tokenSecret: 'prod:NPM_TOKEN' }],
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      environmentStore: makeEnvironmentStore(envs),
      secretResolver: makeSecretResolver(new Map([['prod', { NPM_TOKEN: 't' }]])),
      protectionContext: baseProtectionContext,
    });
    expect(r.decision).toBe('hold');
    if (r.decision === 'hold') {
      expect(r.action).toBe('wait');
      expect(r.holdType).toBe('wait_timer');
    }
  });

  it('skipProtectionGate bypasses the gate and resolves secrets to pass', async () => {
    const envs = new Map<string, DbEnvironment>([
      ['prod', makeEnvRow({ id: 'env-prod', required_reviewers: JSON.stringify(['alice']) })],
    ]);
    const r = await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com/', tokenSecret: 'prod:NPM_TOKEN' }],
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      environmentStore: makeEnvironmentStore(envs),
      secretResolver: makeSecretResolver(new Map([['prod', { NPM_TOKEN: 'secret-value' }]])),
      protectionContext: baseProtectionContext,
      skipProtectionGate: true,
    });
    expect(r.decision).toBe('pass');
    if (r.decision === 'pass') {
      expect(r.npmRegistries?.[0].token).toBe('secret-value');
    }
  });

  it('passes and resolves a registry + an installEnv across two envs', async () => {
    const envs = new Map<string, DbEnvironment>([
      ['prod', makeEnvRow({ id: 'env-prod', name: 'prod' })],
      ['stg', makeEnvRow({ id: 'env-stg', name: 'stg' })],
    ]);
    const secrets = new Map<string, Record<string, string>>([
      ['prod', { NPM_TOKEN: 'prod-token' }],
      ['stg', { CARGO_TOKEN: 'cargo-token' }],
    ]);
    const r = await resolveInstallSecrets({
      registries: [
        {
          url: 'https://npm.example.com/',
          scope: '@acme',
          tokenSecret: 'prod:NPM_TOKEN',
          alwaysAuth: true,
        },
      ],
      installEnv: ['stg:CARGO_TOKEN'],
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      environmentStore: makeEnvironmentStore(envs),
      secretResolver: makeSecretResolver(secrets),
      protectionContext: baseProtectionContext,
    });
    expect(r).toEqual({
      decision: 'pass',
      npmRegistries: [
        {
          url: 'https://npm.example.com/',
          scope: '@acme',
          alwaysAuth: true,
          token: 'prod-token',
        },
      ],
      installEnvSecrets: { CARGO_TOKEN: 'cargo-token' },
      contributorStripped: false,
    });
  });

  it('treats undefined alwaysAuth as true', async () => {
    const r = await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com/', tokenSecret: 'prod:NPM_TOKEN' }],
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      environmentStore: makeEnvironmentStore(new Map([['prod', makeEnvRow()]])),
      secretResolver: makeSecretResolver(new Map([['prod', { NPM_TOKEN: 't' }]])),
      protectionContext: baseProtectionContext,
    });
    expect(r.decision).toBe('pass');
    if (r.decision === 'pass') {
      expect(r.npmRegistries?.[0].alwaysAuth).toBe(true);
    }
  });

  it('rejects when secretResolver missing despite declared registries', async () => {
    const r = await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com/', tokenSecret: 'prod:NPM_TOKEN' }],
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      environmentStore: makeEnvironmentStore(new Map([['prod', makeEnvRow()]])),
      secretResolver: undefined,
      protectionContext: baseProtectionContext,
    });
    expect(r.decision).toBe('reject');
    if (r.decision === 'reject') expect(r.reason).toMatch(/secretResolver/);
  });

  // Sanity: ProtectionGateResult import exercise so a refactor that drops the
  // type re-export from @kici-dev/engine fails the suite loudly rather than
  // silently breaking the resolver.
  it('exercises ProtectionGateResult shape', () => {
    const dummy: ProtectionGateResult = { action: 'pass' };
    expect(dummy.action).toBe('pass');
  });
});

describe('resolveInstallSecrets — Prometheus metrics', () => {
  // Each install-secrets counter is its own lazy wrapper with a private `.add`
  // closure, so a spy on one counter never sees another's calls. Spy on all
  // three counters and aggregate their calls, then match by attribute shape.
  let addSpies: Array<ReturnType<typeof vi.spyOn>>;
  let durationSpy: ReturnType<typeof vi.spyOn>;

  function allAddCalls(): unknown[][] {
    return addSpies.flatMap((spy) => spy.mock.calls);
  }
  function attrCalls<T extends object>(filterKey: keyof T): Array<{ value: number; attrs: T }> {
    return allAddCalls()
      .filter((call: unknown[]) => {
        const attrs = call[1] as Record<string, unknown> | undefined;
        return attrs !== undefined && filterKey in attrs;
      })
      .map((call: unknown[]) => ({ value: call[0] as number, attrs: call[1] as T }));
  }
  const decisionCalls = (): Array<{ value: number; attrs: { decision: string; reason: string } }> =>
    attrCalls<{ decision: string; reason: string }>('decision');
  const registryCalls = (): Array<{
    value: number;
    attrs: { channel: string; provider: string; scope: string };
  }> => attrCalls<{ channel: string; provider: string; scope: string }>('channel');
  const stripCalls = (): Array<{ value: number; attrs: { trust_tier: string } }> =>
    attrCalls<{ trust_tier: string }>('trust_tier');
  const anyAddCalled = (): boolean => addSpies.some((spy) => spy.mock.calls.length > 0);

  beforeEach(() => {
    addSpies = [
      vi.spyOn(metrics.installSecretsDecisionsTotal, 'add'),
      vi.spyOn(metrics.installSecretsRegistryUsedTotal, 'add'),
      vi.spyOn(metrics.installSecretsContributorStrippedTotal, 'add'),
    ];
    durationSpy = vi.spyOn(metrics.installSecretsTokenResolutionDurationSeconds, 'record');
  });

  it('does not emit any metric when the workflow declares no install secrets', async () => {
    await resolveInstallSecrets({
      registries: undefined,
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: undefined,
      environmentStore: undefined,
      secretResolver: undefined,
      protectionContext: baseProtectionContext,
    });
    expect(anyAddCalled()).toBe(false);
    expect(durationSpy).not.toHaveBeenCalled();
  });

  it('records pass + per-tier strip on the untrusted-contributor path', async () => {
    await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com/', tokenSecret: 'prod:NPM_TOKEN' }],
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: untrusted,
      environmentStore: makeEnvironmentStore(new Map([['prod', makeEnvRow()]])),
      secretResolver: makeSecretResolver(new Map([['prod', { NPM_TOKEN: 't' }]])),
      protectionContext: baseProtectionContext,
    });
    expect(stripCalls()).toEqual([{ value: 1, attrs: { trust_tier: 'unknown' } }]);
    expect(decisionCalls()).toEqual([{ value: 1, attrs: { decision: 'pass', reason: 'ok' } }]);
    expect(registryCalls()).toEqual([]);
    expect(durationSpy).not.toHaveBeenCalled();
  });

  it('records reject with malformed_ref reason on a malformed tokenSecret', async () => {
    await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com/', tokenSecret: 'bare-name' }],
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      environmentStore: makeEnvironmentStore(new Map()),
      secretResolver: makeSecretResolver(new Map()),
      protectionContext: baseProtectionContext,
    });
    expect(decisionCalls()).toContainEqual({
      value: 1,
      attrs: { decision: 'reject', reason: 'malformed_ref' },
    });
  });

  it('records reject with invalid_url_scheme reason on a plain http registry', async () => {
    await resolveInstallSecrets({
      registries: [{ url: 'http://npm.example.com/', tokenSecret: 'prod:NPM_TOKEN' }],
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      environmentStore: makeEnvironmentStore(new Map([['prod', makeEnvRow()]])),
      secretResolver: makeSecretResolver(new Map([['prod', { NPM_TOKEN: 'tok' }]])),
      protectionContext: baseProtectionContext,
    });
    expect(decisionCalls()).toContainEqual({
      value: 1,
      attrs: { decision: 'reject', reason: 'invalid_url_scheme' },
    });
  });

  it('records reject with env_not_found reason when an environment is missing', async () => {
    await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com/', tokenSecret: 'prod:NPM_TOKEN' }],
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      environmentStore: makeEnvironmentStore(new Map()),
      secretResolver: makeSecretResolver(new Map()),
      protectionContext: baseProtectionContext,
    });
    expect(decisionCalls()).toContainEqual({
      value: 1,
      attrs: { decision: 'reject', reason: 'env_not_found' },
    });
  });

  it('records reject with protection_rule_block when the env protection gate blocks', async () => {
    await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com/', tokenSecret: 'prod:NPM_TOKEN' }],
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      environmentStore: makeEnvironmentStore(new Map([['prod', makeEnvRow({ enabled: false })]])),
      secretResolver: makeSecretResolver(new Map([['prod', { NPM_TOKEN: 't' }]])),
      protectionContext: baseProtectionContext,
    });
    expect(decisionCalls()).toContainEqual({
      value: 1,
      attrs: { decision: 'reject', reason: 'protection_rule_block' },
    });
  });

  it('records reject with missing_token when the env bag is missing the registry secret', async () => {
    await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com/', tokenSecret: 'prod:MISSING' }],
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      environmentStore: makeEnvironmentStore(new Map([['prod', makeEnvRow()]])),
      secretResolver: makeSecretResolver(new Map([['prod', {}]])),
      protectionContext: baseProtectionContext,
    });
    expect(decisionCalls()).toContainEqual({
      value: 1,
      attrs: { decision: 'reject', reason: 'missing_token' },
    });
    expect(durationSpy).toHaveBeenCalledWith(expect.any(Number), { environment: 'prod' });
  });

  it('records pass + per-channel/scope rows + per-env duration on a fully-resolved dispatch', async () => {
    const envs = new Map<string, DbEnvironment>([
      ['prod', makeEnvRow({ id: 'env-prod', name: 'prod' })],
      ['stg', makeEnvRow({ id: 'env-stg', name: 'stg' })],
    ]);
    const secrets = new Map<string, Record<string, string>>([
      ['prod', { NPM_TOKEN: 'prod-token' }],
      ['stg', { CARGO_TOKEN: 'cargo-token' }],
    ]);
    await resolveInstallSecrets({
      registries: [
        {
          url: 'https://npm.example.com/',
          scope: '@acme',
          tokenSecret: 'prod:NPM_TOKEN',
          alwaysAuth: true,
        },
      ],
      installEnv: ['stg:CARGO_TOKEN'],
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      environmentStore: makeEnvironmentStore(envs),
      secretResolver: makeSecretResolver(secrets),
      protectionContext: baseProtectionContext,
    });

    expect(decisionCalls()).toContainEqual({
      value: 1,
      attrs: { decision: 'pass', reason: 'ok' },
    });
    expect(registryCalls()).toContainEqual({
      value: 1,
      attrs: { channel: 'registries', provider: 'static', scope: '@acme' },
    });
    expect(registryCalls()).toContainEqual({
      value: 1,
      attrs: { channel: 'install_env', provider: 'static', scope: '-' },
    });
    expect(durationSpy).toHaveBeenCalledWith(expect.any(Number), { environment: 'prod' });
    expect(durationSpy).toHaveBeenCalledWith(expect.any(Number), { environment: 'stg' });
  });

  it('labels the default registry scope as `default`', async () => {
    await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com/', tokenSecret: 'prod:NPM_TOKEN' }],
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      environmentStore: makeEnvironmentStore(new Map([['prod', makeEnvRow()]])),
      secretResolver: makeSecretResolver(new Map([['prod', { NPM_TOKEN: 't' }]])),
      protectionContext: baseProtectionContext,
    });
    expect(registryCalls()).toContainEqual({
      value: 1,
      attrs: { channel: 'registries', provider: 'static', scope: 'default' },
    });
  });
});
