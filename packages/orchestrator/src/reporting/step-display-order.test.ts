import { describe, it, expect } from 'vitest';
import { SetupStepType } from '@kici-dev/engine';
import { compareStepsForDisplay, setupStepsFirst } from './step-display-order.js';

describe('setupStepsFirst', () => {
  it('names every setup type, so adding one cannot leave the SQL behind', () => {
    const compiled = setupStepsFirst().toOperationNode();
    const rendered = JSON.stringify(compiled);
    for (const t of SetupStepType.options) {
      expect(rendered).toContain(t);
    }
  });
});

describe('compareStepsForDisplay', () => {
  const build = { step_type: SetupStepType.enum['container:build'], step_index: 1_000_000 };
  const first = { step_type: 'step', step_index: 0 };
  const second = { step_type: 'step', step_index: 1 };
  const cacheSave = { step_type: 'cache:save', step_index: 1100 };

  it('puts the image build ahead of the real steps it ran before', () => {
    // The build's index is far ABOVE every real step — it has to be, since a
    // negative index is not available on the wire — so index alone would render
    // it last, as though it happened last.
    expect([second, build, first].sort(compareStepsForDisplay)).toEqual([build, first, second]);
  });

  it('leaves real steps ordered by index among themselves', () => {
    expect([second, first].sort(compareStepsForDisplay)).toEqual([first, second]);
  });

  it('leaves non-setup pseudo-steps where their index puts them', () => {
    // cache:save brackets the work rather than preceding it, so it is NOT a
    // setup type and keeps its index-based position after the real steps.
    expect([cacheSave, first, second].sort(compareStepsForDisplay)).toEqual([
      first,
      second,
      cacheSave,
    ]);
  });

  it('treats a missing step_type as a real step', () => {
    const untyped = { step_index: 2 };
    expect([untyped, build].sort(compareStepsForDisplay)).toEqual([build, untyped]);
  });

  it('is a total order — equal ranks fall through to the index', () => {
    const a = { step_type: SetupStepType.enum['container:build'], step_index: 5 };
    const b = { step_type: SetupStepType.enum['container:build'], step_index: 3 };
    expect([a, b].sort(compareStepsForDisplay)).toEqual([b, a]);
  });
});
