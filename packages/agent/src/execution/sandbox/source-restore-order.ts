/**
 * When the runner restores the orchestrator-cached `.kici/` source relative to
 * the deps-install phase.
 *
 * The usual order installs deps first, then restores the source over the tree,
 * so the loaded workflow's contentHash matches the lock even if the install
 * touched a `.kici/` file. A `checkout: false` job with a cached source has no
 * `.kici/` before the restore: the deps phase would find no `package.json` and
 * skip, leaving no `.kici/node_modules` for `@kici-dev/sdk` to load from. That
 * job restores before deps as well, and again after, to keep the contentHash
 * guarantee.
 */

import { z } from 'zod';

export const SourceRestoreOrder = z.enum(['after-deps', 'before-and-after-deps']);
export type SourceRestoreOrder = z.infer<typeof SourceRestoreOrder>;

export function sourceRestoreOrder(input: {
  /** The job's checkout flag as the runner receives it (unset means true). */
  checkout: boolean | undefined;
  /** The orchestrator dispatched a cached `.kici/` source tarball. */
  sourceCached: boolean;
  /** `.kici/` exists in the workflow dir once the clone and overlay phases ran. */
  workspacePresent: boolean;
}): SourceRestoreOrder {
  // `workspacePresent` is the condition the in-place and host-checkout paths cannot
  // satisfy the other way: both set checkout = false over a tree that already holds
  // `.kici/` (the operator's checkout, or the host clone), so they keep the usual order.
  return input.checkout === false && input.sourceCached && !input.workspacePresent
    ? SourceRestoreOrder.enum['before-and-after-deps']
    : SourceRestoreOrder.enum['after-deps'];
}
