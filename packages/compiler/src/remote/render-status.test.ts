// Status-colouring tests for `colorStatus`, in their own file because they need
// colour support forced ON.
//
// picocolors decides at import time whether the terminal supports colour, and
// when it does not EVERY colorizer becomes `String` — so `pc.red(s)`,
// `pc.gray(s)` and `s` are the same value and a "this is red, not gray"
// assertion passes no matter what the code does. Forcing `FORCE_COLOR` before
// picocolors loads is what makes these assertions able to fail. The sibling
// `render.test.ts` deliberately keeps the unforced world so it can still test
// the NO_COLOR passthrough.
import { describe, expect, it, vi } from 'vitest';
import pc from 'picocolors';
import { CANONICAL_STATUSES, ExecutionJobStatus, ExecutionRunStatus } from '@kici-dev/engine';
import { colorStatus } from './render.js';

// Hoisted above the imports above, so it runs before picocolors is evaluated.
vi.hoisted(() => {
  process.env.FORCE_COLOR = '1';
  delete process.env.NO_COLOR;
});

describe('colorStatus', () => {
  it('has colour support forced on (positive control for every assertion below)', () => {
    // Without this the whole suite would pass vacuously: `pc.red === pc.gray === String`.
    expect(pc.isColorSupported).toBe(true);
    expect(pc.red('x')).not.toBe('x');
    expect(pc.red('x')).not.toBe(pc.gray('x'));
  });

  it('colours a timed-out job red, not gray', () => {
    const rendered = colorStatus(ExecutionJobStatus.enum.timed_out_stale);
    expect(rendered).toBe(pc.red(ExecutionJobStatus.enum.timed_out_stale));
  });

  it('colours a drift-dropped job red', () => {
    expect(colorStatus(ExecutionJobStatus.enum.drift_dropped)).toBe(
      pc.red(ExecutionJobStatus.enum.drift_dropped),
    );
  });

  it('colours success green and failure red', () => {
    expect(colorStatus(ExecutionRunStatus.enum.success)).toBe(
      pc.green(ExecutionRunStatus.enum.success),
    );
    expect(colorStatus(ExecutionRunStatus.enum.failed)).toBe(
      pc.red(ExecutionRunStatus.enum.failed),
    );
  });

  it('resolves the legacy error spelling to the failed colour', () => {
    expect(colorStatus('error')).toBe(pc.red('error'));
  });

  it('renders every canonical status without falling back to gray', () => {
    for (const status of CANONICAL_STATUSES) {
      expect(colorStatus(status)).not.toBe(pc.gray(status));
    }
  });

  it('falls back to gray for a genuinely unknown status', () => {
    expect(colorStatus('brand_new_status')).toBe(pc.gray('brand_new_status'));
  });
});
