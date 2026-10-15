/**
 * Resolve workflow-level `registries:` and `installEnv:` declarations into the
 * per-dispatch fields the agent needs to authenticate `npm install` against
 * private registries.
 *
 * Each `tokenSecret` / `installEnv[]` entry uses the qualified
 * `<context>:<secret-name>` syntax. The resolver:
 *
 *   1. Parses every qualified ref and groups by context name.
 *   2. Runs the install gate (`install-gate.ts`) over every referenced
 *      context's protection rules. Any `reject` fails the whole workflow
 *      dispatch; otherwise any hold returns ONE aggregated `hold` decision,
 *      recording which contexts held and which passed, so the caller can park a
 *      workflow-scoped held run. On resume the caller sets
 *      `skipProtectionGate` and hands back that record: held contexts are
 *      covered by the approval, every other context is gated again, and a
 *      context that now matches a different row is refused.
 *   3. Resolves secrets per context via `secretResolver.resolveForContext`
 *      (which writes its own audit lines) against the row step 2 gated, so a
 *      glob-pattern context delivers its own bindings.
 *   4. Validates each registry URL scheme: HTTPS always; `http://` only for
 *      loopback / `*.local` hosts or when
 *      `org_settings.allow_http_npm_registries=true`.
 *   5. Strips the resolved auth entirely when the contributor-trust tier is
 *      not `trusted`: defense in depth, so fork PRs never see registry tokens
 *      even through a misconfigured context; the install then fails on
 *      unreachable deps.
 *
 * Pure helper: no imports of the dispatch giant.
 */

import { HoldType } from '@kici-dev/engine';
import type { ApproverClause, LockRegistry } from '@kici-dev/engine';
import type { TrustResolution } from '../security/trust-resolver.js';
import type { SecretResolverApi } from '../secrets/secret-resolver.js';
import type { ContextStore } from '../contexts/context-store.js';
import type { Context as ContextRow } from '../db/types.js';
import { isUntrustedTier } from '../security/trust-tier.js';
import type { JobDispatchContext } from '../contexts/protection/pipeline.js';
import {
  gateInstall,
  gateReleasedInstall,
  type InstallGateOutcome,
  type InstallGateRecord,
} from './install-gate.js';
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
  contextStore: ContextStore | undefined;
  secretResolver: SecretResolverApi | undefined;
  protectionContext: JobDispatchContext;
  /**
   * Resume path past a released install-gate hold: the gate runs only for
   * contexts `releasedHold` does not cover. The untrusted strip still runs first.
   */
  skipProtectionGate?: boolean;
  /**
   * Resume path: the released hold's `record`. Its held contexts are covered by
   * the approval; every recorded context must still match the same row. Absent
   * or malformed stored JSON covers no context.
   */
  releasedHold?: InstallGateRecord;
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
      /** The context whose install gate held. */
      envName: string;
      /** Resolved context id (for the held row). */
      contextId: string;
      /** Discriminates the release trigger — an engine `HoldType` member. */
      holdType: string;
      queueType: 'context' | 'security';
      requirement: InstallHoldRequirement;
      /** Which contexts held (the approval covers them) and which passed. */
      record: InstallGateRecord;
    };

/** Parse `<context>:<secret-name>`. Returns null on malformed input. */
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

/** Hosts exempt from the https requirement: `localhost`, 127.0.0.0/8, `::1`, `*.local`. */
function isLoopbackOrLocalHost(host: string): boolean {
  const lower = host.toLowerCase();
  // URL.hostname keeps IPv6 literals bracketed, e.g. "[::1]".
  const unbracketed = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
  if (unbracketed === 'localhost' || unbracketed === '::1') return true;
  if (unbracketed.endsWith('.local')) return true;
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
          reason: `registries[${i}].tokenSecret must use qualified <context>:<secret-name> syntax (got ${reg.tokenSecret})`,
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
          reason: `installEnv[${i}] must use qualified <context>:<secret-name> syntax (got ${ref})`,
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

/**
 * The held-run `hold_type`: the gate's own `holdType`, else the `HoldType` its
 * action implies. Column and gate share one vocabulary. Exported for tests.
 */
export function resolveHoldType(
  action: 'hold' | 'wait' | 'queue',
  raw: string | undefined,
): string {
  if (raw) return raw;
  if (action === 'wait') return HoldType.enum.timer;
  if (action === 'queue') return HoldType.enum.concurrency;
  return HoldType.enum.reviewer;
}

/**
 * Match every referenced context name once (exact, then glob) so the gate and
 * the secret resolution act on the same row. No match maps to null.
 */
async function matchInstallContexts(
  envNames: Iterable<string>,
  resolvedOrgId: string,
  contextStore: ContextStore,
): Promise<Map<string, ContextRow | null>> {
  const matched = new Map<string, ContextRow | null>();
  for (const envName of envNames) {
    matched.set(envName, await contextStore.matchContext(resolvedOrgId, envName));
  }
  return matched;
}

function holdDecision(
  gate: Extract<InstallGateOutcome, { kind: 'hold' }>,
): Extract<ResolveInstallSecretsResult, { decision: 'hold' }> {
  const { result, primary } = gate;
  const holdType = resolveHoldType(result.action, result.holdType);
  return {
    decision: 'hold',
    action: result.action,
    envName: primary.name,
    contextId: primary.id,
    holdType,
    queueType: holdType === HoldType.enum.security ? 'security' : 'context',
    requirement: {
      clauses: result.clauses ?? [],
      expiresAt: result.holdUntil ?? new Date(Date.now() + DEFAULT_HOLD_EXPIRY_MS).toISOString(),
      reason: result.reason ?? `context '${primary.name}' install gate ${result.action}`,
    },
    record: gate.record,
  };
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

  // Strip first for an untrusted contributor: no token bytes leave the orchestrator.
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

  // Before secret resolution, so a rejected request burns no audit row.
  if (registries) {
    for (let i = 0; i < registries.length; i++) {
      const v = validateRegistryUrlScheme(registries[i].url, args.allowHttpNpmRegistries);
      if (!v.ok) {
        recordReject(InstallSecretsDecisionReason.InvalidUrlScheme);
        return { decision: 'reject', reason: `registries[${i}]: ${v.reason}` };
      }
    }
  }

  if (!args.contextStore) {
    recordReject(InstallSecretsDecisionReason.MissingEnvStore);
    return {
      decision: 'reject',
      reason: 'workflow declares registries:/installEnv: but contextStore is not configured',
    };
  }
  if (!args.secretResolver) {
    recordReject(InstallSecretsDecisionReason.MissingSecretResolver);
    return {
      decision: 'reject',
      reason: 'workflow declares registries:/installEnv: but secretResolver is not configured',
    };
  }

  const matched = await matchInstallContexts(
    collected.envs.keys(),
    args.resolvedOrgId,
    args.contextStore,
  );
  const gateInputs = {
    matched,
    trustResolution: args.trustResolution,
    protectionContext: args.protectionContext,
  };
  const gate = args.skipProtectionGate
    ? await gateReleasedInstall({ ...gateInputs, releasedHold: args.releasedHold })
    : await gateInstall(gateInputs);
  if (gate.kind === 'hold') {
    recordHold();
    return holdDecision(gate);
  }
  if (gate.kind === 'reject') {
    recordReject(gate.reasonKind);
    return { decision: 'reject', reason: gate.reason };
  }

  const perEnv = new Map<string, Record<string, string>>();
  for (const envName of collected.envs.keys()) {
    const envRow = matched.get(envName);
    const startNs = performance.now();
    // Both gates reject an unmatched name, so every name here matched a row.
    const resolved = envRow
      ? await args.secretResolver.resolveForContext(args.resolvedOrgId, {
          id: envRow.id,
          name: envName,
        })
      : {};
    installSecretsTokenResolutionDurationSeconds.record((performance.now() - startNs) / 1000, {
      context: envName,
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
