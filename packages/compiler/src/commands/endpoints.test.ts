import { describe, it, expect, vi, beforeEach } from 'vitest';
import { groupTriggers, displayEndpoints } from './endpoints.js';
import type { LockWorkflow } from '../types.js';

// Mock dependencies
vi.mock('../execution/index.js', () => ({
  resolveKiciDir: vi.fn().mockReturnValue('/mock/.kici'),
}));

vi.mock('../remote/config.js', () => ({
  loadGlobalConfig: vi.fn().mockResolvedValue({}),
}));

// Capture logger output
const logOutput: string[] = [];
vi.mock('@kici-dev/core', () => ({
  logger: {
    info: vi.fn((msg: string) => logOutput.push(msg)),
    error: vi.fn((msg: string) => logOutput.push(msg)),
    warn: vi.fn(),
    debug: vi.fn(),
  },

  toErrorMessage: (err) => (err instanceof Error ? err.message : String(err)),
}));

describe('kici endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logOutput.length = 0;
  });

  describe('groupTriggers', () => {
    it('groups git provider triggers under gitProvider', () => {
      const workflows: LockWorkflow[] = [
        {
          name: 'ci',
          contentHash: '',
          compileSchemaVersion: 5,
          triggers: [
            { _type: 'push', branches: [], paths: [] },
            {
              _type: 'pr',
              events: ['opened'],
              targetBranches: [],
              sourceBranches: [],
              paths: [],
            },
          ],
          jobs: [],
        },
      ];

      const groups = groupTriggers(workflows);

      expect(groups.gitProvider).toHaveLength(1);
      expect(groups.gitProvider[0]).toEqual({ workflowName: 'ci', provider: 'GitHub' });
      expect(groups.genericWebhook).toHaveLength(0);
      expect(groups.schedule).toHaveLength(0);
    });

    it('groups generic webhook triggers', () => {
      const workflows: LockWorkflow[] = [
        {
          name: 'stripe-handler',
          contentHash: '',
          compileSchemaVersion: 5,
          triggers: [{ _type: 'generic_webhook', source: 'stripe', events: ['invoice.paid'] }],
          jobs: [],
        },
        {
          name: 'slack-handler',
          contentHash: '',
          compileSchemaVersion: 5,
          triggers: [{ _type: 'generic_webhook', source: 'slack', events: ['message'] }],
          jobs: [],
        },
      ];

      const groups = groupTriggers(workflows);

      expect(groups.genericWebhook).toHaveLength(2);
      expect(groups.genericWebhook[0]).toEqual({
        workflowName: 'stripe-handler',
        source: 'stripe',
        path: undefined,
      });
      expect(groups.genericWebhook[1]).toEqual({
        workflowName: 'slack-handler',
        source: 'slack',
        path: undefined,
      });
    });

    it('groups schedule triggers with cron and timezone', () => {
      const workflows: LockWorkflow[] = [
        {
          name: 'nightly-cleanup',
          contentHash: '',
          compileSchemaVersion: 5,
          triggers: [
            {
              _type: 'schedule',
              cronExpression: '0 0 * * *',
              timezone: 'UTC',
              description: 'nightly cleanup',
            },
          ],
          jobs: [],
        },
        {
          name: 'hourly-report',
          contentHash: '',
          compileSchemaVersion: 5,
          triggers: [
            { _type: 'schedule', cronExpression: '0 * * * *', timezone: 'America/New_York' },
          ],
          jobs: [],
        },
      ];

      const groups = groupTriggers(workflows);

      expect(groups.schedule).toHaveLength(2);
      expect(groups.schedule[0]).toEqual({
        workflowName: 'nightly-cleanup',
        cron: '0 0 * * *',
        timezone: 'UTC',
        description: 'nightly cleanup',
      });
      expect(groups.schedule[1]).toEqual({
        workflowName: 'hourly-report',
        cron: '0 * * * *',
        timezone: 'America/New_York',
        description: undefined,
      });
    });

    it('groups lifecycle triggers', () => {
      const workflows: LockWorkflow[] = [
        {
          name: 'deploy-notify',
          contentHash: '',
          compileSchemaVersion: 5,
          triggers: [
            {
              _type: 'lifecycle',
              events: ['workflow_complete'],
              description: 'deploy notification',
            },
          ],
          jobs: [],
        },
      ];

      const groups = groupTriggers(workflows);

      expect(groups.lifecycle).toHaveLength(1);
      expect(groups.lifecycle[0]).toEqual({
        workflowName: 'deploy-notify',
        events: ['workflow_complete'],
        description: 'deploy notification',
      });
    });

    it('groups kici_event triggers', () => {
      const workflows: LockWorkflow[] = [
        {
          name: 'slack-handler',
          contentHash: '',
          compileSchemaVersion: 5,
          triggers: [{ _type: 'kici_event', eventName: 'deploy-done' }],
          jobs: [],
        },
      ];

      const groups = groupTriggers(workflows);

      expect(groups.kiciEvent).toHaveLength(1);
      expect(groups.kiciEvent[0]).toEqual({
        workflowName: 'slack-handler',
        eventName: 'deploy-done',
      });
    });

    it('groups workflow_complete triggers into kiciEvent', () => {
      const workflows: LockWorkflow[] = [
        {
          name: 'post-deploy',
          contentHash: '',
          compileSchemaVersion: 5,
          triggers: [{ _type: 'workflow_complete', name: 'deploy' }],
          jobs: [],
        },
        {
          name: 'catch-all',
          contentHash: '',
          compileSchemaVersion: 5,
          triggers: [{ _type: 'workflow_complete' }],
          jobs: [],
        },
      ];

      const groups = groupTriggers(workflows);

      expect(groups.kiciEvent).toHaveLength(2);
      expect(groups.kiciEvent[0]).toEqual({
        workflowName: 'post-deploy',
        eventName: 'workflow_complete:deploy',
      });
      expect(groups.kiciEvent[1]).toEqual({
        workflowName: 'catch-all',
        eventName: 'workflow_complete',
      });
    });

    it('groups job_complete triggers into kiciEvent', () => {
      const workflows: LockWorkflow[] = [
        {
          name: 'notify-build',
          contentHash: '',
          compileSchemaVersion: 5,
          triggers: [{ _type: 'job_complete', workflow: 'ci', job: 'build' }],
          jobs: [],
        },
        {
          name: 'notify-any',
          contentHash: '',
          compileSchemaVersion: 5,
          triggers: [{ _type: 'job_complete' }],
          jobs: [],
        },
      ];

      const groups = groupTriggers(workflows);

      expect(groups.kiciEvent).toHaveLength(2);
      expect(groups.kiciEvent[0]).toEqual({
        workflowName: 'notify-build',
        eventName: 'job_complete:ci.build',
      });
      expect(groups.kiciEvent[1]).toEqual({
        workflowName: 'notify-any',
        eventName: 'job_complete',
      });
    });

    it('handles a lock file with mixed trigger types', () => {
      const workflows: LockWorkflow[] = [
        {
          name: 'ci',
          contentHash: '',
          compileSchemaVersion: 5,
          triggers: [{ _type: 'push', branches: [], paths: [] }],
          jobs: [],
        },
        {
          name: 'stripe-handler',
          contentHash: '',
          compileSchemaVersion: 5,
          triggers: [{ _type: 'generic_webhook', source: 'stripe' }],
          jobs: [],
        },
        {
          name: 'nightly',
          contentHash: '',
          compileSchemaVersion: 5,
          triggers: [{ _type: 'schedule', cronExpression: '0 0 * * *', timezone: 'UTC' }],
          jobs: [],
        },
        {
          name: 'deploy-notify',
          contentHash: '',
          compileSchemaVersion: 5,
          triggers: [{ _type: 'lifecycle', events: ['workflow_complete'] }],
          jobs: [],
        },
        {
          name: 'event-handler',
          contentHash: '',
          compileSchemaVersion: 5,
          triggers: [{ _type: 'kici_event', eventName: 'deploy-done' }],
          jobs: [],
        },
      ];

      const groups = groupTriggers(workflows);

      expect(groups.gitProvider).toHaveLength(1);
      expect(groups.genericWebhook).toHaveLength(1);
      expect(groups.schedule).toHaveLength(1);
      expect(groups.lifecycle).toHaveLength(1);
      expect(groups.kiciEvent).toHaveLength(1);
    });
  });

  describe('displayEndpoints', () => {
    it('displays categorized output with resolved org ID', () => {
      const groups = {
        gitProvider: [{ workflowName: 'ci', provider: 'GitHub' }],
        genericWebhook: [{ workflowName: 'stripe-handler', source: 'stripe' }],
        schedule: [{ workflowName: 'nightly', cron: '0 0 * * *', timezone: 'UTC' }],
        lifecycle: [
          { workflowName: 'deploy-notify', events: ['workflow_complete'] as readonly string[] },
        ],
        kiciEvent: [{ workflowName: 'slack-handler', eventName: 'deploy-done' }],
      };

      displayEndpoints(groups, 'a3Bf9x2K1mPq');

      const output = logOutput.join('\n');
      // Git provider section
      expect(output).toContain('/webhook/a3Bf9x2K1mPq/github');
      // Generic webhook section
      expect(output).toContain('/webhook/a3Bf9x2K1mPq/generic/stripe');
      // Schedule section
      expect(output).toContain('"0 0 * * *"');
      expect(output).toContain('(UTC)');
      // Lifecycle section
      expect(output).toContain('lifecycle (workflow_complete)');
      // kici_event section
      expect(output).toContain('kici_event (deploy-done)');
      // No hint when org ID is resolved
      expect(output).not.toContain('kici login');
    });

    it('displays placeholder when not authenticated', () => {
      const groups = {
        gitProvider: [{ workflowName: 'ci', provider: 'GitHub' }],
        genericWebhook: [{ workflowName: 'stripe-handler', source: 'stripe' }],
        schedule: [],
        lifecycle: [],
        kiciEvent: [],
      };

      displayEndpoints(groups, '{orgId}');

      const output = logOutput.join('\n');
      expect(output).toContain('/webhook/{orgId}/github');
      expect(output).toContain('/webhook/{orgId}/generic/stripe');
      expect(output).toContain('kici login');
      expect(output).toContain('kici org use');
    });

    it('shows "no endpoints" message when nothing is found', () => {
      const groups = {
        gitProvider: [],
        genericWebhook: [],
        schedule: [],
        lifecycle: [],
        kiciEvent: [],
      };

      displayEndpoints(groups, '{orgId}');

      const output = logOutput.join('\n');
      expect(output).toContain('No webhook entrypoints found');
    });

    it('shows minimal output with only git triggers', () => {
      const groups = {
        gitProvider: [{ workflowName: 'ci', provider: 'GitHub' }],
        genericWebhook: [],
        schedule: [],
        lifecycle: [],
        kiciEvent: [],
      };

      displayEndpoints(groups, '{orgId}');

      const output = logOutput.join('\n');
      expect(output).toContain('Git provider webhooks');
      expect(output).toContain('/webhook/{orgId}/github');
      // Should not contain other sections
      expect(output).not.toContain('Generic webhooks');
      expect(output).not.toContain('Scheduled workflows');
      expect(output).not.toContain('Event-driven workflows');
    });

    it('shows timezone for non-UTC schedules', () => {
      const groups = {
        gitProvider: [],
        genericWebhook: [],
        schedule: [
          { workflowName: 'hourly-report', cron: '0 * * * *', timezone: 'America/New_York' },
        ],
        lifecycle: [],
        kiciEvent: [],
      };

      displayEndpoints(groups, '{orgId}');

      const output = logOutput.join('\n');
      expect(output).toContain('(America/New_York)');
    });
  });
});
