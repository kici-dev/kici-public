import { describe, it, expect } from 'vitest';
import { InitFailureCategory } from '@kici-dev/engine';
import { AgentJobFailedError } from './agent-job-failed-error.js';

describe('AgentJobFailedError', () => {
  it('is an Error carrying an optional initFailure', () => {
    const err = new AgentJobFailedError('boom', {
      scope: 'job',
      category: InitFailureCategory.enum.matrix_expansion,
      message: 'boom',
      jobName: 'build',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgentJobFailedError);
    expect(err.name).toBe('AgentJobFailedError');
    expect(err.message).toBe('boom');
    expect(err.initFailure?.category).toBe(InitFailureCategory.enum.matrix_expansion);
  });

  it('works with no initFailure', () => {
    const err = new AgentJobFailedError('plain');
    expect(err.initFailure).toBeUndefined();
  });

  it('survives an instanceof check after being rethrown', () => {
    let caught: unknown;
    try {
      throw new AgentJobFailedError('x');
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof AgentJobFailedError).toBe(true);
  });
});
