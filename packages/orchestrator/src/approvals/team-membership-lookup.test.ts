import { describe, expect, it } from 'vitest';
import {
  EMPTY_TEAM_MEMBERSHIP_LOOKUP,
  type TeamMembershipLookup,
} from './team-membership-lookup.js';

/**
 * Build a lookup the same way `server.ts`'s `onTrustPolicyUpdate` closure does
 * from a pushed `teamMemberships` array. Kept here so the construction logic is
 * unit-tested without standing up the whole server.
 */
function buildLookup(
  teamMemberships: Array<{ teamName: string; memberUserIds: string[] }>,
): TeamMembershipLookup {
  const map = new Map(teamMemberships.map((t) => [t.teamName, new Set(t.memberUserIds)]));
  return { getTeamMembers: (name) => map.get(name) ?? new Set<string>() };
}

describe('team membership lookup', () => {
  it('returns the member set for a known team', () => {
    const lookup = buildLookup([{ teamName: 'leads', memberUserIds: ['u-1', 'u-2'] }]);
    expect([...lookup.getTeamMembers('leads')].sort()).toEqual(['u-1', 'u-2']);
  });

  it('returns an empty set for an unknown team', () => {
    const lookup = buildLookup([{ teamName: 'leads', memberUserIds: ['u-1'] }]);
    expect(lookup.getTeamMembers('nope').size).toBe(0);
  });

  it('EMPTY_TEAM_MEMBERSHIP_LOOKUP returns no members', () => {
    expect(EMPTY_TEAM_MEMBERSHIP_LOOKUP.getTeamMembers('any').size).toBe(0);
  });
});
