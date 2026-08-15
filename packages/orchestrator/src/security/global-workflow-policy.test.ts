import { describe, it, expect } from 'vitest';
import { GlobalWorkflowPolicy } from './global-workflow-policy.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';
import type {
  ClusterSettingRead,
  ClusterSettingsReader,
} from '../cluster/cluster-settings-reader.js';

const ORG = 'kiciStg00001';

function makeMockDb(row: Record<string, unknown> | undefined) {
  return createMockDb({ selectFirstRow: row }).db;
}

/** A ClusterSettingsReader stand-in that returns a fixed read outcome. */
function fakeClusterSettings(read: ClusterSettingRead<boolean>) {
  return { tryGetBoolean: async () => read } as unknown as ClusterSettingsReader;
}

const CLUSTER_ON = fakeClusterSettings({ ok: true, value: true });
const CLUSTER_OFF = fakeClusterSettings({ ok: true, value: false });
const CLUSTER_UNSET = fakeClusterSettings({ ok: true, value: null });
const CLUSTER_UNREADABLE = fakeClusterSettings({ ok: false });

describe('GlobalWorkflowPolicy', () => {
  describe('cluster master switch', () => {
    it('denies every axis when the cluster switch is off, however permissive the org row', async () => {
      const db = makeMockDb({
        customer_id: 'org-1',
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: [{ pattern: 'myorg/*' }],
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_OFF, false);

      const workflow = await policy.isWorkflowRepoAllowed('github:1', 'myorg/wf', 'org-1');
      expect(workflow.allowed).toBe(false);
      expect(workflow.reason).toBe('Global workflows are disabled cluster-wide');

      const source = await policy.isSourceRepoAllowed('github:1', 'myorg/src', 'org-1');
      expect(source.allowed).toBe(false);
      expect(source.reason).toBe('Global workflows are disabled cluster-wide');

      expect(await policy.isElevatedAccessAllowed('github:1', 'myorg/wf', 'org-1')).toBe(false);
    });

    it('falls back to the configured default when the column is NULL', async () => {
      const db = makeMockDb({ customer_id: 'org-1', global_workflow_allowed_repos: null });
      expect(
        (
          await new GlobalWorkflowPolicy(db, CLUSTER_UNSET, false).isWorkflowRepoAllowed(
            'github:1',
            'myorg/wf',
            'org-1',
          )
        ).allowed,
      ).toBe(false);
      expect(
        (
          await new GlobalWorkflowPolicy(db, CLUSTER_UNSET, true).isWorkflowRepoAllowed(
            'github:1',
            'myorg/wf',
            'org-1',
          )
        ).allowed,
      ).toBe(true);
    });

    // Fail closed: an unreadable cluster_settings row must deny even when the
    // configured default would allow. A gate that answered from the default here
    // would open the feature during a database fault.
    it('denies when cluster_settings is unreadable, even with a permissive default', async () => {
      const db = makeMockDb({ customer_id: 'org-1', global_workflow_allowed_repos: null });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_UNREADABLE, true);
      const result = await policy.isWorkflowRepoAllowed('github:1', 'myorg/wf', 'org-1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Global workflows: cluster settings unreadable');
      expect(await policy.isElevatedAccessAllowed('github:1', 'myorg/wf', 'org-1')).toBe(false);
    });

    // The semantic change: a missing org_settings row used to be a hard deny.
    // It now means only "this org has no per-org restrictions", so the repo and
    // source axes evaluate exactly as they do for an all-null row.
    it('allows the repo and source axes with the switch on and NO org row', async () => {
      const db = makeMockDb(undefined);
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);
      expect((await policy.isWorkflowRepoAllowed('github:1', 'myorg/wf', 'org-1')).allowed).toBe(
        true,
      );
      expect((await policy.isSourceRepoAllowed('github:1', 'myorg/src', 'org-1')).allowed).toBe(
        true,
      );
    });

    // Elevated access is NOT widened by the same change: it still requires an
    // explicit list, so a missing row grants nothing.
    it('still denies elevated access with the switch on and NO org row', async () => {
      const policy = new GlobalWorkflowPolicy(makeMockDb(undefined), CLUSTER_ON, false);
      expect(await policy.isElevatedAccessAllowed('github:1', 'myorg/wf', 'org-1')).toBe(false);
    });

    it('still applies the per-org lists when the switch is on', async () => {
      const db = makeMockDb({
        customer_id: 'org-1',
        global_workflow_allowed_repos: [{ pattern: 'myorg/allowed' }],
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);
      expect(
        (await policy.isWorkflowRepoAllowed('github:1', 'myorg/allowed', 'org-1')).allowed,
      ).toBe(true);
      expect((await policy.isWorkflowRepoAllowed('github:1', 'myorg/other', 'org-1')).allowed).toBe(
        false,
      );
    });
  });

  describe('isWorkflowRepoAllowed', () => {
    it('returns true when enabled and allowed_repos is null (any repo)', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      const result = await policy.isWorkflowRepoAllowed('github:42', 'myorg/repo', ORG);
      expect(result.allowed).toBe(true);
    });

    it('returns true when repo is in allowed_repos array (unqualified entry)', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflow_allowed_repos: [
          { pattern: 'myorg/ci-workflows' },
          { pattern: 'myorg/shared-pipelines' },
        ],
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      const result = await policy.isWorkflowRepoAllowed('github:42', 'myorg/ci-workflows', ORG);
      expect(result.allowed).toBe(true);
    });

    it('returns false when repo is NOT in allowed_repos array', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflow_allowed_repos: [{ pattern: 'myorg/ci-workflows' }],
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      const result = await policy.isWorkflowRepoAllowed('github:42', 'myorg/untrusted-repo', ORG);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not in allowed');
    });

    it('supports glob patterns in allowed_repos', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflow_allowed_repos: [{ pattern: 'myorg/*' }],
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      const result = await policy.isWorkflowRepoAllowed('github:42', 'myorg/any-repo', ORG);
      expect(result.allowed).toBe(true);
    });

    it('treats empty allow array as "any repo"', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflow_allowed_repos: [],
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      const result = await policy.isWorkflowRepoAllowed('github:42', 'anyone/anywhere', ORG);
      expect(result.allowed).toBe(true);
    });

    it('ignores deny-list for workflow-repo decisions', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: [{ pattern: 'myorg/ci-workflows' }],
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      const result = await policy.isWorkflowRepoAllowed('github:42', 'myorg/ci-workflows', ORG);
      expect(result.allowed).toBe(true);
    });

    it('source-qualified entry only matches when routing key matches', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflow_allowed_repos: [{ routingKey: 'github:42', pattern: 'myorg/ci-*' }],
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      // Same routing key — entry applies, repo matches.
      const sameKey = await policy.isWorkflowRepoAllowed('github:42', 'myorg/ci-deploy', ORG);
      expect(sameKey.allowed).toBe(true);

      // Different routing key — entry does NOT apply, allow list ends up empty
      // for this workflow's routing key, so repo is rejected.
      const otherKey = await policy.isWorkflowRepoAllowed(
        'generic:kiciStg00001:src-b',
        'myorg/ci-deploy',
        ORG,
      );
      expect(otherKey.allowed).toBe(false);
    });

    it('unqualified entry matches regardless of routing key', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflow_allowed_repos: [{ pattern: 'myorg/ci-*' }],
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      const a = await policy.isWorkflowRepoAllowed('github:42', 'myorg/ci-x', ORG);
      const b = await policy.isWorkflowRepoAllowed('generic:kiciStg00001:src-b', 'myorg/ci-x', ORG);
      expect(a.allowed).toBe(true);
      expect(b.allowed).toBe(true);
    });

    it('orphan entry (routingKey no longer matches any source) never matches', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflow_allowed_repos: [
          { routingKey: 'generic:kiciStg00001:deleted', pattern: 'myorg/ci-*' },
        ],
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      const result = await policy.isWorkflowRepoAllowed('github:42', 'myorg/ci-deploy', ORG);
      expect(result.allowed).toBe(false);
    });
  });

  describe('isSourceRepoAllowed', () => {
    it('returns true when deny-list is null', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      const result = await policy.isSourceRepoAllowed('github:42', 'myorg/main', ORG);
      expect(result.allowed).toBe(true);
    });

    it('returns true when deny-list is empty', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: [],
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      const result = await policy.isSourceRepoAllowed('github:42', 'myorg/main', ORG);
      expect(result.allowed).toBe(true);
    });

    it('returns false when source matches a deny pattern', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: [{ pattern: 'myorg/fork-*' }],
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      const result = await policy.isSourceRepoAllowed('github:42', 'myorg/fork-contrib', ORG);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('denied source-repo');
    });

    it('returns true when source does not match deny-list', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: [{ pattern: 'myorg/fork-*' }],
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      const result = await policy.isSourceRepoAllowed('github:42', 'myorg/main', ORG);
      expect(result.allowed).toBe(true);
    });

    it('cross-source deny: entry pinned to source B does not block source A events', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: [
          { routingKey: 'generic:kiciStg00001:src-b', pattern: 'myorg/main' },
        ],
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      // Event came from source A → deny entry (pinned to source B) doesn't apply.
      const fromA = await policy.isSourceRepoAllowed('github:42', 'myorg/main', ORG);
      expect(fromA.allowed).toBe(true);

      // Event came from source B → deny entry applies.
      const fromB = await policy.isSourceRepoAllowed(
        'generic:kiciStg00001:src-b',
        'myorg/main',
        ORG,
      );
      expect(fromB.allowed).toBe(false);
    });

    it('is independent of allow-list', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflow_allowed_repos: [{ pattern: 'myorg/ci-workflows' }],
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      const result = await policy.isSourceRepoAllowed('github:42', 'otherorg/random', ORG);
      expect(result.allowed).toBe(true);
    });
  });

  describe('isElevatedAccessAllowed', () => {
    it('returns true when repo is in elevated_repos', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: [{ pattern: 'myorg/ci-workflows' }],
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      const result = await policy.isElevatedAccessAllowed('github:42', 'myorg/ci-workflows', ORG);
      expect(result).toBe(true);
    });

    it('returns false when repo is NOT in elevated_repos', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: [{ pattern: 'myorg/ci-workflows' }],
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      const result = await policy.isElevatedAccessAllowed('github:42', 'myorg/other-repo', ORG);
      expect(result).toBe(false);
    });

    it('returns false when elevated_repos is null', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      const result = await policy.isElevatedAccessAllowed('github:42', 'myorg/repo', ORG);
      expect(result).toBe(false);
    });

    it('returns false when no org_settings row exists', async () => {
      const db = makeMockDb(undefined);
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      const result = await policy.isElevatedAccessAllowed('github:42', 'myorg/repo', ORG);
      expect(result).toBe(false);
    });

    it('supports glob patterns in elevated_repos', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: [{ pattern: 'myorg/ci-*' }],
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      const result = await policy.isElevatedAccessAllowed('github:42', 'myorg/ci-workflows', ORG);
      expect(result).toBe(true);
    });

    it('source-qualified elevated entry only matches its routing key', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: [{ routingKey: 'github:42', pattern: 'myorg/ci-deploy' }],
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      const same = await policy.isElevatedAccessAllowed('github:42', 'myorg/ci-deploy', ORG);
      const other = await policy.isElevatedAccessAllowed(
        'generic:kiciStg00001:src-b',
        'myorg/ci-deploy',
        ORG,
      );
      expect(same).toBe(true);
      expect(other).toBe(false);
    });
  });

  // Universal-git sources participate in the same axes via their
  // `generic:<orgId>:<sourceId>` routing key. The policy enforcement code is
  // purely string-based with no hardcoded provider checks, so the same
  // logic applies verbatim — these tests exercise that assumption end to
  // end with universal-git-style `repoIdentifier` values (forge host
  // prefix included) and GitLab-style subgroup paths.
  describe('universal-git routing keys', () => {
    const routingKey = 'generic:kiciStg00001:5f9a1e47-8b2c-4c8a-9f4e-1234567890ab';

    it('isWorkflowRepoAllowed: glob matches Forgejo-style "host/owner/name"', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflow_allowed_repos: [{ pattern: 'forgejo.example.com/ci-workflows/*' }],
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      const result = await policy.isWorkflowRepoAllowed(
        routingKey,
        'forgejo.example.com/ci-workflows/shared',
        ORG,
      );
      expect(result.allowed).toBe(true);
    });

    it('isWorkflowRepoAllowed: non-matching Forgejo path is rejected', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflow_allowed_repos: [{ pattern: 'forgejo.example.com/ci-workflows/*' }],
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      const result = await policy.isWorkflowRepoAllowed(
        routingKey,
        'forgejo.example.com/untrusted/contrib',
        ORG,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not in allowed');
    });

    it('isSourceRepoAllowed: GitLab subgroup deny pattern blocks dispatch', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: [{ pattern: 'group/subgroup/untrusted-*' }],
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      const result = await policy.isSourceRepoAllowed(
        routingKey,
        'group/subgroup/untrusted-contrib',
        ORG,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('denied source-repo');
    });

    it('isSourceRepoAllowed: GitLab path that does not match deny-list is allowed', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: [{ pattern: 'group/subgroup/untrusted-*' }],
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      const result = await policy.isSourceRepoAllowed(
        routingKey,
        'group/subgroup/main-service',
        ORG,
      );
      expect(result.allowed).toBe(true);
    });

    it('with the switch on and no org row, the repo/source axes allow and elevated denies', async () => {
      const db = makeMockDb(undefined);
      const policy = new GlobalWorkflowPolicy(db, CLUSTER_ON, false);

      const wf = await policy.isWorkflowRepoAllowed(
        routingKey,
        'forgejo.example.com/any/repo',
        ORG,
      );
      const src = await policy.isSourceRepoAllowed(routingKey, 'forgejo.example.com/any/repo', ORG);
      const elevated = await policy.isElevatedAccessAllowed(
        routingKey,
        'forgejo.example.com/any/repo',
        ORG,
      );
      expect(wf.allowed).toBe(true);
      expect(src.allowed).toBe(true);
      expect(elevated).toBe(false);
    });
  });
});

/**
 * Repo identifiers are owner/name pairs, not file paths.
 *
 * Under path-glob semantics no wildcard segment matched a dot-prefixed one, so
 * a deny entry of `myorg/*` — or `myorg/**`, or even `**` — silently ADMITTED
 * `myorg/.github`. That is a control failing in the one direction that lets an
 * event through, and `.github` is an ordinary repository name rather than a
 * contrived one, so the gap was reachable. All three axes now match repo
 * identifiers with the same matcher a workflow's own `repos:` patterns use.
 */
describe('GlobalWorkflowPolicy matches a dot-prefixed repository name', () => {
  const DOT_REPO = 'myorg/.github';
  const PLAIN_REPO = 'myorg/service';

  function settings(over: Record<string, unknown>) {
    return makeMockDb({
      customer_id: ORG,
      global_workflow_allowed_repos: null,
      global_workflow_denied_repos: null,
      global_workflow_elevated_repos: null,
      ...over,
    });
  }

  describe('the deny-list, where failing to match admits the event', () => {
    for (const pattern of ['**', 'myorg/*', 'myorg/**', '*/.github']) {
      it(`'${pattern}' denies ${DOT_REPO}`, async () => {
        const policy = new GlobalWorkflowPolicy(
          settings({ global_workflow_denied_repos: [{ pattern }] }),
          CLUSTER_ON,
          false,
        );

        const result = await policy.isSourceRepoAllowed('github:42', DOT_REPO, ORG);
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('denied source-repo list');
      });
    }

    it('still admits a repo no deny entry names', async () => {
      // The control: the deny-list is not matching everything now. Without
      // this, a matcher that returned true unconditionally would pass every
      // assertion above.
      const policy = new GlobalWorkflowPolicy(
        settings({ global_workflow_denied_repos: [{ pattern: 'otherorg/*' }] }),
        CLUSTER_ON,
        false,
      );

      expect((await policy.isSourceRepoAllowed('github:42', DOT_REPO, ORG)).allowed).toBe(true);
      expect((await policy.isSourceRepoAllowed('github:42', PLAIN_REPO, ORG)).allowed).toBe(true);
    });

    it('still denies an ordinary name under the same pattern', async () => {
      const policy = new GlobalWorkflowPolicy(
        settings({ global_workflow_denied_repos: [{ pattern: 'myorg/*' }] }),
        CLUSTER_ON,
        false,
      );

      expect((await policy.isSourceRepoAllowed('github:42', PLAIN_REPO, ORG)).allowed).toBe(false);
    });

    it('honours the routing-key qualifier for a dot-prefixed name too', async () => {
      // A widened pattern must not widen the qualifier: an entry pinned to
      // another source stays a no-op.
      const policy = new GlobalWorkflowPolicy(
        settings({
          global_workflow_denied_repos: [{ routingKey: 'github:99', pattern: 'myorg/*' }],
        }),
        CLUSTER_ON,
        false,
      );

      expect((await policy.isSourceRepoAllowed('github:42', DOT_REPO, ORG)).allowed).toBe(true);
      expect((await policy.isSourceRepoAllowed('github:99', DOT_REPO, ORG)).allowed).toBe(false);
    });
  });

  describe('the allow-list and elevated-access list, which read the same way', () => {
    it("'myorg/*' authorizes a dot-prefixed repo to author global workflows", async () => {
      const policy = new GlobalWorkflowPolicy(
        settings({ global_workflow_allowed_repos: [{ pattern: 'myorg/*' }] }),
        CLUSTER_ON,
        false,
      );

      expect((await policy.isWorkflowRepoAllowed('github:42', DOT_REPO, ORG)).allowed).toBe(true);
      // Control: the allow-list is still an allow-list.
      expect((await policy.isWorkflowRepoAllowed('github:42', 'otherorg/x', ORG)).allowed).toBe(
        false,
      );
    });

    it("'myorg/*' elevates a dot-prefixed repo", async () => {
      const policy = new GlobalWorkflowPolicy(
        settings({ global_workflow_elevated_repos: [{ pattern: 'myorg/*' }] }),
        CLUSTER_ON,
        false,
      );

      expect(await policy.isElevatedAccessAllowed('github:42', DOT_REPO, ORG)).toBe(true);
      expect(await policy.isElevatedAccessAllowed('github:42', 'otherorg/x', ORG)).toBe(false);
    });
  });
});
