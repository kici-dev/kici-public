import { describe, it, expect } from 'vitest';
import { PatKind } from './pat-kind.js';

describe('PatKind', () => {
  it('enumerates user and agent', () => {
    expect(PatKind.options).toEqual(['user', 'agent']);
  });

  it('parses each member', () => {
    expect(PatKind.parse('user')).toBe('user');
    expect(PatKind.parse('agent')).toBe('agent');
  });

  it('rejects an unknown kind', () => {
    expect(PatKind.safeParse('service').success).toBe(false);
  });
});
