/**
 * `findIdentityLink` is the gate the comment-approval path stands on: it decides
 * whether a `/kici approve` commenter is the KiCI user the Platform linked, and
 * that answer is then checked against `ci_trust`. Matching is by immutable
 * numeric id only — a provider username is mutable, so accepting one would let
 * anyone who renames their account to a linked member's handle inherit that
 * member's approval rights.
 *
 * Every refusal is counted under
 * `kici_orch_trust_match_refused_no_id_total{reason}`, and the three reasons are
 * asserted here alongside the return value: a refusal that stops being counted
 * is a refusal nobody can see in production.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const refusedAdd = vi.fn();
vi.mock('../metrics/prometheus.js', () => ({
  trustMatchRefusedNoIdTotal: { add: refusedAdd },
}));

const { findIdentityLink, resolveLinkedUsername } = await import('./identity-link.js');
type IdentityLink = Parameters<typeof findIdentityLink>[0][number];

/** Reasons passed to the refusal counter, in call order. */
function refusalReasons(): string[] {
  return refusedAdd.mock.calls.map((c) => (c[1] as { reason: string }).reason);
}

const LINKED: IdentityLink = {
  userId: 'user-1',
  provider: 'github',
  providerUsername: 'contributor',
  providerUserId: '12345',
};

beforeEach(() => {
  refusedAdd.mockClear();
});

describe('findIdentityLink', () => {
  it('matches on the numeric id, not the username, when the two point at different links', () => {
    // Two links on the same provider. The username matches user-A; the numeric
    // id matches user-B. The id decides.
    const links: IdentityLink[] = [
      {
        userId: 'user-A',
        provider: 'github',
        providerUsername: 'shared-name',
        providerUserId: '111',
      },
      { userId: 'user-B', provider: 'github', providerUsername: 'old-name', providerUserId: '999' },
    ];

    const link = findIdentityLink(links, 'github', 'shared-name', '999');

    expect(link).not.toBeNull();
    expect(link!.userId).toBe('user-B');
    expect(refusalReasons()).toEqual([]);
  });

  it('matches a link whose provider, username and id all agree', () => {
    const link = findIdentityLink([LINKED], 'github', 'contributor', '12345');

    expect(link).not.toBeNull();
    expect(link!.userId).toBe('user-1');
    expect(refusalReasons()).toEqual([]);
  });

  it('refuses when the event carries no numeric id (event_missing)', () => {
    // A webhook without `sender.id` can never claim a link, even when the
    // username matches one exactly.
    expect(findIdentityLink([LINKED], 'github', 'contributor', undefined)).toBeNull();
    expect(refusalReasons()).toEqual(['event_missing']);

    refusedAdd.mockClear();
    expect(findIdentityLink([LINKED], 'github', 'contributor', '')).toBeNull();
    expect(refusalReasons()).toEqual(['event_missing']);
  });

  it('refuses when the matched link carries no numeric id (link_missing)', () => {
    const unbackfilled: IdentityLink = { ...LINKED, providerUserId: null };

    expect(findIdentityLink([unbackfilled], 'github', 'contributor', '12345')).toBeNull();
    expect(refusalReasons()).toEqual(['link_missing']);

    refusedAdd.mockClear();
    const absent: IdentityLink = {
      userId: 'user-1',
      provider: 'github',
      providerUsername: 'contributor',
    };
    expect(findIdentityLink([absent], 'github', 'contributor', '12345')).toBeNull();
    expect(refusalReasons()).toEqual(['link_missing']);
  });

  it('refuses on id_mismatch — a username overlap is not a match', () => {
    // THE impersonation case: an attacker renames their provider account to a
    // linked member's handle. The usernames agree and the numeric ids do not,
    // so nothing is matched and the approval path sees no link.
    const link = findIdentityLink([LINKED], 'github', 'contributor', '999');

    expect(link).toBeNull();
    expect(refusalReasons()).toEqual(['id_mismatch']);
  });

  it('refuses a link belonging to a different provider even when the id matches', () => {
    const otherProvider: IdentityLink = { ...LINKED, provider: 'gitlab' };

    expect(findIdentityLink([otherProvider], 'github', 'contributor', '12345')).toBeNull();
    // No same-provider link matched the username either, so there is nothing to
    // classify — the refusal is silent by construction.
    expect(refusalReasons()).toEqual([]);
  });

  it('returns null for an empty link set without counting a refusal it cannot classify', () => {
    expect(findIdentityLink([], 'github', 'contributor', '12345')).toBeNull();
    expect(refusalReasons()).toEqual([]);
  });
});

describe('resolveLinkedUsername', () => {
  it('names the linked account of a KiCI user id', () => {
    expect(resolveLinkedUsername([LINKED], 'user-1')).toBe('contributor');
  });

  it('names nothing for a user id the directory does not link', () => {
    // A dashboard member who never linked a provider account. The caller drops
    // the attribution rather than printing the raw subject id, which is what
    // would otherwise reach a public commit check.
    expect(resolveLinkedUsername([LINKED], 'user-unlinked')).toBeUndefined();
  });

  it('names nothing when two providers link the same user to different accounts', () => {
    // Nothing here knows which provider serves the commit, so naming either one
    // is a coin flip that misattributes the decision half the time.
    const links: IdentityLink[] = [
      LINKED,
      { userId: 'user-1', provider: 'gitlab', providerUsername: 'someone-else' },
    ];
    expect(resolveLinkedUsername(links, 'user-1')).toBeUndefined();
  });

  it('names the account when two providers agree on it', () => {
    const links: IdentityLink[] = [
      LINKED,
      { userId: 'user-1', provider: 'gitlab', providerUsername: 'contributor' },
    ];
    expect(resolveLinkedUsername(links, 'user-1')).toBe('contributor');
  });

  it('names nothing for an empty directory', () => {
    // The pre-push state after a restart: the cache read failed, so every
    // decision is unattributable until the Platform pushes again.
    expect(resolveLinkedUsername([], 'user-1')).toBeUndefined();
  });
});
