import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { dispatch } from './dispatch.js';

describe('dispatch({ inputs })', () => {
  it('carries an inputs map on the frozen config', () => {
    const t = dispatch({ types: ['deploy'], inputs: { skipCveScan: z.boolean().default(false) } });
    expect(t.inputs?.skipCveScan).toBeDefined();
    expect(Object.isFrozen(t)).toBe(true);
  });
  it('omits inputs when not declared', () => {
    expect(dispatch({ types: ['deploy'] }).inputs).toBeUndefined();
  });
  it('unwraps a defineDispatchInputs handle to its map', () => {
    const handle = {
      __kiciDispatchInputs: true as const,
      map: { mode: z.enum(['full', 'edge-only']) },
    };
    const t = dispatch({ types: ['deploy'], inputs: handle });
    expect(t.inputs?.mode).toBeDefined();
  });
});
