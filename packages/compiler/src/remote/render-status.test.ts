// `colorStatus` tests, in their own file because they force colour ON.
// picocolors decides at import time; without colour EVERY colorizer is `String`,
// so a "red, not gray" assertion passes whatever the code does. The sibling
// `render.test.ts` stays unforced to test the NO_COLOR passthrough.
import { describe, expect, it, vi } from 'vitest';
import pc from 'picocolors';
import { CANONICAL_STATUSES, ExecutionJobStatus, ExecutionRunStatus } from '@kici-dev/engine';
import { colorStatus } from './render.js';

// Hoisted above the imports, so it runs before picocolors is evaluated.
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

  it('renders the retired error spelling as an unknown status', () => {
    // fails-when: `error` still resolves to `failed` through an alias map.
    expect(colorStatus('error')).toBe(pc.gray('error'));
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
