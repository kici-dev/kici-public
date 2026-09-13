import { describe, expect, it } from 'vitest';
import { COMPONENTS, isComponent, type Component } from './types.js';

describe('Component', () => {
  it('COMPONENTS lists the two valid components', () => {
    expect(COMPONENTS).toEqual(['orchestrator', 'agent']);
  });

  it('isComponent narrows valid strings', () => {
    expect(isComponent('orchestrator')).toBe(true);
    expect(isComponent('agent')).toBe(true);
    expect(isComponent('platform')).toBe(false);
    expect(isComponent('')).toBe(false);
  });

  it('Component type only allows orchestrator|agent', () => {
    const ok: Component = 'orchestrator';
    // @ts-expect-error -- 'platform' is not a Component
    const bad: Component = 'platform';
    expect(ok).toBe('orchestrator');
    expect(bad).toBe('platform');
  });
});
