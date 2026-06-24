/**
 * Resolve workflow-level `registries:` and `installEnv:` declarations into the
 * per-dispatch fields the agent needs to authenticate `npm install` against
 * private registries.
 *
 * Each `tokenSecret` / `installEnv[]` entry uses the qualified
 * `<environment>:<secret-name>` syntax. The resolver:
 *
 *   1. Parses every qualified ref and groups by environment name.
 *   2. Fires the per-environment protection-rule pipeline once per unique env
 *      (branch / trust / concurrency / reviewer / wait-timer). A `reject`
 *      result fails the whole workflow dispatch with a clear reason; a
 *      `hold` / `wait` / `queue` result returns a structured `hold` decision
 *      so the caller can pause the workflow dispatch as a workflow-scoped held
 *      run and resume it when the gate clears. On the resume path the caller
 *      sets `skipProtectionGate` so the gate (already satisfied) is bypassed
 *      and secrets are resolved directly.
 *   3. Resolves secrets per environment via `secretResolver.resolveForJob`
 *      (which writes its own audit log lines).
 *   4. Validates each registry URL scheme: HTTPS always allowed; `http://`
 *      allowed only for loopback / `*.local` hosts OR when the org operator
 *      has flipped `org_settings.allow_http_npm_registries=true`.
 *   5. Strips the resolved auth entirely when the contributor-trust tier is
 *      not `trusted` (defense in depth: even if a misconfigured environment
 *      lets an unknown contributor through the protection-pipeline trust
 *      gate, this strip ensures fork PRs never see registry tokens — the
 *      install fails naturally because the deps are unreachable).
 *
 * Pure helper: no imports of the dispatch giant. Tested in isolation in
 * `install-secrets-resolver.test.ts`.
 */

import type { ApproverClause, LockRegistry, TrustTier } from '@kici-dev/engine';
import type { TrustResolution } from '../security/trust-resolver.js';
import type { SecretResolverApi } from '../secrets/secret-resolver.js';
import type { EnvironmentStore } from '../environments/environment-store.js';
import { toEnvironment } from '../environments/environment-store.js';
import {
  evaluateProtectionRules,
  type JobDispatchContext,
} from '../environments/protection/pipeline.js';
import {
  InstallSecretsChannel,
  InstallSecretsDecisionReason,
  installSecretsContributorStrippedTotal,
  installSecretsDecisionsTotal,
  installSecretsRegistryUsedTotal,
  installSecretsTokenResolutionDurationSeconds,
} from '../metrics/prometheus.js';

/** Static provider label until typed RegistryProvider lands. */
const PROVIDER_STATIC = 'static';

/** Fallback hold expiry when the gate result carries no `holdUntil` (1h). */
const DEFAULT_HOLD_EXPIRY_MS = 3600 * 1000;

function recordPass(): void {
  installSecretsDecisionsTotal.add(1, {
    decision: 'pass',
    reason: InstallSecretsDecisionReason.Ok,
  });
}

function recordReject(reason: InstallSecretsDecisionReason): void {
  installSecretsDecisionsTotal.add(1, { decision: 'reject', reason });
}

function recordHold(): void {
  installSecretsDecisionsTotal.add(1, {
    decision: 'hold',
    reason: InstallSecretsDecisionReason.Held,
  });
}

/** Registry spec carried on the dispatch message (token already resolved). */
export interface NpmRegistrySpec {
  url: string;
  scope?: string;
  alwaysAuth: boolean;
  token: string;
}

export interface ResolveInstallSecretsArgs {
  registries: readonly LockRegistry[] | undefined;
  installEnv: readonly string[] | undefined;
  allowHttpNpmRegistries: boolean;
  resolvedOrgId: string;
  trustResolution: TrustResolution | undefined;
  environmentStore: EnvironmentStore | undefined;
  secretResolver: SecretResolverApi | undefined;
  protectionContext: JobDispatchContext;
  /**
   * Resume path: skip the protection-rule gate (already satisfied) and resolve
   * secrets directly. The untrusted-contributor strip still runs first.
   */
  skipProtectionGate?: boolean;
}

/** Normalized requirement carried on a `hold` decision. */
export interface InstallHoldRequirement {
  clauses: ApproverClause[];
  /** ISO timestamp after which the hold expires. */
  expiresAt: string;
  reason: string;
}

export type ResolveInstallSecretsResult =
  | {
      decision: 'pass';
      npmRegistries: NpmRegistrySpec[] | undefined;
      installEnvSecrets: Record<string, string> | undefined;
      contributorStripped: boolean;
    }
  | { decision: 'reject'; reason: string }
  | {
      decision: 'hold';
      /** The gate action that paused the dispatch. */
      action: 'hold' | 'wait' | 'queue';
      /** The environment whose install gate held. */
      envName: string;
      /** Resolved environment id (for the held row). */
      environmentId: string;
      /** Discriminates the release trigger: 'reviewer' | 'wait_timer' | 'concurrency' | 'security'. */
      holdType: string;
      queueType: 'environment' | 'security';
      requirement: InstallHoldRequirement;
    };

/** Parse `<environment>:<secret-name>`. Returns null on malformed input. */
export function parseQualifiedSecretRef(
  ref: string,
): { envName: string; secretName: string } | null {
  const idx = ref.indexOf(':');
  if (idx <= 0 || idx >= ref.length - 1) return null;
  const envName = ref.slice(0, idx);
  const secretName = ref.slice(idx + 1);
  if (envName.length === 0 || secretName.length === 0 || secretName.includes(':')) return null;
  return { envName, secretName };
}

/**
 * Hosts that count as loopback / link-local for the http:// exemption:
 *   - `localhost`
 *   - any IPv4 in 127.0.0.0/8
 *   - the IPv6 loopback `::1` (URL.hostname returns this with brackets)
 *   - any `*.local` mDNS hostname
 */
function isLoopbackOrLocalHost(host: string): boolean {
  const lower = host.toLowerCase();
  // URL.hostname keeps IPv6 literals bracketed, e.g. "[::1]". Strip before compare.
  const unbracketed = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
  if (unbracketed === 'localhost' || unbracketed === '::1') return true;
  if (unbracketed.endsWith('.local')) return true;
  // 127.0.0.0/8 — first octet must be 127 and the rest must be valid IPv4.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(unbracketed);
  if (!m) return false;
  const [, a, b, c, d] = m;
  const oct = (s: string): number => Number(s);
  if (oct(a) !== 127) return false;
  return [b, c, d].every((s) => {
    const n = oct(s);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

/** Validate a registry URL's scheme against the org's http allow-toggle. */
export function validateRegistryUrlScheme(
  url: string,
  allowHttp: boolean,
): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `invalid registry URL: ${url}` };
  }
  if (parsed.protocol === 'https:') return { ok: true };
  if (parsed.protocol === 'http:') {
    if (allowHttp) return { ok: true };
    if (isLoopbackOrLocalHost(parsed.hostname)) return { ok: true };
    return {
      ok: false,
      reason: `http:// registry ${url} is not loopback/.local and org_settings.allow_http_npm_registries is false`,
    };
  }
  return { ok: false, reason: `unsupported registry URL scheme ${parsed.protocol} (${url})` };
}

/** True when the resolved trust tier is anything other than 'trusted'. */
function isUntrustedTier(tier: TrustTier | undefined): boolean {
  if (tier === undefined) return false;
  return tier !== 'trusted';
}

/**
 * Collect every unique `(envName, secretName)` referenced across `registries`
 * and `installEnv`, returning either the parsed map or an aggregated error.
 */
function collectSecretRefs(
  registries: readonly LockRegistry[] | undefined,
  installEnv: readonly string[] | undefined,
):
  | {
      ok: true;
      envs: Map<string, Set<string>>;
      registryRefs: Array<{ index: number; envName: string; secretName: string }>;
      installRefs: Array<{ envName: string; secretName: string }>;
    }
  | { ok: false; reason: string } {
  const envs = new Map<string, Set<string>>();
  const registryRefs: Array<{ index: number; envName: string; secretName: string }> = [];
  const installRefs: Array<{ envName: string; secretName: string }> = [];
  if (registries) {
    for (let i = 0; i < registries.length; i++) {
      const reg = registries[i];
      const parsed = parseQualifiedSecretRef(reg.tokenSecret);
      if (!parsed) {
        return {
          ok: false,
          reason: `registries[${i}].tokenSecret must use qualified <environment>:<secret-name> syntax (got ${reg.tokenSecret})`,
        };
      }
      registryRefs.push({ index: i, ...parsed });
      const set = envs.get(parsed.envName) ?? new Set<string>();
      set.add(parsed.secretName);
      envs.set(parsed.envName, set);
    }
  }
  if (installEnv) {
    for (let i = 0; i < installEnv.length; i++) {
      const ref = installEnv[i];
      const parsed = parseQualifiedSecretRef(ref);
      if (!parsed) {
        return {
          ok: false,
          reason: `installEnv[${i}] must use qualified <environment>:<secret-name> syntax (got ${ref})`,
        };
      }
      installRefs.push(parsed);
      const set = envs.get(parsed.envName) ?? new Set<string>();
      set.add(parsed.secretName);
      envs.set(parsed.envName, set);
    }
  }
  return { ok: true, envs, registryRefs, installRefs };
}

/** Engine gate `holdType` ('timer') → held-run `hold_type` ('wait_timer'). */
function normalizeHoldType(action: 'hold' | 'wait' | 'queue', raw: string | undefined): string {
  if (raw === 'timer') return 'wait_timer';
  if (raw) return raw;
  if (action === 'wait') return 'wait_timer';
  if (action === 'queue') return 'concurrency';
  return 'reviewer';
}

/**
 * Result of evaluating the per-environment install gates. `held` carries the
 * structured gate outcome (action, env id, hold type, clauses, hold-expiry) so
 * the caller can pause the workflow dispatch as a workflow-scoped held run.
 */
type FireProtectionResult =
  | { ok: true }
  | { ok: false; reasonKind: 'env_not_found' | 'protection_rule_block'; reason: string }
  | {
      ok: false;
      reasonKind: 'held';
      action: 'hold' | 'wait' | 'queue';
      envName: string;
      environmentId: string;
      holdType: string;
      holdUntil: string | undefined;
      clauses: ApproverClause[];
      reason: string;
    };

/**
 * Run the protection-rule pipeline once per unique environment. On the first
 * `reject` env returns a reject result; on the first `hold`/`wait`/`queue` env
 * returns a structured `held` result. When `skipProtectionGate` is set (resume
 * path) the gate is bypassed entirely.
 */
async function fireProtectionRulesPerEnv(args: {
  envNames: Iterable<string>;
  resolvedOrgId: string;
  environmentStore: EnvironmentStore;
  trustResolution: TrustResolution | undefined;
  protectionContext: JobDispatchContext;
  skipProtectionGate: boolean;
}): Promise<FireProtectionResult> {
  const { envNames, resolvedOrgId, environmentStore, trustResolution, protectionContext } = args;
  if (args.skipProtectionGate) return { ok: true };
  for (const envName of envNames) {
    const envRow = await environmentStore.matchEnvironment(resolvedOrgId, envName);
    if (!envRow) {
      return {
        ok: false,
        reasonKind: 'env_not_found',
        reason: `registries: refers to environment '${envName}' which does not exist`,
      };
    }
    const env = toEnvironment(envRow);
    // Workflow-level install has no per-job concurrency group — pass the
    // env name itself so the concurrency-gate counts on the env scope only.
    const concurrencyGroup = envName;
    // running-count of 0: workflow-level install does not yet contribute to
    // the env's running-job count (a queue hold pauses the workflow instead).
    const result = await evaluateProtectionRules(
      env,
      protectionContext,
      0,
      concurrencyGroup,
      trustResolution?.tier,
    );
    if (result.action === 'pass') continue;
    if (result.action === 'reject') {
      const detail = result.reason ?? 'rejected';
      return {
        ok: false,
        reasonKind: 'protection_rule_block',
        reason: `environment '${envName}' install gate reject: ${detail}`,
      };
    }
    return {
      ok: false,
      reasonKind: 'held',
      action: result.action,
      envName,
      environmentId: env.id,
      holdType: normalizeHoldType(result.action, result.holdType),
      holdUntil: result.holdUntil,
      clauses: result.clauses ?? [],
      reason: result.reason ?? `environment '${envName}' install gate ${result.action}`,
    };
  }
  return { ok: true };
}

export async function resolveInstallSecrets(
  args: ResolveInstallSecretsArgs,
): Promise<ResolveInstallSecretsResult> {
  const { registries, installEnv } = args;
  const hasRegistries = registries && registries.length > 0;
  const hasInstallEnv = installEnv && installEnv.length > 0;
  if (!hasRegistries && !hasInstallEnv) {
    return {
      decision: 'pass',
      npmRegistries: undefined,
      installEnvSecrets: undefined,
      contributorStripped: false,
    };
  }

  // Strip first when the contributor is untrusted: the install will fail
  // naturally on missing private deps, no token bytes leave the orchestrator.
  if (isUntrustedTier(args.trustResolution?.tier)) {
    installSecretsContributorStrippedTotal.add(1, {
      trust_tier: args.trustResolution?.tier ?? 'unknown',
    });
    recordPass();
    return {
      decision: 'pass',
      npmRegistries: undefined,
      installEnvSecrets: undefined,
      contributorStripped: true,
    };
  }

  const collected = collectSecretRefs(registries, installEnv);
  if (!collected.ok) {
    recordReject(InstallSecretsDecisionReason.MalformedRef);
    return { decision: 'reject', reason: collected.reason };
  }

  // Validate registry URL schemes BEFORE any secret resolution to avoid
  // burning a secret-resolver audit row on a request that will be rejected.
  if (registries) {
    for (let i = 0; i < registries.length; i++) {
      const v = validateRegistryUrlScheme(registries[i].url, args.allowHttpNpmRegistries);
      if (!v.ok) {
        recordReject(InstallSecretsDecisionReason.InvalidUrlScheme);
        return { decision: 'reject', reason: `registries[${i}]: ${v.reason}` };
      }
    }
  }

  if (!args.environmentStore) {
    recordReject(InstallSecretsDecisionReason.MissingEnvStore);
    return {
      decision: 'reject',
      reason: 'workflow declares registries:/installEnv: but environmentStore is not configured',
    };
  }
  if (!args.secretResolver) {
    recordReject(InstallSecretsDecisionReason.MissingSecretResolver);
    return {
      decision: 'reject',
      reason: 'workflow declares registries:/installEnv: but secretResolver is not configured',
    };
  }

  const gateResult = await fireProtectionRulesPerEnv({
    envNames: collected.envs.keys(),
    resolvedOrgId: args.resolvedOrgId,
    environmentStore: args.environmentStore,
    trustResolution: args.trustResolution,
    protectionContext: args.protectionContext,
    skipProtectionGate: args.skipProtectionGate ?? false,
  });
  if (!gateResult.ok && gateResult.reasonKind === 'held') {
    recordHold();
    const expiresAt =
      gateResult.holdUntil ?? new Date(Date.now() + DEFAULT_HOLD_EXPIRY_MS).toISOString();
    return {
      decision: 'hold',
      action: gateResult.action,
      envName: gateResult.envName,
      environmentId: gateResult.environmentId,
      holdType: gateResult.holdType,
      queueType: gateResult.holdType === 'security' ? 'security' : 'environment',
      requirement: {
        clauses: gateResult.clauses,
        expiresAt,
        reason: gateResult.reason,
      },
    };
  }
  if (!gateResult.ok) {
    recordReject(
      gateResult.reasonKind === 'env_not_found'
        ? InstallSecretsDecisionReason.EnvNotFound
        : InstallSecretsDecisionReason.ProtectionRuleBlock,
    );
    return { decision: 'reject', reason: gateResult.reason };
  }

  // Resolve once per unique env, then look up the bare secret names from
  // each result. Missing secret => reject with a clear message.
  const perEnv = new Map<string, Record<string, string>>();
  for (const envName of collected.envs.keys()) {
    const startNs = performance.now();
    const resolved = await args.secretResolver.resolveForJob(args.resolvedOrgId, envName);
    installSecretsTokenResolutionDurationSeconds.record((performance.now() - startNs) / 1000, {
      environment: envName,
    });
    perEnv.set(envName, resolved);
  }

  const npmRegistries: NpmRegistrySpec[] = [];
  for (const ref of collected.registryRefs) {
    const reg = registries![ref.index];
    const bag = perEnv.get(ref.envName) ?? {};
    const token = bag[ref.secretName];
    if (token === undefined || token.length === 0) {
      recordReject(InstallSecretsDecisionReason.MissingToken);
      return {
        decision: 'reject',
        reason: `registries[${ref.index}].tokenSecret '${reg.tokenSecret}' did not resolve to a value (env '${ref.envName}', secret '${ref.secretName}')`,
      };
    }
    npmRegistries.push({
      url: reg.url,
      scope: reg.scope,
      alwaysAuth: reg.alwaysAuth ?? true,
      token,
    });
    installSecretsRegistryUsedTotal.add(1, {
      channel: InstallSecretsChannel.Registries,
      provider: PROVIDER_STATIC,
      scope: reg.scope ?? 'default',
    });
  }

  const installEnvSecrets: Record<string, string> = {};
  for (const ref of collected.installRefs) {
    const bag = perEnv.get(ref.envName) ?? {};
    const value = bag[ref.secretName];
    if (value === undefined || value.length === 0) {
      recordReject(InstallSecretsDecisionReason.MissingInstallEnv);
      return {
        decision: 'reject',
        reason: `installEnv entry '${ref.envName}:${ref.secretName}' did not resolve to a value`,
      };
    }
    installEnvSecrets[ref.secretName] = value;
    installSecretsRegistryUsedTotal.add(1, {
      channel: InstallSecretsChannel.InstallEnv,
      provider: PROVIDER_STATIC,
      scope: '-',
    });
  }

  recordPass();
  return {
    decision: 'pass',
    npmRegistries: npmRegistries.length > 0 ? npmRegistries : undefined,
    installEnvSecrets: Object.keys(installEnvSecrets).length > 0 ? installEnvSecrets : undefined,
    contributorStripped: false,
  };
}
