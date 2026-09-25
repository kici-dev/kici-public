/**
 * Resolve workflow-level `registries:` and `installEnv:` declarations into the
 * per-dispatch fields the agent needs to authenticate `npm install` against
 * private registries.
 *
 * Each `tokenSecret` / `installEnv[]` entry uses the qualified
 * `<context>:<secret-name>` syntax. The resolver:
 *
 *   1. Parses every qualified ref and groups by context name.
 *   2. Runs the install gate (`install-gate.ts`): every referenced context's
 *      protection rules (branch / trust / concurrency / reviewer / wait-timer)
 *      are evaluated before it decides. Any `reject` fails the whole workflow
 *      dispatch with a clear reason; otherwise any hold returns ONE structured
 *      `hold` decision, aggregated across the contexts, so the caller can
 *      pause the workflow dispatch as a workflow-scoped held run and resume it
 *      when the gate clears. The hold records which contexts held and which
 *      passed. On the resume path the caller sets `skipProtectionGate` and
 *      hands back that record: the contexts that held are covered by the
 *      approval, every other context is gated again, and a context that now
 *      matches a different row is refused.
 *   3. Resolves secrets per context via `secretResolver.resolveForContext`
 *      against the row step 2 gated (which writes its own audit log lines),
 *      so a context whose name is a glob pattern delivers its own bindings.
 *   4. Validates each registry URL scheme: HTTPS always allowed; `http://`
 *      allowed only for loopback / `*.local` hosts OR when the org operator
 *      has flipped `org_settings.allow_http_npm_registries=true`.
 *   5. Strips the resolved auth entirely when the contributor-trust tier is
 *      not `trusted` (defense in depth: even if a misconfigured context
 *      lets an unknown contributor through the protection-pipeline trust
 *      gate, this strip ensures fork PRs never see registry tokens — the
 *      install fails naturally because the deps are unreachable).
 *
 * Pure helper: no imports of the dispatch giant. Tested in isolation in
 * `install-secrets-resolver.test.ts`.
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
   * Resume path: the dispatch continues past a released install-gate hold. The
   * gate runs only for the contexts `releasedHold` does not cover. The
   * untrusted-contributor strip still runs first.
   */
  skipProtectionGate?: boolean;
  /**
   * Resume path: what the released hold recorded (`hold` decision's
   * `record`). Its held contexts are covered by the approval; every recorded
   * context must still match the same row. Read as stored JSON: absent or
   * malformed, it covers no context.
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
 * The held-run `hold_type` for a gate outcome — the gate's own `holdType` when
 * it set one, otherwise the `HoldType` member its action implies. Column and
 * gate share one vocabulary, so nothing is translated here.
 *
 * Distinct from the engine's `normalizePersistedHoldType`, which maps a value
 * read back OUT of the column onto that same vocabulary.
 *
 * Exported for tests.
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
 * Match every referenced context name once — exact name first, then a glob
 * context whose pattern matches — so the protection gate and the secret
 * resolution below both act on the same row. A name with no match maps to null.
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

/**
 * The hold decision for a gate outcome that held: the aggregated verdict, the
 * context that names the hold, and the record of which contexts held.
 */
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

  // Resolve once per unique env, then look up the bare secret names from
  // each result. Missing secret => reject with a clear message.
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
