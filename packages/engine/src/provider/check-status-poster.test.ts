import { describe, it, expectTypeOf } from 'vitest';
import type { CheckStatusPoster } from './check-status-poster.js';

describe('CheckStatusPoster interface', () => {
  it('declares postWorkflowModificationCheck', () => {
    expectTypeOf<CheckStatusPoster>().toHaveProperty('postWorkflowModificationCheck');
  });
});
