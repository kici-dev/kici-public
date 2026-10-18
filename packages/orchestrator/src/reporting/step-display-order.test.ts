import { describe, it, expect } from 'vitest';
import { INIT_STEP_INDEX_BASE, INIT_STEP_TYPE_PREFIX, SetupStepType } from '@kici-dev/engine';
import {
  compareStepRowsForDisplay,
  compareStepsForDisplay,
  setupStepsFirst,
} from './step-display-order.js';

describe('setupStepsFirst', () => {
  it('names every setup type, so adding one cannot leave the SQL behind', () => {
    const compiled = setupStepsFirst().toOperationNode();
    const rendered = JSON.stringify(compiled);
    for (const t of SetupStepType.options) {
      expect(rendered).toContain(t);
    }
  });

  it('ranks an untyped init row by its index and name', () => {
    const rendered = JSON.stringify(setupStepsFirst().toOperationNode());
    // fails-when: the SQL rank reads only step_type, so an untyped init row sorts last
    expect(rendered).toContain(String(INIT_STEP_INDEX_BASE));
    expect(rendered).toContain('step_name');
  });

  it('has an init rank', () => {
    const rendered = JSON.stringify(setupStepsFirst().toOperationNode());
    // fails-when: the SQL sort has no init rank, so init steps sort by index, last
    expect(rendered).toContain('^' + INIT_STEP_TYPE_PREFIX + '[0-9]+$');
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

  it('puts init steps after the image build and before the real steps', () => {
    const init0 = { step_type: 'init:0', step_index: 1_000_000 };
    const init1 = { step_type: 'init:1', step_index: 1_000_001 };
    // fails-when: init steps keep the index order, after every real step
    expect([second, init1, cacheSave, first, init0, build].sort(compareStepsForDisplay)).toEqual([
      build,
      init0,
      init1,
      first,
      second,
      cacheSave,
    ]);
  });

  it('puts an init step stored without a type ahead of the steps', () => {
    const untypedInit = { step_type: 'step', step_index: 1_000_000, step_name: 'init:0' };
    // fails-when: the comparator drops the step name, so the untyped init row sorts last
    expect([second, untypedInit, first].sort(compareStepsForDisplay)).toEqual([
      untypedInit,
      first,
      second,
    ]);
  });

  it('keeps an untyped step just below the init base a real step', () => {
    const below = { step_type: 'step', step_index: 999_999, step_name: 'init:-1' };
    // breaks-if-wrong: the last index below the init block is never read as an init step
    expect([below, first].sort(compareStepsForDisplay)).toEqual([first, below]);
  });

  it('treats a step type that only starts like an init as a real step', () => {
    const lookalike = { step_type: 'init:x', step_index: 3 };
    // breaks-if-wrong: the init match stays as narrow as the SQL pattern
    expect([lookalike, first].sort(compareStepsForDisplay)).toEqual([first, lookalike]);
  });

  it('is a total order — equal ranks fall through to the index', () => {
    const a = { step_type: SetupStepType.enum['container:build'], step_index: 5 };
    const b = { step_type: SetupStepType.enum['container:build'], step_index: 3 };
    expect([a, b].sort(compareStepsForDisplay)).toEqual([b, a]);
  });
});

describe('compareStepRowsForDisplay', () => {
  it('orders cold-store rows the way the PG query does', () => {
    const rows: Record<string, unknown>[] = [
      { step_index: 1, step_type: 'step' },
      { step_index: 1_000_000, step_type: 'init:0' },
      { step_index: 0, step_type: 'step' },
      { step_index: 2_000_000, step_type: 'container:build' },
    ];
    // fails-when: archived rows sort by index alone, putting the build and init last
    expect(rows.sort(compareStepRowsForDisplay).map((r) => r.step_index)).toEqual([
      2_000_000, 1_000_000, 0, 1,
    ]);
  });

  it('reads an archived init row with no step_type by its index and name', () => {
    const rows: Record<string, unknown>[] = [
      { step_index: 0, step_name: 'baseline' },
      { step_index: 1_000_000, step_name: 'init:0' },
    ];
    // fails-when: the cold-store path drops step_name, so the init row sorts by index
    expect(rows.sort(compareStepRowsForDisplay).map((r) => r.step_index)).toEqual([1_000_000, 0]);
  });

  it('reads a row with no step_type as a real step', () => {
    const rows: Record<string, unknown>[] = [
      { step_index: 2 },
      { step_index: 1_000_000, step_type: 'init:0' },
    ];
    // breaks-if-wrong: an archived row written before step_type existed still sorts
    expect(rows.sort(compareStepRowsForDisplay).map((r) => r.step_index)).toEqual([1_000_000, 2]);
  });
});
