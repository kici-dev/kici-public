/**
 * The reduced-privilege note a run whose ref resolved to a tier other than
 * `trusted` carries on the provider checks that describe a run which executes.
 */
import { describe, it, expect } from 'vitest';
import { REDUCED_PRIVILEGE_MARKER, buildReducedPrivilegeNote } from './reduced-privilege-note.js';
import { buildSecurityHoldSummary, buildSecurityRejectionSummary } from '../pipeline/processor.js';

const BASE_BRANCH_CLAUSE = 'Workflow definitions were read from the base branch';

describe('buildReducedPrivilegeNote', () => {
  it('names the posture for the untrusted tier a fork ref resolves to', () => {
    const note = buildReducedPrivilegeNote('unknown');
    expect(note).toContain(REDUCED_PRIVILEGE_MARKER);
    expect(note).toContain("does not carry the workflow's registry or install secrets");
    expect(note).toContain('build-cache writes are confined to this run');
  });

  it('names the posture for the legacy `known` tier stored rows may still hold', () => {
    expect(buildReducedPrivilegeNote('known')).toContain(REDUCED_PRIVILEGE_MARKER);
  });

  it('says nothing for a trusted ref', () => {
    expect(buildReducedPrivilegeNote('trusted')).toBeNull();
    expect(buildReducedPrivilegeNote('trusted', 'base')).toBeNull();
  });

  it('says nothing when trust never resolved — an absent tier keeps its install secrets', () => {
    expect(buildReducedPrivilegeNote(undefined)).toBeNull();
    expect(buildReducedPrivilegeNote(null)).toBeNull();
    expect(buildReducedPrivilegeNote(undefined, 'base')).toBeNull();
  });

  it('adds the base-branch clause only for a run recorded against the base lock', () => {
    expect(buildReducedPrivilegeNote('unknown', 'base')).toContain(BASE_BRANCH_CLAUSE);
    expect(buildReducedPrivilegeNote('unknown', 'head')).not.toContain(BASE_BRANCH_CLAUSE);
    expect(buildReducedPrivilegeNote('unknown', null)).not.toContain(BASE_BRANCH_CLAUSE);
    expect(buildReducedPrivilegeNote('unknown')).not.toContain(BASE_BRANCH_CLAUSE);
  });
});

describe('the security-queue summary builders carry no posture note of their own', () => {
  // Neither builder appends the note; the call site does, because the two
  // summaries are read on checks with different fates. A trust-policy HOLD
  // stores a resume context, so `/kici approve` replays its dispatch and
  // `holdRunForSecurityPolicy` appends the note — asserted at that call site in
  // `dispatch-matched-workflow.test.ts`. A trust-policy REJECTION never runs, so
  // its call site appends nothing and a note there would describe a run that
  // does not happen.
  it('omits it from a fork-PR hold summary', () => {
    const summary = buildSecurityHoldSummary('fork_pr', 'unknown', 'octocat');
    expect(summary).toContain('Fork PR requires approval');
    expect(summary).toContain('(tier: unknown)');
    expect(summary).not.toContain(REDUCED_PRIVILEGE_MARKER);
  });

  it('omits it from a trust-policy rejection summary', () => {
    const summary = buildSecurityRejectionSummary('fork_pr', 'msg', 'unknown', 'octocat');
    expect(summary).toContain('**Rejected by the org trust policy** (fork_pr).');
    expect(summary).not.toContain(REDUCED_PRIVILEGE_MARKER);
  });

  it('displays `unknown` for an unresolved tier rather than making the caller forge it', () => {
    expect(buildSecurityHoldSummary('fork_pr', undefined, 'octocat')).toContain('(tier: unknown)');
    expect(buildSecurityRejectionSummary('fork_pr', 'msg', undefined, 'octocat')).toContain(
      '(tier: unknown)',
    );
  });
});
