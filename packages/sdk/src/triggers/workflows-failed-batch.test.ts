import { describe, expect, it } from 'vitest';
import { workflowsFailedBatch } from './workflows-failed-batch.js';

describe('workflowsFailedBatch', () => {
  it('returns a frozen config with the accumulation window', () => {
    const config = workflowsFailedBatch({ accumulateFor: 10000 });
    expect(config).toEqual({ _tag: 'WorkflowsFailedBatchTrigger', accumulateFor: 10000 });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('carries optional name and source filters', () => {
    const config = workflowsFailedBatch({
      accumulateFor: 5000,
      name: 'CI',
      source: 'org/repo',
      description: 'Batch failure notifier',
    });
    expect(config).toEqual({
      _tag: 'WorkflowsFailedBatchTrigger',
      accumulateFor: 5000,
      name: 'CI',
      source: 'org/repo',
      description: 'Batch failure notifier',
    });
  });

  it('omits optional fields when not provided', () => {
    const config = workflowsFailedBatch({ accumulateFor: 3000 });
    expect('name' in config).toBe(false);
    expect('source' in config).toBe(false);
    expect('description' in config).toBe(false);
  });
});
