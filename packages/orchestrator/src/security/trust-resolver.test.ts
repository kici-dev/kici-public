import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TrustResolver, type IdentityLink, type PermissionLevel } from './trust-resolver.js';
import { ContributorCache } from './contributor-cache.js';
import type { ContributorResolver, ContributorInfo, ContributorPermission } from '@kici-dev/engine';

// ── Helpers ──────────────────────────────────────────────────────

function createMockResolver(permission: ContributorPermission = 'write'): ContributorResolver {
  return {
    provider: 'github',
    resolveContributor: vi.fn().mockResolvedValue({
      username: 'contributor',
      permission,
      isForkPR: false,
    }),
  };
}

function createParams(overrides: {
  providerUsername?: string;
  providerUserId?: string;
  isForkPR?: boolean;
  identityLinks?: IdentityLink[];
  orgMemberPermissions?: Map<string, PermissionLevel>;
  contributorResolver?: ContributorResolver;
}) {
  return {
    providerUsername: overrides.providerUsername ?? 'contributor',
    providerUserId: overrides.providerUserId,
    provider: 'github',
    repoIdentifier: 'owner/repo',
    isForkPR: overrides.isForkPR ?? false,
    orgId: 'org-1',
    identityLinks: overrides.identityLinks ?? [],
    orgMemberPermissions: overrides.orgMemberPermissions ?? new Map(),
    contributorResolver: overrides.contributorResolver ?? createMockResolver(),
    credentials: { installationId: 123 },
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('TrustResolver', () => {
  let cache: ContributorCache;
  let resolver: TrustResolver;

  beforeEach(() => {
    cache = new ContributorCache({ ttlMs: 60_000 });
    resolver = new TrustResolver(cache);
  });

  describe('fork PRs', () => {
    it('resolves to unknown regardless of identity or RBAC', async () => {
      const result = await resolver.resolveTrustTier(
        createParams({
          isForkPR: true,
          identityLinks: [
            { userId: 'user-1', provider: 'github', providerUsername: 'contributor' },
          ],
          orgMemberPermissions: new Map([['user-1', 'admin']]),
          contributorResolver: createMockResolver('admin'),
        }),
      );

      expect(result.tier).toBe('unknown');
      expect(result.identityLinked).toBe(false);
      expect(result.reason).toContain('Fork PR');
    });
  });

  describe('no identity link', () => {
    it('resolves to known when provider shows read access', async () => {
      const result = await resolver.resolveTrustTier(
        createParams({
          identityLinks: [],
          contributorResolver: createMockResolver('read'),
        }),
      );

      expect(result.tier).toBe('known');
      expect(result.identityLinked).toBe(false);
      expect(result.reason).toContain('No identity link');
      expect(result.reason).toContain('read');
    });

    it('resolves to known when provider shows write access', async () => {
      const result = await resolver.resolveTrustTier(
        createParams({
          identityLinks: [],
          contributorResolver: createMockResolver('write'),
        }),
      );

      expect(result.tier).toBe('known');
      expect(result.identityLinked).toBe(false);
    });

    it('resolves to unknown when provider shows no access', async () => {
      const result = await resolver.resolveTrustTier(
        createParams({
          identityLinks: [],
          contributorResolver: createMockResolver('none'),
        }),
      );

      expect(result.tier).toBe('unknown');
      expect(result.identityLinked).toBe(false);
      expect(result.reason).toContain('No identity link');
    });

    it('never resolves to trusted without identity link', async () => {
      // Even with admin access, no identity link -> never trusted
      const result = await resolver.resolveTrustTier(
        createParams({
          identityLinks: [],
          contributorResolver: createMockResolver('admin'),
        }),
      );

      expect(result.tier).not.toBe('trusted');
      expect(result.tier).toBe('known');
    });
  });

  describe('identity linked', () => {
    const identityLinks: IdentityLink[] = [
      {
        userId: 'user-1',
        provider: 'github',
        providerUsername: 'contributor',
        providerUserId: '12345',
      },
    ];

    function linkedParams(
      overrides: Parameters<typeof createParams>[0] = {},
    ): ReturnType<typeof createParams> {
      // Strict policy requires both event + link to expose the numeric id;
      // tests in this block default to id '12345' on both sides.
      return createParams({ providerUserId: '12345', identityLinks, ...overrides });
    }

    it('trusted: ci_trust write + provider write', async () => {
      const result = await resolver.resolveTrustTier(
        linkedParams({
          orgMemberPermissions: new Map([['user-1', 'write']]),
          contributorResolver: createMockResolver('write'),
        }),
      );

      expect(result.tier).toBe('trusted');
      expect(result.identityLinked).toBe(true);
      expect(result.userId).toBe('user-1');
      expect(result.ciTrustLevel).toBe('write');
      expect(result.providerPermission).toBe('write');
    });

    it('trusted: ci_trust admin + provider admin', async () => {
      const result = await resolver.resolveTrustTier(
        linkedParams({
          orgMemberPermissions: new Map([['user-1', 'admin']]),
          contributorResolver: createMockResolver('admin'),
        }),
      );

      expect(result.tier).toBe('trusted');
    });

    it('trusted: ci_trust admin + provider write', async () => {
      const result = await resolver.resolveTrustTier(
        linkedParams({
          orgMemberPermissions: new Map([['user-1', 'admin']]),
          contributorResolver: createMockResolver('write'),
        }),
      );

      expect(result.tier).toBe('trusted');
    });

    it('known: ci_trust none + provider write', async () => {
      const result = await resolver.resolveTrustTier(
        linkedParams({
          orgMemberPermissions: new Map([['user-1', 'none']]),
          contributorResolver: createMockResolver('write'),
        }),
      );

      expect(result.tier).toBe('known');
      expect(result.ciTrustLevel).toBe('none');
    });

    it('known: ci_trust read + provider write', async () => {
      const result = await resolver.resolveTrustTier(
        linkedParams({
          orgMemberPermissions: new Map([['user-1', 'read']]),
          contributorResolver: createMockResolver('write'),
        }),
      );

      expect(result.tier).toBe('known');
    });

    it('known: ci_trust admin + provider read (read overrides trust)', async () => {
      const result = await resolver.resolveTrustTier(
        linkedParams({
          orgMemberPermissions: new Map([['user-1', 'admin']]),
          contributorResolver: createMockResolver('read'),
        }),
      );

      expect(result.tier).toBe('known');
      expect(result.reason).toContain('read');
    });

    it('unknown: ci_trust write + provider none', async () => {
      const result = await resolver.resolveTrustTier(
        linkedParams({
          orgMemberPermissions: new Map([['user-1', 'write']]),
          contributorResolver: createMockResolver('none'),
        }),
      );

      expect(result.tier).toBe('unknown');
      expect(result.ciTrustLevel).toBe('write');
      expect(result.providerPermission).toBe('none');
    });

    it('defaults to ci_trust none when user not in orgMemberPermissions', async () => {
      const result = await resolver.resolveTrustTier(
        linkedParams({
          orgMemberPermissions: new Map(), // user-1 not present
          contributorResolver: createMockResolver('write'),
        }),
      );

      expect(result.tier).toBe('known');
      expect(result.ciTrustLevel).toBe('none');
    });
  });

  describe('audit trail', () => {
    it('includes human-readable reason for all tiers', async () => {
      const identityLinks: IdentityLink[] = [
        {
          userId: 'user-1',
          provider: 'github',
          providerUsername: 'contributor',
          providerUserId: '12345',
        },
      ];

      const trusted = await resolver.resolveTrustTier(
        createParams({
          providerUserId: '12345',
          identityLinks,
          orgMemberPermissions: new Map([['user-1', 'write']]),
          contributorResolver: createMockResolver('write'),
        }),
      );
      expect(trusted.reason).toBeTruthy();
      expect(trusted.reason.length).toBeGreaterThan(10);

      const unknown = await resolver.resolveTrustTier(
        createParams({
          isForkPR: true,
        }),
      );
      expect(unknown.reason).toBeTruthy();
      expect(unknown.reason.length).toBeGreaterThan(10);
    });

    it('numeric-id match wins over username when both are present', async () => {
      // Two links: same provider, different users. Username matches user-A,
      // but providerUserId matches user-B. Expect resolution against user-B.
      const result = await resolver.resolveTrustTier(
        createParams({
          providerUsername: 'shared-name',
          providerUserId: '999',
          identityLinks: [
            {
              userId: 'user-A',
              provider: 'github',
              providerUsername: 'shared-name',
              providerUserId: '111',
            },
            {
              userId: 'user-B',
              provider: 'github',
              providerUsername: 'old-name',
              providerUserId: '999',
            },
          ],
          orgMemberPermissions: new Map([
            ['user-A', 'none'],
            ['user-B', 'admin'],
          ]),
          contributorResolver: createMockResolver('admin'),
        }),
      );
      expect(result.tier).toBe('trusted');
      expect(result.userId).toBe('user-B');
    });

    it('refuses identity-link match when event has no providerUserId (event_missing)', async () => {
      // Strict policy: a webhook without sender.id can never claim an
      // identity link. Treated as if no link exists -> resolution falls
      // through to provider-permission-only path (here: provider admin -> known).
      const result = await resolver.resolveTrustTier(
        createParams({
          providerUsername: 'contributor',
          // providerUserId omitted
          identityLinks: [
            {
              userId: 'user-1',
              provider: 'github',
              providerUsername: 'contributor',
              providerUserId: '12345',
            },
          ],
          orgMemberPermissions: new Map([['user-1', 'admin']]),
          contributorResolver: createMockResolver('admin'),
        }),
      );
      expect(result.identityLinked).toBe(false);
      expect(result.tier).toBe('known');
      expect(result.userId).toBeUndefined();
    });

    it('refuses identity-link match when link has no providerUserId (link_missing)', async () => {
      // Legacy un-backfilled row -> strict policy refuses, resolution
      // falls through to provider-permission-only path.
      const result = await resolver.resolveTrustTier(
        createParams({
          providerUsername: 'contributor',
          providerUserId: '12345',
          identityLinks: [
            {
              userId: 'user-1',
              provider: 'github',
              providerUsername: 'contributor',
              providerUserId: null,
            },
          ],
          orgMemberPermissions: new Map([['user-1', 'admin']]),
          contributorResolver: createMockResolver('admin'),
        }),
      );
      expect(result.identityLinked).toBe(false);
      expect(result.tier).toBe('known');
    });

    it('refuses identity-link match on id_mismatch (username overlap is not enough)', async () => {
      // Username matches user-1, but the link's id (111) does not match
      // the event id (999) -> the username overlap is exactly the
      // mutable-username impersonation case the strict policy blocks.
      // No identity link -> provider permission alone -> known.
      const result = await resolver.resolveTrustTier(
        createParams({
          providerUsername: 'contributor',
          providerUserId: '999',
          identityLinks: [
            {
              userId: 'user-1',
              provider: 'github',
              providerUsername: 'contributor',
              providerUserId: '111',
            },
          ],
          orgMemberPermissions: new Map([['user-1', 'admin']]),
          contributorResolver: createMockResolver('admin'),
        }),
      );
      expect(result.identityLinked).toBe(false);
      expect(result.tier).toBe('known');
    });

    it('refuses to unknown when id_mismatch and provider has no permission', async () => {
      const result = await resolver.resolveTrustTier(
        createParams({
          providerUsername: 'contributor',
          providerUserId: '999',
          identityLinks: [
            {
              userId: 'user-1',
              provider: 'github',
              providerUsername: 'contributor',
              providerUserId: '111',
            },
          ],
          orgMemberPermissions: new Map([['user-1', 'admin']]),
          contributorResolver: createMockResolver('none'),
        }),
      );
      expect(result.identityLinked).toBe(false);
      expect(result.tier).toBe('unknown');
    });

    it('populates all fields for linked trusted contributor', async () => {
      const result = await resolver.resolveTrustTier(
        createParams({
          providerUserId: '12345',
          identityLinks: [
            {
              userId: 'user-1',
              provider: 'github',
              providerUsername: 'contributor',
              providerUserId: '12345',
            },
          ],
          orgMemberPermissions: new Map([['user-1', 'admin']]),
          contributorResolver: createMockResolver('admin'),
        }),
      );

      expect(result.tier).toBe('trusted');
      expect(result.contributorUsername).toBe('contributor');
      expect(result.identityLinked).toBe(true);
      expect(result.userId).toBe('user-1');
      expect(result.providerPermission).toBe('admin');
      expect(result.ciTrustLevel).toBe('admin');
      expect(result.reason).toBeTruthy();
    });
  });

  // ── `trust_policy.update` orch-side defense-in-depth (security invariant) ──
  //
  // Pentest catalog at
  // — Platform→Orchestrator dispatch surface under attacker model A10
  // (compromised Platform credential / rogue Platform process). The Platform
  // pushes `trust_policy.update` carrying `identityLinks` + `memberCiTrustLevels`
  // (consumed) and `policy.{forkPolicy,unknownContributorPolicy,
  // workflowChangePolicy,approvalExpiryHours}` (received but DROPPED by
  // `server.ts:798 onTrustPolicyUpdate`). The defense-in-depth invariant is:
  // even if a rogue Platform forges identityLinks + admin ci_trust for an
  // attacker, the trust resolver still calls `contributorCache.resolve(...)`
  // against the real provider API. Without provider write+ access, the
  // resolved tier cannot be `trusted` regardless of Platform-supplied data.
  describe('defense-in-depth under rogue Platform (A10)', () => {
    it('rogue Platform-supplied identity link + admin ci_trust cannot fake trusted when provider permission is none', async () => {
      // Forged Platform push: claims attacker is linked to an internal userId
      // and that userId has admin ci_trust. The provider API independently
      // returns 'none' for the attacker — the resolver must NOT elevate.
      const result = await resolver.resolveTrustTier(
        createParams({
          providerUsername: 'attacker',
          providerUserId: '99999',
          identityLinks: [
            {
              userId: 'forged-user-id',
              provider: 'github',
              providerUsername: 'attacker',
              providerUserId: '99999',
            },
          ],
          orgMemberPermissions: new Map([['forged-user-id', 'admin']]),
          contributorResolver: createMockResolver('none'),
        }),
      );

      expect(result.tier).toBe('unknown');
      expect(result.tier).not.toBe('trusted');
      expect(result.providerPermission).toBe('none');
    });

    it('rogue Platform-supplied admin ci_trust does not elevate provider read to trusted', async () => {
      // Real user with provider read access. Rogue Platform claims they have
      // admin ci_trust. Without provider write+, the tier must stay at known
      // (provider read) — never trusted.
      const result = await resolver.resolveTrustTier(
        createParams({
          providerUsername: 'contributor',
          providerUserId: '12345',
          identityLinks: [
            {
              userId: 'user-1',
              provider: 'github',
              providerUsername: 'contributor',
              providerUserId: '12345',
            },
          ],
          orgMemberPermissions: new Map([['user-1', 'admin']]),
          contributorResolver: createMockResolver('read'),
        }),
      );

      expect(result.tier).toBe('known');
      expect(result.tier).not.toBe('trusted');
      expect(result.providerPermission).toBe('read');
      expect(result.ciTrustLevel).toBe('admin');
    });

    it('fork PR with rogue admin identity link still resolves to unknown', async () => {
      // Fork PRs are unconditionally unknown regardless of identity / RBAC.
      // A rogue Platform that pre-seeds an identityLink for the fork
      // contributor cannot bypass the fork-PR gate.
      const result = await resolver.resolveTrustTier(
        createParams({
          isForkPR: true,
          providerUsername: 'attacker',
          providerUserId: '99999',
          identityLinks: [
            {
              userId: 'forged',
              provider: 'github',
              providerUsername: 'attacker',
              providerUserId: '99999',
            },
          ],
          orgMemberPermissions: new Map([['forged', 'admin']]),
          contributorResolver: createMockResolver('admin'),
        }),
      );

      expect(result.tier).toBe('unknown');
      expect(result.reason).toContain('Fork PR');
    });
  });
});
