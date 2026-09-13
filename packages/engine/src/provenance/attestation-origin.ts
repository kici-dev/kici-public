import { z } from 'zod';

/**
 * When the Platform identity token bound into a provenance bundle was minted,
 * relative to the build. Orthogonal to the run's `SourceOrigin` brand.
 * `live` — minted synchronously during the build (no deferral).
 * `deferred` — the build's mint failed transiently; the token was minted later
 *   against run/job rows the Platform already had (transient-blip recovery).
 * `offline-backfill` — the run was ingested while the Platform was fully down;
 *   the run/job rows were backfilled before the deferred mint. The temporal gap
 *   is disclosed, never hidden.
 */
export const AttestationOrigin = z.enum(['live', 'deferred', 'offline-backfill']);
export type AttestationOrigin = z.infer<typeof AttestationOrigin>;
