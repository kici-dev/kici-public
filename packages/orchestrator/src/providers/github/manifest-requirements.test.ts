import { describe, it, expect, vi } from 'vitest';
import {
  findGithubAppRequirementGaps,
  hasRequirementGaps,
  listGithubAppInstallations,
  type GithubAppInstallationGrant,
} from './manifest.js';

const COMPLETE_EVENTS = ['push', 'pull_request', 'check_run', 'check_suite', 'issue_comment'];
// A real App often holds more than KiCI asks for: write on contents and issues.
const COMPLETE_PERMISSIONS = {
  contents: 'write',
  metadata: 'read',
  pull_requests: 'read',
  checks: 'write',
  members: 'read',
  issues: 'write',
};

function org(id: number, permissions: Record<string, string>): GithubAppInstallationGrant {
  return { id, account: `org-${id}`, accountType: 'Organization', permissions };
}

describe('findGithubAppRequirementGaps', () => {
  // fails-when: the check reads the wrong response field or always reports nothing.
  it('reports an App made before issue_comment was required', () => {
    const { issues: _issues, ...withoutIssues } = COMPLETE_PERMISSIONS;
    const gaps = findGithubAppRequirementGaps(
      {
        events: ['push', 'pull_request', 'check_run', 'check_suite'],
        permissions: withoutIssues,
      },
      [],
    );
    expect(gaps.missingEvents).toEqual(['issue_comment']);
    expect(gaps.missingPermissions).toEqual(['issues']);
    expect(hasRequirementGaps(gaps)).toBe(true);
  });

  // fails-when: the check requires check_run / check_suite in GET /app's `events`.
  //   GitHub subscribes an App with Checks write to both automatically and does not
  //   list them, so every real App would be reported as lacking them.
  it('treats check_run and check_suite as subscribed when the App holds Checks write', () => {
    const gaps = findGithubAppRequirementGaps(
      { events: ['push', 'pull_request', 'issue_comment'], permissions: COMPLETE_PERMISSIONS },
      [],
    );
    expect(gaps.missingEvents).toEqual([]);
  });

  // breaks-if-wrong: with only Checks read, GitHub does not subscribe the App
  //   automatically, so unlisted check events are still reported.
  it('still reports unlisted check events when the App holds only Checks read', () => {
    const gaps = findGithubAppRequirementGaps(
      {
        events: ['push', 'pull_request', 'issue_comment'],
        permissions: { ...COMPLETE_PERMISSIONS, checks: 'read' },
      },
      [],
    );
    expect(gaps.missingEvents).toEqual(['check_run', 'check_suite']);
    expect(gaps.missingPermissions).toEqual(['checks']);
  });

  // breaks-if-wrong: a higher level than required is never a gap.
  it('reports nothing for a complete App holding higher levels', () => {
    const gaps = findGithubAppRequirementGaps(
      { events: COMPLETE_EVENTS, permissions: COMPLETE_PERMISSIONS },
      [org(1, COMPLETE_PERMISSIONS)],
    );
    expect(gaps).toEqual({
      missingEvents: [],
      missingPermissions: [],
      installationsPendingApproval: [],
    });
    expect(hasRequirementGaps(gaps)).toBe(false);
  });

  // breaks-if-wrong: admin is the highest level, so it satisfies a write requirement.
  it('treats admin as satisfying a write requirement', () => {
    const gaps = findGithubAppRequirementGaps(
      { events: COMPLETE_EVENTS, permissions: { ...COMPLETE_PERMISSIONS, checks: 'admin' } },
      [],
    );
    expect(gaps.missingPermissions).toEqual([]);
  });

  it('reports a level below the required one', () => {
    const gaps = findGithubAppRequirementGaps(
      { events: COMPLETE_EVENTS, permissions: { ...COMPLETE_PERMISSIONS, checks: 'read' } },
      [],
    );
    expect(gaps.missingPermissions).toEqual(['checks']);
  });

  // fails-when: an unknown level string crashes the check or counts as a grant.
  it('counts an unknown level string as not granting the permission', () => {
    const gaps = findGithubAppRequirementGaps(
      { events: COMPLETE_EVENTS, permissions: { ...COMPLETE_PERMISSIONS, issues: 'triage' } },
      [],
    );
    expect(gaps.missingPermissions).toEqual(['issues']);
  });

  it('lists an organization installation that has not accepted a permission the App holds', () => {
    const { issues: _issues, ...installed } = COMPLETE_PERMISSIONS;
    const gaps = findGithubAppRequirementGaps(
      { events: COMPLETE_EVENTS, permissions: COMPLETE_PERMISSIONS },
      [org(7, installed)],
    );
    expect(gaps.installationsPendingApproval).toEqual([
      { installationId: 7, account: 'org-7', missingPermissions: ['issues'] },
    ]);
  });

  // breaks-if-wrong: a user account cannot hold the organization permission members.
  it('never lists members as pending on a user-account installation', () => {
    const { members: _members, ...userGrant } = COMPLETE_PERMISSIONS;
    const gaps = findGithubAppRequirementGaps(
      { events: COMPLETE_EVENTS, permissions: COMPLETE_PERMISSIONS },
      [{ id: 9, account: 'alice', accountType: 'User', permissions: userGrant }],
    );
    expect(gaps.installationsPendingApproval).toEqual([]);
  });

  it('does not list an installation for a permission the App itself lacks', () => {
    const { issues: _issues, ...noIssues } = COMPLETE_PERMISSIONS;
    const gaps = findGithubAppRequirementGaps({ events: COMPLETE_EVENTS, permissions: noIssues }, [
      org(3, noIssues),
    ]);
    expect(gaps.missingPermissions).toEqual(['issues']);
    expect(gaps.installationsPendingApproval).toEqual([]);
  });
});

describe('listGithubAppInstallations', () => {
  it('reads every page and maps the account', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      account: { login: `a${i}`, type: 'Organization' },
      permissions: { issues: 'read' },
    }));
    const page2 = [{ id: 101, account: { slug: 'acme-ent' }, permissions: {} }];
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({ data: page2 });
    const grants = await listGithubAppInstallations(
      { appId: '1', privateKey: 'PEM' },
      { appOctokit: { request } as never },
    );
    expect(grants).toHaveLength(101);
    expect(grants[100]).toEqual({
      id: 101,
      account: 'acme-ent',
      accountType: null,
      permissions: {},
    });
    expect(request).toHaveBeenNthCalledWith(1, 'GET /app/installations', {
      per_page: 100,
      page: 1,
    });
    expect(request).toHaveBeenNthCalledWith(2, 'GET /app/installations', {
      per_page: 100,
      page: 2,
    });
  });

  // fails-when: the walk does not stop on a short page and requests a page past the end.
  it('stops after a short first page', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      data: [
        { id: 5, account: { login: 'alice', type: 'User' }, permissions: { checks: 'write' } },
      ],
    });
    const grants = await listGithubAppInstallations(
      { appId: '1', privateKey: 'PEM' },
      { appOctokit: { request } as never },
    );
    expect(grants).toEqual([
      { id: 5, account: 'alice', accountType: 'User', permissions: { checks: 'write' } },
    ]);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
