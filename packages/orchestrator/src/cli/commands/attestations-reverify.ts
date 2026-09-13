import type { Kysely } from 'kysely';
import { createLogger } from '@kici-dev/shared';
import type { Database } from '../../db/types.js';
import type { CacheStorage } from '../../storage/types.js';
import type { ProvenanceTrustRoot } from '../../provenance/trust-root.js';
import { computeAttestationVerdict } from '../../provenance/verify-at-ingest.js';

const logger = createLogger({ prefix: 'kici-admin-attestations' });

/**
 * Backfill / refresh attestation verdicts. By default it re-evaluates only rows
 * that have no usable verdict yet (`pending` / `unverifiable`) — the rollout
 * path for rows recorded before verify-at-ingest, or before an org configured
 * provenance. With `--all` it re-evaluates every row. Idempotent: re-running
 * over already-verified rows (when `--all`) recomputes the same verdict.
 */
export async function reverifyAttestations(
  db: Kysely<Database>,
  trustRoot: ProvenanceTrustRoot,
  storage: CacheStorage | undefined,
  opts: { all: boolean },
): Promise<{ updated: number; scanned: number }> {
  let query = db.selectFrom('attestations').select(['id', 'storage_key', 'verify_status']);
  if (!opts.all) {
    query = query.where('verify_status', 'in', ['pending', 'unverifiable']);
  }
  const rows = await query.execute();

  let updated = 0;
  for (const row of rows) {
    const verdict = await computeAttestationVerdict({
      trustRoot,
      storage,
      storageKey: row.storage_key,
      logWarn: (reason) =>
        logger.warn('reverify: verification error', { attestationId: row.id, reason }),
    });
    await db
      .updateTable('attestations')
      .set({
        verify_status: verdict.verifyStatus,
        verify_reason: verdict.verifyReason,
        verified_at: verdict.verifiedAt,
      })
      .where('id', '=', row.id)
      .execute();
    updated += 1;
    logger.info('reverify: updated attestation verdict', {
      attestationId: row.id,
      from: row.verify_status,
      to: verdict.verifyStatus,
    });
  }
  return { updated, scanned: rows.length };
}
