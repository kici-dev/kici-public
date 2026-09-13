import { describe, it, expect } from 'vitest';
import { coerceDispatchInputs, parseInputPairs, DispatchInputError } from './coerce.js';

const map = {
  target: { type: 'string' as const, optional: true, nullable: false },
  skipCveScan: { type: 'boolean' as const, optional: false, nullable: false, default: false },
  mode: {
    type: 'enum' as const,
    optional: false,
    nullable: false,
    values: ['full', 'edge-only'],
    default: 'full',
  },
};

describe('coerceDispatchInputs', () => {
  it('coerces + applies defaults', () => {
    const r = coerceDispatchInputs({ skipCveScan: 'true' }, map);
    expect('values' in r && r.values).toEqual({ skipCveScan: true, mode: 'full' });
  });
  it('errors with per-key issues on unknown key + bad enum', () => {
    const r = coerceDispatchInputs({ nope: 'x', mode: 'bad' }, map);
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error.issues.map((i) => i.key).sort()).toEqual(['mode', 'nope']);
  });
  it('parseInputPairs splits key=value and rejects malformed', () => {
    expect(parseInputPairs(['a=1', 'b=x'])).toEqual({ a: '1', b: 'x' });
    expect(() => parseInputPairs(['novalue'])).toThrow(DispatchInputError);
  });
  it('parseInputPairs keeps "=" inside the value', () => {
    expect(parseInputPairs(['reason=a=b'])).toEqual({ reason: 'a=b' });
  });
});
