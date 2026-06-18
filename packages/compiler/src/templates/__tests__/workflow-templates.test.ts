/**
 * Tests for workflow templates
 *
 * Validates that template workflows are valid TypeScript/SDK code.
 */

import { describe, it, expect } from 'vitest';
import { access } from 'node:fs/promises';
import { helloWorldWorkflow, prChecksWorkflow } from '../workflows/hello-world.js';
import { prChecksWorkflow as prChecksWorkflowImport } from '../workflows/pr-checks.js';
import { workflowPaths } from '../index.js';

describe('workflow templates', () => {
  describe('hello-world workflow', () => {
    it('should be a valid workflow object', () => {
      expect(helloWorldWorkflow).toBeDefined();
      expect(helloWorldWorkflow.name).toBe('hello-world');
    });

    it('should have the correct structure', () => {
      expect(helloWorldWorkflow.jobs).toBeDefined();
      expect(helloWorldWorkflow.jobs).toHaveLength(1);
      expect(helloWorldWorkflow.on).toBeDefined();
    });

    it('should have a greet job with correct properties', () => {
      const greetJob = helloWorldWorkflow.jobs[0];
      expect(greetJob).toBeDefined();
      expect(greetJob.name).toBe('greet');
      expect(greetJob.runsOn).toBe('kici:os:linux');
      expect(greetJob.steps).toBeDefined();
      expect(greetJob.steps).toHaveLength(1);
    });

    it('should have a say-hello step', () => {
      const greetJob = helloWorldWorkflow.jobs[0];
      const step = greetJob.steps[0];
      expect(step).toBeDefined();
      expect(step.name).toBe('say-hello');
      expect(step.run).toBeDefined();
      expect(typeof step.run).toBe('function');
    });

    it('should have a push trigger', () => {
      const triggerConfigs = helloWorldWorkflow.on;
      expect(triggerConfigs).toBeDefined();
      expect(triggerConfigs).toHaveLength(1);
      expect(triggerConfigs![0]._tag).toBe('PushTrigger');
    });
  });

  describe('pr-checks workflow', () => {
    it('should be a valid workflow object', () => {
      expect(prChecksWorkflowImport).toBeDefined();
      expect(prChecksWorkflowImport.name).toBe('pr-checks');
    });

    it('should have the correct structure', () => {
      expect(prChecksWorkflowImport.jobs).toBeDefined();
      expect(prChecksWorkflowImport.jobs).toHaveLength(2);
      expect(prChecksWorkflowImport.on).toBeDefined();
      expect(prChecksWorkflowImport.rules).toBeDefined();
      expect(prChecksWorkflowImport.rules).toHaveLength(2);
    });

    it('should have lint and test jobs', () => {
      const jobs = prChecksWorkflowImport.jobs;
      expect(jobs[0].name).toBe('lint');
      expect(jobs[1].name).toBe('test');
    });

    it('should have test job depend on lint job', () => {
      const testJob = prChecksWorkflowImport.jobs[1];
      expect(testJob.needs).toBeDefined();
      expect(testJob.needs).toEqual(['lint']);
    });

    it('should have lint job with 2 steps', () => {
      const lintJob = prChecksWorkflowImport.jobs[0];
      expect(lintJob.steps).toHaveLength(2);
      expect(lintJob.steps[0].name).toBe('checkout');
      expect(lintJob.steps[1].name).toBe('run-linter');
    });

    it('should have test job with 3 steps', () => {
      const testJob = prChecksWorkflowImport.jobs[1];
      expect(testJob.steps).toHaveLength(3);
      expect(testJob.steps[0].name).toBe('checkout');
      expect(testJob.steps[1].name).toBe('install-deps');
      expect(testJob.steps[2].name).toBe('run-tests');
    });

    it('should have a pr trigger with targeting and paths', () => {
      const triggerConfigs = prChecksWorkflowImport.on;
      expect(triggerConfigs).toBeDefined();
      expect(triggerConfigs).toHaveLength(1);

      const trigger = triggerConfigs![0] as any;
      expect(trigger._tag).toBe('PrTrigger');
      expect(trigger.targetBranches).toBeDefined();
      expect(trigger.targetBranches.length).toBeGreaterThan(0);
      expect(trigger.paths).toBeDefined();
      expect(trigger.paths.length).toBeGreaterThan(0);
    });

    it('should have 2 rules', () => {
      const rules = prChecksWorkflowImport.rules;
      expect(rules).toHaveLength(2);
      expect(rules[0].label).toBe('skip-draft-prs');
      expect(rules[1].label).toBe('require-src-changes');
    });

    it('should have rule check functions', () => {
      const rules = prChecksWorkflowImport.rules;
      expect(typeof rules[0].check).toBe('function');
      expect(typeof rules[1].check).toBe('function');
    });

    it('skip-draft-prs rule should fail (skip workflow) for draft PRs', async () => {
      const rules = prChecksWorkflowImport.rules;
      const ctx = {
        event: { type: 'pull_request', payload: { pull_request: { draft: true } } },
        changedFiles: [],
        env: {},
        $: {} as any,
      };
      // skip() inverts: draft=true → check returns false → rule fails → workflow skipped
      expect(await rules[0].check(ctx)).toBe(false);
    });

    it('skip-draft-prs rule should pass (run workflow) for non-draft PRs', async () => {
      const rules = prChecksWorkflowImport.rules;
      const ctx = {
        event: { type: 'pull_request', payload: { pull_request: { draft: false } } },
        changedFiles: [],
        env: {},
        $: {} as any,
      };
      // skip() inverts: draft=false → check returns true → rule passes → workflow runs
      expect(await rules[0].check(ctx)).toBe(true);
    });

    it('require-src-changes rule should use ctx.changedFiles', async () => {
      const rules = prChecksWorkflowImport.rules;
      const withSrc = {
        event: { type: 'pull_request' },
        changedFiles: ['src/index.ts', 'README.md'],
        env: {},
        $: {} as any,
      };
      expect(await rules[1].check(withSrc)).toBe(true);

      const withoutSrc = {
        event: { type: 'pull_request' },
        changedFiles: ['README.md', 'docs/guide.md'],
        env: {},
        $: {} as any,
      };
      expect(await rules[1].check(withoutSrc)).toBe(false);
    });
  });

  describe('workflow paths', () => {
    it('should export workflowPaths object', () => {
      expect(workflowPaths).toBeDefined();
      expect(typeof workflowPaths).toBe('object');
    });

    it('should have hello-world path', () => {
      expect(workflowPaths['hello-world']).toBeDefined();
      expect(typeof workflowPaths['hello-world']).toBe('string');
      expect(workflowPaths['hello-world']).toContain('hello-world.ts');
    });

    it('should have pr-checks path', () => {
      expect(workflowPaths['pr-checks']).toBeDefined();
      expect(typeof workflowPaths['pr-checks']).toBe('string');
      expect(workflowPaths['pr-checks']).toContain('pr-checks.ts');
    });

    it('should point to existing files', async () => {
      // Test that files actually exist at the specified paths
      for (const [name, filePath] of Object.entries(workflowPaths)) {
        try {
          await access(filePath);
        } catch (error) {
          throw new Error(`Workflow file for "${name}" not found at: ${filePath}`);
        }
      }
    });
  });
});
