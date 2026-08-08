import { canonicalizeCapability, isKnownCapability } from '@kici-dev/engine';
import type { ResolvedSandboxGrant, SandboxNetworkMode } from '@kici-dev/engine';
import type { SandboxAllowList } from './sandbox-allowlist-reader.js';

/** The workflow-declared per-job escape-hatch request carried in the lock. */
export interface SandboxRequest {
  capabilities?: string[];
  network?: SandboxNetworkMode;
}

/**
 * The resolution outcome: either an authorized grant (possibly `undefined` when
 * the request is a no-op / non-escalating) or a total, loud denial.
 */
export type SandboxGrantResolution =
  { grant?: ResolvedSandboxGrant } | { denied: { reason: string } };

/**
 * Resolve a workflow-declared sandbox request against the operator's allow-list
 * (the single enforcement point). Deny is loud and total — a request for any
 * capability or host-network the operator did not allow-list fails the run with
 * a reason naming the offending cap/knob; a disallowed cap is never silently
 * stripped and run anyway. Pure (no I/O), so the allow-list is injected and the
 * function is exhaustively unit-testable.
 */
export function resolveSandboxGrant(
  request: SandboxRequest | undefined,
  allowList: SandboxAllowList,
): SandboxGrantResolution {
  if (!request || ((request.capabilities?.length ?? 0) === 0 && !request.network)) {
    return { grant: undefined };
  }

  const allowed = new Set(allowList.capabilities.map(canonicalizeCapability));
  const caps: string[] = [];
  for (const raw of request.capabilities ?? []) {
    if (!isKnownCapability(raw)) {
      return { denied: { reason: `unknown Linux capability '${raw}' in sandbox.capabilities` } };
    }
    const canon = canonicalizeCapability(raw);
    if (!allowed.has(canon)) {
      return {
        denied: {
          reason: `capability '${canon}' is not in the operator allow-list (sandboxAllowedCapabilities)`,
        },
      };
    }
    caps.push(canon);
  }

  if (request.network === 'host' && !allowList.allowHostNetwork) {
    return {
      denied: {
        reason: `host networking is not permitted (sandboxAllowHostNetwork is disabled)`,
      },
    };
  }

  const grant: ResolvedSandboxGrant = {};
  if (caps.length) grant.capabilities = caps;
  // 'default' means "use the sandbox's configured default" — do NOT emit it (config
  // wins), so a grant can never silently loosen an operator-imposed network posture.
  // Only 'none' (tighten) and the permission-gated 'host' are emitted.
  if (request.network === 'none' || request.network === 'host') grant.network = request.network;
  return { grant: Object.keys(grant).length ? grant : undefined };
}
