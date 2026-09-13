import { describe, it, expect } from 'vitest';
import { kiciEvent, workflowComplete, jobComplete } from './index.js';

describe('kiciEvent()', () => {
  it('creates frozen config with correct _tag', () => {
    const trigger = kiciEvent({ name: 'deploy-complete' });
    expect(trigger._tag).toBe('KiciEventTrigger');
    expect(trigger.name).toBe('deploy-complete');
    expect(Object.isFrozen(trigger)).toBe(true);
  });

  it('requires name field', () => {
    const trigger = kiciEvent({ name: 'my-event' });
    expect(trigger.name).toBe('my-event');
  });

  it('throws on empty name', () => {
    expect(() => kiciEvent({ name: '' })).toThrow('non-empty name');
  });

  it('throws on whitespace-only name', () => {
    expect(() => kiciEvent({ name: '   ' })).toThrow('non-empty name');
  });

  it('supports optional match field', () => {
    const trigger = kiciEvent({ name: 'deploy', match: { '$.env': 'prod' } });
    expect(trigger.match).toEqual({ '$.env': 'prod' });
  });

  it('supports optional not field', () => {
    const trigger = kiciEvent({ name: 'deploy', not: { '$.env': 'staging' } });
    expect(trigger.not).toEqual({ '$.env': 'staging' });
  });

  it('supports optional source field', () => {
    const trigger = kiciEvent({ name: 'deploy', source: 'org/infra-repo' });
    expect(trigger.source).toBe('org/infra-repo');
  });

  it('supports optional description field', () => {
    const trigger = kiciEvent({ name: 'deploy', description: 'Deploy events' });
    expect(trigger.description).toBe('Deploy events');
  });

  it('omits undefined optional fields', () => {
    const trigger = kiciEvent({ name: 'deploy' });
    expect('match' in trigger).toBe(false);
    expect('not' in trigger).toBe(false);
    expect('source' in trigger).toBe(false);
    expect('description' in trigger).toBe(false);
  });

  it('includes all provided fields', () => {
    const trigger = kiciEvent({
      name: 'deploy',
      match: { '$.env': 'prod' },
      not: { '$.dry_run': true },
      source: 'org/repo',
      description: 'Production deploys only',
    });
    expect(trigger).toEqual({
      _tag: 'KiciEventTrigger',
      name: 'deploy',
      match: { '$.env': 'prod' },
      not: { '$.dry_run': true },
      source: 'org/repo',
      description: 'Production deploys only',
    });
  });

  it('defensively copies and freezes match and not objects', () => {
    const matchObj = { '$.env': 'prod' } as Record<string, unknown>;
    const notObj = { '$.dry_run': true } as Record<string, unknown>;
    const trigger = kiciEvent({ name: 'deploy', match: matchObj, not: notObj });

    // Mutating the original should not affect the trigger config
    matchObj['$.env'] = 'staging';
    notObj['$.dry_run'] = false;

    expect(trigger.match).toEqual({ '$.env': 'prod' });
    expect(trigger.not).toEqual({ '$.dry_run': true });
    expect(Object.isFrozen(trigger.match)).toBe(true);
    expect(Object.isFrozen(trigger.not)).toBe(true);
  });
});

describe('workflowComplete()', () => {
  it('creates frozen config with correct _tag and no args', () => {
    const trigger = workflowComplete();
    expect(trigger._tag).toBe('WorkflowCompleteTrigger');
    expect(Object.isFrozen(trigger)).toBe(true);
  });

  it('omits undefined optional fields when called with no args', () => {
    const trigger = workflowComplete();
    expect('name' in trigger).toBe(false);
    expect('status' in trigger).toBe(false);
    expect('source' in trigger).toBe(false);
    expect('description' in trigger).toBe(false);
  });

  it('supports name filter', () => {
    const trigger = workflowComplete({ name: 'CI' });
    expect(trigger.name).toBe('CI');
  });

  it('supports status filter with frozen array', () => {
    const trigger = workflowComplete({ status: ['success', 'failed'] });
    expect(trigger.status).toEqual(['success', 'failed']);
    expect(Object.isFrozen(trigger.status)).toBe(true);
  });

  it('supports source filter', () => {
    const trigger = workflowComplete({ source: 'org/repo' });
    expect(trigger.source).toBe('org/repo');
  });

  it('supports description', () => {
    const trigger = workflowComplete({ description: 'CI completion' });
    expect(trigger.description).toBe('CI completion');
  });

  it('includes all provided fields', () => {
    const trigger = workflowComplete({
      name: 'CI',
      status: ['success'],
      source: 'org/repo',
      description: 'Successful CI',
    });
    expect(trigger).toEqual({
      _tag: 'WorkflowCompleteTrigger',
      name: 'CI',
      status: ['success'],
      source: 'org/repo',
      description: 'Successful CI',
    });
  });
});

describe('jobComplete()', () => {
  it('creates frozen config with correct _tag and no args', () => {
    const trigger = jobComplete();
    expect(trigger._tag).toBe('JobCompleteTrigger');
    expect(Object.isFrozen(trigger)).toBe(true);
  });

  it('omits undefined optional fields when called with no args', () => {
    const trigger = jobComplete();
    expect('workflow' in trigger).toBe(false);
    expect('job' in trigger).toBe(false);
    expect('status' in trigger).toBe(false);
    expect('source' in trigger).toBe(false);
    expect('description' in trigger).toBe(false);
  });

  it('supports workflow and job filters', () => {
    const trigger = jobComplete({ workflow: 'CI', job: 'build' });
    expect(trigger.workflow).toBe('CI');
    expect(trigger.job).toBe('build');
  });

  it('supports status filter with frozen array', () => {
    const trigger = jobComplete({ status: ['success', 'failed', 'cancelled', 'skipped'] });
    expect(trigger.status).toEqual(['success', 'failed', 'cancelled', 'skipped']);
    expect(Object.isFrozen(trigger.status)).toBe(true);
  });

  it('supports source filter', () => {
    const trigger = jobComplete({ source: 'org/repo' });
    expect(trigger.source).toBe('org/repo');
  });

  it('supports description', () => {
    const trigger = jobComplete({ description: 'Build job' });
    expect(trigger.description).toBe('Build job');
  });

  it('includes all provided fields', () => {
    const trigger = jobComplete({
      workflow: 'CI',
      job: 'build',
      status: ['success'],
      source: 'org/repo',
      description: 'CI build success',
    });
    expect(trigger).toEqual({
      _tag: 'JobCompleteTrigger',
      workflow: 'CI',
      job: 'build',
      status: ['success'],
      source: 'org/repo',
      description: 'CI build success',
    });
  });
});
