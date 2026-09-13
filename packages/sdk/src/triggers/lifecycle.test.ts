import { describe, it, expect } from 'vitest';
import { lifecycle } from './index.js';

describe('lifecycle()', () => {
  it('creates frozen config with correct _tag', () => {
    const trigger = lifecycle({ events: ['workflow_complete'] });
    expect(trigger._tag).toBe('LifecycleTrigger');
    expect(trigger.events).toEqual(['workflow_complete']);
    expect(Object.isFrozen(trigger)).toBe(true);
  });

  it('freezes the events array', () => {
    const trigger = lifecycle({ events: ['workflow_complete', 'job_failed'] });
    expect(Object.isFrozen(trigger.events)).toBe(true);
  });

  it('supports optional sources with frozen array', () => {
    const trigger = lifecycle({
      events: ['job_complete'],
      sources: ['org/deploy-repo', 'org/infra-repo'],
    });
    expect(trigger.sources).toEqual(['org/deploy-repo', 'org/infra-repo']);
    expect(Object.isFrozen(trigger.sources)).toBe(true);
  });

  it('supports optional description', () => {
    const trigger = lifecycle({
      events: ['registration_updated'],
      description: 'React to registration changes',
    });
    expect(trigger.description).toBe('React to registration changes');
  });

  it('omits undefined optional fields', () => {
    const trigger = lifecycle({ events: ['workflow_complete'] });
    expect('sources' in trigger).toBe(false);
    expect('description' in trigger).toBe(false);
  });

  it('throws on empty events array', () => {
    expect(() => lifecycle({ events: [] })).toThrow('non-empty events array');
  });

  it('produces correct full config', () => {
    const trigger = lifecycle({
      events: ['workflow_complete', 'job_failed'],
      sources: ['org/deploy-repo'],
      description: 'Monitor deployments',
    });
    expect(trigger).toEqual({
      _tag: 'LifecycleTrigger',
      events: ['workflow_complete', 'job_failed'],
      sources: ['org/deploy-repo'],
      description: 'Monitor deployments',
    });
  });
});
