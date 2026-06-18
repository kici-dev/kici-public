import { describe, it, expect } from 'vitest';
import { GlobalWorkflowPolicy } from './global-workflow-policy.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

const ORG = 'kiciStg00001';

function makeMockDb(row: Record<string, unknown> | undefined) {
  return createMockDb({ selectFirstRow: row }).db;
}

describe('GlobalWorkflowPolicy', () => {
  describe('isWorkflowRepoAllowed', () => {
    it('returns false when no org_settings row exists', async () => {
      const db = makeMockDb(undefined);
      const policy = new GlobalWorkflowPolicy(db);

      const result = await policy.isWorkflowRepoAllowed('github:42', 'myorg/repo', ORG);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not enabled');
    });

    it('returns false when global_workflows_enabled is false', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflows_enabled: false,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db);

      const result = await policy.isWorkflowRepoAllowed('github:42', 'myorg/repo', ORG);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('disabled');
    });

    it('returns true when enabled and allowed_repos is null (any repo)', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflows_enabled: true,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db);

      const result = await policy.isWorkflowRepoAllowed('github:42', 'myorg/repo', ORG);
      expect(result.allowed).toBe(true);
    });

    it('returns true when repo is in allowed_repos array (unqualified entry)', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflows_enabled: true,
        global_workflow_allowed_repos: [
          { pattern: 'myorg/ci-workflows' },
          { pattern: 'myorg/shared-pipelines' },
        ],
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db);

      const result = await policy.isWorkflowRepoAllowed('github:42', 'myorg/ci-workflows', ORG);
      expect(result.allowed).toBe(true);
    });

    it('returns false when repo is NOT in allowed_repos array', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflows_enabled: true,
        global_workflow_allowed_repos: [{ pattern: 'myorg/ci-workflows' }],
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db);

      const result = await policy.isWorkflowRepoAllowed('github:42', 'myorg/untrusted-repo', ORG);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not in allowed');
    });

    it('supports glob patterns in allowed_repos', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflows_enabled: true,
        global_workflow_allowed_repos: [{ pattern: 'myorg/*' }],
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db);

      const result = await policy.isWorkflowRepoAllowed('github:42', 'myorg/any-repo', ORG);
      expect(result.allowed).toBe(true);
    });

    it('treats empty allow array as "any repo"', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflows_enabled: true,
        global_workflow_allowed_repos: [],
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db);

      const result = await policy.isWorkflowRepoAllowed('github:42', 'anyone/anywhere', ORG);
      expect(result.allowed).toBe(true);
    });

    it('ignores deny-list for workflow-repo decisions', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflows_enabled: true,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: [{ pattern: 'myorg/ci-workflows' }],
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db);

      const result = await policy.isWorkflowRepoAllowed('github:42', 'myorg/ci-workflows', ORG);
      expect(result.allowed).toBe(true);
    });

    it('source-qualified entry only matches when routing key matches', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflows_enabled: true,
        global_workflow_allowed_repos: [{ routingKey: 'github:42', pattern: 'myorg/ci-*' }],
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db);

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
        global_workflows_enabled: true,
        global_workflow_allowed_repos: [{ pattern: 'myorg/ci-*' }],
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db);

      const a = await policy.isWorkflowRepoAllowed('github:42', 'myorg/ci-x', ORG);
      const b = await policy.isWorkflowRepoAllowed('generic:kiciStg00001:src-b', 'myorg/ci-x', ORG);
      expect(a.allowed).toBe(true);
      expect(b.allowed).toBe(true);
    });

    it('orphan entry (routingKey no longer matches any source) never matches', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflows_enabled: true,
        global_workflow_allowed_repos: [
          { routingKey: 'generic:kiciStg00001:deleted', pattern: 'myorg/ci-*' },
        ],
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db);

      const result = await policy.isWorkflowRepoAllowed('github:42', 'myorg/ci-deploy', ORG);
      expect(result.allowed).toBe(false);
    });
  });

  describe('isSourceRepoAllowed', () => {
    it('returns false when no org_settings row exists', async () => {
      const db = makeMockDb(undefined);
      const policy = new GlobalWorkflowPolicy(db);

      const result = await policy.isSourceRepoAllowed('github:42', 'myorg/forks-1', ORG);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not enabled');
    });

    it('returns false when global_workflows_enabled is false', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflows_enabled: false,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db);

      const result = await policy.isSourceRepoAllowed('github:42', 'myorg/main', ORG);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('disabled');
    });

    it('returns true when deny-list is null', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflows_enabled: true,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db);

      const result = await policy.isSourceRepoAllowed('github:42', 'myorg/main', ORG);
      expect(result.allowed).toBe(true);
    });

    it('returns true when deny-list is empty', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflows_enabled: true,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: [],
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db);

      const result = await policy.isSourceRepoAllowed('github:42', 'myorg/main', ORG);
      expect(result.allowed).toBe(true);
    });

    it('returns false when source matches a deny pattern', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflows_enabled: true,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: [{ pattern: 'myorg/fork-*' }],
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db);

      const result = await policy.isSourceRepoAllowed('github:42', 'myorg/fork-contrib', ORG);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('denied source-repo');
    });

    it('returns true when source does not match deny-list', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflows_enabled: true,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: [{ pattern: 'myorg/fork-*' }],
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db);

      const result = await policy.isSourceRepoAllowed('github:42', 'myorg/main', ORG);
      expect(result.allowed).toBe(true);
    });

    it('cross-source deny: entry pinned to source B does not block source A events', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflows_enabled: true,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: [
          { routingKey: 'generic:kiciStg00001:src-b', pattern: 'myorg/main' },
        ],
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db);

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
        global_workflows_enabled: true,
        global_workflow_allowed_repos: [{ pattern: 'myorg/ci-workflows' }],
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db);

      const result = await policy.isSourceRepoAllowed('github:42', 'otherorg/random', ORG);
      expect(result.allowed).toBe(true);
    });
  });

  describe('isElevatedAccessAllowed', () => {
    it('returns true when repo is in elevated_repos', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflows_enabled: true,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: [{ pattern: 'myorg/ci-workflows' }],
      });
      const policy = new GlobalWorkflowPolicy(db);

      const result = await policy.isElevatedAccessAllowed('github:42', 'myorg/ci-workflows', ORG);
      expect(result).toBe(true);
    });

    it('returns false when repo is NOT in elevated_repos', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflows_enabled: true,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: [{ pattern: 'myorg/ci-workflows' }],
      });
      const policy = new GlobalWorkflowPolicy(db);

      const result = await policy.isElevatedAccessAllowed('github:42', 'myorg/other-repo', ORG);
      expect(result).toBe(false);
    });

    it('returns false when elevated_repos is null', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflows_enabled: true,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db);

      const result = await policy.isElevatedAccessAllowed('github:42', 'myorg/repo', ORG);
      expect(result).toBe(false);
    });

    it('returns false when no org_settings row exists', async () => {
      const db = makeMockDb(undefined);
      const policy = new GlobalWorkflowPolicy(db);

      const result = await policy.isElevatedAccessAllowed('github:42', 'myorg/repo', ORG);
      expect(result).toBe(false);
    });

    it('supports glob patterns in elevated_repos', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflows_enabled: true,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: [{ pattern: 'myorg/ci-*' }],
      });
      const policy = new GlobalWorkflowPolicy(db);

      const result = await policy.isElevatedAccessAllowed('github:42', 'myorg/ci-workflows', ORG);
      expect(result).toBe(true);
    });

    it('source-qualified elevated entry only matches its routing key', async () => {
      const db = makeMockDb({
        customer_id: ORG,
        global_workflows_enabled: true,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: [{ routingKey: 'github:42', pattern: 'myorg/ci-deploy' }],
      });
      const policy = new GlobalWorkflowPolicy(db);

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
        global_workflows_enabled: true,
        global_workflow_allowed_repos: [{ pattern: 'forgejo.example.com/ci-workflows/*' }],
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db);

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
        global_workflows_enabled: true,
        global_workflow_allowed_repos: [{ pattern: 'forgejo.example.com/ci-workflows/*' }],
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db);

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
        global_workflows_enabled: true,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: [{ pattern: 'group/subgroup/untrusted-*' }],
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db);

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
        global_workflows_enabled: true,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: [{ pattern: 'group/subgroup/untrusted-*' }],
        global_workflow_elevated_repos: null,
      });
      const policy = new GlobalWorkflowPolicy(db);

      const result = await policy.isSourceRepoAllowed(
        routingKey,
        'group/subgroup/main-service',
        ORG,
      );
      expect(result.allowed).toBe(true);
    });

    it('opt-in model holds: no org_settings row → every axis denies', async () => {
      const db = makeMockDb(undefined);
      const policy = new GlobalWorkflowPolicy(db);

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
      expect(wf.allowed).toBe(false);
      expect(src.allowed).toBe(false);
      expect(elevated).toBe(false);
    });
  });
});
