/**
 * Open a write window for one repository, pre-flighting the grant.
 *
 * The mint happens HERE — at elevation entry, before any git runs — and the
 * forge returns the permissions it actually granted. Comparing the two turns
 * "wrong permission requested" from a cryptic push-time git failure at the end
 * of a long build into a legible failure at the call site.
 *
 * What pre-flight proves: the TOKEN holds the permission. What it cannot prove:
 * that the push will succeed. A branch protection rule or repository ruleset
 * can still reject, and no token inspection predicts that.
 */

import type { GrantTable } from './grant-table.js';

type Permissions = Readonly<Record<string, string>>;
type Grant = { scoped: false } | { scoped: true; permissions: Record<string, string> };

/** Requested entries the grant does not satisfy, as `key=value` strings. */
export function missingPermissions(requested: Permissions, granted: Permissions): string[] {
  return Object.entries(requested)
    .filter(([key, value]) => granted[key] !== value)
    .map(([key, value]) => `${key}=${value}`);
}

/** Default window when the credential reports no expiry of its own. */
const DEFAULT_GRANT_TTL_MS = 60 * 60 * 1000;

export interface ElevateArgs {
  repository: string;
  permissions: Permissions;
  grants: GrantTable;
  request: (args: {
    repository: string;
    permissions: Permissions;
  }) => Promise<{ grant: Grant; expiresAt: string | null }>;
}

export async function elevateForWrite(
  args: ElevateArgs,
): Promise<{ grantId: string; granted: Grant }> {
  const { grant, expiresAt } = await args.request({
    repository: args.repository,
    permissions: args.permissions,
  });

  if (grant.scoped) {
    const missing = missingPermissions(args.permissions, grant.permissions);
    if (missing.length > 0) {
      throw new Error(
        `Cannot elevate '${args.repository}' for write: the app did not grant ` +
          `${missing.join(', ')}. Grant the permission on the app installation, ` +
          `or request only what it holds.`,
      );
    }
  }
  // A static credential reports `scoped: false`. It cannot be narrowed, so
  // there is nothing to verify — proceed and let the caller see the truth.

  const parsed = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const expiry = Number.isFinite(parsed) ? parsed : Date.now() + DEFAULT_GRANT_TTL_MS;
  const grantId = args.grants.add({
    repoPath: args.repository,
    permissions: args.permissions,
    expiresAt: expiry,
  });
  return { grantId, granted: grant };
}
