/**
 * Read-only lookup over the team memberships pushed from the Platform via
 * `trust_policy.update`. The orchestrator has no identity store, so this is the
 * only source of "who is in team X" — the approval resolver uses it to satisfy
 * `{team}` approver clauses.
 */
export interface TeamMembershipLookup {
  /** Returns the set of member user ids for a team name (empty if unknown). */
  getTeamMembers(name: string): Set<string>;
}

/** A lookup backed by no teams — the default before any push arrives. */
export const EMPTY_TEAM_MEMBERSHIP_LOOKUP: TeamMembershipLookup = {
  getTeamMembers: () => new Set<string>(),
};
