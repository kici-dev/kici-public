/**
 * Tests for extractRegisterableWorkflows.
 *
 * Verifies that workflows with non-Git-provider triggers (kici_event, schedule,
 * lifecycle, generic_webhook, workflow_complete, job_complete) are extracted
 * AND that Git triggers (push, pr, tag, …) are extracted too — the latter
 * since phase 28.5 so cross-source dispatch can resolve them by repo.
 */
import { describe, it, expect } from 'vitest';

import type { LockFile, LockWorkflow, LockTrigger } from '@kici-dev/engine';

import {
  extractRegisterableWorkflows,
  extractGlobalWorkflows,
  hasRepoPatterns,
  REGISTERABLE_TRIGGER_TYPES,
} from './extractor.js';

// ── Helpers ────────────────────────────────────────────────────────

function makeLockWorkflow(
  name: string,
  triggers: LockTrigger[],
  overrides: Partial<LockWorkflow> = {},
): LockWorkflow {
  return {
    name,
    contentHash: 'sha256-test',
    compileSchemaVersion: 1,
    triggers,
    jobs: [],
    ...overrides,
  };
}

function makeLockFile(workflows: LockWorkflow[]): LockFile {
  return {
    schemaVersion: 5,
    source: { file: '.kici/workflows/test.ts', export: '#default' },
    contentHash: 'sha256-lockfile',
    workflows,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('extractRegisterableWorkflows', () => {
  it('should return workflows with kici_event triggers', () => {
    const wf = makeLockWorkflow('on-deploy', [
      { _type: 'kici_event', eventName: 'deploy-complete' },
    ]);
    const result = extractRegisterableWorkflows(makeLockFile([wf]));
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('on-deploy');
  });

  it('should return workflows with schedule triggers', () => {
    const wf = makeLockWorkflow('nightly-build', [
      { _type: 'schedule', cronExpression: '0 2 * * *', timezone: 'UTC' },
    ]);
    const result = extractRegisterableWorkflows(makeLockFile([wf]));
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('nightly-build');
  });

  it('should return workflows with lifecycle triggers', () => {
    const wf = makeLockWorkflow('on-complete', [
      { _type: 'lifecycle', events: ['workflow_complete'] },
    ]);
    const result = extractRegisterableWorkflows(makeLockFile([wf]));
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('on-complete');
  });

  it('should return workflows with generic_webhook triggers', () => {
    const wf = makeLockWorkflow('stripe-handler', [{ _type: 'generic_webhook', source: 'stripe' }]);
    const result = extractRegisterableWorkflows(makeLockFile([wf]));
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('stripe-handler');
  });

  it('should return workflows with workflow_complete triggers', () => {
    const wf = makeLockWorkflow('post-deploy', [
      { _type: 'workflow_complete', name: 'deploy', status: ['success'] },
    ]);
    const result = extractRegisterableWorkflows(makeLockFile([wf]));
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('post-deploy');
  });

  it('should return workflows with job_complete triggers', () => {
    const wf = makeLockWorkflow('after-test', [
      { _type: 'job_complete', workflow: 'ci', job: 'test', status: ['success'] },
    ]);
    const result = extractRegisterableWorkflows(makeLockFile([wf]));
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('after-test');
  });

  it('should include workflows with only push triggers (phase 28.5 — cross-source repo lookup)', () => {
    const wf = makeLockWorkflow('ci', [{ _type: 'push', branches: [], paths: [] }]);
    const result = extractRegisterableWorkflows(makeLockFile([wf]));
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('ci');
  });

  it('should include workflows with only pr triggers (phase 28.5 — cross-source repo lookup)', () => {
    const wf = makeLockWorkflow('pr-check', [
      {
        _type: 'pr',
        events: ['opened'],
        targetBranches: [],
        sourceBranches: [],
        paths: [],
      },
    ]);
    const result = extractRegisterableWorkflows(makeLockFile([wf]));
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('pr-check');
  });

  it('should include workflows with only tag triggers (phase 28.5 — cross-source repo lookup)', () => {
    const wf = makeLockWorkflow('release', [{ _type: 'tag', patterns: [] }]);
    const result = extractRegisterableWorkflows(makeLockFile([wf]));
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('release');
  });

  it('should include workflows that mix Git and registerable triggers', () => {
    const wf = makeLockWorkflow('mixed', [
      { _type: 'push', branches: [], paths: [] },
      { _type: 'kici_event', eventName: 'deploy-complete' },
    ]);
    const result = extractRegisterableWorkflows(makeLockFile([wf]));
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('mixed');
  });

  it('should handle lock file with no workflows', () => {
    const result = extractRegisterableWorkflows(makeLockFile([]));
    expect(result).toHaveLength(0);
  });

  it('should handle lock file with a mix of registerable and non-registerable workflows', () => {
    // git-trigger workflows are also registerable — every
    // workflow in this lock file should come out of the extractor.
    const gitOnly = makeLockWorkflow('ci', [{ _type: 'push', branches: [], paths: [] }]);
    const registerable = makeLockWorkflow('cron-job', [
      { _type: 'schedule', cronExpression: '*/5 * * * *', timezone: 'UTC' },
    ]);
    const alsoRegisterable = makeLockWorkflow('event-handler', [
      { _type: 'kici_event', eventName: 'test-event' },
    ]);

    const result = extractRegisterableWorkflows(
      makeLockFile([gitOnly, registerable, alsoRegisterable]),
    );
    expect(result).toHaveLength(3);
    expect(result.map((w) => w.name)).toEqual(['ci', 'cron-job', 'event-handler']);
  });

  it('should define all non-Git and Git trigger types as registerable', () => {
    // Non-Git-provider triggers
    expect(REGISTERABLE_TRIGGER_TYPES.has('kici_event')).toBe(true);
    expect(REGISTERABLE_TRIGGER_TYPES.has('workflow_complete')).toBe(true);
    expect(REGISTERABLE_TRIGGER_TYPES.has('job_complete')).toBe(true);
    expect(REGISTERABLE_TRIGGER_TYPES.has('generic_webhook')).toBe(true);
    expect(REGISTERABLE_TRIGGER_TYPES.has('schedule')).toBe(true);
    expect(REGISTERABLE_TRIGGER_TYPES.has('lifecycle')).toBe(true);
    // webhook is registerable so cross-source delivery can find
    // workflow registrations by (customerId, eventName) — see plan 28.4-01.
    expect(REGISTERABLE_TRIGGER_TYPES.has('webhook')).toBe(true);
  });

  it('should include Git-provider trigger types as registerable (phase 28.5)', () => {
    const gitTypes = [
      'push',
      'pr',
      'tag',
      'comment',
      'review',
      'review_comment',
      'release',
      'dispatch',
      'create',
      'delete',
      'status',
      'workflow_run',
      'fork',
      'star',
      'watch',
    ];
    for (const type of gitTypes) {
      expect(REGISTERABLE_TRIGGER_TYPES.has(type)).toBe(true);
    }
  });

  it('should include global workflows (with repos) even if triggers are only Git types', () => {
    const wf = makeLockWorkflow('security-scan', [
      {
        _type: 'push',
        branches: [],
        paths: [],
        repos: [{ type: 'glob', pattern: 'myorg/*' }],
      } as any,
    ]);
    const result = extractRegisterableWorkflows(makeLockFile([wf]));
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('security-scan');
  });
});

describe('hasRepoPatterns', () => {
  it('should return true for triggers with repos array', () => {
    const trigger = {
      _type: 'push',
      branches: [],
      paths: [],
      repos: [{ type: 'glob', pattern: 'myorg/*' }],
    } as any;
    expect(hasRepoPatterns(trigger)).toBe(true);
  });

  it('should return true for triggers with !-prefixed exclusion in repos array', () => {
    const trigger = {
      _type: 'push',
      branches: [],
      paths: [],
      repos: [{ type: 'glob', pattern: '!myorg/internal-*' }],
    } as any;
    expect(hasRepoPatterns(trigger)).toBe(true);
  });

  it('should return false for triggers without repos', () => {
    const trigger: LockTrigger = {
      _type: 'push',
      branches: [],
      paths: [],
    };
    expect(hasRepoPatterns(trigger)).toBe(false);
  });

  it('should return false for triggers with empty repos array', () => {
    const trigger = {
      _type: 'push',
      branches: [],
      paths: [],
      repos: [],
    } as any;
    expect(hasRepoPatterns(trigger)).toBe(false);
  });
});

describe('extractGlobalWorkflows', () => {
  it('should detect workflows with repos field on any trigger', () => {
    const globalWf = makeLockWorkflow('security-scan', [
      {
        _type: 'push',
        branches: [],
        paths: [],
        repos: [{ type: 'glob', pattern: 'myorg/*' }],
      } as any,
    ]);
    const localWf = makeLockWorkflow('ci', [{ _type: 'push', branches: [], paths: [] }]);
    const result = extractGlobalWorkflows(makeLockFile([globalWf, localWf]));
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('security-scan');
  });

  it('should detect workflows with !-prefixed exclusion in repos', () => {
    const globalWf = makeLockWorkflow('compliance', [
      {
        _type: 'pr',
        events: ['opened'],
        targetBranches: [],
        sourceBranches: [],
        paths: [],
        repos: [{ type: 'glob', pattern: '!myorg/internal-*' }],
      } as any,
    ]);
    const result = extractGlobalWorkflows(makeLockFile([globalWf]));
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('compliance');
  });

  it('should return empty for workflows without repos', () => {
    const wf = makeLockWorkflow('ci', [{ _type: 'push', branches: [], paths: [] }]);
    const result = extractGlobalWorkflows(makeLockFile([wf]));
    expect(result).toHaveLength(0);
  });

  it('should handle empty lock file', () => {
    const result = extractGlobalWorkflows(makeLockFile([]));
    expect(result).toHaveLength(0);
  });
});
