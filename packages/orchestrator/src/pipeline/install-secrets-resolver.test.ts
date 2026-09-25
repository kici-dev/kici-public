import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { initTelemetry } from '@kici-dev/shared';
import type { Context as DbContext } from '../db/types.js';
import { HoldType, installGateJobId } from '@kici-dev/engine';
import type { Context as EngineContext, ProtectionGateResult } from '@kici-dev/engine';
import type { TrustResolution } from '../security/trust-resolver.js';
import type { SecretResolver } from '../secrets/secret-resolver.js';
import type { ContextStore } from '../contexts/context-store.js';
import type { JobDispatchContext } from '../contexts/protection/pipeline.js';
import {
  parseQualifiedSecretRef,
  validateRegistryUrlScheme,
  resolveInstallSecrets,
  resolveHoldType,
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
  jobId: installGateJobId('wf'),
};

function makeEnvRow(overrides: Partial<DbContext> = {}): DbContext {
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
  } as unknown as DbContext;
}

function makeContextStore(envs: Map<string, DbContext>): ContextStore {
  return {
    matchContext: vi.fn(async (_orgId: string, name: string) => envs.get(name) ?? null),
  } as unknown as ContextStore;
}

function makeSecretResolver(perEnv: Map<string, Record<string, string>>): SecretResolver {
  return {
    resolveForContext: vi.fn(
      async (_orgId: string, context: { name: string }) => perEnv.get(context.name) ?? {},
    ),
  } as unknown as SecretResolver;
}

const trusted: TrustResolution = {
  tier: 'trusted',
  contributorUsername: 'alice',
  reason: 'same-repo ref',
};

const untrusted: TrustResolution = {
  tier: 'unknown',
  contributorUsername: 'fork-user',
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
      contextStore: undefined,
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
      contextStore: makeContextStore(new Map([['prod', makeEnvRow()]])),
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
      contextStore: makeContextStore(new Map()),
      secretResolver: makeSecretResolver(new Map()),
      protectionContext: baseProtectionContext,
    });
    expect(r.decision).toBe('reject');
    if (r.decision === 'reject') expect(r.reason).toMatch(/qualified <context>:<secret-name>/);
  });

  it('resolves a registry token through a glob-matched context row', async () => {
    // 'deploy-prod' matches the glob context 'deploy-*' (row env-glob); no
    // context row is named 'deploy-prod', so a lookup by name finds nothing.
    const globRow = makeEnvRow({ id: 'env-glob', name: 'deploy-*', type: 'glob' });
    const resolveForContext = vi.fn(async (_orgId: string, context: { id: string }) =>
      context.id === 'env-glob' ? { NPM_TOKEN: 'glob-token' } : {},
    );
    const r = await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com/', tokenSecret: 'deploy-prod:NPM_TOKEN' }],
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      contextStore: makeContextStore(new Map([['deploy-prod', globRow]])),
      secretResolver: { resolveForContext } as unknown as SecretResolver,
      protectionContext: baseProtectionContext,
    });
    // fails-when: the token is resolved by the declared name instead of the matched row
    expect(r.decision).toBe('pass');
    if (r.decision === 'pass') expect(r.npmRegistries?.[0]?.token).toBe('glob-token');
    expect(resolveForContext).toHaveBeenCalledWith('org-1', {
      id: 'env-glob',
      name: 'deploy-prod',
    });
  });

  it('resolves through the glob-matched row on the resume path too (skipProtectionGate)', async () => {
    const globRow = makeEnvRow({ id: 'env-glob', name: 'deploy-*', type: 'glob' });
    const resolveForContext = vi.fn(async (_orgId: string, context: { id: string }) =>
      context.id === 'env-glob' ? { CARGO_TOKEN: 'c' } : {},
    );
    const r = await resolveInstallSecrets({
      registries: undefined,
      installEnv: ['deploy-prod:CARGO_TOKEN'],
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      contextStore: makeContextStore(new Map([['deploy-prod', globRow]])),
      secretResolver: { resolveForContext } as unknown as SecretResolver,
      protectionContext: baseProtectionContext,
      skipProtectionGate: true,
    });
    expect(r.decision).toBe('pass');
    if (r.decision === 'pass') expect(r.installEnvSecrets).toEqual({ CARGO_TOKEN: 'c' });
  });

  it('rejects on missing context', async () => {
    const r = await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com/', tokenSecret: 'prod:NPM_TOKEN' }],
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      contextStore: makeContextStore(new Map()),
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
      contextStore: makeContextStore(new Map([['prod', makeEnvRow()]])),
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
      contextStore: makeContextStore(new Map([['prod', makeEnvRow()]])),
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
      contextStore: makeContextStore(new Map([['prod', makeEnvRow({ enabled: false })]])),
      secretResolver: makeSecretResolver(new Map([['prod', { NPM_TOKEN: 't' }]])),
      protectionContext: baseProtectionContext,
    });
    expect(r.decision).toBe('reject');
    if (r.decision === 'reject') expect(r.reason).toMatch(/install gate reject/);
  });

  it('returns a hold decision (not reject) when the env install gate holds for review', async () => {
    const envs = new Map<string, DbContext>([
      ['prod', makeEnvRow({ id: 'env-prod', required_reviewers: JSON.stringify(['alice']) })],
    ]);
    const r = await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com/', tokenSecret: 'prod:NPM_TOKEN' }],
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      contextStore: makeContextStore(envs),
      secretResolver: makeSecretResolver(new Map([['prod', { NPM_TOKEN: 't' }]])),
      protectionContext: baseProtectionContext,
    });
    expect(r.decision).toBe('hold');
    if (r.decision === 'hold') {
      expect(r.action).toBe('hold');
      expect(r.holdType).toBe(HoldType.enum.reviewer);
      expect(r.envName).toBe('prod');
      expect(r.contextId).toBe('env-prod');
      expect(r.queueType).toBe('context');
      expect(r.requirement.clauses).toEqual([{ user: 'alice' }]);
      expect(typeof r.requirement.expiresAt).toBe('string');
    }
  });

  it('persists an install-gate wait hold under the same type as a dispatch-gate one', () => {
    // Both gates persist a wait hold under the same type, so two semantically
    // identical holds get the same badge, the same live countdown and the same
    // "Skip timer" button whichever gate produced them.
    expect(resolveHoldType('wait', HoldType.enum.timer)).toBe(HoldType.enum.timer);
    expect(resolveHoldType('wait', undefined)).toBe(HoldType.enum.timer);
  });

  it('keeps the queue and reviewer fallbacks on the gate vocabulary', () => {
    expect(resolveHoldType('queue', undefined)).toBe(HoldType.enum.concurrency);
    expect(resolveHoldType('hold', undefined)).toBe(HoldType.enum.reviewer);
  });

  it('returns a hold decision with the timer hold type for a wait-timer env', async () => {
    const envs = new Map<string, DbContext>([
      ['prod', makeEnvRow({ id: 'env-prod', wait_timer_seconds: 30 })],
    ]);
    const r = await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com/', tokenSecret: 'prod:NPM_TOKEN' }],
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      contextStore: makeContextStore(envs),
      secretResolver: makeSecretResolver(new Map([['prod', { NPM_TOKEN: 't' }]])),
      protectionContext: baseProtectionContext,
    });
    expect(r.decision).toBe('hold');
    if (r.decision === 'hold') {
      expect(r.action).toBe('wait');
      expect(r.holdType).toBe(HoldType.enum.timer);
    }
  });

  it('a released hold skips the gate for the context its approval covered', async () => {
    const envs = new Map<string, DbContext>([
      ['prod', makeEnvRow({ id: 'env-prod', required_reviewers: JSON.stringify(['alice']) })],
    ]);
    const r = await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com/', tokenSecret: 'prod:NPM_TOKEN' }],
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      contextStore: makeContextStore(envs),
      secretResolver: makeSecretResolver(new Map([['prod', { NPM_TOKEN: 'secret-value' }]])),
      protectionContext: baseProtectionContext,
      skipProtectionGate: true,
      releasedHold: { held: [{ name: 'prod', id: 'env-prod' }], admitted: [] },
    });
    expect(r.decision).toBe('pass');
    if (r.decision === 'pass') {
      expect(r.npmRegistries?.[0].token).toBe('secret-value');
    }
  });

  it('passes and resolves a registry + an installEnv across two envs', async () => {
    const envs = new Map<string, DbContext>([
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
      contextStore: makeContextStore(envs),
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
      contextStore: makeContextStore(new Map([['prod', makeEnvRow()]])),
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
      contextStore: makeContextStore(new Map([['prod', makeEnvRow()]])),
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

describe('resolveInstallSecrets — every install context is gated', () => {
  // Two contexts named by one workflow: `a` from the registry token, `b` from
  // installEnv. Their rows carry real rule columns, so the real protection
  // pipeline decides each verdict.
  const A_REVIEWED = makeEnvRow({
    id: 'env-a',
    name: 'a',
    required_reviewers: JSON.stringify(['alice']),
  });
  const B_OPEN = makeEnvRow({ id: 'env-b', name: 'b' });
  // The dispatch presents branch `main`; this restriction does not admit it.
  const B_BRANCH_RESTRICTED = makeEnvRow({
    id: 'env-b',
    name: 'b',
    branch_restrictions: JSON.stringify(['release/*']),
  });
  const B_REVIEWED = makeEnvRow({
    id: 'env-b',
    name: 'b',
    required_reviewers: JSON.stringify(['bob']),
  });
  const SECRETS = new Map<string, Record<string, string>>([
    ['a', { NPM_TOKEN: 'a-token' }],
    ['b', { CARGO_TOKEN: 'b-token' }],
  ]);

  function resolveWith(
    rows: DbContext[],
    extra: Partial<Parameters<typeof resolveInstallSecrets>[0]> = {},
  ) {
    const secretResolver = makeSecretResolver(SECRETS);
    const result = resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com/', tokenSecret: 'a:NPM_TOKEN' }],
      installEnv: ['b:CARGO_TOKEN'],
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      contextStore: makeContextStore(new Map(rows.map((r) => [r.name, r]))),
      secretResolver,
      protectionContext: baseProtectionContext,
      ...extra,
    });
    return { result, resolveForContext: secretResolver.resolveForContext };
  }

  it('rejects when one context holds and a later one rejects, delivering nothing', async () => {
    const { result, resolveForContext } = resolveWith([A_REVIEWED, B_BRANCH_RESTRICTED]);
    const r = await result;
    // fails-when: the gate stops at the first context that holds and never evaluates `b`
    expect(r.decision).toBe('reject');
    if (r.decision === 'reject') expect(r.reason).toMatch(/context 'b' install gate reject/);
    expect(resolveForContext).not.toHaveBeenCalled();
  });

  it('holds when one context holds and the other passes, recording both', async () => {
    const r = await resolveWith([A_REVIEWED, B_OPEN]).result;
    expect(r.decision).toBe('hold');
    if (r.decision !== 'hold') return;
    expect(r.envName).toBe('a');
    expect(r.contextId).toBe('env-a');
    expect(r.requirement.clauses).toEqual([{ user: 'alice' }]);
    // fails-when: the hold does not say which contexts its approval covers
    expect(r.record).toEqual({
      held: [{ name: 'a', id: 'env-a' }],
      admitted: [{ name: 'b', id: 'env-b' }],
    });
  });

  it('delivers both contexts once the hold is released', async () => {
    const held = await resolveWith([A_REVIEWED, B_OPEN]).result;
    if (held.decision !== 'hold') throw new Error('expected a hold');
    const r = await resolveWith([A_REVIEWED, B_OPEN], {
      skipProtectionGate: true,
      releasedHold: held.record,
    }).result;
    // breaks-if-wrong: the approved context must not be held again by its stateless reviewer rule
    expect(r.decision).toBe('pass');
    if (r.decision !== 'pass') return;
    expect(r.npmRegistries?.[0]?.token).toBe('a-token');
    expect(r.installEnvSecrets).toEqual({ CARGO_TOKEN: 'b-token' });
  });

  it('fails closed on release when an admitted context now rejects', async () => {
    const held = await resolveWith([A_REVIEWED, B_OPEN]).result;
    if (held.decision !== 'hold') throw new Error('expected a hold');
    const { result, resolveForContext } = resolveWith([A_REVIEWED, B_BRANCH_RESTRICTED], {
      skipProtectionGate: true,
      releasedHold: held.record,
    });
    const r = await result;
    // fails-when: the release skips the gate for `b`, which the approval never covered
    expect(r.decision).toBe('reject');
    if (r.decision === 'reject') expect(r.reason).toMatch(/context 'b' install gate reject/);
    expect(resolveForContext).not.toHaveBeenCalled();
  });

  it('fails closed on release when an admitted context now holds', async () => {
    const held = await resolveWith([A_REVIEWED, B_OPEN]).result;
    if (held.decision !== 'hold') throw new Error('expected a hold');
    const { result, resolveForContext } = resolveWith([A_REVIEWED, B_REVIEWED], {
      skipProtectionGate: true,
      releasedHold: held.record,
    });
    const r = await result;
    // fails-when: `b`'s new reviewer requirement is satisfied by `a`'s approval
    expect(r.decision).toBe('reject');
    if (r.decision === 'reject') {
      expect(r.reason).toMatch(/context 'b' install gate hold/);
      expect(r.reason).toMatch(/did not cover/);
    }
    expect(resolveForContext).not.toHaveBeenCalled();
  });

  it('holds once for two held contexts, requiring every reviewer', async () => {
    const r = await resolveWith([A_REVIEWED, B_REVIEWED]).result;
    expect(r.decision).toBe('hold');
    if (r.decision !== 'hold') return;
    // The clause list is an AND list: bob must approve for `b` as well.
    // fails-when: the hold carries only the first context's reviewers
    expect(r.requirement.clauses).toEqual([{ user: 'alice' }, { user: 'bob' }]);
    expect(r.record.held).toEqual([
      { name: 'a', id: 'env-a' },
      { name: 'b', id: 'env-b' },
    ]);
    const released = await resolveWith([A_REVIEWED, B_REVIEWED], {
      skipProtectionGate: true,
      releasedHold: r.record,
    }).result;
    expect(released.decision).toBe('pass');
  });

  it('refuses a release when a held context now matches a different row', async () => {
    const held = await resolveWith([A_REVIEWED, B_OPEN]).result;
    if (held.decision !== 'hold') throw new Error('expected a hold');
    // `a` was deleted and recreated while held: same name, new row, no reviewers.
    const replaced = makeEnvRow({ id: 'env-a-new', name: 'a' });
    const { result, resolveForContext } = resolveWith([replaced, B_OPEN], {
      skipProtectionGate: true,
      releasedHold: held.record,
    });
    const r = await result;
    // fails-when: the release resolves whichever row matches now instead of the approved one
    expect(r.decision).toBe('reject');
    if (r.decision === 'reject') expect(r.reason).toMatch(/context 'a' was removed or replaced/);
    expect(resolveForContext).not.toHaveBeenCalled();
  });

  it('refuses a release when an admitted context now matches a different row', async () => {
    const held = await resolveWith([A_REVIEWED, B_OPEN]).result;
    if (held.decision !== 'hold') throw new Error('expected a hold');
    const replaced = makeEnvRow({ id: 'env-b-new', name: 'b' });
    const r = await resolveWith([A_REVIEWED, replaced], {
      skipProtectionGate: true,
      releasedHold: held.record,
    }).result;
    expect(r.decision).toBe('reject');
    if (r.decision === 'reject') expect(r.reason).toMatch(/context 'b' was removed or replaced/);
  });

  it('gates every context again when the released hold recorded nothing', async () => {
    const { result, resolveForContext } = resolveWith([A_REVIEWED, B_OPEN], {
      skipProtectionGate: true,
    });
    const r = await result;
    // fails-when: a release with no record of what its approval covered skips the gate for all
    expect(r.decision).toBe('reject');
    if (r.decision === 'reject') expect(r.reason).toMatch(/context 'a' install gate hold/);
    expect(resolveForContext).not.toHaveBeenCalled();
  });

  it('treats a malformed stored record as recording nothing', async () => {
    const r = await resolveWith([A_REVIEWED, B_OPEN], {
      skipProtectionGate: true,
      releasedHold: { held: 'a' } as never,
    }).result;
    expect(r.decision).toBe('reject');
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
      contextStore: undefined,
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
      contextStore: makeContextStore(new Map([['prod', makeEnvRow()]])),
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
      contextStore: makeContextStore(new Map()),
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
      contextStore: makeContextStore(new Map([['prod', makeEnvRow()]])),
      secretResolver: makeSecretResolver(new Map([['prod', { NPM_TOKEN: 'tok' }]])),
      protectionContext: baseProtectionContext,
    });
    expect(decisionCalls()).toContainEqual({
      value: 1,
      attrs: { decision: 'reject', reason: 'invalid_url_scheme' },
    });
  });

  it('records reject with env_not_found reason when an context is missing', async () => {
    await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com/', tokenSecret: 'prod:NPM_TOKEN' }],
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      contextStore: makeContextStore(new Map()),
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
      contextStore: makeContextStore(new Map([['prod', makeEnvRow({ enabled: false })]])),
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
      contextStore: makeContextStore(new Map([['prod', makeEnvRow()]])),
      secretResolver: makeSecretResolver(new Map([['prod', {}]])),
      protectionContext: baseProtectionContext,
    });
    expect(decisionCalls()).toContainEqual({
      value: 1,
      attrs: { decision: 'reject', reason: 'missing_token' },
    });
    expect(durationSpy).toHaveBeenCalledWith(expect.any(Number), { context: 'prod' });
  });

  it('records pass + per-channel/scope rows + per-env duration on a fully-resolved dispatch', async () => {
    const envs = new Map<string, DbContext>([
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
      contextStore: makeContextStore(envs),
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
    expect(durationSpy).toHaveBeenCalledWith(expect.any(Number), { context: 'prod' });
    expect(durationSpy).toHaveBeenCalledWith(expect.any(Number), { context: 'stg' });
  });

  it('labels the default registry scope as `default`', async () => {
    await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com/', tokenSecret: 'prod:NPM_TOKEN' }],
      installEnv: undefined,
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: trusted,
      contextStore: makeContextStore(new Map([['prod', makeEnvRow()]])),
      secretResolver: makeSecretResolver(new Map([['prod', { NPM_TOKEN: 't' }]])),
      protectionContext: baseProtectionContext,
    });
    expect(registryCalls()).toContainEqual({
      value: 1,
      attrs: { channel: 'registries', provider: 'static', scope: 'default' },
    });
  });
});
