/**
 * What the agent host prepares before a job's sandbox starts.
 *
 * A container job gets its tree from the host, so the customer's image needs
 * no git and clone-time credentials never enter the container. A `checkout:
 * false` container job still needs `.kici/` to load its workflow: when nothing
 * else supplies it (no cached source, no full-repo overlay, no tree already in
 * the work dir), the host fetches only `.kici/` and copies that in.
 */

import { z } from 'zod';

export const HostWorkspace = z.enum([
  /** Nothing: the sandbox prepares its own workspace (bare-metal, fork, or a source the runner restores). */
  'none',
  /** The full host-side clone (and overlay) of a container job. */
  'clone',
  /** Only `.kici/`, fetched on the host, for a `checkout: false` container job. */
  'kici-only',
]);
export type HostWorkspace = z.infer<typeof HostWorkspace>;

export function hostWorkspaceFor(input: {
  /** The job runs in a container sandbox. */
  container: boolean;
  /** The job config's checkout flag (unset means true). */
  checkout: unknown;
  /** The orchestrator dispatched a cached `.kici/` source tarball. */
  sourceCached: boolean;
  /** The overlay tarball is the whole workspace (`kici run remote`). */
  fullRepo: boolean;
  /** `.kici/` already exists in the host work dir (in-place). */
  kiciPresent: boolean;
}): HostWorkspace {
  if (!input.container) return HostWorkspace.enum.none;
  if (input.checkout !== false) return HostWorkspace.enum.clone;
  // The cached source and the full-repo overlay both reach `.kici/` inside the
  // container; an in-place tree already holds it.
  if (input.sourceCached || input.fullRepo || input.kiciPresent) return HostWorkspace.enum.none;
  return HostWorkspace.enum['kici-only'];
}
