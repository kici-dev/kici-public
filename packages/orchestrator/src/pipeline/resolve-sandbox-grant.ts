import { canonicalizeCapability, isKnownCapability } from '@kici-dev/engine';
import type { ResolvedSandboxGrant, SandboxNetworkMode } from '@kici-dev/engine';
import type { SandboxAllowList } from './sandbox-allowlist-reader.js';

/** The workflow-declared per-job escape-hatch request carried in the lock. */
export interface SandboxRequest {
  capabilities?: string[];
  network?: SandboxNetworkMode;
}

/** An authorized grant (`undefined` for a no-op / non-escalating request) or a total denial. */
export type SandboxGrantResolution =
  { grant?: ResolvedSandboxGrant } | { denied: { reason: string } };

/**
 * The single enforcement point of a sandbox request against the operator's
 * allow-list. Deny is loud and total: any capability or host-network not
 * allow-listed fails the run with a reason naming it; a disallowed cap is never
 * silently stripped and run anyway. Pure: the allow-list is injected.
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
  // 'default' is never emitted (config wins), so a grant cannot silently loosen an
  // operator-imposed network posture; only 'none' and the gated 'host' are.
  if (request.network === 'none' || request.network === 'host') grant.network = request.network;
  return { grant: Object.keys(grant).length ? grant : undefined };
}
