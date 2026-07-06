import { z } from 'zod';

/**
 * How a run was initiated, as branded into provenance attestations.
 *
 * `triggered` — a webhook event that resolved to a cloned commit; the
 * repository/ref/sha coordinates come from a real VCS event.
 * `run-remote` — a developer's local working-tree overlay (`kici run remote`):
 * the source coordinates are caller-supplied, not a triggered VCS event.
 *
 * The brand is org-asserted (derived from the orchestrator-reported
 * `local_working_tree` flag on the run). The one un-forgeable trust anchor is
 * the origin org id; the brand and the repo/ref/sha are scoped to that org's
 * infrastructure.
 */
export const SourceOrigin = z.enum(['triggered', 'run-remote']);
export type SourceOrigin = z.infer<typeof SourceOrigin>;
