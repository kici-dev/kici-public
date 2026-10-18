import { describe, it, expect } from 'vitest';
import { stepDisplayName, stepsInRunOrder } from './step-order.js';

describe('stepsInRunOrder', () => {
  it('puts init steps ahead of the steps, whatever order they arrive in', () => {
    const steps = [
      { stepIndex: 0, stepName: 'checkout', stepType: 'step' },
      { stepIndex: 1_000_000, stepName: 'init:0', stepType: 'init:0' },
      { stepIndex: 1, stepName: 'test' },
    ];
    // fails-when: the steps keep the stored-index order, init last
    expect(stepsInRunOrder(steps).map((s) => s.stepName)).toEqual(['init:0', 'checkout', 'test']);
    // breaks-if-wrong: the caller's array is not reordered in place
    expect(steps[0].stepName).toBe('checkout');
  });

  it('puts an init step stored without a type ahead of the steps', () => {
    // An older orchestrator stored the init step untyped, at its index and under its name.
    const steps = [
      { stepIndex: 0, stepName: 'baseline', stepType: 'step' },
      { stepIndex: 1_000_000, stepName: 'init:0', stepType: 'step' },
      { stepIndex: 999_999, stepName: 'init:-1', stepType: 'step' },
    ];
    // fails-when: only an init:<n> type places a step first
    // breaks-if-wrong: the untyped step just below the init base stays among the steps
    expect(stepsInRunOrder(steps).map((s) => s.stepIndex)).toEqual([1_000_000, 0, 999_999]);
  });

  it('reads a missing step list as no steps', () => {
    expect(stepsInRunOrder(undefined)).toEqual([]);
  });
});

describe('stepDisplayName', () => {
  it('names an init step init[n] and leaves every other step its own name', () => {
    // fails-when: the init step prints its internal name
    expect(stepDisplayName({ stepIndex: 1_000_002, stepName: 'init:2', stepType: 'init:2' })).toBe(
      'init[2]',
    );
    // breaks-if-wrong: a user step named like an init keeps its name
    expect(stepDisplayName({ stepIndex: 0, stepName: 'init:0', stepType: 'step' })).toBe('init:0');
    // fails-when: an init step stored without a type keeps its internal name
    expect(stepDisplayName({ stepIndex: 1_000_001, stepName: 'init:1', stepType: 'step' })).toBe(
      'init[1]',
    );
  });
});
