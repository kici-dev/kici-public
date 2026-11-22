import { describe, it, expect } from 'vitest';
import { SourceRestoreOrder, sourceRestoreOrder } from './source-restore-order.js';

const Order = SourceRestoreOrder.enum;

describe('sourceRestoreOrder', () => {
  it('restores the cached source before deps for a checkout: false job with no workspace', () =>
    // fails-when: the old order is returned, so the deps phase finds no .kici/package.json
    // and the workflow loads without .kici/node_modules
    expect(
      sourceRestoreOrder({ checkout: false, sourceCached: true, workspacePresent: false }),
    ).toBe(Order['before-and-after-deps']));

  it.each([
    // A normal checkout job: the clone supplied .kici/.
    [{ checkout: true, sourceCached: true, workspacePresent: true }],
    [{ checkout: undefined, sourceCached: true, workspacePresent: true }],
    // In-place and host-checkout set checkout = false over a tree that is already there.
    [{ checkout: false, sourceCached: true, workspacePresent: true }],
    // No cached source: nothing to restore early.
    [{ checkout: false, sourceCached: false, workspacePresent: false }],
  ])('keeps the deps-then-restore order for %j', (input) =>
    // breaks-if-wrong: a cloned, in-place or host-checkout job keeps today's phase order
    expect(sourceRestoreOrder(input)).toBe(Order['after-deps']),
  );
});
